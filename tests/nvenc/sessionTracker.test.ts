import { describe, expect, it } from "vitest";
import { NvencSessionTracker, selectEncoder } from "../../src/nvenc/sessionTracker.js";
import type { EncoderName } from "../../src/config/schema.js";

describe("NvencSessionTracker", () => {
  it("has capacity until the ceiling is reached", () => {
    const tracker = new NvencSessionTracker(2);
    expect(tracker.hasCapacity()).toBe(true);
    tracker.reserve();
    expect(tracker.hasCapacity()).toBe(true);
    tracker.reserve();
    expect(tracker.hasCapacity()).toBe(false);
  });

  it("frees capacity on release", () => {
    const tracker = new NvencSessionTracker(1);
    tracker.reserve();
    expect(tracker.hasCapacity()).toBe(false);
    tracker.release();
    expect(tracker.hasCapacity()).toBe(true);
  });

  it("never goes negative on excess release", () => {
    const tracker = new NvencSessionTracker(1);
    tracker.release();
    expect(tracker.current).toBe(0);
  });
});

describe("selectEncoder", () => {
  it("picks the first preference when NVENC capacity is available", () => {
    const tracker = new NvencSessionTracker(5);
    const preference: EncoderName[] = ["h264_nvenc", "h264_amf", "libx264"];
    expect(selectEncoder("leg-a", preference, tracker)).toBe("h264_nvenc");
    expect(tracker.current).toBe(1);
  });

  it("falls back to the next preference once NVENC capacity is exhausted", () => {
    const tracker = new NvencSessionTracker(1);
    tracker.reserve(); // simulate one session already in use
    const preference: EncoderName[] = ["h264_nvenc", "h264_amf", "libx264"];
    expect(selectEncoder("leg-b", preference, tracker)).toBe("h264_amf");
    // AMF isn't NVENC — shouldn't consume a tracked slot
    expect(tracker.current).toBe(1);
  });

  it("never limits non-NVENC encoders even with zero ceiling", () => {
    const tracker = new NvencSessionTracker(0);
    expect(selectEncoder("leg-c", ["libx264"], tracker)).toBe("libx264");
  });

  it("uses the last preference as a best-effort fallback when everything is NVENC and full", () => {
    const tracker = new NvencSessionTracker(0);
    const preference: EncoderName[] = ["h264_nvenc", "hevc_nvenc"];
    expect(selectEncoder("leg-d", preference, tracker)).toBe("hevc_nvenc");
  });
});
