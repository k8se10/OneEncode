import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { loadConfig } from "../src/config/load.js";
import { startRelayServer, stopRelayServer } from "../src/ingest/relayServer.js";
import { startDecodeRelay } from "../src/ingest/decodeRelay.js";
import { buildCopyArgv } from "../src/legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "../src/health/monitor.js";

/**
 * Follow-up to jitterFpsModeTest.ts (task #24): confirmed a single NVENC
 * rendition encode reading LIVE from the relay reproduces the official
 * 0.0740 CoV finding, and that `-fps_mode cfr` does not fix it (0.0771,
 * slightly worse, with frame duplication). This test isolates whether the
 * effect is NVENC-specific by re-running the SAME single-rendition-off-the-
 * live-relay topology with libx264 (CPU encoder) instead, holding
 * everything else constant (one rendition process, same relay, same
 * source, same capture window).
 */

const CAPTURE_SECONDS = 30;
const RECORDINGS_DIR = path.resolve(process.cwd(), "recordings");

function renditionArgvLibx264(inputUrl: string, outputUrl: string): string[] {
  return [
    "-hide_banner", "-loglevel", "warning", "-stats",
    "-i", inputUrl,
    "-vf", "scale=1920:1080",
    "-c:v", "libx264", "-preset", "veryfast", "-b:v", "6000k", "-maxrate", "6000k", "-bufsize", "12000k", "-g", "120",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-f", "flv", outputUrl,
  ];
}

async function main(): Promise<void> {
  const { config } = loadConfig();
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

  console.log(`[encoder-test] starting relay server...`);
  const relay = startRelayServer();
  await relay.ready;

  console.log(`[encoder-test] starting synthetic source...`);
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

  console.log(`[encoder-test] starting decode/relay...`);
  const decodeRelay = startDecodeRelay(config);
  await decodeRelay.ready;

  const relayUrl = config.relay.url;
  const parsed = new URL(relayUrl);
  const outUrl = `${parsed.protocol}//${parsed.host}/rendition/test-libx264`;

  console.log(`[encoder-test] starting single libx264 rendition encoder off the live relay...`);
  const rendition = superviseLeg({
    legId: "rendition-libx264",
    encoderLabel: "libx264",
    buildArgv: () => renditionArgvLibx264(relayUrl, outUrl),
    restartPolicy: config.restartPolicy,
  });
  await rendition.ready;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(RECORDINGS_DIR, `libx264-rendition_${stamp}.mp4`);

  console.log(`[encoder-test] starting capture tap...`);
  const tap: LegSupervisor = superviseLeg({
    legId: "tap-libx264",
    encoderLabel: "copy",
    buildArgv: () => buildCopyArgv(outUrl, { kind: "local-file", path: file }),
    restartPolicy: config.restartPolicy,
  });
  await tap.ready;

  console.log(`[encoder-test] capturing for ${CAPTURE_SECONDS}s...`);
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_SECONDS * 1000));

  console.log(`[encoder-test] shutting down...`);
  await tap.stop();
  await rendition.stop();
  await decodeRelay.stop();
  source.kill();
  stopRelayServer(relay);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`\n[encoder-test] ground-truth PTS jitter, libx264 rendition reading live from the relay:\n`);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    console.log(`NO OUTPUT FILE`);
  } else {
    const ptsCsv = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file,
    ]).toString();
    const ptsFile = file.replace(/\.mp4$/, ".pts.txt");
    fs.writeFileSync(ptsFile, ptsCsv);
    const result = execFileSync("python", [path.resolve(process.cwd(), "scripts/ptsJitter.py"), ptsFile]).toString().trim();
    console.log(`  ${result}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[encoder-test] fatal error:`, err);
  process.exit(1);
});
