import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Mocks child_process.spawn only -- fs/os/path stay real so the probe's
// real temp-directory create/cleanup logic is actually exercised, just
// without spawning a real ffmpeg process (that's covered separately by a
// real functional check documented in PATCHNOTES.md/CLAUDE.md, not
// something to re-run on every test suite invocation).
let exitCode: number | null = 0;
let shouldErrorOnSpawn = false;
const spawnCalls: string[][] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((_cmd: string, argv: string[]) => {
    spawnCalls.push(argv);
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = vi.fn();
    if (shouldErrorOnSpawn) {
      queueMicrotask(() => child.emit("error", new Error("spawn ffmpeg ENOENT")));
    } else {
      queueMicrotask(() => child.emit("exit", exitCode));
    }
    return child;
  }),
}));

const { probeDecodeHwaccel } = await import("../../src/nvenc/decodeHwaccelProbe.js");

describe("probeDecodeHwaccel", () => {
  beforeEach(() => {
    exitCode = 0;
    shouldErrorOnSpawn = false;
    spawnCalls.length = 0;
  });

  it("returns true when both the clip-generation and decode/scale_cuda probe exit cleanly", async () => {
    const result = await probeDecodeHwaccel();
    expect(result).toBe(true);
    // Two real ffmpeg invocations: generate the tiny test clip, then probe decode+scale_cuda against it.
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]).toContain("-hwaccel");
    expect(spawnCalls[1]).toContain("cuda");
    expect(spawnCalls[1].join(" ")).toContain("scale_cuda");
  });

  it("returns false if the probe ffmpeg exits non-zero (no CUDA support on this machine)", async () => {
    // First call (clip generation) succeeds, second (the real probe) fails.
    let call = 0;
    const { spawn } = await import("node:child_process");
    (spawn as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation((_cmd: string, argv: string[]) => {
      spawnCalls.push(argv);
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = vi.fn();
      const code = call === 0 ? 0 : 1;
      call++;
      queueMicrotask(() => child.emit("exit", code));
      return child;
    });

    const result = await probeDecodeHwaccel();
    expect(result).toBe(false);
  });

  it("returns false if ffmpeg can't even be spawned (ENOENT)", async () => {
    shouldErrorOnSpawn = true;
    const result = await probeDecodeHwaccel();
    expect(result).toBe(false);
  });
});
