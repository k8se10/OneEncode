import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ConfigError } from "../../src/config/load.js";

const CONFIG_DIR = path.resolve(process.cwd(), "config");
const LEGS_LOCAL_PATH = path.join(CONFIG_DIR, "legs.local.yaml");
const LEGS_DEFAULT_PATH = path.join(CONFIG_DIR, "legs.default.yaml");

// Real fs against the real config/ directory, same pattern as
// tests/logging/readLog.test.ts -- backs up/restores whatever was already
// there so this never clobbers a real local dev config, and exercises the
// actual committed legs.default.yaml content through real YAML parsing and
// schema validation rather than a hand-rolled fs mock reproducing the same
// copy logic (higher-confidence: this proves the real default file is
// actually schema-valid, not just that the copy mechanism works).
describe("loadConfig — first-run default config auto-generation", () => {
  let originalLocalContent: string | undefined;
  let originalDefaultContent: string | undefined;

  beforeEach(() => {
    originalLocalContent = fs.existsSync(LEGS_LOCAL_PATH) ? fs.readFileSync(LEGS_LOCAL_PATH, "utf8") : undefined;
    originalDefaultContent = fs.existsSync(LEGS_DEFAULT_PATH) ? fs.readFileSync(LEGS_DEFAULT_PATH, "utf8") : undefined;
    fs.rmSync(LEGS_LOCAL_PATH, { force: true });
  });

  afterEach(() => {
    if (originalLocalContent === undefined) {
      fs.rmSync(LEGS_LOCAL_PATH, { force: true });
    } else {
      fs.writeFileSync(LEGS_LOCAL_PATH, originalLocalContent);
    }
    if (originalDefaultContent !== undefined) {
      fs.writeFileSync(LEGS_DEFAULT_PATH, originalDefaultContent);
    }
  });

  it("auto-generates legs.local.yaml from legs.default.yaml when missing, and loads it successfully", () => {
    expect(fs.existsSync(LEGS_LOCAL_PATH)).toBe(false);

    const loaded = loadConfig();

    expect(loaded.usingDefaultConfig).toBe(true);
    expect(fs.existsSync(LEGS_LOCAL_PATH)).toBe(true);
    expect(fs.readFileSync(LEGS_LOCAL_PATH, "utf8")).toBe(fs.readFileSync(LEGS_DEFAULT_PATH, "utf8"));

    // The real committed default must itself be schema-valid and startable:
    // one safe local-file leg, no unresolved secrets.
    expect(loaded.config.legs).toHaveLength(1);
    expect(loaded.config.legs[0].type).toBe("local-file");
    expect(loaded.destinations.rtmpUrlByLegId.size).toBe(0);
  });

  it("does not overwrite an existing legs.local.yaml, and reports usingDefaultConfig: false", () => {
    fs.writeFileSync(
      LEGS_LOCAL_PATH,
      [
        "ingest: { listenUrl: 'rtmp://127.0.0.1:1935/ingest/live' }",
        "relay: { url: 'rtmp://127.0.0.1:1935/relay/live' }",
        "encoderPriority: [libx264]",
        "renditions: [{ id: r1, resolution: source, videoBitrateKbps: 1000, encoderPreference: [libx264] }]",
        "legs: [{ id: leg1, type: local-file, renditionId: r1, outputDir: recordings }]",
      ].join("\n"),
    );

    const loaded = loadConfig();

    expect(loaded.usingDefaultConfig).toBe(false);
    expect(loaded.config.renditions[0].id).toBe("r1");
  });

  it("throws a clear ConfigError if neither legs.local.yaml nor legs.default.yaml exist", () => {
    fs.rmSync(LEGS_DEFAULT_PATH, { force: true });
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/legs\.default\.yaml.*also missing/s);
  });
});
