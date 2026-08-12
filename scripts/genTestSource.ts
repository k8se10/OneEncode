import { spawn } from "node:child_process";

/**
 * Simulates OBS: publishes a synthetic 2560x1440@60 test pattern + tone to
 * the local ingest point, standing in for a real capture-card/OBS source so
 * Phase 1 can be proven fully offline (see plan Phase 1 — "no real platform
 * yet, lowest risk"). Uses CPU libx264 here deliberately, to leave the GPU's
 * NVENC/AMF budget free for the pipeline's own encodes.
 *
 * Usage: npm run gen:testsource -- [rtmpUrl] [durationSec]
 * Requires the relay (mediamtx) to already be listening on that URL's port —
 * start the orchestrator (npm start) first.
 */
const rtmpUrl = process.argv[2] ?? "rtmp://127.0.0.1:1935/ingest/live";
const durationSec = process.argv[3];

const argv = [
  "-hide_banner",
  "-loglevel", "info",
  "-re",
  "-f", "lavfi",
  "-i", "testsrc2=size=2560x1440:rate=60",
  "-f", "lavfi",
  "-i", "sine=frequency=1000:sample_rate=48000",
  ...(durationSec ? ["-t", durationSec] : []),
  "-c:v", "libx264",
  "-preset", "ultrafast",
  "-b:v", "20000k",
  "-g", "120",
  "-c:a", "aac",
  "-b:a", "192k",
  "-f", "flv",
  rtmpUrl,
];

console.log(`[gen-test-source] publishing synthetic 2560x1440@60 source to ${rtmpUrl}`);
const child = spawn("ffmpeg", argv, { stdio: "inherit", windowsHide: true });
child.on("exit", (code) => {
  console.log(`[gen-test-source] ffmpeg exited with code ${code}`);
  process.exit(code ?? 0);
});
