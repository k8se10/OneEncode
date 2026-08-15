import { describe, expect, it, vi, beforeEach } from "vitest";

// Mocks node:fs (just fs.watch — this module never reads/writes files
// itself, that's load.ts's job) and config/load.js's loadConfig, so this
// test exercises the debounce/error-handling logic in isolation without
// touching the real filesystem or spawning anything.
let watchCallback: ((eventType: string, filename: string | null) => void) | undefined;
const watchCloseSpy = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    watch: vi.fn((_dir: string, cb: (eventType: string, filename: string | null) => void) => {
      watchCallback = cb;
      return { close: watchCloseSpy };
    }),
  },
}));

let loadConfigImpl: () => { config: unknown; destinations: unknown };
vi.mock("../../src/config/load.js", () => ({
  loadConfig: vi.fn(() => loadConfigImpl()),
  ConfigError: class ConfigError extends Error {},
}));

const { watchConfigForHotReload } = await import("../../src/config/watcher.js");
const { ConfigError } = await import("../../src/config/load.js");

function triggerFileChange(filename = "legs.local.yaml"): void {
  watchCallback?.("change", filename);
}

describe("watchConfigForHotReload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    watchCallback = undefined;
    watchCloseSpy.mockClear();
  });

  it("ignores changes to unrelated files in the same directory", async () => {
    const reconcile = vi.fn();
    loadConfigImpl = () => ({ config: {}, destinations: {} });
    watchConfigForHotReload({ reconcile } as never);

    triggerFileChange("some-other-file.txt");
    await vi.advanceTimersByTimeAsync(1000);

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("debounces multiple rapid change events into a single reconcile call", async () => {
    const reconcile = vi.fn().mockResolvedValue({ noChanges: true, legsAdded: [], legsRemoved: [], legsRestarted: [], restartedCombinedProcess: false });
    loadConfigImpl = () => ({ config: { marker: 1 }, destinations: {} });
    watchConfigForHotReload({ reconcile } as never);

    triggerFileChange();
    triggerFileChange();
    triggerFileChange();
    await vi.advanceTimersByTimeAsync(1000);

    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("calls pipeline.reconcile with the freshly-loaded config and destinations", async () => {
    const reconcile = vi.fn().mockResolvedValue({ noChanges: true, legsAdded: [], legsRemoved: [], legsRestarted: [], restartedCombinedProcess: false });
    const fakeConfig = { marker: "abc" };
    const fakeDestinations = { rtmpUrlByLegId: new Map() };
    loadConfigImpl = () => ({ config: fakeConfig, destinations: fakeDestinations });
    watchConfigForHotReload({ reconcile } as never);

    triggerFileChange();
    await vi.advanceTimersByTimeAsync(1000);

    expect(reconcile).toHaveBeenCalledWith(fakeConfig, fakeDestinations);
  });

  it("does not crash and keeps the pipeline running when the new config is invalid", async () => {
    const reconcile = vi.fn();
    loadConfigImpl = () => {
      throw new ConfigError("config/legs.local.yaml failed validation: renditions.0.id: required");
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    watchConfigForHotReload({ reconcile } as never);

    triggerFileChange();
    await vi.advanceTimersByTimeAsync(1000);

    expect(reconcile).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("config reload FAILED"));
    errorSpy.mockRestore();
  });

  it("close() stops the underlying directory watch", () => {
    const reconcile = vi.fn();
    loadConfigImpl = () => ({ config: {}, destinations: {} });
    const handle = watchConfigForHotReload({ reconcile } as never);

    handle.close();
    expect(watchCloseSpy).toHaveBeenCalled();
  });
});
