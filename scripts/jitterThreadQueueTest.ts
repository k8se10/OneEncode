import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { loadConfig } from "../src/config/load.js";
import { startRelayServer, stopRelayServer } from "../src/ingest/relayServer.js";
import { superviseLeg } from "../src/health/monitor.js";

/**
 * Follow-up to jitterMediaMtxRelayTest.ts / jitterStdioPipeTest.ts (task
 * #24): proved the jitter is inherent to crossing ANY process boundary
 * (RTMP/MediaMTX, or a plain OS pipe -- both elevated, pipe actually
 * worse). This tests the one real, ffmpeg-native lever not yet tried:
 * `-thread_queue_size` on the READING side of a copy leg. Unlike
 * MediaMTX's writeQueueSize (already tried, no effect) or `-fps_mode cfr`
 * (already tried, made things worse), thread_queue_size is a genuine
 * demuxer-side input queue specifically meant to decouple irregular
 * packet arrival from downstream processing -- a real jitter buffer,
 * not a pacing-mode flag.
 *
 * Reproduces the worst-case scenario from jitterMultiBranchTest.ts
 * (NVENC+NVENC 2-branch combined process, ~0.087 CoV baseline) and
 * compares the leg's default thread_queue_size against a much larger one.
 *
 * Usage: npx tsx scripts/jitterThreadQueueTest.ts [queueSize]
 * (omit queueSize for ffmpeg's default; pass e.g. 4096 to test a large queue)
 */

const CAPTURE_SECONDS = 30;
const RECORDINGS_DIR = path.resolve(process.cwd(), "recordings");
const queueSizeArg = process.argv[2];
const queueSize = queueSizeArg ? Number(queueSizeArg) : undefined;

async function main(): Promise<void> {
  const { config } = loadConfig();
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  console.log(`[thread-queue-test] thread_queue_size under test: ${queueSize ?? "(ffmpeg default)"}`);

  console.log(`[thread-queue-test] starting relay server...`);
  const relay = startRelayServer();
  await relay.ready;

  console.log(`[thread-queue-test] starting synthetic source...`);
  const source = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "warning",
      "-re",
      "-f", "lavfi", "-i", "testsrc2=size=2560x1440:rate=60",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
      "-t", String(CAPTURE_SECONDS + 25),
      "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "20000k", "-g", "120",
      "-c:a", "aac", "-b:a", "192k",
      "-f", "flv", config.ingest.listenUrl,
    ],
    { windowsHide: true, stdio: "ignore" },
  );

  const relayUrl = "rtmp://127.0.0.1:1935/tqtest/relay";
  const renditionUrl = "rtmp://127.0.0.1:1935/tqtest/rendition";

  console.log(`[thread-queue-test] starting combined 2-branch process (NVENC+NVENC, the proven worst case)...`);
  const combined = superviseLeg({
    legId: "tqtest-combined",
    encoderLabel: "h264_nvenc",
    buildArgv: () => [
      "-hide_banner", "-loglevel", "warning", "-stats",
      "-i", config.ingest.listenUrl,
      "-filter_complex", "[0:v]split=2[va][vb];[vb]scale=1920:1080[vbs]",
      "-map", "[va]", "-map", "0:a",
      "-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-rc", "cbr",
      "-b:v", "40000k", "-maxrate", "40000k", "-bufsize", "20000k", "-g", "60", "-bf", "0",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-f", "flv", relayUrl,
      "-map", "[vbs]", "-map", "0:a",
      "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "cbr",
      "-b:v", "6000k", "-maxrate", "6000k", "-bufsize", "12000k", "-g", "120", "-bf", "2",
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
      "-f", "flv", renditionUrl,
    ],
    restartPolicy: config.restartPolicy,
  });
  await combined.ready;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copyFile = path.join(RECORDINGS_DIR, `tqtest-${queueSize ?? "default"}_${stamp}.mp4`);

  console.log(`[thread-queue-test] starting -c copy reader${queueSize ? ` with -thread_queue_size ${queueSize}` : " (default queue)"}...`);
  const copyReader = superviseLeg({
    legId: "tqtest-copy-reader",
    encoderLabel: "copy",
    buildArgv: () => [
      "-hide_banner", "-loglevel", "warning", "-stats",
      ...(queueSize ? ["-thread_queue_size", String(queueSize)] : []),
      "-i", renditionUrl,
      "-c", "copy",
      "-movflags", "+faststart", copyFile,
    ],
    restartPolicy: config.restartPolicy,
  });
  await copyReader.ready;

  console.log(`[thread-queue-test] capturing for ${CAPTURE_SECONDS}s...`);
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_SECONDS * 1000));

  console.log(`[thread-queue-test] shutting down...`);
  await copyReader.stop();
  await combined.stop();
  source.kill();
  stopRelayServer(relay);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`\n[thread-queue-test] ground-truth PTS jitter, thread_queue_size=${queueSize ?? "default"}:\n`);
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
  console.log(`\n[thread-queue-test] Compare to jitterMultiBranchTest.ts's NVENC+NVENC baseline (~0.087 CoV, default queue).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[thread-queue-test] fatal error:`, err);
  process.exit(1);
});
