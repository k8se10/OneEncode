import { describe, expect, it } from "vitest";
import { buildLegArgv, buildRelayArgv } from "../../src/legs/argvBuilder.js";
import type { LegConfig } from "../../src/config/schema.js";

const baseLeg = {
  id: "test-leg",
  enabled: true,
  fps: 60,
  audioBitrateKbps: 160,
  keyframeIntervalSec: 2,
  priority: 0,
};

describe("buildLegArgv", () => {
  it("builds an rtmp-push leg with a bitrate-based encoder", () => {
    const leg: LegConfig = {
      ...baseLeg,
      type: "rtmp-push",
      destinationUrlEnv: "SOME_ENV",
      resolution: { width: 1920, height: 1080 },
      videoBitrateKbps: 6000,
      encoderPreference: ["h264_nvenc"],
    };
    const argv = buildLegArgv({
      leg,
      relayUrl: "rtmp://127.0.0.1:1935/relay/live",
      encoder: "h264_nvenc",
      destinationUrl: "rtmp://real.example.com/live/SECRET_KEY",
    });

    expect(argv).toContain("-i");
    expect(argv).toContain("rtmp://127.0.0.1:1935/relay/live");
    expect(argv).toContain("scale=1920:1080");
    expect(argv).toContain("h264_nvenc");
    expect(argv.at(-1)).toBe("rtmp://real.example.com/live/SECRET_KEY");
    expect(argv.at(-2)).toBe("flv");
    expect(argv.at(-3)).toBe("-f");
    // no shell string anywhere — every element is a discrete argv token
    for (const token of argv) {
      expect(typeof token).toBe("string");
    }
  });

  it("throws if an rtmp-push leg is built without a destination URL", () => {
    const leg: LegConfig = {
      ...baseLeg,
      type: "rtmp-push",
      destinationUrlEnv: "SOME_ENV",
      resolution: "source",
      videoBitrateKbps: 3000,
      encoderPreference: ["libx264"],
    };
    expect(() =>
      buildLegArgv({ leg, relayUrl: "rtmp://127.0.0.1:1935/relay/live", encoder: "libx264" }),
    ).toThrow(/destinationUrl/);
  });

  it("builds a local-file leg using cq quality mode", () => {
    const leg: LegConfig = {
      ...baseLeg,
      type: "local-file",
      outputDir: "recordings",
      filenamePattern: "archive_{timestamp}.mp4",
      resolution: "source",
      videoQuality: { mode: "cq", value: 19 },
      encoderPreference: ["h264_nvenc"],
    };
    const argv = buildLegArgv({
      leg,
      relayUrl: "rtmp://127.0.0.1:1935/relay/live",
      encoder: "h264_nvenc",
      resolvedOutputPath: "D:\\projects\\OneEncode\\recordings\\archive_test.mp4",
    });

    expect(argv).not.toContain("-vf");
    expect(argv).toContain("-cq");
    expect(argv).toContain("19");
    expect(argv.at(-1)).toBe("D:\\projects\\OneEncode\\recordings\\archive_test.mp4");
  });

  it("throws if neither videoQuality nor videoBitrateKbps is set", () => {
    const leg = {
      ...baseLeg,
      type: "local-file",
      outputDir: "recordings",
      filenamePattern: "x_{timestamp}.mp4",
      resolution: "source",
      encoderPreference: ["libx264"],
    } as unknown as LegConfig;
    expect(() =>
      buildLegArgv({ leg, relayUrl: "rtmp://x/relay/live", encoder: "libx264", resolvedOutputPath: "out.mp4" }),
    ).toThrow(/videoBitrateKbps/);
  });
});

describe("buildRelayArgv", () => {
  it("builds the decode/relay argv", () => {
    const argv = buildRelayArgv("rtmp://127.0.0.1:1935/ingest/live", "rtmp://127.0.0.1:1935/relay/live", {
      encoder: "h264_nvenc",
      preset: "p1",
      bitrateKbps: 40000,
    });
    expect(argv).toContain("rtmp://127.0.0.1:1935/ingest/live");
    expect(argv).toContain("rtmp://127.0.0.1:1935/relay/live");
    expect(argv).toContain("-tune");
    expect(argv).toContain("ull");
  });
});
