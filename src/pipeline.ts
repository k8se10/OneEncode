import type { RootConfig } from "./config/schema.js";
import type { ResolvedDestinations } from "./config/load.js";
import { planReconciliation } from "./config/reconcile.js";
import { startRelayServer, stopRelayServer, type RelayServerHandle } from "./ingest/relayServer.js";
import { startCombinedRelay, buildCombinedEncodeArgv, type CombinedEncodeController } from "./ingest/decodeRelay.js";
import { buildCopyArgv, type RenditionEncodeTarget } from "./legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "./health/monitor.js";
import { createBroadcastArmState } from "./health/broadcastArm.js";
import { groupLegsByRendition, buildRenditionUrl } from "./rendition/group.js";
import { resolveOutputPath } from "./destinations/localFileDestination.js";
import { resolveRtmpDestination } from "./destinations/rtmpDestination.js";
import { loadProbedCeiling, NvencSessionTracker, selectEncoder } from "./nvenc/sessionTracker.js";
import { probeDecodeHwaccel } from "./nvenc/decodeHwaccelProbe.js";
import type { LegConfig } from "./config/schema.js";

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

/** Resolves `relay.decodeHwaccel`'s "auto" (the default) into a real, probed boolean — see the field's own schema comment. */
async function resolveDecodeHwaccel(setting: RootConfig["relay"]["decodeHwaccel"]): Promise<boolean> {
  if (setting !== "auto") return setting;
  const available = await probeDecodeHwaccel();
  console.log(
    `[oneencode] GPU decode (NVDEC) auto-detected: ${
      available ? "available -- enabling GPU-side decode/scale" : "not available -- using software decode"
    }`,
  );
  return available;
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
  /**
   * Hot-reload: applies a freshly-validated config (and its freshly-
   * resolved secrets) to the already-running pipeline, restarting only what
   * actually needs it (see config/reconcile.ts's planReconciliation for the
   * config-diff rules; an rtmp-push leg whose *resolved secret value*
   * changed — e.g. a rotated stream key in secrets.local.yaml, with the
   * leg's own config fields otherwise unchanged — is also treated as
   * needing a rebuild, since planReconciliation alone can't see secret
   * values). Never auto-starts an rtmp-push leg — a newly-added or edited
   * rtmp-push leg always lands staged, same as at initial startup,
   * requiring an explicit arm+go-live regardless of whether broadcast is
   * currently armed. Returns a summary for logging.
   */
  reconcile(newConfig: RootConfig, newDestinations: ResolvedDestinations): Promise<ReconcileSummary>;
}

export interface ReconcileSummary {
  restartedCombinedProcess: boolean;
  restartCombinedReason?: string;
  legsAdded: string[];
  legsRemoved: string[];
  legsRestarted: string[];
  noChanges: boolean;
}

/**
 * Groups config.legs by rendition and resolves each unique rendition's
 * actual encoder via a FRESH NvencSessionTracker (starting at 0 — correct
 * both at initial startup and after a combined-process rebuild, since the
 * old process's own NVENC sessions are always stopped first/around the
 * same time, freeing them). Shared by startPipeline (initial build) and
 * reconcile() (hot-reload combined-process rebuild) so both paths make the
 * exact same encoder-selection decision from the same config.
 */
function computeRenditionTargets(config: RootConfig): RenditionEncodeTarget[] {
  const { ceiling: nvencCeiling } = loadProbedCeiling();
  const nvencTracker = new NvencSessionTracker(nvencCeiling);
  const legsByRendition = groupLegsByRendition(config.legs);
  const renditionTargets: RenditionEncodeTarget[] = [];
  for (const [renditionId, legsForRendition] of legsByRendition) {
    const rendition = config.renditions.find((r) => r.id === renditionId);
    if (!rendition) {
      // Unreachable — schema validation already rejects a leg referencing an unknown renditionId.
      throw new Error(`Internal error: no rendition found for id "${renditionId}"`);
    }
    const encoder = selectEncoder(`rendition-${renditionId}`, rendition.encoderPreference, nvencTracker);
    console.log(
      `[oneencode] rendition "${renditionId}": ${legsForRendition.length} leg(s) sharing this encode ` +
        `(${legsForRendition.map((l) => l.id).join(", ")}), encoder ${encoder}`,
    );
    renditionTargets.push({ rendition, encoder, outputUrl: buildRenditionUrl(config.relay.url, renditionId) });
  }
  return renditionTargets;
}

/**
 * Builds a single leg's Managed descriptor (argv closure + supervisor).
 * rtmp-push legs always start staged — never auto-started, whether at
 * initial startup or added/changed later via reconcile() — see
 * RunningPipeline.reconcile's own doc comment for why this holds
 * regardless of the current broadcast-arm state. local-file legs have no
 * external side effect and always auto-start.
 */
function createLegManaged(
  leg: LegConfig,
  renditionUrl: string,
  destinations: ResolvedDestinations,
  restartPolicy: RootConfig["restartPolicy"],
): Managed {
  const buildArgv = () => {
    const output =
      leg.type === "local-file"
        ? ({ kind: "local-file", path: resolveOutputPath(leg) } as const)
        : ({ kind: "rtmp", url: resolveRtmpDestination(leg, destinations) } as const);
    return buildCopyArgv(renditionUrl, output);
  };
  const supervisor =
    leg.type === "rtmp-push"
      ? stagedSupervisor(leg.id)
      : superviseLeg({ legId: leg.id, encoderLabel: "copy", buildArgv, restartPolicy });
  return { id: leg.id, type: leg.type, encoderLabel: "copy", buildArgv, supervisor };
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

  // "auto" (the default) is resolved to a real, empirically-probed boolean
  // here, once, so nothing downstream (argv building, manual restarts via
  // buildArgv closures below, the RunningPipeline.config exposed to the
  // dashboard) needs to know "auto" exists at all -- they only ever see a
  // definite true/false. Never assumed from GPU vendor/name, same posture
  // as the NVENC session ceiling probe just below.
  const decodeHwaccel = await resolveDecodeHwaccel(config.relay.decodeHwaccel);
  config = { ...config, relay: { ...config.relay, decodeHwaccel } };

  // No reservation for config.relay.encoder here: the relay's own separate
  // mezzanine encode branch was removed 2026-08-13 (buildCombinedRelayAndRenditionsArgv's
  // own comment has the full story) — nothing consumes it anymore, so it no
  // longer runs and shouldn't claim an NVENC session slot for a branch that
  // doesn't exist.
  let renditionTargets = computeRenditionTargets(config);

  console.log(`[oneencode] starting combined decode/relay/rendition-encode process (pulling ${config.ingest.listenUrl})...`);
  let combinedEncode = startCombinedRelay(config, renditionTargets);
  await combinedEncode.ready;
  console.log(`[oneencode] combined encode is producing frames — starting destination legs`);

  const broadcastArm = createBroadcastArmState();
  let legIds: string[] = [];
  const managedById = new Map<string, Managed>();
  managedById.set("relay", {
    id: "relay",
    type: "relay",
    encoderLabel: config.relay.encoder,
    buildArgv: () => buildCombinedEncodeArgv(config, renditionTargets),
    supervisor: combinedEncode,
  });

  const legsByRendition = groupLegsByRendition(config.legs);
  let stagedBroadcastLegCount = 0;
  for (const [renditionId, legsForRendition] of legsByRendition) {
    const renditionUrl = buildRenditionUrl(config.relay.url, renditionId);
    for (const leg of legsForRendition) {
      // rtmp-push legs are a real broadcast to a real external platform —
      // they do NOT auto-start here even if enabled:true. They stay staged
      // until a manual "go live" (restartManaged) action, which itself
      // requires the broadcast arm switch to be on. local-file legs have no
      // external side effect, so they auto-start as before. See
      // createLegManaged.
      if (leg.type === "rtmp-push") stagedBroadcastLegCount++;
      managedById.set(leg.id, createLegManaged(leg, renditionUrl, destinations, config.restartPolicy));
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
    // Getters, not plain properties: reconcile() below can rebuild the
    // combined process (a new CombinedEncodeController instance), add/
    // remove legs (mutating legIds), and swap the running config — every
    // caller (dashboard, benchmark scripts) must always see the current
    // state, not a snapshot frozen at startPipeline's own return time.
    get combinedEncode() {
      return combinedEncode;
    },
    get legIds() {
      return legIds;
    },
    get legSupervisorsById() {
      return asMap(legIds);
    },
    get config() {
      return config;
    },
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
    reconcile: async (rawNewConfig: RootConfig, newDestinations: ResolvedDestinations): Promise<ReconcileSummary> => {
      // `config` (the running baseline) always has relay.decodeHwaccel
      // resolved to a definite boolean (see startPipeline above) — a freshly
      // loadConfig()'d file still has the raw "auto" from disk if the user
      // never set it explicitly. Comparing those directly would make EVERY
      // reload look like a relay-settings change (spurious combined-process
      // restart on every single edit, found via live testing). Resolve the
      // same way startPipeline does before the diff ever sees it — but only
      // actually re-run the ~250ms probe when something that could change
      // its answer is different (an explicit true/false, or some other
      // relay field changed and a rebuild is happening anyway); otherwise
      // reuse the already-resolved value from the running config, since GPU
      // capability doesn't change between one reload and the next.
      const { decodeHwaccel: rawDecodeHwaccel, ...rawRelayRest } = rawNewConfig.relay;
      const { decodeHwaccel: _currentDecodeHwaccel, ...currentRelayRest } = config.relay;
      const otherRelayFieldsChanged = JSON.stringify(rawRelayRest) !== JSON.stringify(currentRelayRest);
      const decodeHwaccel =
        rawDecodeHwaccel !== "auto"
          ? rawDecodeHwaccel
          : otherRelayFieldsChanged
            ? await resolveDecodeHwaccel("auto")
            : config.relay.decodeHwaccel;
      const newConfig: RootConfig = { ...rawNewConfig, relay: { ...rawNewConfig.relay, decodeHwaccel } };

      const plan = planReconciliation(config, newConfig);

      // planReconciliation only ever sees LegConfig objects, which never
      // contain a secret value (just the destinationUrlEnv NAME) -- so a
      // rotated stream key with the leg's own config fields unchanged is
      // invisible to it. Detect that here by comparing resolved URLs
      // directly (never logged -- only the leg id), for legs present in
      // both old and new (an add/remove already covers those) and not
      // already flagged by the config diff.
      const alreadyRestarting = new Set(plan.legsToRestart.map((l) => l.id));
      const addedOrRemoved = new Set([...plan.legsToAdd.map((l) => l.id), ...plan.legsToRemove]);
      const secretChangedLegs = newConfig.legs.filter((leg) => {
        if (leg.type !== "rtmp-push" || addedOrRemoved.has(leg.id) || alreadyRestarting.has(leg.id)) return false;
        return destinations.rtmpUrlByLegId.get(leg.id) !== newDestinations.rtmpUrlByLegId.get(leg.id);
      });
      const legsToRestart = [...plan.legsToRestart, ...secretChangedLegs];
      const noChanges = plan.noChanges && secretChangedLegs.length === 0;

      if (noChanges) {
        console.log(`[oneencode] config reload: no actionable changes`);
        return { restartedCombinedProcess: false, legsAdded: [], legsRemoved: [], legsRestarted: [], noChanges: true };
      }

      if (plan.restartCombinedProcess) {
        console.log(`[oneencode] config reload: restarting combined encode process (${plan.restartCombinedReason})`);
        await managedById.get("relay")!.supervisor.stop();
        renditionTargets = computeRenditionTargets(newConfig);
        combinedEncode = startCombinedRelay(newConfig, renditionTargets);
        await combinedEncode.ready;
        managedById.set("relay", {
          id: "relay",
          type: "relay",
          encoderLabel: newConfig.relay.encoder,
          buildArgv: () => buildCombinedEncodeArgv(newConfig, renditionTargets),
          supervisor: combinedEncode,
        });
      }

      for (const id of plan.legsToRemove) {
        console.log(`[oneencode] config reload: removing leg "${id}"`);
        await managedById.get(id)!.supervisor.stop();
        managedById.delete(id);
        legIds = legIds.filter((existing) => existing !== id);
      }

      for (const leg of plan.legsToAdd) {
        console.log(`[oneencode] config reload: adding leg "${leg.id}"${leg.type === "rtmp-push" ? " (staged — arm + go live to start pushing)" : ""}`);
        const renditionUrl = buildRenditionUrl(newConfig.relay.url, leg.renditionId);
        managedById.set(leg.id, createLegManaged(leg, renditionUrl, newDestinations, newConfig.restartPolicy));
        legIds.push(leg.id);
      }

      for (const leg of legsToRestart) {
        // A changed rtmp-push leg always lands staged again, even if it was
        // live before the edit — never auto-restart a real broadcast just
        // because its config (or its resolved secret) changed underneath
        // it. A changed local-file leg restarts immediately; it has no
        // external side effect.
        console.log(`[oneencode] config reload: rebuilding leg "${leg.id}"${leg.type === "rtmp-push" ? " (staged — arm + go live to resume pushing)" : ""}`);
        await managedById.get(leg.id)!.supervisor.stop();
        const renditionUrl = buildRenditionUrl(newConfig.relay.url, leg.renditionId);
        managedById.set(leg.id, createLegManaged(leg, renditionUrl, newDestinations, newConfig.restartPolicy));
      }

      config = newConfig;
      destinations = newDestinations;
      return {
        restartedCombinedProcess: plan.restartCombinedProcess,
        restartCombinedReason: plan.restartCombinedReason,
        legsAdded: plan.legsToAdd.map((l) => l.id),
        legsRemoved: plan.legsToRemove,
        legsRestarted: legsToRestart.map((l) => l.id),
        noChanges: false,
      };
    },
  };
}
