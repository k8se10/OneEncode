import { describe, expect, it } from "vitest";
import { buildEncodeArgv, buildCopyArgv, buildRelayArgv } from "../../src/legs/argvBuilder.js";
import type { Rendition } from "../../src/config/schema.js";

const baseRendition = {
  id: "test-rendition",
  fps: 60,
  audioBitrateKbps: 160,
  keyframeIntervalSec: 2,
};

describe("buildEncodeArgv", () => {
  it("builds an rtmp-push output with a bitrate-based encoder", () => {
    const rendition: Rendition = {
      ...baseRendition,
      resolution: { width: 1920, height: 1080 },
      videoBitrateKbps: 6000,
      encoderPreference: ["h264_nvenc"],
    };
    const argv = buildEncodeArgv("rtmp://127.0.0.1:1935/relay/live", rendition, "h264_nvenc", {
      kind: "rtmp",
      url: "rtmp://real.example.com/live/SECRET_KEY",
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

  it("builds a local-file output using cq quality mode, no scale filter at source resolution", () => {
    const rendition: Rendition = {
      ...baseRendition,
      resolution: "source",
      videoQuality: { mode: "cq", value: 19 },
      encoderPreference: ["h264_nvenc"],
    };
    const argv = buildEncodeArgv("rtmp://127.0.0.1:1935/relay/live", rendition, "h264_nvenc", {
      kind: "local-file",
      path: "D:\\projects\\OneEncode\\recordings\\archive_test.mp4",
    });

    expect(argv).not.toContain("-vf");
    expect(argv).toContain("-cq");
    expect(argv).toContain("19");
    expect(argv.at(-1)).toBe("D:\\projects\\OneEncode\\recordings\\archive_test.mp4");
  });

  it("throws if neither videoQuality nor videoBitrateKbps is set", () => {
    const rendition = {
      ...baseRendition,
      resolution: "source",
      encoderPreference: ["libx264"],
    } as unknown as Rendition;
    expect(() =>
      buildEncodeArgv("rtmp://x/relay/live", rendition, "libx264", { kind: "local-file", path: "out.mp4" }),
    ).toThrow(/videoBitrateKbps/);
  });
});

describe("buildCopyArgv", () => {
  it("builds a stream-copy argv with no encode flags", () => {
    const argv = buildCopyArgv("rtmp://127.0.0.1:1935/rendition/1080p60/live", {
      kind: "rtmp",
      url: "rtmp://real.example.com/live/SECRET_KEY",
    });
    expect(argv).toContain("-c");
    expect(argv).toContain("copy");
    expect(argv).not.toContain("-c:v");
    expect(argv).not.toContain("-vf");
    expect(argv.at(-1)).toBe("rtmp://real.example.com/live/SECRET_KEY");
  });

  it("builds a local-file stream-copy output", () => {
    const argv = buildCopyArgv("rtmp://127.0.0.1:1935/rendition/1080p60/live", {
      kind: "local-file",
      path: "D:\\out.mp4",
    });
    expect(argv.at(-1)).toBe("D:\\out.mp4");
    expect(argv).toContain("-movflags");
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
