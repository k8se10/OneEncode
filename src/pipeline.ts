import type { RootConfig } from "./config/schema.js";
import type { ResolvedDestinations } from "./config/load.js";
import { startRelayServer, stopRelayServer, type RelayServerHandle } from "./ingest/relayServer.js";
import { startCombinedRelay, buildCombinedEncodeArgv, type CombinedEncodeController } from "./ingest/decodeRelay.js";
import { buildCopyArgv, type RenditionEncodeTarget } from "./legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "./health/monitor.js";
import { groupLegsByRendition, buildRenditionUrl } from "./rendition/group.js";
import { resolveOutputPath } from "./destinations/localFileDestination.js";
import { resolveRtmpDestination } from "./destinations/rtmpDestination.js";
import { loadProbedCeiling, NvencSessionTracker, selectEncoder, isNvencEncoder } from "./nvenc/sessionTracker.js";

/** A managed leg's recreate-on-demand descriptor, so a manual restart doesn't need the whole pipeline rebuilt. */
interface Managed {
  id: string;
  encoderLabel: string;
  buildArgv: () => string[];
  supervisor: LegSupervisor;
}

export interface RunningPipeline {
  relay: RelayServerHandle;
  /**
   * The single combined process: decode-once, plus the relay's own
   * mezzanine re-encode, plus every unique rendition's encode — all from
   * that one decode (see argvBuilder.ts's buildCombinedRelayAndRenditionsArgv).
   * Stopping/restarting this affects the relay and every rendition
   * together; it's managed under id "relay" via stopManaged/restartManaged
   * below, same as before this was combined.
   */
  combinedEncode: CombinedEncodeController;
  /** Destination leg ids (the stream-copy processes), for callers that want per-leg stats analysis (e.g. benchmark scripts). */
  legIds: string[];
  /** legId -> live supervisor, for callers (e.g. the dashboard) that need to look up a specific leg's current state. */
  legSupervisorsById: Map<string, LegSupervisor>;
  config: RootConfig;
  /** Stops a leg or the combined encode process ("relay") by id without restarting it. */
  stopManaged(id: string): Promise<void>;
  /** Stops (if running) and respawns a fresh supervised process for a leg or the combined encode process by id — e.g. a manual dashboard "restart" action. */
  restartManaged(id: string): Promise<void>;
  stopAll(): Promise<void>;
}

/**
 * Builds and starts the full pipeline: relay server, the combined decode+
 * relay+rendition-encode process, and one supervised stream-copy process
 * per destination leg. Shared by src/index.ts (real operation) and
 * scripts/benchOneEncode.ts (so the benchmark exercises the exact same
 * code path as production, not a reimplementation of it).
 */
export async function startPipeline(config: RootConfig, destinations: ResolvedDestinations): Promise<RunningPipeline> {
  console.log(`[oneencode] starting relay server...`);
  const relay: RelayServerHandle = startRelayServer();
  await relay.ready;

  const { ceiling: nvencCeiling } = loadProbedCeiling();
  const nvencTracker = new NvencSessionTracker(nvencCeiling);
  if (isNvencEncoder(config.relay.encoder)) nvencTracker.reserve();

  const legsByRendition = groupLegsByRendition(config.legs);
  const renditionTargets: RenditionEncodeTarget[] = [];
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
        `(${legsForRendition.map((l) => l.id).join(", ")}), encoder ${encoder}`,
    );
    renditionTargets.push({ rendition, encoder, outputUrl: buildRenditionUrl(config.relay.url, renditionId) });
  }

  console.log(`[oneencode] starting combined decode/relay/rendition-encode process (pulling ${config.ingest.listenUrl})...`);
  const combinedEncode = startCombinedRelay(config, renditionTargets);
  await combinedEncode.ready;
  console.log(`[oneencode] combined encode is producing frames — starting destination legs`);

  const legIds: string[] = [];
  const managedById = new Map<string, Managed>();
  managedById.set("relay", {
    id: "relay",
    encoderLabel: config.relay.encoder,
    buildArgv: () => buildCombinedEncodeArgv(config, renditionTargets),
    supervisor: combinedEncode,
  });

  for (const [renditionId, legsForRendition] of legsByRendition) {
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

  console.log(`[oneencode] ${renditionTargets.length} rendition(s) inside the combined encode, ${legIds.length} leg(s) starting.`);

  function asMap(ids: string[]): Map<string, LegSupervisor> {
    return new Map(ids.map((id) => [id, managedById.get(id)!.supervisor]));
  }

  return {
    relay,
    combinedEncode,
    legIds,
    get legSupervisorsById() {
      return asMap(legIds);
    },
    config,
    stopManaged: async (id: string) => {
      const managed = managedById.get(id);
      if (!managed) throw new Error(`No managed leg/process with id "${id}"`);
      await managed.supervisor.stop();
    },
    restartManaged: async (id: string) => {
      const managed = managedById.get(id);
      if (!managed) throw new Error(`No managed leg/process with id "${id}"`);
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
      await managedById.get("relay")!.supervisor.stop();
      stopRelayServer(relay);
    },
  };
}
