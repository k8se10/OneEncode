import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { appendRotatingLog, listTodaysRotatedFiles, MAX_LOG_FILE_BYTES } from "../../src/logging/logRotation.js";

const LOGS_DIR = path.resolve(process.cwd(), "logs");
const BASE = "test-rotation-fixture";

function cleanupFixtures(): void {
  if (!fs.existsSync(LOGS_DIR)) return;
  for (const f of fs.readdirSync(LOGS_DIR)) {
    if (f.startsWith(BASE)) fs.rmSync(path.join(LOGS_DIR, f), { force: true });
  }
}

function listFixtureFiles(): string[] {
  return listTodaysRotatedFiles(BASE, ".log").map((p) => path.basename(p));
}

describe("appendRotatingLog", () => {
  beforeEach(cleanupFixtures);
  afterEach(cleanupFixtures);

  it("appends to the base file while under the size cap", () => {
    appendRotatingLog(BASE, ".log", "line one\n");
    appendRotatingLog(BASE, ".log", "line two\n");
    expect(listFixtureFiles()).toEqual([`${BASE}.log`]);
    expect(fs.readFileSync(path.join(LOGS_DIR, `${BASE}.log`), "utf8")).toBe("line one\nline two\n");
  });

  it("rolls to a new numbered file once the base file would exceed the size cap", () => {
    // Write a line just under MAX_LOG_FILE_BYTES so the base file is nearly full.
    const filler = "x".repeat(MAX_LOG_FILE_BYTES - 10) + "\n";
    appendRotatingLog(BASE, ".log", filler);
    // This next line would push the base file over the cap -> rolls to .2.
    appendRotatingLog(BASE, ".log", "overflow line\n");

    expect(listFixtureFiles()).toEqual([`${BASE}.log`, `${BASE}.2.log`]);
    expect(fs.readFileSync(path.join(LOGS_DIR, `${BASE}.2.log`), "utf8")).toBe("overflow line\n");
  });

  it("accepts a single oversized line into a fresh file rather than looping forever", () => {
    const hugeLine = "y".repeat(MAX_LOG_FILE_BYTES + 1000) + "\n";
    expect(() => appendRotatingLog(BASE, ".log", hugeLine)).not.toThrow();
    expect(listFixtureFiles()).toEqual([`${BASE}.log`]);
  });
});
