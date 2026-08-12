import { Router } from "express";
import type { RunningPipeline } from "../pipeline.js";
import type { LiveStateTracker } from "./liveState.js";
import { redactObject } from "../logging/redact.js";

/**
 * REST API for the local dashboard. V1 scope (documented, not silently
 * short of the original plan): live status/health monitoring and
 * start/stop/restart controls for already-configured legs/renditions.
 * Adding/editing/removing legs through the UI (full CRUD) is NOT built yet
 * — config changes still go through hand-editing config/legs.local.yaml +
 * an orchestrator restart, same as before this dashboard existed. See
 * CLAUDE.md architecture decision #8 for the full scope note.
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

    const renditions = pipeline.config.renditions.map((rendition) => {
      const legId = `rendition-${rendition.id}`;
      const supervisor = pipeline.renditionSupervisorsById.get(legId);
      return {
        ...rendition, // renditions never contain secrets — resolution/fps/bitrate/codec only
        state: supervisor?.getState() ?? "unknown",
        stats: snapshot.get(legId) ?? null,
      };
    });

    res.json({ legs, renditions });
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
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/renditions/:id/stop", async (req, res) => {
    try {
      await pipeline.stopManaged(`rendition-${req.params.id}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/renditions/:id/restart", async (req, res) => {
    try {
      await pipeline.restartManaged(`rendition-${req.params.id}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
