import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import jsYaml from "js-yaml";
import { Document, parseDocument, type YAMLSeq } from "yaml";
import type { z } from "zod";
import { rootConfigSchema, legSchema, renditionSchema, encoderName, type RootConfig } from "../config/schema.js";

/**
 * Config CRUD API — add/edit/remove renditions and legs through the
 * dashboard (CLAUDE.md architecture decision #8 item (a), the one gap the
 * original UI backend left open). Mounted separately from src/ui/api.ts's
 * live-monitoring/control router, same token gate.
 *
 * Every write goes through the SAME zod schema the orchestrator itself
 * loads with (`config/schema.ts: rootConfigSchema`) before anything ever
 * touches disk — a bad request cannot produce a config the orchestrator
 * would then reject at startup (CLAUDE.md §"UI code" rule).
 *
 * Secrets: a request MAY include a `secretValue` field for an rtmp-push
 * leg's real destination URL/stream key. It is written to
 * config/secrets.local.yaml and NEVER echoed back — GET responses only
 * ever report whether a given env-var name currently has a value set
 * (`secretSet: true/false`), never the value itself.
 *
 * Non-destructive writes: mutations use the `yaml` package's
 * comment-preserving `Document`/`YAMLSeq` API (add/set/delete on the
 * actual rendition/leg sequence node) instead of re-serializing the whole
 * parsed config from scratch — a hand-added comment anywhere in the file
 * outside the specific item being touched survives a dashboard write. Every
 * write is also atomic (temp file + rename in the same directory), so a
 * crash mid-write can never leave legs.local.yaml/secrets.local.yaml
 * truncated or corrupt.
 *
 * Hot-reload IS implemented (src/config/watcher.ts watches these files and
 * calls RunningPipeline.reconcile()) — a successful write here takes effect
 * on its own, no restart needed. `restartRequired` is no longer part of any
 * response.
 */

const CONFIG_DIR = path.resolve(process.cwd(), "config");
const LEGS_LOCAL_PATH = path.join(CONFIG_DIR, "legs.local.yaml");
const SECRETS_LOCAL_PATH = path.join(CONFIG_DIR, "secrets.local.yaml");
const PLATFORM_PROFILES_PATH = path.join(CONFIG_DIR, "platformProfiles.yaml");

/** Temp file in the same directory + rename over the target — the rename is atomic on both Windows and POSIX, so a crash mid-write can never leave a torn/corrupt config file. */
function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * destinationUrlEnv (the env-var name a leg's real URL/key is resolved
 * from at startup, see src/config/load.ts) is an internal naming detail —
 * it doesn't need to be something a streamer types in themselves. The UI
 * no longer collects it; this derives a stable, readable one from the
 * leg's own id so the schema's requirement is still satisfied.
 */
function deriveDestinationUrlEnv(legId: string): string {
  return `ONEENCODE_${legId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_URL`;
}

export class ConfigApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function readDocument(): Document {
  if (!fs.existsSync(LEGS_LOCAL_PATH)) {
    throw new ConfigApiError(
      "config/legs.local.yaml does not exist yet — copy config/legs.example.yaml to config/legs.local.yaml first.",
      404,
    );
  }
  return parseDocument(fs.readFileSync(LEGS_LOCAL_PATH, "utf8"));
}

/** Validates a Document's current content against the same schema the orchestrator loads with. Throws ConfigApiError (400) on failure — never writes an invalid result. */
function validateDocument(doc: Document): RootConfig {
  const result = rootConfigSchema.safeParse(doc.toJSON());
  if (!result.success) {
    throw new ConfigApiError(formatIssues(result.error), 400);
  }
  return result.data;
}

function readRawConfig(): RootConfig {
  const result = rootConfigSchema.safeParse(readDocument().toJSON());
  if (!result.success) {
    throw new ConfigApiError(`config/legs.local.yaml on disk is currently invalid: ${formatIssues(result.error)}`, 500);
  }
  return result.data;
}

/** Validates, then writes atomically (temp file + rename) — comments/formatting outside whatever the caller actually mutated on `doc` are untouched, since this serializes the SAME Document instance the caller edited in place, never a freshly-dumped plain object. */
function writeDocument(doc: Document): RootConfig {
  const validated = validateDocument(doc);
  atomicWriteFileSync(LEGS_LOCAL_PATH, doc.toString());
  return validated;
}

/** Finds a rendition's or leg's index within its YAMLSeq by id — mutations below operate on that index directly (seq.set/seq.delete) rather than re-serializing the whole array. */
function findIndexById(seq: YAMLSeq, id: string): number {
  return (seq.toJSON() as Array<{ id: string }>).findIndex((item) => item.id === id);
}

function readSecretDocument(): Document {
  if (!fs.existsSync(SECRETS_LOCAL_PATH)) {
    const doc = new Document({});
    doc.commentBefore = " Real destination URLs/stream keys — gitignored, never commit real values.";
    return doc;
  }
  return parseDocument(fs.readFileSync(SECRETS_LOCAL_PATH, "utf8"));
}

function writeSecret(envName: string, value: string): void {
  const doc = readSecretDocument();
  doc.set(envName, value);
  atomicWriteFileSync(SECRETS_LOCAL_PATH, doc.toString());
}

function deleteSecret(envName: string): void {
  if (!fs.existsSync(SECRETS_LOCAL_PATH)) return;
  const doc = readSecretDocument();
  if (!doc.has(envName)) return;
  doc.delete(envName);
  atomicWriteFileSync(SECRETS_LOCAL_PATH, doc.toString());
}

function readSecretMap(): Record<string, string> {
  const parsed = readSecretDocument().toJSON();
  if (typeof parsed !== "object" || parsed === null) return {};
  return parsed as Record<string, string>;
}

export function createConfigApiRouter(): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    try {
      const config = readRawConfig();
      const secretNames = new Set(Object.keys(readSecretMap()));
      const legs = config.legs.map((leg) => ({
        ...leg,
        secretSet: leg.type === "rtmp-push" ? secretNames.has(leg.destinationUrlEnv) : undefined,
      }));
      res.json({ renditions: config.renditions, legs, encoderOptions: encoderName.options });
    } catch (err) {
      const status = err instanceof ConfigApiError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // CLAUDE.md architecture decision #10: published platform-recommended
  // rendition settings, seeded as an optional DEFAULT the UI can offer
  // when creating a new rendition -- never applied automatically, never
  // overrides an already-set value. Read fresh on every request rather
  // than cached, since it's a small file a maintainer might hand-edit.
  router.get("/platform-profiles", (_req, res) => {
    try {
      if (!fs.existsSync(PLATFORM_PROFILES_PATH)) {
        res.json({ platforms: [] });
        return;
      }
      const parsed = jsYaml.load(fs.readFileSync(PLATFORM_PROFILES_PATH, "utf8")) as { platforms?: unknown[] };
      res.json({ platforms: parsed.platforms ?? [] });
    } catch (err) {
      const status = err instanceof ConfigApiError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Renditions ---

  router.post("/renditions", (req, res) => {
    try {
      const parsedRendition = renditionSchema.safeParse(req.body);
      if (!parsedRendition.success) {
        res.status(400).json({ error: formatIssues(parsedRendition.error) });
        return;
      }
      const doc = readDocument();
      const seq = doc.get("renditions", true) as YAMLSeq;
      if (findIndexById(seq, parsedRendition.data.id) !== -1) {
        throw new ConfigApiError(`Rendition "${parsedRendition.data.id}" already exists`, 409);
      }
      seq.add(parsedRendition.data);
      writeDocument(doc);
      res.json({ ok: true, rendition: parsedRendition.data });
    } catch (err) {
      const status = err instanceof ConfigApiError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/renditions/:id", (req, res) => {
    try {
      const parsedRendition = renditionSchema.safeParse({ ...req.body, id: req.params.id });
      if (!parsedRendition.success) {
        res.status(400).json({ error: formatIssues(parsedRendition.error) });
        return;
      }
      const doc = readDocument();
      const seq = doc.get("renditions", true) as YAMLSeq;
      const idx = findIndexById(seq, req.params.id);
      if (idx === -1) throw new ConfigApiError(`No rendition "${req.params.id}"`, 404);
      seq.set(idx, parsedRendition.data);
      writeDocument(doc);
      res.json({ ok: true });
    } catch (err) {
      const status = err instanceof ConfigApiError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/renditions/:id", (req, res) => {
    try {
      const doc = readDocument();
      const config = validateDocument(doc);
      const dependentLegs = config.legs.filter((leg) => leg.renditionId === req.params.id);
      if (dependentLegs.length > 0) {
        throw new ConfigApiError(
          `Cannot delete rendition "${req.params.id}": ${dependentLegs.length} leg(s) still reference it ` +
            `(${dependentLegs.map((l) => l.id).join(", ")}). Delete or reassign those legs first.`,
          400,
        );
      }
      const seq = doc.get("renditions", true) as YAMLSeq;
      const idx = findIndexById(seq, req.params.id);
      if (idx === -1) throw new ConfigApiError(`No rendition "${req.params.id}"`, 404);
      seq.delete(idx);
      writeDocument(doc);
      res.json({ ok: true });
    } catch (err) {
      const status = err instanceof ConfigApiError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Legs ---

  router.post("/legs", (req, res) => {
    try {
      const { secretValue, ...legBody } = (req.body ?? {}) as Record<string, unknown> & { secretValue?: string };
      if (legBody.type === "rtmp-push" && !legBody.destinationUrlEnv && typeof legBody.id === "string") {
        legBody.destinationUrlEnv = deriveDestinationUrlEnv(legBody.id);
      }
      const parsedLeg = legSchema.safeParse(legBody);
      if (!parsedLeg.success) {
        res.status(400).json({ error: formatIssues(parsedLeg.error) });
        return;
      }
      const doc = readDocument();
      const seq = doc.get("legs", true) as YAMLSeq;
      if (findIndexById(seq, parsedLeg.data.id) !== -1) {
        throw new ConfigApiError(`Leg "${parsedLeg.data.id}" already exists`, 409);
      }
      seq.add(parsedLeg.data);
      writeDocument(doc);
      if (parsedLeg.data.type === "rtmp-push" && typeof secretValue === "string" && secretValue.trim()) {
        writeSecret(parsedLeg.data.destinationUrlEnv, secretValue.trim());
      }
      res.json({ ok: true });
    } catch (err) {
      const status = err instanceof ConfigApiError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/legs/:id", (req, res) => {
    try {
      const { secretValue, ...legBody } = (req.body ?? {}) as Record<string, unknown> & { secretValue?: string };
      if (legBody.type === "rtmp-push" && !legBody.destinationUrlEnv) {
        // Preserve the existing env-var name on edit (the UI never sends
        // one) rather than re-deriving it -- re-deriving would orphan
        // whatever secret is already stored under the current name.
        const existing = readRawConfig().legs.find((l) => l.id === req.params.id);
        legBody.destinationUrlEnv =
          existing?.type === "rtmp-push" ? existing.destinationUrlEnv : deriveDestinationUrlEnv(req.params.id);
      }
      const parsedLeg = legSchema.safeParse({ ...legBody, id: req.params.id });
      if (!parsedLeg.success) {
        res.status(400).json({ error: formatIssues(parsedLeg.error) });
        return;
      }
      const doc = readDocument();
      const seq = doc.get("legs", true) as YAMLSeq;
      const idx = findIndexById(seq, req.params.id);
      if (idx === -1) throw new ConfigApiError(`No leg "${req.params.id}"`, 404);
      seq.set(idx, parsedLeg.data);
      writeDocument(doc);
      if (parsedLeg.data.type === "rtmp-push" && typeof secretValue === "string" && secretValue.trim()) {
        writeSecret(parsedLeg.data.destinationUrlEnv, secretValue.trim());
      }
      res.json({ ok: true });
    } catch (err) {
      const status = err instanceof ConfigApiError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/legs/:id", (req, res) => {
    try {
      const doc = readDocument();
      const config = validateDocument(doc);
      const deletedLeg = config.legs.find((l) => l.id === req.params.id);
      if (!deletedLeg) throw new ConfigApiError(`No leg "${req.params.id}"`, 404);
      const seq = doc.get("legs", true) as YAMLSeq;
      const idx = findIndexById(seq, req.params.id);
      seq.delete(idx);
      writeDocument(doc);
      if (deletedLeg.type === "rtmp-push") deleteSecret(deletedLeg.destinationUrlEnv);
      res.json({ ok: true });
    } catch (err) {
      const status = err instanceof ConfigApiError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
