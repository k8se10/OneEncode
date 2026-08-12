import { describe, expect, it } from "vitest";
import { computeBackoffMs, isOverRestartCap } from "../../src/health/monitor.js";

describe("computeBackoffMs", () => {
  const policy = { backoffInitialMs: 2000, backoffMaxMs: 60000 };

  it("doubles each attempt starting from backoffInitialMs", () => {
    expect(computeBackoffMs(1, policy)).toBe(2000);
    expect(computeBackoffMs(2, policy)).toBe(4000);
    expect(computeBackoffMs(3, policy)).toBe(8000);
    expect(computeBackoffMs(4, policy)).toBe(16000);
  });

  it("caps at backoffMaxMs", () => {
    expect(computeBackoffMs(10, policy)).toBe(60000);
    expect(computeBackoffMs(100, policy)).toBe(60000);
  });

  it("treats attempt 0 or negative as attempt 1", () => {
    expect(computeBackoffMs(0, policy)).toBe(2000);
    expect(computeBackoffMs(-5, policy)).toBe(2000);
  });
});

describe("isOverRestartCap", () => {
  const policy = { maxRestartsPerHour: 3 };
  const now = 1_000_000_000_000;

  it("is not over cap when below the threshold", () => {
    expect(isOverRestartCap([now - 1000, now - 2000], now, policy)).toBe(false);
  });

  it("is over cap once the threshold is reached", () => {
    expect(isOverRestartCap([now - 1000, now - 2000, now - 3000], now, policy)).toBe(true);
  });

  it("ignores restarts older than one hour", () => {
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    expect(isOverRestartCap([twoHoursAgo, twoHoursAgo, twoHoursAgo], now, policy)).toBe(false);
  });

  it("counts a restart exactly on the one-hour boundary as expired", () => {
    const exactlyOneHourAgo = now - 60 * 60 * 1000;
    expect(isOverRestartCap([exactlyOneHourAgo, exactlyOneHourAgo, exactlyOneHourAgo], now, policy)).toBe(false);
  });
});
