import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { loadConfig } from "../src/config/load.js";
import { startRelayServer, stopRelayServer } from "../src/ingest/relayServer.js";
import { superviseLeg } from "../src/health/monitor.js";
import { buildCopyArgv } from "../src/legs/argvBuilder.js";

/**
 * Follow-up to jitterRtmpMechanismTest.ts (task #24): confirmed a SINGLE
 * encode branch, published over RTMP and read back by one separate -c copy
 * process, has a real but modest jitter floor (CoV=0.0283) versus the
 * ~0.0000 direct-to-file control -- independent of re-encoding. But the
 * REAL combined-process pipeline (relay branch + rendition branch, both
 * NVENC, sharing one decode via filter_complex split, task #24's shipped
 * fix) measures roughly double that (~0.06-0.07) in live-verify runs.
 *
 * This isolates why: replicates the combined process's exact 2-branch
 * split (branch A: relay-style NVENC ull, branch B: rendition-style,
 * encoder configurable via argv) and measures branch B's RTMP-published,
 * copy-read output. Run once with branch B on NVENC (matching the shipped
 * design) and once with libx264, to see whether TWO simultaneous NVENC
 * sessions within the SAME ffmpeg process (not two separate processes --
 * that contention was already ruled out earlier in this investigation) is
 * what pushes jitter above the single-branch RTMP-hop floor.
 *
 * Usage: npx tsx scripts/jitterMultiBranchTest.ts [nvenc|libx264]
 */

const CAPTURE_SECONDS = 30;
const RECORDINGS_DIR = path.resolve(process.cwd(), "recordings");
const branchBEncoder = (process.argv[2] === "libx264" ? "libx264" : "nvenc") as "nvenc" | "libx264";
const branchAAlsoLibx264 = process.argv.includes("branchA-libx264");
const branchAToFile = process.argv.includes("branchA-tofile");

function branchBEncodeArgs(): string[] {
  if (branchBEncoder === "libx264") {
    return ["-c:v", "libx264", "-preset", "veryfast", "-b:v", "6000k", "-maxrate", "6000k", "-bufsize", "12000k", "-g", "120"];
  }
  return [
    "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "cbr",
    "-b:v", "6000k", "-maxrate", "6000k", "-bufsize", "12000k", "-g", "120", "-bf", "2",
  ];
}

async function main(): Promise<void> {
  const { config } = loadConfig();
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  console.log(`[multi-branch-test] branch B encoder under test: ${branchBEncoder}`);

  console.log(`[multi-branch-test] starting relay server...`);
  const relay = startRelayServer();
  await relay.ready;

  console.log(`[multi-branch-test] starting synthetic source...`);
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

  const relayUrl = "rtmp://127.0.0.1:1935/multibranch-test/relay";
  const renditionUrl = "rtmp://127.0.0.1:1935/multibranch-test/rendition";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const branchADirectFile = path.join(RECORDINGS_DIR, `multibranch-branchA-direct_${stamp}.mp4`);

  console.log(
    `[multi-branch-test] starting combined 2-branch process (decode once, split, branch A relay-style ` +
      `${branchAToFile ? "-> local file, no RTMP" : "NVENC ull -> RTMP"}, branch B rendition-style ${branchBEncoder} -> RTMP)...`,
  );
  const combined = superviseLeg({
    legId: "multibranch-combined",
    encoderLabel: "h264_nvenc",
    buildArgv: () => [
      "-hide_banner", "-loglevel", "warning", "-stats",
      "-i", config.ingest.listenUrl,
      "-filter_complex", "[0:v]split=2[va][vb];[vb]scale=1920:1080[vbs]",
      "-map", "[va]", "-map", "0:a",
      ...(branchAAlsoLibx264
        ? ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-b:v", "40000k", "-maxrate", "40000k", "-bufsize", "20000k", "-g", "60", "-bf", "0"]
        : ["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-rc", "cbr", "-b:v", "40000k", "-maxrate", "40000k", "-bufsize", "20000k", "-g", "60", "-bf", "0"]),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      ...(branchAToFile ? ["-movflags", "+faststart", branchADirectFile] : ["-f", "flv", relayUrl]),
      "-map", "[vbs]", "-map", "0:a",
      ...branchBEncodeArgs(),
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
      "-f", "flv", renditionUrl,
    ],
    restartPolicy: config.restartPolicy,
  });
  await combined.ready;

  const copyFile = path.join(RECORDINGS_DIR, `multibranch-${branchBEncoder}_${stamp}.mp4`);

  console.log(`[multi-branch-test] starting -c copy reader on branch B's rendition publish...`);
  const copyReader = superviseLeg({
    legId: "multibranch-copy-reader",
    encoderLabel: "copy",
    buildArgv: () => buildCopyArgv(renditionUrl, { kind: "local-file", path: copyFile }),
    restartPolicy: config.restartPolicy,
  });
  await copyReader.ready;

  console.log(`[multi-branch-test] capturing for ${CAPTURE_SECONDS}s...`);
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_SECONDS * 1000));

  console.log(`[multi-branch-test] shutting down...`);
  await copyReader.stop();
  await combined.stop();
  source.kill();
  stopRelayServer(relay);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`\n[multi-branch-test] ground-truth PTS jitter, branch B (${branchBEncoder}) of a 2-branch combined process:\n`);
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
    `\n[multi-branch-test] Compare to jitterRtmpMechanismTest.ts's single-branch floor (0.0283) and the ` +
      `real combined-process live-verify result (~0.06-0.07, NVENC+NVENC). If libx264 here comes back near ` +
      `the 0.0283 floor while nvenc stays elevated, two simultaneous NVENC sessions in one ffmpeg process is ` +
      `the mechanism pushing jitter above the single-branch RTMP-hop floor.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`[multi-branch-test] fatal error:`, err);
  process.exit(1);
});
