import type { RootConfig } from "./config/schema.js";
import type { ResolvedDestinations } from "./config/load.js";
import { startRelayServer, stopRelayServer, type RelayServerHandle } from "./ingest/relayServer.js";
import { startDecodeRelay, type DecodeRelayController } from "./ingest/decodeRelay.js";
import { buildCopyArgv } from "./legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "./health/monitor.js";
import { groupLegsByRendition, buildRenditionUrl } from "./rendition/group.js";
import { startRenditionEncode, buildRenditionEncodeArgv } from "./rendition/renditionProcess.js";
import { resolveOutputPath } from "./destinations/localFileDestination.js";
import { resolveRtmpDestination } from "./destinations/rtmpDestination.js";
import { loadProbedCeiling, NvencSessionTracker, selectEncoder, isNvencEncoder } from "./nvenc/sessionTracker.js";

/** A leg's or rendition's recreate-on-demand descriptor, so a manual restart doesn't need the whole pipeline rebuilt. */
interface Managed {
  id: string;
  encoderLabel: string;
  buildArgv: () => string[];
  supervisor: LegSupervisor;
}

export interface RunningPipeline {
  relay: RelayServerHandle;
  decodeRelay: DecodeRelayController;
  /** Destination leg ids (the stream-copy processes), for callers that want per-leg stats analysis (e.g. benchmark scripts). */
  legIds: string[];
  /** Rendition-encode process ids ("rendition-<id>"), same purpose as legIds above. */
  renditionLegIds: string[];
  /** legId -> live supervisor, for callers (e.g. the dashboard) that need to look up a specific leg's current state. */
  legSupervisorsById: Map<string, LegSupervisor>;
  /** "rendition-<id>" -> live supervisor, same purpose as legSupervisorsById above. */
  renditionSupervisorsById: Map<string, LegSupervisor>;
  config: RootConfig;
  /** Stops a leg or rendition-encode by id without restarting it. */
  stopManaged(id: string): Promise<void>;
  /** Stops (if running) and respawns a fresh supervised process for a leg or rendition-encode by id — e.g. a manual dashboard "restart" action. */
  restartManaged(id: string): Promise<void>;
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
  const legIds: string[] = [];
  const renditionLegIds: string[] = [];
  const managedById = new Map<string, Managed>();

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
    const renditionLegId = `rendition-${renditionId}`;
    // Re-selecting the encoder on every (re)spawn would double-reserve
    // NVENC tracker slots across manual restarts — the tracker's
    // reservation lifetime is intentionally scoped to startup only (see
    // CLAUDE.md architecture decision #4's noted simplification), so a
    // manual restart rebuilds the same argv with the originally-selected
    // encoder rather than re-running selection.
    const renditionBuildArgv = () => buildRenditionEncodeArgv(config, rendition, encoder);
    const renditionSupervisor = startRenditionEncode(config, rendition, encoder);
    managedById.set(renditionLegId, {
      id: renditionLegId,
      encoderLabel: encoder,
      buildArgv: renditionBuildArgv,
      supervisor: renditionSupervisor,
    });
    renditionLegIds.push(renditionLegId);

    const renditionUrl = buildRenditionUrl(config.relay.url, renditionId);
    for (const leg of legsForRendition) {
      const buildArgv = () => {
        const output =
          leg.type === "local-file"
            ? ({ kind: "local-file", path: resolveOutputPath(leg) } as const)
            : ({ kind: "rtmp", url: resolveRtmpDestination(leg, destinations) } as const);
        return buildCopyArgv(renditionUrl, output);
      };
      const legSupervisor = superviseLeg({
        legId: leg.id,
        encoderLabel: "copy",
        buildArgv,
        restartPolicy: config.restartPolicy,
      });
      managedById.set(leg.id, { id: leg.id, encoderLabel: "copy", buildArgv, supervisor: legSupervisor });
      legIds.push(leg.id);
    }
  }

  console.log(`[oneencode] ${renditionLegIds.length} rendition(s), ${legIds.length} leg(s) starting.`);

  function asMap(ids: string[]): Map<string, LegSupervisor> {
    return new Map(ids.map((id) => [id, managedById.get(id)!.supervisor]));
  }

  return {
    relay,
    decodeRelay,
    legIds,
    renditionLegIds,
    get legSupervisorsById() {
      return asMap(legIds);
    },
    get renditionSupervisorsById() {
      return asMap(renditionLegIds);
    },
    config,
    stopManaged: async (id: string) => {
      const managed = managedById.get(id);
      if (!managed) throw new Error(`No managed leg/rendition with id "${id}"`);
      await managed.supervisor.stop();
    },
    restartManaged: async (id: string) => {
      const managed = managedById.get(id);
      if (!managed) throw new Error(`No managed leg/rendition with id "${id}"`);
      await managed.supervisor.stop();
      const fresh = superviseLeg({
        legId: managed.id,
        encoderLabel: managed.encoderLabel,
        buildArgv: managed.buildArgv,
        restartPolicy: config.restartPolicy,
      });
      managedById.set(id, { ...managed, supervisor: fresh });
    },
    stopAll: async () => {
      await Promise.all(legIds.map((id) => managedById.get(id)!.supervisor.stop()));
      await Promise.all(renditionLegIds.map((id) => managedById.get(id)!.supervisor.stop()));
      await decodeRelay.stop();
      stopRelayServer(relay);
    },
  };
}
