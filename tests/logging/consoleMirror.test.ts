import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const appended: string[] = [];

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: () => {},
    appendFileSync: (_path: string, content: string) => {
      appended.push(content);
    },
  },
}));

const { mirrorConsoleToFile } = await import("../../src/logging/consoleMirror.js");

describe("mirrorConsoleToFile", () => {
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    appended.length = 0;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  it("still prints normally in addition to writing to the log file", () => {
    const printed: unknown[][] = [];
    console.log = (...args: unknown[]) => printed.push(args);
    mirrorConsoleToFile();

    console.log("hello world");

    expect(printed).toEqual([["hello world"]]);
    expect(appended.some((line) => line.includes("hello world"))).toBe(true);
  });

  it("redacts a secret URL embedded mid-string before writing to the log file", () => {
    console.error = () => {};
    mirrorConsoleToFile();

    console.error('leg "kick-main" failed: Error opening output rtmps://host/REAL_SECRET_KEY: I/O error');

    const combined = appended.join("\n");
    expect(combined).not.toContain("REAL_SECRET_KEY");
    expect(combined).toContain("***REDACTED***");
  });
});
