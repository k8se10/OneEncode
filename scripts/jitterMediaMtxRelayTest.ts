import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { startRelayServer, stopRelayServer } from "../src/ingest/relayServer.js";
import { superviseLeg } from "../src/health/monitor.js";
import { buildCopyArgv } from "../src/legs/argvBuilder.js";

/**
 * Follow-up to jitterRtmpMechanismTest.ts / jitterMultiBranchTest.ts (task
 * #24): every prior test in this thread republished a LIVE encode over
 * RTMP. This isolates whether MediaMTX's relay mechanism itself introduces
 * timing irregularity independent of anything about live encoding, by
 * republishing an ALREADY-PERFECT, pre-recorded file -- pure remux
 * (`-c copy`, no decode, no encode, no live encoder timing involved at
 * all), paced at real-time via `-re`. If a separate copy-reader still
 * shows elevated jitter reading this back, that's decisive: MediaMTX's
 * publish/relay/subscribe mechanism itself can't preserve perfect timing,
 * regardless of source.
 *
 * Step 1: generate a perfectly clean source file directly (lavfi -> file,
 * no RTMP anywhere, matching the repeatedly-proven CoV~0.0000 recipe).
 * Step 2: republish that file via `-re -c copy` to RTMP (pure remux, no
 * encoder in this step at all).
 * Step 3: separate `-c copy` reader subscribes and writes to a second file.
 * Step 4: compare ground-truth PTS jitter of step 3's output against the
 * step 1 source (both should reflect the same underlying frame spacing if
 * MediaMTX preserves timing perfectly).
 */

const RECORDINGS_DIR = path.resolve(process.cwd(), "recordings");
const DURATION_SEC = 20;

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: "inherit" });
}

async function main(): Promise<void> {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sourceFile = path.join(RECORDINGS_DIR, `mtx-relay-source_${stamp}.mp4`);
  const copyFile = path.join(RECORDINGS_DIR, `mtx-relay-copy_${stamp}.mp4`);
  const tapUrl = "rtmp://127.0.0.1:1935/mtx-relay-test/live";

  console.log(`[mtx-relay-test] step 1: generating a perfectly clean source file (no RTMP involved)...`);
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=60:duration=${DURATION_SEC}`,
    "-f", "lavfi", "-i", `sine=frequency=1000:sample_rate=48000:duration=${DURATION_SEC}`,
    "-c:v", "libx264", "-preset", "veryfast", "-b:v", "6000k", "-g", "120",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart", "-y", sourceFile,
  ]);
  console.log(`[mtx-relay-test] source file generated: ${sourceFile}`);

  console.log(`[mtx-relay-test] starting relay server...`);
  const relay = startRelayServer();
  await relay.ready;

  console.log(`[mtx-relay-test] step 2: republishing the clean file via -re -c copy (pure remux, no live encoder involved)...`);
  const republisher = superviseLeg({
    legId: "mtx-relay-republisher",
    encoderLabel: "copy",
    buildArgv: () => [
      "-hide_banner", "-loglevel", "warning", "-stats",
      "-re", "-i", sourceFile,
      "-c", "copy",
      "-f", "flv", tapUrl,
    ],
    restartPolicy: { maxRestartsPerHour: 5, backoffInitialMs: 2000, backoffMaxMs: 60000 },
  });
  await republisher.ready;

  console.log(`[mtx-relay-test] step 3: starting a separate -c copy reader on the republish...`);
  const copyReader = superviseLeg({
    legId: "mtx-relay-copy-reader",
    encoderLabel: "copy",
    buildArgv: () => buildCopyArgv(tapUrl, { kind: "local-file", path: copyFile }),
    restartPolicy: { maxRestartsPerHour: 5, backoffInitialMs: 2000, backoffMaxMs: 60000 },
  });
  await copyReader.ready;

  console.log(`[mtx-relay-test] capturing for ${DURATION_SEC + 3}s...`);
  await new Promise((resolve) => setTimeout(resolve, (DURATION_SEC + 3) * 1000));

  console.log(`[mtx-relay-test] shutting down...`);
  await copyReader.stop();
  await republisher.stop();
  stopRelayServer(relay);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`\n[mtx-relay-test] ground-truth PTS jitter, source file vs MediaMTX-relayed-then-copy-read:\n`);
  for (const [label, file] of [
    ["source file (no RTMP anywhere)", sourceFile],
    ["republished via MediaMTX, then -c copy read back", copyFile],
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
  console.log(
    `[mtx-relay-test] Interpretation: the republish step is a pure remux (-c copy) of an already-perfect ` +
      `file, no live encoder involved at all. If the relayed-then-copy-read file is elevated versus the ` +
      `source, MediaMTX's own publish/subscribe relay mechanism is the mechanism -- independent of encoding, ` +
      `live or otherwise.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`[mtx-relay-test] fatal error:`, err);
  process.exit(1);
});
