import { loadConfig, ConfigError } from "./config/load.js";
import { logEvent } from "./logging/logger.js";
import { startRelayServer, stopRelayServer, type RelayServerHandle } from "./ingest/relayServer.js";
import { startDecodeRelay, type DecodeRelayController } from "./ingest/decodeRelay.js";
import { buildLegArgv } from "./legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "./health/monitor.js";
import { resolveOutputPath } from "./destinations/localFileDestination.js";
import { resolveRtmpDestination } from "./destinations/rtmpDestination.js";

/**
 * Orchestrator entrypoint: spawn the relay + decode/relay + every enabled
 * leg (each fully supervised — restart with backoff, watchdog, rolling-hour
 * failure cap, see health/monitor.ts), log stats, and shut everything down
 * cleanly on Ctrl+C.
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

  const legSupervisors: LegSupervisor[] = [];
  for (const leg of config.legs) {
    if (!leg.enabled) continue;

    const encoder = leg.encoderPreference[0];
    // buildArgv is re-invoked on every (re)start, not precomputed once — a
    // local-file leg needs a fresh timestamped output path per attempt so a
    // restart doesn't reopen/overwrite a prior partial file.
    const buildArgv = () =>
      leg.type === "local-file"
        ? buildLegArgv({ leg, relayUrl: config.relay.url, encoder, resolvedOutputPath: resolveOutputPath(leg) })
        : buildLegArgv({
            leg,
            relayUrl: config.relay.url,
            encoder,
            destinationUrl: resolveRtmpDestination(leg, destinations),
          });

    legSupervisors.push(
      superviseLeg({ legId: leg.id, encoderLabel: encoder, buildArgv, restartPolicy: config.restartPolicy }),
    );
  }

  console.log(`[oneencode] ${legSupervisors.length} leg(s) starting. Press Ctrl+C to stop.`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[oneencode] shutting down...`);
    await Promise.all(legSupervisors.map((s) => s.stop()));
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
