import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config/load.js";
import { startRelayServer, stopRelayServer } from "../src/ingest/relayServer.js";
import { startDecodeRelay } from "../src/ingest/decodeRelay.js";
import { startRenditionEncode } from "../src/rendition/renditionProcess.js";
import { buildRenditionUrl } from "../src/rendition/group.js";
import { buildCopyArgv } from "../src/legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "../src/health/monitor.js";

/**
 * Root-cause isolation for task #24 (rendition-dedup jitter regression).
 *
 * Prior investigation confirmed the regression is real (baseline PTS CoV
 * ~0.00 vs this design's ~0.074) and ruled out two candidate fixes
 * (nobuffer/low_delay, MediaMTX writeQueueSize) without finding the actual
 * cause. This script isolates WHICH hop introduces the jitter by tapping
 * (`-c copy`, zero extra decode/encode) the live stream at each of the
 * three stages simultaneously:
 *
 *   1. ingest  — the raw source, straight off MediaMTX (0 encode hops)
 *   2. relay   — after the single decode/relay re-encode (1 encode hop)
 *   3. rendition — after the rendition's own re-encode of the relay (2 encode hops)
 *
 * Each tap is a pure remux (no decode/re-encode of its own), so its
 * recorded PTS spacing reflects exactly what arrived at that hop — no tap
 * introduces its own jitter. Comparing ground-truth ptsJitter.py CoV
 * across the three pinpoints whether jitter appears at hop 1 (the relay's
 * own live re-encode already isn't isochronous) or only at hop 2 (re-
 * encoding an already-live-relayed stream is what compounds it), rather
 * than continuing to guess between architecture-wide theories.
 *
 * Usage: npm run investigate:jitter
 * Requires config/legs.local.yaml to have at least one rendition (uses the
 * first one). Self-contained — spawns its own synthetic source, no need to
 * run gen:testsource separately first.
 */

const CAPTURE_SECONDS = 40;
const RECORDINGS_DIR = path.resolve(process.cwd(), "recordings");

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const { config } = loadConfig();
  const rendition = config.renditions[0];
  if (!rendition) throw new Error("config/legs.local.yaml has no renditions to test against");

  console.log(`[jitter-hop-isolation] using rendition "${rendition.id}" for the rendition-stage tap`);
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

  console.log(`[jitter-hop-isolation] starting relay server...`);
  const relay = startRelayServer();
  await relay.ready;

  console.log(`[jitter-hop-isolation] starting synthetic source...`);
  const source = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "warning",
      "-re",
      "-f", "lavfi", "-i", "testsrc2=size=2560x1440:rate=60",
      "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
      "-t", String(CAPTURE_SECONDS + 30),
      "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "20000k", "-g", "120",
      "-c:a", "aac", "-b:a", "192k",
      "-f", "flv", config.ingest.listenUrl,
    ],
    { windowsHide: true, stdio: "ignore" },
  );

  console.log(`[jitter-hop-isolation] starting decode/relay (hop 1)...`);
  const decodeRelay = startDecodeRelay(config);
  await decodeRelay.ready;

  console.log(`[jitter-hop-isolation] starting rendition encode "${rendition.id}" (hop 2)...`);
  const renditionEncode = startRenditionEncode(config, rendition, rendition.encoderPreference[0]);
  await renditionEncode.ready;

  const renditionUrl = buildRenditionUrl(config.relay.url, rendition.id);
  const stamp = ts();
  const files = {
    ingest: path.join(RECORDINGS_DIR, `hop-ingest_${stamp}.mp4`),
    relay: path.join(RECORDINGS_DIR, `hop-relay_${stamp}.mp4`),
    rendition: path.join(RECORDINGS_DIR, `hop-rendition_${stamp}.mp4`),
  };

  console.log(`[jitter-hop-isolation] starting 3 zero-encode capture taps...`);
  const taps: Record<string, LegSupervisor> = {
    ingest: superviseLeg({
      legId: "tap-ingest",
      encoderLabel: "copy",
      buildArgv: () => buildCopyArgv(config.ingest.listenUrl, { kind: "local-file", path: files.ingest }),
      restartPolicy: config.restartPolicy,
    }),
    relay: superviseLeg({
      legId: "tap-relay",
      encoderLabel: "copy",
      buildArgv: () => buildCopyArgv(config.relay.url, { kind: "local-file", path: files.relay }),
      restartPolicy: config.restartPolicy,
    }),
    rendition: superviseLeg({
      legId: "tap-rendition",
      encoderLabel: "copy",
      buildArgv: () => buildCopyArgv(renditionUrl, { kind: "local-file", path: files.rendition }),
      restartPolicy: config.restartPolicy,
    }),
  };
  await Promise.all(Object.values(taps).map((t) => t.ready));

  console.log(`[jitter-hop-isolation] all taps live — capturing for ${CAPTURE_SECONDS}s...`);
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_SECONDS * 1000));

  console.log(`[jitter-hop-isolation] capture window done — shutting down (taps first, then upstream)...`);
  await Promise.all(Object.values(taps).map((t) => t.stop()));
  await renditionEncode.stop();
  await decodeRelay.stop();
  source.kill();
  stopRelayServer(relay);

  // Give ffmpeg's "q" shutdown a moment to fully flush the mp4 moov atom
  // before ffprobe reads it.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`\n[jitter-hop-isolation] ground-truth PTS jitter by hop (lower CoV = steadier delivery):\n`);
  const stageOrder: Array<[string, string]> = [
    ["ingest (0 encode hops — raw source)", files.ingest],
    ["relay (1 encode hop — decode/relay re-encode)", files.relay],
    ["rendition (2 encode hops — re-encode of the relay)", files.rendition],
  ];
  for (const [label, file] of stageOrder) {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      console.log(`${label}: NO OUTPUT FILE — capture likely failed, check logs`);
      continue;
    }
    try {
      const ptsCsv = execFileSync("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "frame=pts_time",
        "-of", "csv=p=0",
        file,
      ]).toString();
      const ptsFile = file.replace(/\.mp4$/, ".pts.txt");
      fs.writeFileSync(ptsFile, ptsCsv);
      const result = execFileSync("python", [path.resolve(process.cwd(), "scripts/ptsJitter.py"), ptsFile]).toString().trim();
      console.log(`${label}:\n  ${result}\n`);
    } catch (err) {
      console.log(`${label}: analysis failed — ${(err as Error).message}`);
    }
  }
  console.log(
    `[jitter-hop-isolation] Interpretation: if "relay" CoV is already close to "rendition" CoV, the ` +
      `single decode/relay hop's own live re-encode is the root cause (not rendition-dedup specifically). ` +
      `If "relay" stays near "ingest" (clean) and only "rendition" jumps, re-encoding an already-live-relayed ` +
      `stream is what compounds the jitter — pinning it on rendition-dedup's extra encode hop specifically.`,
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(`[jitter-hop-isolation] fatal error:`, err);
  process.exit(1);
});
