import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// logEvent() (called by spawnLegProcess) writes to a real file under
// cwd()/logs — mock node:fs so this test never touches the real
// filesystem/cwd. Deliberately NOT using process.chdir() here: it's real
// global process state, and mutating it leaked into other test files
// sharing the same vitest worker, corrupting an unrelated log-reading test
// (readFpsSamplesForLegs) that assumed the real project's logs/ dir.
vi.mock("node:fs", () => ({
  default: {
    existsSync: () => true,
    mkdirSync: () => {},
    appendFileSync: () => {},
  },
}));

// Deterministically simulate the binary not being found (ENOENT), rather
// than relying on whether ffmpeg happens to be on PATH on whatever machine
// runs this test — that's the exact real-world condition that surfaced the
// bug (a standalone-exe build where ffmpeg wasn't yet resolvable on PATH).
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { stderr: PassThrough; stdin: PassThrough; pid?: number };
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    queueMicrotask(() => {
      child.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
    });
    return child;
  }),
}));

const { spawnLegProcess } = await import("../../src/legs/legProcess.js");

describe("spawnLegProcess", () => {
  it("does not crash the process when the binary can't be found — resolves `exited` instead of throwing", async () => {
    // Regression test: a spawn failure (ENOENT) used to be an unhandled
    // "error" event on the child process, which is an uncaught exception
    // that kills the ENTIRE Node process — not just this one leg. That
    // defeats the whole point of per-leg failure isolation (CLAUDE.md §5),
    // and was found for real while testing a standalone-exe build where
    // ffmpeg wasn't yet resolvable on PATH.
    const handle = spawnLegProcess("test-leg", ["-hide_banner"], "copy", () => {});
    const result = await handle.exited;
    expect(result.code).toBeNull();
    expect(result.signal).toBeNull();
  });
});
