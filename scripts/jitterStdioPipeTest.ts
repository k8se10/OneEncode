import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { startRelayServer, stopRelayServer } from "../src/ingest/relayServer.js";

/**
 * Follow-up to jitterMediaMtxRelayTest.ts (task #24): proved MediaMTX's
 * own publish/relay/subscribe mechanism introduces jitter (CoV~0.06)
 * independent of encoding.
 *
 * This tests the one remaining lever: does a non-network, non-MediaMTX
 * transport between two SEPARATE processes preserve clean timing where
 * RTMP/MediaMTX doesn't? Two child processes are connected via a plain OS
 * pipe (encoder's stdout piped directly into a separate reader process's
 * stdin, via Node's child_process stdio -- a real OS-level pipe, not a
 * Windows named pipe server, which ffmpeg doesn't auto-create). If the
 * reader's file comes back near CoV~0.0000, a non-network transport is a
 * real fix for a single-reader hop; if still elevated, the mechanism is
 * about cross-process handoff/scheduling in general, not RTMP/network
 * specifically.
 *
 * Scope note: this is a single-writer/single-reader pipe, same fan-out
 * limitation as the named-pipe approach -- proof of concept only.
 */

const RECORDINGS_DIR = path.resolve(process.cwd(), "recordings");
const DURATION_SEC = 20;

async function main(): Promise<void> {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copyFile = path.join(RECORDINGS_DIR, `stdiopipe-copy_${stamp}.mp4`);

  console.log(`[stdio-pipe-test] starting relay server (for the ingest source only)...`);
  const relay = startRelayServer();
  await relay.ready;

  console.log(`[stdio-pipe-test] starting synthetic source...`);
  const source = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "warning",
      "-re",
      "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
      "-t", String(DURATION_SEC + 15),
      "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "10000k", "-g", "120",
      "-c:a", "aac", "-b:a", "192k",
      "-f", "flv", "rtmp://127.0.0.1:1935/ingest/live",
    ],
    { windowsHide: true, stdio: "ignore" },
  );

  // Give the source a moment to start publishing before the encoder tries
  // to connect (normal startup race, same as everywhere else in this
  // investigation).
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log(`[stdio-pipe-test] starting encoder (writes MPEGTS to its own stdout)...`);
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

  console.log(`[stdio-pipe-test] starting reader (reads MPEGTS from its own stdin, connected directly to the encoder's stdout)...`);
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

  encoder.stdout!.pipe(reader.stdin!);

  console.log(`[stdio-pipe-test] capturing for ${DURATION_SEC}s...`);
  await new Promise((resolve) => setTimeout(resolve, DURATION_SEC * 1000));

  console.log(`[stdio-pipe-test] shutting down...`);
  encoder.kill();
  reader.kill();
  source.kill();
  stopRelayServer(relay);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log(`\n[stdio-pipe-test] ground-truth PTS jitter, encoder -> OS pipe -> separate reader process:\n`);
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
  console.log(
    `\n[stdio-pipe-test] Compare to the MediaMTX-relayed equivalent (~0.06 CoV) and the ~0.0000 direct-` +
      `to-file control. If this comes back near 0.0000, a non-network transport genuinely fixes the cross-` +
      `process handoff where RTMP/MediaMTX doesn't (single-reader case only).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`[stdio-pipe-test] fatal error:`, err);
  process.exit(1);
});
