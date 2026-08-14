import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { rootConfigSchema, type RootConfig } from "./schema.js";

export class ConfigError extends Error {}

const CONFIG_DIR = path.resolve(process.cwd(), "config");
const LEGS_LOCAL_PATH = path.join(CONFIG_DIR, "legs.local.yaml");
const LEGS_DEFAULT_PATH = path.join(CONFIG_DIR, "legs.default.yaml");
const SECRETS_LOCAL_PATH = path.join(CONFIG_DIR, "secrets.local.yaml");

/**
 * First-run UX: a missing legs.local.yaml used to be a hard startup error
 * ("copy the example and fill it in yourself") -- real friction for a
 * standalone release meant to be click-and-run. Now it's auto-generated
 * from the committed, safe-by-construction config/legs.default.yaml (a
 * single local-file leg, no real credentials needed, no external side
 * effect) so the orchestrator can actually start on a completely fresh
 * install. A missing/invalid legs.local.yaml that *does* exist still fails
 * loudly -- this only fires when the file is absent entirely, never
 * silently overwrites a real (if broken) config.
 */
function ensureLegsLocalExists(): boolean {
  if (fs.existsSync(LEGS_LOCAL_PATH)) return false;
  if (!fs.existsSync(LEGS_DEFAULT_PATH)) {
    throw new ConfigError(
      `config/legs.local.yaml not found, and config/legs.default.yaml (the auto-generated fallback template) is also missing. Copy config/legs.example.yaml to config/legs.local.yaml and fill in real values before starting.`,
    );
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.copyFileSync(LEGS_DEFAULT_PATH, LEGS_LOCAL_PATH);
  return true;
}

function readYamlFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  return yaml.load(raw);
}

function loadSecrets(): Record<string, string> {
  if (!fs.existsSync(SECRETS_LOCAL_PATH)) {
    return {};
  }
  const parsed = readYamlFile(SECRETS_LOCAL_PATH);
  if (typeof parsed !== "object" || parsed === null) {
    throw new ConfigError(
      `config/secrets.local.yaml must be a flat map of ENV_NAME: value, got ${typeof parsed}`,
    );
  }
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new ConfigError(`config/secrets.local.yaml: value for "${key}" must be a string`);
    }
    secrets[key] = value;
  }
  return secrets;
}

/**
 * A leg's real destination URL, resolved from secrets.local.yaml (or process.env
 * as a fallback) but never embedded in the returned RootConfig itself, so that
 * a config object can be freely logged/passed around without leaking secrets.
 */
export interface ResolvedDestinations {
  /** legId -> resolved RTMP destination URL, for rtmp-push legs only */
  rtmpUrlByLegId: Map<string, string>;
}

export interface LoadedConfig {
  config: RootConfig;
  destinations: ResolvedDestinations;
  /** True when legs.local.yaml didn't exist and was just auto-generated from legs.default.yaml this call. */
  usingDefaultConfig: boolean;
}

export function loadConfig(): LoadedConfig {
  const usingDefaultConfig = ensureLegsLocalExists();

  const rawConfig = readYamlFile(LEGS_LOCAL_PATH);
  const parseResult = rootConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`config/legs.local.yaml failed validation:\n${issues}`);
  }
  const config = parseResult.data;

  const secrets = loadSecrets();
  const rtmpUrlByLegId = new Map<string, string>();
  const unresolved: string[] = [];

  for (const leg of config.legs) {
    if (leg.type !== "rtmp-push") continue;
    const value = secrets[leg.destinationUrlEnv] ?? process.env[leg.destinationUrlEnv];
    if (!value) {
      unresolved.push(`leg "${leg.id}" references env "${leg.destinationUrlEnv}"`);
      continue;
    }
    rtmpUrlByLegId.set(leg.id, value);
  }

  if (unresolved.length > 0) {
    throw new ConfigError(
      `Unresolvable destination secrets — refusing to start:\n` +
        unresolved.map((line) => `  - ${line}`).join("\n") +
        `\nAdd the missing key(s) to config/secrets.local.yaml.`,
    );
  }

  // Duplicate leg/rendition ids and dangling renditionId references are
  // already rejected by rootConfigSchema's superRefine above.

  return { config, destinations: { rtmpUrlByLegId }, usingDefaultConfig };
}
