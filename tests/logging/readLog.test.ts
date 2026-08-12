import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readFpsSamplesForLegs } from "../../src/logging/readLog.js";

const LOGS_DIR = path.resolve(process.cwd(), "logs");
const today = new Date().toISOString().slice(0, 10);
const LOG_PATH = path.join(LOGS_DIR, `oneencode-${today}.jsonl`);

function line(legId: string, fps: number, timestamp: string): string {
  return JSON.stringify({ event: "leg_stats_sample", legId, fps, timestamp }) + "\n";
}

describe("readFpsSamplesForLegs", () => {
  let originalContent: string | undefined;

  beforeEach(() => {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    originalContent = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, "utf8") : undefined;
    fs.writeFileSync(
      LOG_PATH,
      [
        line("relay", 60, "2026-08-13T10:00:00.000Z"), // an earlier, unrelated run
        line("relay", 61, "2026-08-13T10:00:01.000Z"),
        line("relay", 62, "2026-08-13T12:00:00.000Z"), // this run
        line("relay", 63, "2026-08-13T12:00:01.000Z"),
        line("other-leg", 30, "2026-08-13T12:00:00.500Z"),
        "not valid json\n",
        JSON.stringify({ event: "leg_exit", legId: "relay" }) + "\n",
      ].join(""),
    );
  });

  afterEach(() => {
    if (originalContent === undefined) {
      fs.rmSync(LOG_PATH, { force: true });
    } else {
      fs.writeFileSync(LOG_PATH, originalContent);
    }
  });

  it("only includes samples at or after the given cutoff", () => {
    const result = readFpsSamplesForLegs(["relay"], new Date("2026-08-13T11:00:00.000Z"));
    expect(result.get("relay")).toEqual([62, 63]);
  });

  it("excludes legIds not requested", () => {
    const result = readFpsSamplesForLegs(["relay"], new Date("2026-08-13T00:00:00.000Z"));
    expect(result.has("other-leg")).toBe(false);
  });

  it("returns an empty array for a requested legId with no matching samples", () => {
    const result = readFpsSamplesForLegs(["nonexistent-leg"], new Date("2026-08-13T00:00:00.000Z"));
    expect(result.get("nonexistent-leg")).toEqual([]);
  });

  it("tolerates malformed lines without throwing", () => {
    expect(() => readFpsSamplesForLegs(["relay"], new Date(0))).not.toThrow();
  });
});
