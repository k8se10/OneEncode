import { describe, expect, it } from "vitest";
import { computeJitterStats } from "../../src/legs/statsAnalysis.js";

describe("computeJitterStats", () => {
  it("returns zeroed stats for an empty sample set", () => {
    expect(computeJitterStats([])).toEqual({ count: 0, mean: 0, stddev: 0, min: 0, max: 0, coefficientOfVariation: 0 });
  });

  it("reports zero stddev for a perfectly steady series", () => {
    const stats = computeJitterStats([60, 60, 60, 60]);
    expect(stats.mean).toBe(60);
    expect(stats.stddev).toBe(0);
    expect(stats.coefficientOfVariation).toBe(0);
  });

  it("reports high stddev/CoV for a bursty series with the same average as a steady one", () => {
    const steady = computeJitterStats([60, 60, 60, 60]);
    const bursty = computeJitterStats([30, 90, 30, 90]);
    expect(bursty.mean).toBe(steady.mean); // same average throughput
    expect(bursty.stddev).toBeGreaterThan(steady.stddev); // but visibly less consistent
    expect(bursty.coefficientOfVariation).toBeGreaterThan(steady.coefficientOfVariation);
  });

  it("ignores non-finite and non-positive samples (e.g. the fps:0 seen on the very first sample)", () => {
    const stats = computeJitterStats([0, 60, 60, NaN, 60]);
    expect(stats.count).toBe(3);
    expect(stats.mean).toBe(60);
  });

  it("computes min/max correctly", () => {
    const stats = computeJitterStats([55, 70, 60, 45]);
    expect(stats.min).toBe(45);
    expect(stats.max).toBe(70);
  });
});
