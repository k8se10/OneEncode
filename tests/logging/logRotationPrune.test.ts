import { describe, expect, it, vi, beforeEach } from "vitest";

// Pruning kicks in once the whole logs/ directory exceeds MAX_TOTAL_LOG_BYTES
// (200MB) -- exercising that for real would mean writing ~200MB to disk in a
// unit test, which is slow and wasteful. Mock fs instead so directory
// listings can report large sizes without any real bytes ever being written.
const files = new Map<string, { size: number; mtimeMs: number }>();
const unlinked: string[] = [];

vi.mock("node:fs", () => ({
  default: {
    existsSync: (p: string) => files.has(basename(p)) || p.endsWith("logs"),
    mkdirSync: () => {},
    statSync: (p: string) => {
      const entry = files.get(basename(p));
      if (!entry) throw new Error(`no such fixture file: ${p}`);
      return entry;
    },
    readdirSync: () => [...files.keys()],
    appendFileSync: (p: string, content: string) => {
      const name = basename(p);
      const existing = files.get(name);
      files.set(name, { size: (existing?.size ?? 0) + Buffer.byteLength(content, "utf8"), mtimeMs: Date.now() });
    },
    unlinkSync: (p: string) => {
      const name = basename(p);
      files.delete(name);
      unlinked.push(name);
    },
  },
}));

function basename(p: string): string {
  return p.split(/[\\/]/).pop()!;
}

const { appendRotatingLog, MAX_TOTAL_LOG_BYTES } = await import("../../src/logging/logRotation.js");

describe("appendRotatingLog pruning", () => {
  beforeEach(() => {
    files.clear();
    unlinked.length = 0;
  });

  it("deletes the oldest oneencode-prefixed files once total size exceeds the cap", () => {
    const oldTime = Date.now() - 60_000;
    files.set("oneencode-2026-08-01.jsonl", { size: MAX_TOTAL_LOG_BYTES, mtimeMs: oldTime });

    // Appending a new file's first line triggers the prune check.
    appendRotatingLog("oneencode-2026-08-14", ".jsonl", "line\n");

    expect(unlinked).toContain("oneencode-2026-08-01.jsonl");
    expect(files.has("oneencode-2026-08-14.jsonl")).toBe(true);
  });

  it("keeps files once total size is back under the cap", () => {
    files.set("oneencode-2026-08-01.jsonl", { size: 1000, mtimeMs: Date.now() - 60_000 });

    appendRotatingLog("oneencode-2026-08-14", ".jsonl", "line\n");

    expect(unlinked).toEqual([]);
    expect(files.has("oneencode-2026-08-01.jsonl")).toBe(true);
  });
});
