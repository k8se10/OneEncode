import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { rootConfigSchema, type RootConfig } from "./schema.js";

export class ConfigError extends Error {}

const CONFIG_DIR = path.resolve(process.cwd(), "config");
const LEGS_LOCAL_PATH = path.join(CONFIG_DIR, "legs.local.yaml");
const SECRETS_LOCAL_PATH = path.join(CONFIG_DIR, "secrets.local.yaml");

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
}

export function loadConfig(): LoadedConfig {
  if (!fs.existsSync(LEGS_LOCAL_PATH)) {
    throw new ConfigError(
      `config/legs.local.yaml not found. Copy config/legs.example.yaml to ` +
        `config/legs.local.yaml and fill in real values before starting.`,
    );
  }

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

  const enabledIds = config.legs.filter((leg) => leg.enabled).map((leg) => leg.id);
  const duplicateIds = enabledIds.filter((id, i) => enabledIds.indexOf(id) !== i);
  if (duplicateIds.length > 0) {
    throw new ConfigError(`Duplicate leg id(s) in config: ${[...new Set(duplicateIds)].join(", ")}`);
  }

  return { config, destinations: { rtmpUrlByLegId } };
}
