import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { loadConfig } from "../src/config/load.js";
import { startRelayServer, stopRelayServer } from "../src/ingest/relayServer.js";
import { superviseLeg } from "../src/health/monitor.js";
import { buildCopyArgv } from "../src/legs/argvBuilder.js";

/**
 * Follow-up to the live-verify finding (task #24): the combined
 * decode+relay+rendition process (scripts/jitterNoRtmpHopTest.ts) measured
 * CoV=0.0000 when its rendition branch wrote straight to a local file, but
 * the REAL pipeline still showed elevated CoV (~0.06-0.07) once that same
 * rendition branch instead published over RTMP and a separate leg process
 * read it back via `-c copy` -- which is structurally required for any
 * real deployment (a rendition needs to be readable by its leg(s)).
 *
 * This isolates whether the mechanism is "re-encoding an already-relayed
 * stream" (the original theory) or something more fundamental: any RTMP
 * publish/subscribe boundary between two separate processes, independent
 * of what fed the publish. Uses ffmpeg's `tee` muxer so a SINGLE,
 * already-proven-clean baseline-style encode (decode once, encode once,
 * same settings that measured CoV=0.0000 writing directly to a file)
 * writes to a local file AND publishes over RTMP from the exact same
 * encoded bitstream -- no second encode, no filter_complex split. A
 * separate process then reads that RTMP publish via `-c copy` into a
 * second file.
 *
 * If the direct file stays clean (CoV~0.0000, confirming nothing about the
 * encode itself changed) while the RTMP-then-copy file is elevated, that
 * proves the RTMP publish/subscribe boundary itself -- not re-encoding,
 * not generation count -- is the mechanism.
 */

const CAPTURE_SECONDS = 30;
const RECORDINGS_DIR = path.resolve(process.cwd(), "recordings");

async function main(): Promise<void> {
  const { config } = loadConfig();
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

  console.log(`[rtmp-mechanism-test] starting relay server...`);
  const relay = startRelayServer();
  await relay.ready;

  console.log(`[rtmp-mechanism-test] starting synthetic source...`);
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
  const tapUrl = `rtmp://127.0.0.1:1935/rtmp-mech-test/live`;
  const copyFile = path.join(RECORDINGS_DIR, `rtmp-mech-copy_${stamp}.mp4`);

  // No tee muxer (its RTMP leg didn't reliably connect in an earlier attempt
  // of this script — real friction, not worth fighting). These are the
  // exact settings that have measured CoV~0.0000 direct-to-file repeatedly
  // throughout this investigation (baseline, and jitterNoRtmpHopTest.ts's
  // branch B) — that number is the control this test compares against, no
  // need to re-derive it in the same run.
  console.log(`[rtmp-mechanism-test] starting a baseline-style encode, publishing ONLY to RTMP (no local file from this process)...`);
  const encoder = superviseLeg({
    legId: "rtmp-mech-encoder",
    encoderLabel: "h264_nvenc",
    buildArgv: () => [
      "-hide_banner", "-loglevel", "warning", "-stats",
      "-i", config.ingest.listenUrl,
      "-vf", "scale=1920:1080",
      "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "cbr",
      "-b:v", "6000k", "-maxrate", "6000k", "-bufsize", "12000k", "-g", "120", "-bf", "2",
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
      "-f", "flv", tapUrl,
    ],
    restartPolicy: config.restartPolicy,
  });
  await encoder.ready;

  console.log(`[rtmp-mechanism-test] starting a separate -c copy process reading the RTMP publish...`);
  const copyReader = superviseLeg({
    legId: "rtmp-mech-copy-reader",
    encoderLabel: "copy",
    buildArgv: () => buildCopyArgv(tapUrl, { kind: "local-file", path: copyFile }),
    restartPolicy: config.restartPolicy,
  });
  await copyReader.ready;

  console.log(`[rtmp-mechanism-test] capturing for ${CAPTURE_SECONDS}s...`);
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_SECONDS * 1000));

  console.log(`[rtmp-mechanism-test] shutting down...`);
  await copyReader.stop();
  await encoder.stop();
  source.kill();
  stopRelayServer(relay);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`\n[rtmp-mechanism-test] ground-truth PTS jitter, RTMP-published-then-copy-read (compare to the well-established ~0.0000 direct-to-file control):\n`);
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
    `\n[rtmp-mechanism-test] Interpretation: this is the SAME encode settings that repeatedly measured ` +
      `CoV~0.0000 direct-to-file elsewhere in this investigation. If this run is elevated instead, the RTMP ` +
      `publish/subscribe boundary itself is the mechanism -- independent of re-encoding or generation count.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`[rtmp-mechanism-test] fatal error:`, err);
  process.exit(1);
});
