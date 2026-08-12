import type { RootConfig } from "./config/schema.js";
import type { ResolvedDestinations } from "./config/load.js";
import { startRelayServer, stopRelayServer, type RelayServerHandle } from "./ingest/relayServer.js";
import { startDecodeRelay, type DecodeRelayController } from "./ingest/decodeRelay.js";
import { buildCopyArgv } from "./legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "./health/monitor.js";
import { groupLegsByRendition, buildRenditionUrl } from "./rendition/group.js";
import { startRenditionEncode } from "./rendition/renditionProcess.js";
import { resolveOutputPath } from "./destinations/localFileDestination.js";
import { resolveRtmpDestination } from "./destinations/rtmpDestination.js";
import { loadProbedCeiling, NvencSessionTracker, selectEncoder, isNvencEncoder } from "./nvenc/sessionTracker.js";

export interface RunningPipeline {
  relay: RelayServerHandle;
  decodeRelay: DecodeRelayController;
  renditionSupervisors: LegSupervisor[];
  legSupervisors: LegSupervisor[];
  /** Destination leg ids (the stream-copy processes), for callers that want per-leg stats analysis (e.g. benchmark scripts). */
  legIds: string[];
  /** Rendition-encode process ids ("rendition-<id>"), same purpose as legIds above. */
  renditionLegIds: string[];
  stopAll(): Promise<void>;
}

/**
 * Builds and starts the full two-stage pipeline: relay server, decode/relay
 * process, one supervised encode per unique rendition actually referenced
 * by an enabled leg, and one supervised stream-copy process per leg. Shared
 * by src/index.ts (real operation) and scripts/benchOneEncode.ts (so the
 * benchmark exercises the exact same code path as production, not a
 * reimplementation of it).
 */
export async function startPipeline(config: RootConfig, destinations: ResolvedDestinations): Promise<RunningPipeline> {
  console.log(`[oneencode] starting relay server...`);
  const relay: RelayServerHandle = startRelayServer();
  await relay.ready;

  console.log(`[oneencode] starting decode/relay process (pulling ${config.ingest.listenUrl})...`);
  const decodeRelay: DecodeRelayController = startDecodeRelay(config);
  await decodeRelay.ready;
  console.log(`[oneencode] decode/relay is producing frames — starting renditions`);

  const { ceiling: nvencCeiling } = loadProbedCeiling();
  const nvencTracker = new NvencSessionTracker(nvencCeiling);
  if (isNvencEncoder(config.relay.encoder)) nvencTracker.reserve();

  const legsByRendition = groupLegsByRendition(config.legs);
  const renditionSupervisors: LegSupervisor[] = [];
  const legSupervisors: LegSupervisor[] = [];
  const legIds: string[] = [];
  const renditionLegIds: string[] = [];

  for (const [renditionId, legsForRendition] of legsByRendition) {
    const rendition = config.renditions.find((r) => r.id === renditionId);
    if (!rendition) {
      // Unreachable — the config loader's schema validation already rejects
      // a leg referencing an unknown renditionId before this ever runs.
      throw new Error(`Internal error: no rendition found for id "${renditionId}"`);
    }
    const encoder = selectEncoder(`rendition-${renditionId}`, rendition.encoderPreference, nvencTracker);
    console.log(
      `[oneencode] rendition "${renditionId}": ${legsForRendition.length} leg(s) sharing this encode ` +
        `(${legsForRendition.map((l) => l.id).join(", ")})`,
    );
    const renditionSupervisor = startRenditionEncode(config, rendition, encoder);
    renditionSupervisors.push(renditionSupervisor);
    renditionLegIds.push(`rendition-${renditionId}`);

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
      legIds.push(leg.id);
    }
  }

  console.log(`[oneencode] ${renditionSupervisors.length} rendition(s), ${legSupervisors.length} leg(s) starting.`);

  return {
    relay,
    decodeRelay,
    renditionSupervisors,
    legSupervisors,
    legIds,
    renditionLegIds,
    stopAll: async () => {
      await Promise.all(legSupervisors.map((s) => s.stop()));
      await Promise.all(renditionSupervisors.map((s) => s.stop()));
      await decodeRelay.stop();
      stopRelayServer(relay);
    },
  };
}
