import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
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
 * Hot-reload is NOT implemented — every successful write responds with
 * `restartRequired: true` and the caller (the dashboard UI) is responsible
 * for surfacing that to the user. Changes only take effect after the
 * orchestrator process is restarted.
 */

const CONFIG_DIR = path.resolve(process.cwd(), "config");
const LEGS_LOCAL_PATH = path.join(CONFIG_DIR, "legs.local.yaml");
const SECRETS_LOCAL_PATH = path.join(CONFIG_DIR, "secrets.local.yaml");
const PLATFORM_PROFILES_PATH = path.join(CONFIG_DIR, "platformProfiles.yaml");

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

function readRawConfig(): RootConfig {
  if (!fs.existsSync(LEGS_LOCAL_PATH)) {
    throw new ConfigApiError(
      "config/legs.local.yaml does not exist yet — copy config/legs.example.yaml to config/legs.local.yaml first.",
      404,
    );
  }
  const raw = fs.readFileSync(LEGS_LOCAL_PATH, "utf8");
  const parsed = yaml.load(raw);
  const result = rootConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigApiError(`config/legs.local.yaml on disk is currently invalid: ${formatIssues(result.error)}`, 500);
  }
  return result.data;
}

function writeConfig(config: RootConfig): void {
  const content =
    "# Managed in part by the OneEncode dashboard (src/ui/configApi.ts) —\n" +
    "# hand edits are preserved on the next dashboard write, but a hand edit\n" +
    "# and a concurrent dashboard write can still race each other.\n" +
    "# Changes here require an orchestrator restart to take effect.\n" +
    yaml.dump(config, { noRefs: true, sortKeys: false });
  fs.writeFileSync(LEGS_LOCAL_PATH, content, "utf8");
}

function readSecretMap(): Record<string, string> {
  if (!fs.existsSync(SECRETS_LOCAL_PATH)) return {};
  const parsed = yaml.load(fs.readFileSync(SECRETS_LOCAL_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return {};
  return parsed as Record<string, string>;
}

function writeSecret(envName: string, value: string): void {
  const existing = readSecretMap();
  existing[envName] = value;
  const content =
    "# Real destination URLs/stream keys — gitignored, never commit real values.\n" +
    "# Managed in part by the OneEncode dashboard (src/ui/configApi.ts).\n" +
    yaml.dump(existing, { noRefs: true, sortKeys: true });
  fs.writeFileSync(SECRETS_LOCAL_PATH, content, "utf8");
}

function deleteSecret(envName: string): void {
  if (!fs.existsSync(SECRETS_LOCAL_PATH)) return;
  const existing = readSecretMap();
  if (!(envName in existing)) return;
  delete existing[envName];
  fs.writeFileSync(
    SECRETS_LOCAL_PATH,
    "# Real destination URLs/stream keys — gitignored, never commit real values.\n" + yaml.dump(existing, { noRefs: true, sortKeys: true }),
    "utf8",
  );
}

/** Applies a mutation to a validated copy of the config, validates the WHOLE result, writes only if valid. Throws ConfigApiError on any failure. */
function applyAndWrite(mutate: (config: RootConfig) => RootConfig): RootConfig {
  const current = readRawConfig();
  const next = mutate(current);
  const validated = rootConfigSchema.safeParse(next);
  if (!validated.success) {
    throw new ConfigApiError(formatIssues(validated.error), 400);
  }
  writeConfig(validated.data);
  return validated.data;
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
      const parsed = yaml.load(fs.readFileSync(PLATFORM_PROFILES_PATH, "utf8")) as { platforms?: unknown[] };
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
      const config = applyAndWrite((cfg) => ({ ...cfg, renditions: [...cfg.renditions, parsedRendition.data] }));
      res.json({ ok: true, restartRequired: true, rendition: config.renditions.find((r) => r.id === parsedRendition.data.id) });
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
      applyAndWrite((cfg) => {
        const idx = cfg.renditions.findIndex((r) => r.id === req.params.id);
        if (idx === -1) throw new ConfigApiError(`No rendition "${req.params.id}"`, 404);
        const renditions = [...cfg.renditions];
        renditions[idx] = parsedRendition.data;
        return { ...cfg, renditions };
      });
      res.json({ ok: true, restartRequired: true });
    } catch (err) {
      const status = err instanceof ConfigApiError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/renditions/:id", (req, res) => {
    try {
      applyAndWrite((cfg) => {
        const dependentLegs = cfg.legs.filter((leg) => leg.renditionId === req.params.id);
        if (dependentLegs.length > 0) {
          throw new ConfigApiError(
            `Cannot delete rendition "${req.params.id}": ${dependentLegs.length} leg(s) still reference it ` +
              `(${dependentLegs.map((l) => l.id).join(", ")}). Delete or reassign those legs first.`,
            400,
          );
        }
        return { ...cfg, renditions: cfg.renditions.filter((r) => r.id !== req.params.id) };
      });
      res.json({ ok: true, restartRequired: true });
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
      applyAndWrite((cfg) => ({ ...cfg, legs: [...cfg.legs, parsedLeg.data] }));
      if (parsedLeg.data.type === "rtmp-push" && typeof secretValue === "string" && secretValue.trim()) {
        writeSecret(parsedLeg.data.destinationUrlEnv, secretValue.trim());
      }
      res.json({ ok: true, restartRequired: true });
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
      applyAndWrite((cfg) => {
        const idx = cfg.legs.findIndex((l) => l.id === req.params.id);
        if (idx === -1) throw new ConfigApiError(`No leg "${req.params.id}"`, 404);
        const legs = [...cfg.legs];
        legs[idx] = parsedLeg.data;
        return { ...cfg, legs };
      });
      if (parsedLeg.data.type === "rtmp-push" && typeof secretValue === "string" && secretValue.trim()) {
        writeSecret(parsedLeg.data.destinationUrlEnv, secretValue.trim());
      }
      res.json({ ok: true, restartRequired: true });
    } catch (err) {
      const status = err instanceof ConfigApiError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/legs/:id", (req, res) => {
    try {
      let deletedLeg: RootConfig["legs"][number] | undefined;
      applyAndWrite((cfg) => {
        deletedLeg = cfg.legs.find((l) => l.id === req.params.id);
        if (!deletedLeg) throw new ConfigApiError(`No leg "${req.params.id}"`, 404);
        return { ...cfg, legs: cfg.legs.filter((l) => l.id !== req.params.id) };
      });
      if (deletedLeg?.type === "rtmp-push") deleteSecret(deletedLeg.destinationUrlEnv);
      res.json({ ok: true, restartRequired: true });
    } catch (err) {
      const status = err instanceof ConfigApiError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
