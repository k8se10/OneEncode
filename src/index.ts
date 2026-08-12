import { loadConfig, ConfigError } from "./config/load.js";
import { logEvent } from "./logging/logger.js";
import { startRelayServer, stopRelayServer, type RelayServerHandle } from "./ingest/relayServer.js";
import { startDecodeRelay, type DecodeRelayController } from "./ingest/decodeRelay.js";
import { buildLegArgv } from "./legs/argvBuilder.js";
import { spawnLegWithRetry, type RetryingLegController } from "./legs/legProcess.js";
import { resolveOutputPath } from "./destinations/localFileDestination.js";
import { resolveRtmpDestination } from "./destinations/rtmpDestination.js";

/**
 * Phase 1 minimal orchestrator: spawn the relay + decode/relay + every
 * enabled leg, log stats, and shut everything down cleanly on Ctrl+C.
 *
 * No restart/backoff/health state machine yet — that's Phase 4
 * (src/health/monitor.ts, not built yet). This exists purely to prove the
 * single-decode/multi-leg mechanism and produce real drop=/dup= numbers to
 * compare against the naive baseline (scripts/benchBaseline.ts).
 */
async function main(): Promise<void> {
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logEvent({ event: "config_validation_error", message: err.message });
      process.exit(1);
    }
    throw err;
  }
  const { config, destinations } = loaded;

  console.log(`[oneencode] starting relay server...`);
  const relay: RelayServerHandle = startRelayServer();
  await relay.ready;

  console.log(`[oneencode] starting decode/relay process (pulling ${config.ingest.listenUrl})...`);
  const decodeRelay: DecodeRelayController = startDecodeRelay(config);
  await decodeRelay.ready;
  console.log(`[oneencode] decode/relay is producing frames — starting destination legs`);

  const legControllers: RetryingLegController[] = [];
  for (const leg of config.legs) {
    if (!leg.enabled) continue;

    const encoder = leg.encoderPreference[0];
    const argv =
      leg.type === "local-file"
        ? buildLegArgv({ leg, relayUrl: config.relay.url, encoder, resolvedOutputPath: resolveOutputPath(leg) })
        : buildLegArgv({
            leg,
            relayUrl: config.relay.url,
            encoder,
            destinationUrl: resolveRtmpDestination(leg, destinations),
          });

    // spawnLegWithRetry (not a bare spawn) — a leg can otherwise lose the
    // startup race against the decode/relay process's own publish becoming
    // visible to MediaMTX, confirmed live during Phase 1 testing.
    legControllers.push(spawnLegWithRetry(leg.id, argv, encoder));
  }

  console.log(`[oneencode] ${legControllers.length} leg(s) starting. Press Ctrl+C to stop.`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[oneencode] shutting down...`);
    await Promise.all(legControllers.map((c) => c.stop()));
    await decodeRelay.stop();
    stopRelayServer(relay);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[oneencode] fatal error:`, err);
  process.exit(1);
});
