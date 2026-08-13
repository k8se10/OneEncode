import { Router } from "express";
import type { RunningPipeline } from "../pipeline.js";
import type { LiveStateTracker } from "./liveState.js";
import { redactObject } from "../logging/redact.js";

/**
 * REST API for the local dashboard. V1 scope (documented, not silently
 * short of the original plan): live status/health monitoring and
 * start/stop/restart controls for already-configured legs and the shared
 * encode pipeline. Adding/editing/removing legs through the UI (full CRUD)
 * is NOT built yet — config changes still go through hand-editing
 * config/legs.local.yaml + an orchestrator restart, same as before this
 * dashboard existed. See CLAUDE.md architecture decision #8 for the full
 * scope note.
 */
export function createApiRouter(pipeline: RunningPipeline, liveState: LiveStateTracker): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    const snapshot = liveState.getSnapshot();

    const legs = pipeline.config.legs.map((leg) => {
      const supervisor = pipeline.legSupervisorsById.get(leg.id);
      return {
        ...redactObject(leg),
        state: supervisor?.getState() ?? "unknown",
        stats: snapshot.get(leg.id) ?? null,
      };
    });

    // Every rendition now shares ONE combined encode process with the relay
    // (see src/pipeline.ts, task #24) — there's no independent per-rendition
    // supervisor anymore, so `state` reflects that shared process for every
    // rendition. `stats` can't come from the combined process's own -stats
    // output either: ffmpeg reports one aggregate progress line for a
    // multi-output command, not one per branch. A rendition's first enabled
    // leg is an exact stand-in instead — it's a `-c copy` of that rendition's
    // real bytes, so its stats are that rendition's real delivered stats.
    const encodeState = pipeline.combinedEncode.getState();
    const renditions = pipeline.config.renditions.map((rendition) => {
      const legForRendition = pipeline.config.legs.find((leg) => leg.enabled && leg.renditionId === rendition.id);
      return {
        ...rendition, // renditions never contain secrets — resolution/fps/bitrate/codec only
        state: encodeState,
        stats: legForRendition ? (snapshot.get(legForRendition.id) ?? null) : null,
      };
    });

    res.json({ legs, renditions, encode: { state: encodeState }, broadcastArmed: pipeline.isArmed() });
  });

  // Broadcast arm switch: the gate in front of every rtmp-push leg (real
  // external platforms). Disarmed by default on every orchestrator start.
  router.get("/broadcast/armed", (_req, res) => {
    res.json({ armed: pipeline.isArmed() });
  });

  router.post("/broadcast/arm", (_req, res) => {
    pipeline.arm();
    res.json({ armed: true });
  });

  router.post("/broadcast/disarm", async (_req, res) => {
    const stoppedLegs = await pipeline.disarm();
    res.json({ armed: false, stoppedLegs });
  });

  router.post("/legs/:id/stop", async (req, res) => {
    try {
      await pipeline.stopManaged(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/legs/:id/restart", async (req, res) => {
    try {
      await pipeline.restartManaged(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Not-armed is a distinct, expected rejection (403) — anything else
      // (unknown leg id) stays 404.
      const status = message.startsWith("Broadcast is not armed") ? 403 : 404;
      res.status(status).json({ error: message });
    }
  });

  // The relay and every rendition share one process (task #24) — these two
  // routes act on that shared process, not on any one rendition. There is
  // deliberately no per-rendition stop/restart anymore; that would imply an
  // independence that no longer exists.
  router.post("/encode/stop", async (_req, res) => {
    try {
      await pipeline.stopManaged("relay");
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/encode/restart", async (_req, res) => {
    try {
      await pipeline.restartManaged("relay");
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
