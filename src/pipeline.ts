import type { RootConfig } from "./config/schema.js";
import type { ResolvedDestinations } from "./config/load.js";
import { startRelayServer, stopRelayServer, type RelayServerHandle } from "./ingest/relayServer.js";
import { startCombinedRelay, buildCombinedEncodeArgv, type CombinedEncodeController } from "./ingest/decodeRelay.js";
import { buildCopyArgv, type RenditionEncodeTarget } from "./legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "./health/monitor.js";
import { createBroadcastArmState } from "./health/broadcastArm.js";
import { groupLegsByRendition, buildRenditionUrl } from "./rendition/group.js";
import { resolveOutputPath } from "./destinations/localFileDestination.js";
import { resolveRtmpDestination } from "./destinations/rtmpDestination.js";
import { loadProbedCeiling, NvencSessionTracker, selectEncoder, isNvencEncoder } from "./nvenc/sessionTracker.js";

/** A managed leg's recreate-on-demand descriptor, so a manual restart doesn't need the whole pipeline rebuilt. */
interface Managed {
  id: string;
  /** "rtmp-push" legs are gated behind the broadcast arm switch (see below); "relay" and "local-file" are not. */
  type: "relay" | "rtmp-push" | "local-file";
  encoderLabel: string;
  buildArgv: () => string[];
  supervisor: LegSupervisor;
}

/** A placeholder for an rtmp-push leg that hasn't been manually gone-live yet — reports "stopped", owns no real process. */
function stagedSupervisor(legId: string): LegSupervisor {
  return {
    legId,
    getState: () => "stopped",
    ready: Promise.resolve(),
    stop: async () => {},
  };
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
  /**
   * Stops (if running) and respawns a fresh supervised process for a leg or
   * the combined encode process by id — e.g. a manual dashboard "restart"
   * action. For an "rtmp-push" leg, this is also how it goes live for the
   * first time (it starts staged/stopped at boot regardless of
   * `enabled: true` — see startPipeline) and requires the broadcast arm
   * switch to be on, since it's the one action that actually sends real
   * data to a real external platform.
   */
  restartManaged(id: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Whether the broadcast arm switch (the gate in front of every real destination platform) is currently on. */
  isArmed(): boolean;
  /** Turns the broadcast arm switch on. Does not itself start any leg — legs still need an explicit restart/go-live action. */
  arm(): void;
  /** Turns the broadcast arm switch off AND immediately stops every currently-running rtmp-push leg (a kill switch, not just a future-start block). Returns the ids actually stopped. */
  disarm(): Promise<string[]>;
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

  const broadcastArm = createBroadcastArmState();
  const legIds: string[] = [];
  const managedById = new Map<string, Managed>();
  managedById.set("relay", {
    id: "relay",
    type: "relay",
    encoderLabel: config.relay.encoder,
    buildArgv: () => buildCombinedEncodeArgv(config, renditionTargets),
    supervisor: combinedEncode,
  });

  let stagedBroadcastLegCount = 0;
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
      // rtmp-push legs are a real broadcast to a real external platform —
      // they do NOT auto-start here even if enabled:true. They stay staged
      // until a manual "go live" (restartManaged) action, which itself
      // requires the broadcast arm switch to be on. local-file legs have no
      // external side effect, so they auto-start as before.
      let legSupervisor: LegSupervisor;
      if (leg.type === "rtmp-push") {
        stagedBroadcastLegCount++;
        legSupervisor = stagedSupervisor(leg.id);
      } else {
        legSupervisor = superviseLeg({ legId: leg.id, encoderLabel: "copy", buildArgv, restartPolicy: config.restartPolicy });
      }
      managedById.set(leg.id, { id: leg.id, type: leg.type, encoderLabel: "copy", buildArgv, supervisor: legSupervisor });
      legIds.push(leg.id);
    }
  }

  if (stagedBroadcastLegCount > 0) {
    console.log(
      `[oneencode] ${stagedBroadcastLegCount} rtmp-push leg(s) staged but NOT started — broadcast is disarmed. ` +
        `Arm via the dashboard/API, then restart/go-live each leg to actually start pushing.`,
    );
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
      if (managed.type === "rtmp-push" && !broadcastArm.isArmed()) {
        throw new Error(
          `Broadcast is not armed — leg "${id}" pushes to a real external platform. Arm broadcasting first, then go live.`,
        );
      }
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
    isArmed: () => broadcastArm.isArmed(),
    arm: () => broadcastArm.arm(),
    disarm: async () => {
      broadcastArm.disarm();
      const stopped: string[] = [];
      for (const [id, managed] of managedById) {
        if (managed.type === "rtmp-push" && managed.supervisor.getState() !== "stopped") {
          await managed.supervisor.stop();
          stopped.push(id);
        }
      }
      return stopped;
    },
  };
}
