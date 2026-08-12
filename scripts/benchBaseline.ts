import { loadConfig } from "../src/config/load.js";
import { startRelayServer, stopRelayServer } from "../src/ingest/relayServer.js";
import { buildEncodeArgv } from "../src/legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "../src/health/monitor.js";
import { resolveOutputPath } from "../src/destinations/localFileDestination.js";

/**
 * Baseline comparison for Phase 1 (see the implementation plan's exit
 * criteria): reproduces TODAY's naive approach — one independent ffmpeg
 * process per rendition, each pulling and decoding the SAME source
 * separately (config.ingest.listenUrl directly, NOT the single-decode
 * relay, and NOT the rendition-dedup path either — this deliberately
 * ignores dedup too, since the naive baseline never shared anything) — so
 * the drop=/dup= numbers can be directly compared against `npm start`'s
 * design under identical rendition definitions and identical source content.
 *
 * Usage: start MediaMTX + the synthetic test source first (or run this
 * against a real OBS source), then `npm run bench:baseline`.
 */
async function main(): Promise<void> {
  const { config } = loadConfig();

  console.log(`[bench-baseline] starting relay server (needed for the ingest listener only)...`);
  const relay = startRelayServer();
  await relay.ready;

  console.log(
    `[bench-baseline] spawning ${config.legs.filter((l) => l.enabled).length} INDEPENDENT ffmpeg ` +
      `processes, each decoding ${config.ingest.listenUrl} separately — this is today's naive approach.`,
  );

  const controllers: LegSupervisor[] = [];
  for (const leg of config.legs) {
    if (!leg.enabled) continue;
    if (leg.type !== "local-file") {
      console.log(`[bench-baseline] skipping non-local-file leg "${leg.id}" (baseline only compares local-file legs)`);
      continue;
    }
    const rendition = config.renditions.find((r) => r.id === leg.renditionId);
    if (!rendition) throw new Error(`No rendition "${leg.renditionId}" for leg "${leg.id}"`);
    const encoder = rendition.encoderPreference[0];
    // Deliberately points at the ORIGINAL ingest, not the relay — this is
    // the naive "N independent decodes of the same source" baseline.
    const buildArgv = () =>
      buildEncodeArgv(config.ingest.listenUrl, rendition, encoder, {
        kind: "local-file",
        path: resolveOutputPath({ ...leg, filenamePattern: `baseline_${leg.filenamePattern}` }),
      });
    controllers.push(
      superviseLeg({ legId: `baseline-${leg.id}`, encoderLabel: encoder, buildArgv, restartPolicy: config.restartPolicy }),
    );
  }

  console.log(`[bench-baseline] ${controllers.length} independent leg(s) starting. Press Ctrl+C to stop.`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[bench-baseline] shutting down...`);
    await Promise.all(controllers.map((c) => c.stop()));
    stopRelayServer(relay);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[bench-baseline] fatal error:`, err);
  process.exit(1);
});
