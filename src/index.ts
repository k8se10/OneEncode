import { loadConfig, ConfigError } from "./config/load.js";
import { logEvent } from "./logging/logger.js";
import { startRelayServer, stopRelayServer, type RelayServerHandle } from "./ingest/relayServer.js";
import { startDecodeRelay, type DecodeRelayController } from "./ingest/decodeRelay.js";
import { buildCopyArgv } from "./legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "./health/monitor.js";
import { groupLegsByRendition, buildRenditionUrl } from "./rendition/group.js";
import { startRenditionEncode } from "./rendition/renditionProcess.js";
import { resolveOutputPath } from "./destinations/localFileDestination.js";
import { resolveRtmpDestination } from "./destinations/rtmpDestination.js";

/**
 * Orchestrator entrypoint. Two-stage pipeline per CLAUDE.md architecture
 * decision #9: one supervised encode process per unique rendition actually
 * referenced by an enabled leg, then one supervised cheap stream-copy
 * process per leg reading from its rendition's relay path. Two legs sharing
 * a rendition therefore share one encode, not two.
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
  console.log(`[oneencode] decode/relay is producing frames — starting renditions`);

  const legsByRendition = groupLegsByRendition(config.legs);
  const renditionSupervisors: LegSupervisor[] = [];
  const legSupervisors: LegSupervisor[] = [];

  for (const [renditionId, legsForRendition] of legsByRendition) {
    const rendition = config.renditions.find((r) => r.id === renditionId);
    if (!rendition) {
      // Unreachable — the config loader's schema validation already rejects
      // a leg referencing an unknown renditionId before main() ever runs.
      throw new Error(`Internal error: no rendition found for id "${renditionId}"`);
    }
    const encoder = rendition.encoderPreference[0];
    console.log(
      `[oneencode] rendition "${renditionId}": ${legsForRendition.length} leg(s) sharing this encode ` +
        `(${legsForRendition.map((l) => l.id).join(", ")})`,
    );
    const renditionSupervisor = startRenditionEncode(config, rendition, encoder);
    renditionSupervisors.push(renditionSupervisor);

    const renditionUrl = buildRenditionUrl(config.relay.url, renditionId);
    for (const leg of legsForRendition) {
      const buildArgv = () => {
        const output =
          leg.type === "local-file"
            ? ({ kind: "local-file", path: resolveOutputPath(leg) } as const)
            : ({ kind: "rtmp", url: resolveRtmpDestination(leg, destinations) } as const);
        return buildCopyArgv(renditionUrl, output);
      };
      legSupervisors.push(
        superviseLeg({ legId: leg.id, encoderLabel: "copy", buildArgv, restartPolicy: config.restartPolicy }),
      );
    }
  }

  console.log(
    `[oneencode] ${renditionSupervisors.length} rendition(s), ${legSupervisors.length} leg(s) starting. Press Ctrl+C to stop.`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[oneencode] shutting down...`);
    await Promise.all(legSupervisors.map((s) => s.stop()));
    await Promise.all(renditionSupervisors.map((s) => s.stop()));
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
