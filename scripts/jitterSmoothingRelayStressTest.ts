import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { startRelayServer, stopRelayServer } from "../src/ingest/relayServer.js";
import { superviseLeg } from "../src/health/monitor.js";

/**
 * Stress test for the pacing-relay fix (task #24), which measured a clean
 * CoV=0.0000 (reproduced twice) in jitterSmoothingRelayTest.ts's minimal
 * single-writer/single-reader setup. That setup doesn't prove the fix
 * works for what the real pipeline actually needs:
 *
 *   - fan-out to MULTIPLE legs sharing one rendition (the whole point of
 *     the rendition-dedup design) -- untested so far, this relay buffers
 *     once and needs to release the SAME paced bytes to N sinks.
 *   - longer duration, to catch buffer drift (unbounded growth if the
 *     target byte rate is set too low relative to real encoder output,
 *     or underruns/stutters if set too high or the priming margin is
 *     too thin) that a 20-30s test wouldn't reveal.
 *   - the REAL topology: combined process publishes the rendition via
 *     RTMP unchanged (as shipped), a separate reader subscribes via
 *     `-c copy` to get bytes into the relay (itself jittery on arrival --
 *     that's fine, the relay's job is to re-time regardless of how
 *     jittery its input arrived), the relay paces and fans out to N leg
 *     writers.
 *
 * Logs buffer depth periodically to watch for drift, and reports
 * ground-truth PTS jitter + drop/dup for every leg at the end.
 *
 * Usage: npx tsx scripts/jitterSmoothingRelayStressTest.ts [durationSec] [primingMs] [legCount]
 */

const DURATION_SEC = Number(process.argv[2] ?? 180);
const PRIMING_MS = Number(process.argv[3] ?? 300);
const LEG_COUNT = Number(process.argv[4] ?? 2);
const TICK_MS = Number(process.argv[5] ?? 10);
const RECORDINGS_DIR = path.resolve(process.cwd(), "recordings");
const TS_PACKET_SIZE = 188;
const BUFFER_LOG_INTERVAL_MS = 10_000;

/**
 * Adaptive pacing relay: replaces the earlier fixed-rate version, which
 * the 3-minute stress test proved wrong -- its static target byte rate
 * (derived from nominal config bitrate) undershot the REAL incoming rate
 * (MPEG-TS container overhead, CBR drift above nominal), so the buffer
 * grew unbounded (0 -> 48MB over 3 minutes, one leg falling to 0.7x
 * real-time) instead of reaching a steady state.
 *
 * Instead of trusting a pre-computed number, this measures the actual
 * incoming byte rate continuously and steers the release rate toward it
 * with a slow, gentle correction based on how far the current buffer
 * level is from the target (priming) depth -- classic jitter-buffer
 * control, not a static guess. Corrections are deliberately slow (a
 * multi-second time constant, plus exponential smoothing on top) so the
 * release rate itself stays nearly constant tick-to-tick -- an abruptly
 * changing release rate would just reintroduce the jitter this exists to
 * remove.
 */
class FanOutPacingRelay {
  private buffer: Buffer[] = [];
  private bufferedBytes = 0;
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private logTimer: NodeJS.Timeout | undefined;
  private measureTimer: NodeJS.Timeout | undefined;
  private adjustTimer: NodeJS.Timeout | undefined;
  private readonly tickMs = TICK_MS;
  private lastTickAt = 0;
  private peakBufferedBytes = 0;
  private underrunTicks = 0;

  // The ORIGINAL fixed-rate version achieved perfect smoothing (CoV
  // 0.0000) specifically BECAUSE its release rate never varied -- a
  // continuous per-tick correction (tried above, reverted) fixed the
  // unbounded-drift bug but reintroduced jitter through its own constant
  // fluctuation. This version holds a genuinely CONSTANT rate for a whole
  // adjustment window (smooth within the window, matching the original's
  // clean result), and only makes small, infrequent step adjustments
  // between windows to track real inflow and prevent long-term drift.
  private bytesSinceLastMeasure = 0;
  private measuredRateBytesPerSec = 0;
  private readonly measureIntervalMs = 1000;

  private targetBufferBytes = 0;
  private readonly startedAt = Date.now();
  private currentReleaseRateBytesPerSec = 0;
  private readonly adjustIntervalMs = 5000;

  constructor(
    private readonly source: NodeJS.ReadableStream,
    private readonly sinks: NodeJS.WritableStream[],
  ) {
    source.on("data", (chunk: Buffer) => this.onData(chunk));
    this.measureTimer = setInterval(() => this.remeasure(), this.measureIntervalMs);
    this.logTimer = setInterval(() => {
      console.log(
        `[pacing-relay] buffered=${(this.bufferedBytes / 1024).toFixed(1)}KB ` +
          `target=${(this.targetBufferBytes / 1024).toFixed(1)}KB ` +
          `measuredRate=${(this.measuredRateBytesPerSec / 1024).toFixed(1)}KB/s ` +
          `releaseRate=${(this.currentReleaseRateBytesPerSec / 1024).toFixed(1)}KB/s ` +
          `peak=${(this.peakBufferedBytes / 1024).toFixed(1)}KB underrunTicks=${this.underrunTicks}`,
      );
    }, BUFFER_LOG_INTERVAL_MS);
  }

  private remeasure(): void {
    this.measuredRateBytesPerSec = (this.bytesSinceLastMeasure * 1000) / this.measureIntervalMs;
    this.bytesSinceLastMeasure = 0;
  }

  private adjustReleaseRate(): void {
    if (this.measuredRateBytesPerSec <= 0) return;
    this.targetBufferBytes = (this.measuredRateBytesPerSec * PRIMING_MS) / 1000;
    // Moderate correction (15s time constant), applied only once every
    // adjustIntervalMs -- strong enough to actually close real drift
    // within tens of seconds, but changes happen in infrequent discrete
    // steps, not continuously, so the rate stays constant (smooth) within
    // each window.
    const bufferError = this.bufferedBytes - this.targetBufferBytes;
    const desired = this.measuredRateBytesPerSec + bufferError / 15;
    const bounded = Math.max(this.measuredRateBytesPerSec * 0.7, Math.min(this.measuredRateBytesPerSec * 1.5, desired));
    const alpha = 0.5; // smooth the step itself so consecutive windows don't jump too abruptly
    this.currentReleaseRateBytesPerSec =
      this.currentReleaseRateBytesPerSec === 0 ? bounded : this.currentReleaseRateBytesPerSec * (1 - alpha) + bounded * alpha;
  }

  private primingElapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  private onData(chunk: Buffer): void {
    this.buffer.push(chunk);
    this.bufferedBytes += chunk.length;
    this.bytesSinceLastMeasure += chunk.length;
    this.peakBufferedBytes = Math.max(this.peakBufferedBytes, this.bufferedBytes);
    if (!this.started && this.primingElapsedMs() >= PRIMING_MS) {
      this.started = true;
      this.targetBufferBytes = this.bufferedBytes;
      this.currentReleaseRateBytesPerSec = (this.bufferedBytes * 1000) / Math.max(1, PRIMING_MS);
      this.lastTickAt = Date.now();
      this.timer = setInterval(() => this.tick(), this.tickMs);
      this.adjustTimer = setInterval(() => this.adjustReleaseRate(), this.adjustIntervalMs);
    }
  }

  private tick(): void {
    // setInterval(fn, 10) does not reliably fire every 10ms under real
    // load (measured independently by two forks debugging this exact
    // stress-test failure: only ~55-64% of nominal tick count actually
    // fires, with 7+ concurrent child processes competing for the event
    // loop). Computing the release budget from the ASSUMED tickMs instead
    // of the ACTUAL elapsed time silently under-released every tick, and
    // that shortfall compounded into unbounded buffer growth over a long
    // run -- confirmed root cause, not an accounting bug or backpressure
    // (both independently ruled out). Using real elapsed time makes the
    // release volume self-correct for whatever the event loop actually
    // delivers, rather than trusting the timer's nominal interval.
    const now = Date.now();
    const elapsedMs = this.lastTickAt > 0 ? now - this.lastTickAt : this.tickMs;
    this.lastTickAt = now;

    // Constant within an adjustment window -- adjustReleaseRate() is the
    // only thing that changes currentReleaseRateBytesPerSec, and only
    // once every adjustIntervalMs, gently.
    const targetBytes = Math.floor((this.currentReleaseRateBytesPerSec * elapsedMs) / 1000 / TS_PACKET_SIZE) * TS_PACKET_SIZE;
    let toRelease = Math.min(targetBytes, this.bufferedBytes);
    toRelease = Math.floor(toRelease / TS_PACKET_SIZE) * TS_PACKET_SIZE;
    if (toRelease <= 0) {
      if (this.started) this.underrunTicks++;
      return;
    }

    const combined = Buffer.concat(this.buffer);
    const out = combined.subarray(0, toRelease);
    for (const sink of this.sinks) sink.write(out);
    const remainder = combined.subarray(toRelease);
    this.buffer = remainder.length > 0 ? [remainder] : [];
    this.bufferedBytes = remainder.length;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.logTimer) clearInterval(this.logTimer);
    if (this.measureTimer) clearInterval(this.measureTimer);
    if (this.adjustTimer) clearInterval(this.adjustTimer);
    if (this.buffer.length > 0) {
      const combined = Buffer.concat(this.buffer);
      for (const sink of this.sinks) sink.write(combined);
    }
    console.log(`[pacing-relay] final: peakBuffered=${(this.peakBufferedBytes / 1024).toFixed(1)}KB underrunTicks=${this.underrunTicks}`);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  console.log(`[stress-test] duration=${DURATION_SEC}s priming=${PRIMING_MS}ms legCount=${LEG_COUNT}`);
  console.log(`[stress-test] starting relay server...`);
  const relay = startRelayServer();
  await relay.ready;

  console.log(`[stress-test] starting synthetic source...`);
  const source = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "warning",
      "-re",
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
      "-t", String(DURATION_SEC + 20),
      "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "10000k", "-g", "120",
      "-c:a", "aac", "-b:a", "192k",
      "-f", "flv", "rtmp://127.0.0.1:1935/ingest/live",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const renditionUrl = "rtmp://127.0.0.1:1935/stresstest/rendition";
  console.log(`[stress-test] starting rendition encoder, publishing to RTMP exactly as the real shipped pipeline does...`);
  const encoder = superviseLeg({
    legId: "stress-encoder",
    encoderLabel: "libx264",
    buildArgv: () => [
      "-hide_banner", "-loglevel", "warning", "-stats",
      "-i", "rtmp://127.0.0.1:1935/ingest/live",
      "-c:v", "libx264", "-preset", "veryfast", "-b:v", "6000k", "-maxrate", "6000k", "-bufsize", "12000k", "-g", "120",
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
      "-f", "flv", renditionUrl,
    ],
    restartPolicy: { maxRestartsPerHour: 5, backoffInitialMs: 2000, backoffMaxMs: 60000 },
  });
  await encoder.ready;

  console.log(`[stress-test] starting reader (RTMP subscribe -> stdout, feeds the pacing relay)...`);
  // Raw spawn, no supervision -- but the encoder's own "ready" (first
  // -stats sample from reading the INGEST side) doesn't guarantee MediaMTX
  // has finished registering its publish on renditionUrl yet, the same
  // startup race documented throughout this investigation. Retry a few
  // times with a short delay instead of failing outright on the first hit.
  async function startReaderWithRetry(): Promise<import("node:child_process").ChildProcess> {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const proc = spawn(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "warning", "-stats", "-i", renditionUrl, "-c", "copy", "-f", "mpegts", "pipe:1"],
        { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] },
      );
      const exitedQuickly = await Promise.race([
        new Promise<boolean>((resolve) => proc.once("exit", () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      if (!exitedQuickly) return proc;
      console.log(`[stress-test] reader connection attempt ${attempt} failed (publish not registered yet), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("reader failed to connect after 10 attempts");
  }
  const reader = await startReaderWithRetry();

  const legFiles: string[] = [];
  const legWriters = Array.from({ length: LEG_COUNT }, (_, i) => {
    const file = path.join(RECORDINGS_DIR, `stress-leg${i}_${stamp}.mp4`);
    legFiles.push(file);
    return spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "warning", "-stats", "-f", "mpegts", "-i", "pipe:0", "-c", "copy", "-movflags", "+faststart", file],
      { windowsHide: true, stdio: ["pipe", "ignore", "inherit"] },
    );
  });

  console.log(`[stress-test] starting pacing relay, fanning out to ${LEG_COUNT} leg(s)...`);
  const pacer = new FanOutPacingRelay(
    reader.stdout!,
    legWriters.map((w) => w.stdin!),
  );

  console.log(`[stress-test] capturing for ${DURATION_SEC}s...`);
  await new Promise((resolve) => setTimeout(resolve, DURATION_SEC * 1000));

  console.log(`[stress-test] shutting down...`);
  pacer.stop();
  reader.kill();
  await encoder.stop();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (const w of legWriters) w.kill();
  source.kill();
  stopRelayServer(relay);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log(`\n[stress-test] ground-truth PTS jitter per leg (priming=${PRIMING_MS}ms, legCount=${LEG_COUNT}, duration=${DURATION_SEC}s):\n`);
  for (const [i, file] of legFiles.entries()) {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      console.log(`leg${i}: NO OUTPUT FILE`);
      continue;
    }
    const ptsCsv = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file,
    ]).toString();
    const ptsFile = file.replace(/\.mp4$/, ".pts.txt");
    fs.writeFileSync(ptsFile, ptsCsv);
    const result = execFileSync("python", [path.resolve(process.cwd(), "scripts/ptsJitter.py"), ptsFile]).toString().trim();
    console.log(`leg${i}:\n  ${result}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[stress-test] fatal error:`, err);
  process.exit(1);
});
