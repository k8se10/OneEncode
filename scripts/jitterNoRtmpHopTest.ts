import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { loadConfig } from "../src/config/load.js";
import { startRelayServer, stopRelayServer } from "../src/ingest/relayServer.js";
import { superviseLeg } from "../src/health/monitor.js";

/**
 * Direct test of the leading hypothesis from jitterEncoderTest.ts (task
 * #24): the jitter is introduced specifically by the relay->rendition
 * RTMP publish/subscribe roundtrip (a full demux/remux + separate-process
 * boundary through MediaMTX), not by "encoding twice" per se.
 *
 * This spawns ONE ffmpeg process that decodes the ingest exactly once and
 * splits the decoded frames (-filter_complex split) into two branches:
 *   - branch A: the relay's normal ull/40Mbps encode, published to the
 *     real relay RTMP path exactly as today (unchanged, so nothing else
 *     in the system is affected) — included so this test carries the same
 *     total GPU/encode workload as the real pipeline, not a lighter one.
 *   - branch B: a rendition-style 1080p6M encode, written DIRECTLY to a
 *     local file — no RTMP publish, no MediaMTX, no second process. This
 *     is the one variable changed vs. jitterEncoderTest.ts's rendition
 *     encoder, which read the same kind of stream back over RTMP from a
 *     separate process.
 *
 * If branch B's ground-truth CoV comes back close to baseline's ~0.0000,
 * that confirms the RTMP roundtrip itself (not double-encoding in
 * general) is the mechanism. If it's still elevated (~0.06-0.08), the
 * cause is something inherent to encoding an already-live-encoded frame
 * stream a second time, RTMP hop or not — a materially different, harder
 * conclusion.
 *
 * Caveat (explicitly not addressed by this test): the ingest side here is
 * still the synthetic lavfi source used throughout this investigation, not
 * real OBS output. OBS's own encode pipeline has its own overhead/pacing
 * characteristics that could differ — this test isolates the relay-
 * >rendition boundary specifically, using the same ingest for both arms
 * of every comparison so far, but real-OBS validation is a separate,
 * still-open follow-up.
 */

const CAPTURE_SECONDS = 30;
const RECORDINGS_DIR = path.resolve(process.cwd(), "recordings");

async function main(): Promise<void> {
  const { config } = loadConfig();
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

  console.log(`[no-rtmp-hop-test] starting relay server...`);
  const relay = startRelayServer();
  await relay.ready;

  console.log(`[no-rtmp-hop-test] starting synthetic source...`);
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

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const branchBFile = path.join(RECORDINGS_DIR, `no-rtmp-hop-rendition_${stamp}.mp4`);

  console.log(`[no-rtmp-hop-test] starting combined decode + split-encode process (branch A -> relay RTMP, branch B -> direct local file, no RTMP hop)...`);
  const combined = superviseLeg({
    legId: "combined-relay-rendition",
    encoderLabel: "h264_nvenc",
    buildArgv: () => [
      "-hide_banner", "-loglevel", "warning", "-stats",
      "-i", config.ingest.listenUrl,
      "-filter_complex", "[0:v]split=2[va][vb];[vb]scale=1920:1080[vb_scaled]",
      // Branch A: relay's normal ull encode, published exactly as today.
      "-map", "[va]", "-map", "0:a",
      "-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-rc", "cbr",
      "-b:v", "40000k", "-maxrate", "40000k", "-bufsize", "20000k", "-g", "60", "-bf", "0",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-f", "flv", config.relay.url,
      // Branch B: rendition-style encode, written straight to a local file — no RTMP hop.
      "-map", "[vb_scaled]", "-map", "0:a",
      "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "cbr",
      "-b:v", "6000k", "-maxrate", "6000k", "-bufsize", "12000k", "-g", "120", "-bf", "2",
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
      "-movflags", "+faststart", branchBFile,
    ],
    restartPolicy: config.restartPolicy,
  });
  await combined.ready;

  console.log(`[no-rtmp-hop-test] capturing for ${CAPTURE_SECONDS}s...`);
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_SECONDS * 1000));

  console.log(`[no-rtmp-hop-test] shutting down...`);
  await combined.stop();
  source.kill();
  stopRelayServer(relay);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`\n[no-rtmp-hop-test] ground-truth PTS jitter, rendition-style branch with NO RTMP hop between decode and this encode:\n`);
  if (!fs.existsSync(branchBFile) || fs.statSync(branchBFile).size === 0) {
    console.log(`NO OUTPUT FILE — check logs above for the actual ffmpeg error`);
  } else {
    const ptsCsv = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", branchBFile,
    ]).toString();
    const ptsFile = branchBFile.replace(/\.mp4$/, ".pts.txt");
    fs.writeFileSync(ptsFile, ptsCsv);
    const result = execFileSync("python", [path.resolve(process.cwd(), "scripts/ptsJitter.py"), ptsFile]).toString().trim();
    console.log(`  ${result}`);
    console.log(
      `\n[no-rtmp-hop-test] Compare to jitterEncoderTest.ts's NVENC result (0.0740, same rendition ` +
        `settings, but reading the rendition's input back over RTMP from a separate process). Close to ` +
        `~0.0000 here confirms the RTMP roundtrip itself is the mechanism; still elevated means it isn't.`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[no-rtmp-hop-test] fatal error:`, err);
  process.exit(1);
});
