import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { startRelayServer, stopRelayServer } from "../src/ingest/relayServer.js";

/**
 * Follow-up to jitterThreadQueueTest.ts (task #24): thread_queue_size's
 * apparent improvement didn't reproduce on repeat -- run-to-run variance
 * in this environment is too large to trust simple flag tuning. This
 * tests a genuine custom fix instead: a small Node.js pacing relay sits
 * between the encoder and the reader, buffers a priming window of MPEG-TS
 * bytes, then releases them to the reader at a steady, calculated byte
 * rate aligned to 188-byte TS packet boundaries -- a real leaky-bucket
 * jitter buffer, decoupling the reader's input arrival timing from
 * whatever irregular timing the encoder->relay hop produced.
 *
 * Usage: npx tsx scripts/jitterSmoothingRelayTest.ts [primingMs]
 * (omit primingMs to disable smoothing entirely -- pure passthrough control)
 */

const CAPTURE_SECONDS = 30;
const RECORDINGS_DIR = path.resolve(process.cwd(), "recordings");
const TS_PACKET_SIZE = 188;
const primingMsArg = process.argv[2];
const primingMs = primingMsArg ? Number(primingMsArg) : 0;
// Rendition branch target: 6000kbps video + 160kbps audio, small headroom
// so the buffer doesn't grow unboundedly if actual CBR output runs
// slightly above nominal.
const TARGET_BYTES_PER_SEC = Math.floor(((6000 + 160) * 1000) / 8 * 1.08);

class PacingRelay {
  private buffer: Buffer[] = [];
  private bufferedBytes = 0;
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly tickMs = 10;

  constructor(
    private readonly source: NodeJS.ReadableStream,
    private readonly sink: NodeJS.WritableStream,
  ) {
    source.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer.push(chunk);
    this.bufferedBytes += chunk.length;
    if (!this.started && this.bufferedBytes >= (TARGET_BYTES_PER_SEC * primingMs) / 1000) {
      this.started = true;
      this.timer = setInterval(() => this.tick(), this.tickMs);
    }
  }

  private tick(): void {
    const targetBytes = Math.floor((TARGET_BYTES_PER_SEC * this.tickMs) / 1000 / TS_PACKET_SIZE) * TS_PACKET_SIZE;
    let toRelease = Math.min(targetBytes, this.bufferedBytes);
    toRelease = Math.floor(toRelease / TS_PACKET_SIZE) * TS_PACKET_SIZE;
    if (toRelease <= 0) return;

    const combined = Buffer.concat(this.buffer);
    this.sink.write(combined.subarray(0, toRelease));
    const remainder = combined.subarray(toRelease);
    this.buffer = remainder.length > 0 ? [remainder] : [];
    this.bufferedBytes = remainder.length;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    // Flush whatever's left so the reader's stream ends cleanly.
    if (this.buffer.length > 0) this.sink.write(Buffer.concat(this.buffer));
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copyFile = path.join(RECORDINGS_DIR, `smoothrelay-${primingMs}ms_${stamp}.mp4`);

  console.log(`[smoothing-relay-test] priming buffer: ${primingMs}ms (target rate ${(TARGET_BYTES_PER_SEC / 1000).toFixed(0)} KB/s)`);
  console.log(`[smoothing-relay-test] starting relay server (for the ingest source only)...`);
  const relay = startRelayServer();
  await relay.ready;

  console.log(`[smoothing-relay-test] starting synthetic source...`);
  const source = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "warning",
      "-re",
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
      "-t", String(CAPTURE_SECONDS + 20),
      "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "10000k", "-g", "120",
      "-c:a", "aac", "-b:a", "192k",
      "-f", "flv", "rtmp://127.0.0.1:1935/ingest/live",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log(`[smoothing-relay-test] starting encoder (writes MPEGTS to its own stdout)...`);
  const encoder = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "warning", "-stats",
      "-i", "rtmp://127.0.0.1:1935/ingest/live",
      "-c:v", "libx264", "-preset", "veryfast", "-b:v", "6000k", "-maxrate", "6000k", "-bufsize", "12000k", "-g", "120",
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
      "-f", "mpegts", "pipe:1",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] },
  );

  console.log(`[smoothing-relay-test] starting reader (reads MPEGTS from its own stdin, fed through the pacing relay)...`);
  const reader = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "warning", "-stats",
      "-f", "mpegts", "-i", "pipe:0",
      "-c", "copy",
      "-movflags", "+faststart", copyFile,
    ],
    { windowsHide: true, stdio: ["pipe", "ignore", "inherit"] },
  );

  const relayer = primingMs > 0 ? new PacingRelay(encoder.stdout!, reader.stdin!) : null;
  if (!relayer) {
    console.log(`[smoothing-relay-test] primingMs=0 -- pure passthrough control, no smoothing applied`);
    encoder.stdout!.pipe(reader.stdin!);
  }

  console.log(`[smoothing-relay-test] capturing for ${CAPTURE_SECONDS}s...`);
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_SECONDS * 1000));

  console.log(`[smoothing-relay-test] shutting down...`);
  relayer?.stop();
  encoder.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  reader.kill();
  source.kill();
  stopRelayServer(relay);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log(`\n[smoothing-relay-test] ground-truth PTS jitter, priming=${primingMs}ms:\n`);
  if (!fs.existsSync(copyFile) || fs.statSync(copyFile).size === 0) {
    console.log(`NO OUTPUT FILE`);
  } else {
    const ptsCsv = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", copyFile,
    ]).toString();
    const ptsFile = copyFile.replace(/\.mp4$/, ".pts.txt");
    fs.writeFileSync(ptsFile, ptsCsv);
    const result = execFileSync("python", [path.resolve(process.cwd(), "scripts/ptsJitter.py"), ptsFile]).toString().trim();
    console.log(`  ${result}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[smoothing-relay-test] fatal error:`, err);
  process.exit(1);
});
