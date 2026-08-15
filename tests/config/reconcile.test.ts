import { describe, expect, it } from "vitest";
import { planReconciliation } from "../../src/config/reconcile.js";
import type { RootConfig } from "../../src/config/schema.js";

const baseConfig: RootConfig = {
  ingest: { listenUrl: "rtmp://127.0.0.1:1935/ingest/live" },
  relay: {
    url: "rtmp://127.0.0.1:1935/relay/live",
    encoder: "h264_nvenc",
    preset: "p1",
    tuneLowLatency: true,
    bitrateKbps: 40000,
    decodeHwaccel: "auto",
  },
  encoderPriority: ["h264_nvenc", "h264_amf", "libx264"],
  renditions: [
    {
      id: "r1",
      resolution: { width: 1920, height: 1080 },
      fps: 60,
      videoBitrateKbps: 6000,
      audioBitrateKbps: 160,
      keyframeIntervalSec: 2,
      encoderPreference: ["h264_nvenc"],
    },
  ],
  legs: [
    { id: "leg1", enabled: true, renditionId: "r1", priority: 0, type: "local-file", outputDir: "recordings", filenamePattern: "archive_{timestamp}.mp4" },
  ],
  restartPolicy: { maxRestartsPerHour: 5, backoffInitialMs: 2000, backoffMaxMs: 60000 },
};

function clone(config: RootConfig): RootConfig {
  return JSON.parse(JSON.stringify(config));
}

describe("planReconciliation", () => {
  it("reports noChanges when nothing differs", () => {
    const plan = planReconciliation(baseConfig, clone(baseConfig));
    expect(plan.noChanges).toBe(true);
    expect(plan.restartCombinedProcess).toBe(false);
    expect(plan.legsToAdd).toEqual([]);
    expect(plan.legsToRemove).toEqual([]);
    expect(plan.legsToRestart).toEqual([]);
  });

  it("flags a combined-process restart when a rendition changes, even if no leg diff exists", () => {
    const next = clone(baseConfig);
    next.renditions[0].videoBitrateKbps = 8000;
    const plan = planReconciliation(baseConfig, next);
    expect(plan.restartCombinedProcess).toBe(true);
    expect(plan.restartCombinedReason).toBe("renditions changed");
    expect(plan.legsToAdd).toEqual([]);
    expect(plan.legsToRestart).toEqual([]);
  });

  it("flags a combined-process restart when ingest.listenUrl changes", () => {
    const next = clone(baseConfig);
    next.ingest.listenUrl = "rtmp://127.0.0.1:1935/ingest/other";
    const plan = planReconciliation(baseConfig, next);
    expect(plan.restartCombinedProcess).toBe(true);
    expect(plan.restartCombinedReason).toBe("ingest settings changed");
  });

  it("flags a combined-process restart when relay.decodeHwaccel changes", () => {
    const next = clone(baseConfig);
    next.relay.decodeHwaccel = false;
    const plan = planReconciliation(baseConfig, next);
    expect(plan.restartCombinedProcess).toBe(true);
    expect(plan.restartCombinedReason).toBe("relay settings changed");
  });

  it("detects a newly-added leg without touching the combined process", () => {
    const next = clone(baseConfig);
    next.legs.push({ id: "leg2", enabled: true, renditionId: "r1", priority: 0, type: "local-file", outputDir: "recordings", filenamePattern: "archive2_{timestamp}.mp4" });
    const plan = planReconciliation(baseConfig, next);
    expect(plan.restartCombinedProcess).toBe(false);
    expect(plan.legsToAdd).toHaveLength(1);
    expect(plan.legsToAdd[0].id).toBe("leg2");
    expect(plan.noChanges).toBe(false);
  });

  it("detects a removed leg", () => {
    const next = clone(baseConfig);
    next.legs = [];
    const plan = planReconciliation(baseConfig, next);
    expect(plan.restartCombinedProcess).toBe(false);
    expect(plan.legsToRemove).toEqual(["leg1"]);
  });

  it("detects a changed leg (same id, different field) as a restart, not add+remove", () => {
    const next = clone(baseConfig);
    next.legs[0].priority = 99;
    const plan = planReconciliation(baseConfig, next);
    expect(plan.legsToAdd).toEqual([]);
    expect(plan.legsToRemove).toEqual([]);
    expect(plan.legsToRestart).toHaveLength(1);
    expect(plan.legsToRestart[0].id).toBe("leg1");
    expect(plan.legsToRestart[0].priority).toBe(99);
  });

  it("treats an added rtmp-push leg the same as any other add -- staging/arm logic lives in the executor, not the plan", () => {
    const next = clone(baseConfig);
    next.legs.push({
      id: "twitch-new",
      enabled: true,
      renditionId: "r1",
      priority: 0,
      type: "rtmp-push",
      destinationUrlEnv: "ONEENCODE_TWITCH_NEW_URL",
    });
    const plan = planReconciliation(baseConfig, next);
    expect(plan.legsToAdd).toHaveLength(1);
    expect(plan.legsToAdd[0].type).toBe("rtmp-push");
  });

  it("does not report noChanges when only restartPolicy differs, even though nothing running needs to change", () => {
    const next = clone(baseConfig);
    next.restartPolicy.maxRestartsPerHour = 10;
    const plan = planReconciliation(baseConfig, next);
    expect(plan.restartCombinedProcess).toBe(false);
    expect(plan.legsToAdd).toEqual([]);
    expect(plan.legsToRemove).toEqual([]);
    expect(plan.legsToRestart).toEqual([]);
    expect(plan.noChanges).toBe(false);
  });
});
