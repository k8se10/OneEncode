import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { loadConfig } from "../src/config/load.js";
import { startRelayServer, stopRelayServer } from "../src/ingest/relayServer.js";
import { startDecodeRelay } from "../src/ingest/decodeRelay.js";
import { buildCopyArgv } from "../src/legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "../src/health/monitor.js";

/**
 * Follow-up to jitterHopIsolation.ts (task #24). That experiment found all
 * 3 hops (ingest/relay/rendition, via zero-encode copy taps) showed
 * IDENTICAL CoV within one run — meaning the rendition encode stage wasn't
 * adding jitter on top of what arrived from the relay in that run, which
 * doesn't match the earlier official finding of baseline CoV~0.00 vs this
 * design's ~0.074. An offline file-based re-encode of a captured relay tap
 * came back CoV=0.0000 regardless of default vsync vs explicit
 * `-fps_mode cfr` — meaning file-based reprocessing always regularizes,
 * so it can't reproduce whatever the live-only effect is. This script
 * tests the one remaining lever directly, live: two rendition-style
 * encoders reading the SAME live relay concurrently, one with ffmpeg's
 * default output pacing and one with `-fps_mode cfr` forced, to see
 * whether forcing constant-frame-rate output on a LIVE re-encode closes
 * the gap that a file-based test could not exercise.
 */

const CAPTURE_SECONDS = 30;
const RECORDINGS_DIR = path.resolve(process.cwd(), "recordings");

function renditionArgv(inputUrl: string, outputUrl: string, forceCfr: boolean): string[] {
  return [
    "-hide_banner", "-loglevel", "warning", "-stats",
    "-i", inputUrl,
    "-vf", "scale=1920:1080",
    ...(forceCfr ? ["-fps_mode", "cfr"] : []),
    "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "cbr",
    "-b:v", "6000k", "-maxrate", "6000k", "-bufsize", "12000k", "-g", "120", "-bf", "2",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-f", "flv", outputUrl,
  ];
}

async function main(): Promise<void> {
  const { config } = loadConfig();
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

  console.log(`[fps-mode-test] starting relay server...`);
  const relay = startRelayServer();
  await relay.ready;

  console.log(`[fps-mode-test] starting synthetic source...`);
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

  console.log(`[fps-mode-test] starting decode/relay...`);
  const decodeRelay = startDecodeRelay(config);
  await decodeRelay.ready;

  const relayUrl = config.relay.url;
  const parsed = new URL(relayUrl);
  const defaultUrl = `${parsed.protocol}//${parsed.host}/rendition/test-default`;
  const cfrUrl = `${parsed.protocol}//${parsed.host}/rendition/test-cfr`;

  console.log(`[fps-mode-test] starting two concurrent rendition encoders off the same live relay (default vs -fps_mode cfr)...`);
  const renditionDefault = superviseLeg({
    legId: "rendition-default",
    encoderLabel: "h264_nvenc",
    buildArgv: () => renditionArgv(relayUrl, defaultUrl, false),
    restartPolicy: config.restartPolicy,
  });
  const renditionCfr = superviseLeg({
    legId: "rendition-cfr",
    encoderLabel: "h264_nvenc",
    buildArgv: () => renditionArgv(relayUrl, cfrUrl, true),
    restartPolicy: config.restartPolicy,
  });
  await Promise.all([renditionDefault.ready, renditionCfr.ready]);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const files = {
    default: path.join(RECORDINGS_DIR, `fpsmode-default_${stamp}.mp4`),
    cfr: path.join(RECORDINGS_DIR, `fpsmode-cfr_${stamp}.mp4`),
  };

  console.log(`[fps-mode-test] starting capture taps...`);
  const taps: Record<string, LegSupervisor> = {
    default: superviseLeg({
      legId: "tap-default",
      encoderLabel: "copy",
      buildArgv: () => buildCopyArgv(defaultUrl, { kind: "local-file", path: files.default }),
      restartPolicy: config.restartPolicy,
    }),
    cfr: superviseLeg({
      legId: "tap-cfr",
      encoderLabel: "copy",
      buildArgv: () => buildCopyArgv(cfrUrl, { kind: "local-file", path: files.cfr }),
      restartPolicy: config.restartPolicy,
    }),
  };
  await Promise.all(Object.values(taps).map((t) => t.ready));

  console.log(`[fps-mode-test] capturing for ${CAPTURE_SECONDS}s...`);
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_SECONDS * 1000));

  console.log(`[fps-mode-test] shutting down...`);
  await Promise.all(Object.values(taps).map((t) => t.stop()));
  await Promise.all([renditionDefault.stop(), renditionCfr.stop()]);
  await decodeRelay.stop();
  source.kill();
  stopRelayServer(relay);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`\n[fps-mode-test] ground-truth PTS jitter, live default vsync vs live -fps_mode cfr:\n`);
  for (const [label, file] of [
    ["default (ffmpeg's normal live output pacing)", files.default],
    ["-fps_mode cfr (forced constant frame rate output)", files.cfr],
  ] as const) {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      console.log(`${label}: NO OUTPUT FILE`);
      continue;
    }
    const ptsCsv = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file,
    ]).toString();
    const ptsFile = file.replace(/\.mp4$/, ".pts.txt");
    fs.writeFileSync(ptsFile, ptsCsv);
    const result = execFileSync("python", [path.resolve(process.cwd(), "scripts/ptsJitter.py"), ptsFile]).toString().trim();
    console.log(`${label}:\n  ${result}\n`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`[fps-mode-test] fatal error:`, err);
  process.exit(1);
});
