import { describe, expect, it } from "vitest";
import {
  buildEncodeArgv,
  buildCopyArgv,
  buildRelayArgv,
  buildCombinedRelayAndRenditionsArgv,
  type RenditionEncodeTarget,
} from "../../src/legs/argvBuilder.js";
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
    // Regression test: bufsize used to be 2x the target bitrate, which a
    // real Twitch Inspector capture showed let "CBR" swing wide enough to
    // look bursty/VBR-like (avg on target, but noisy per-second delivery).
    // 1x (a 1s VBV window) is the standard tightened setting for live CBR.
    const bufsizeIdx = argv.indexOf("-bufsize");
    expect(argv[bufsizeIdx + 1]).toBe("6000k");
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

  it("uses a 1x-bitrate bufsize for libx264's bitrate-based branch too (same tightened CBR fix as NVENC)", () => {
    const rendition: Rendition = {
      ...baseRendition,
      resolution: "source",
      videoBitrateKbps: 3500,
      encoderPreference: ["libx264"],
    };
    const argv = buildEncodeArgv("rtmp://127.0.0.1:1935/relay/live", rendition, "libx264", {
      kind: "local-file",
      path: "out.mp4",
    });
    const bufsizeIdx = argv.indexOf("-bufsize");
    expect(argv[bufsizeIdx + 1]).toBe("3500k");
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

  it("does not emit NVENC-only flags (-tune ull, -rc) for a libx264 relay encoder", () => {
    const argv = buildRelayArgv("rtmp://127.0.0.1:1935/ingest/live", "rtmp://127.0.0.1:1935/relay/live", {
      encoder: "libx264",
      preset: "ultrafast",
      bitrateKbps: 20000,
    });
    // Real bug found via live testing (see PATCHNOTES.md): these NVENC-only
    // flags used to be emitted unconditionally, which made ffmpeg reject the
    // command outright for any non-NVENC relay.encoder.
    expect(argv).not.toContain("-rc");
    const tuneIdx = argv.indexOf("-tune");
    expect(argv[tuneIdx + 1]).toBe("zerolatency"); // libx264's real low-latency tune, not NVENC's "ull"
    expect(argv).toContain("libx264");
    expect(argv).toContain("ultrafast");
  });

  it("uses AMF's -quality speed instead of NVENC's -tune/-preset for an AMF relay encoder", () => {
    const argv = buildRelayArgv("rtmp://127.0.0.1:1935/ingest/live", "rtmp://127.0.0.1:1935/relay/live", {
      encoder: "h264_amf",
      preset: "p1", // deliberately an NVENC-shaped preset value — AMF must ignore it, not pass it through
      bitrateKbps: 20000,
    });
    expect(argv).not.toContain("-tune");
    expect(argv).not.toContain("p1");
    expect(argv).toContain("-quality");
    expect(argv).toContain("speed");
  });
});

describe("buildCombinedRelayAndRenditionsArgv", () => {
  const relayOpts = { encoder: "h264_nvenc" as const, preset: "p1", bitrateKbps: 40000 };

  it("falls back to buildRelayArgv exactly when there are no rendition targets", () => {
    const combined = buildCombinedRelayAndRenditionsArgv(
      "rtmp://127.0.0.1:1935/ingest/live",
      "rtmp://127.0.0.1:1935/relay/live",
      relayOpts,
      [],
    );
    const plain = buildRelayArgv("rtmp://127.0.0.1:1935/ingest/live", "rtmp://127.0.0.1:1935/relay/live", relayOpts);
    expect(combined).toEqual(plain);
    expect(combined).not.toContain("-filter_complex");
  });

  it("decodes once and splits into one branch per rendition, no separate relay branch — task #24 fix", () => {
    // Deliberately mixes: one rendition that needs scaling (1080p) on NVENC,
    // one at source resolution (no scale filter should appear for it) on AMF
    // — exercises both the scale/no-scale split and per-encoder-family argv
    // in the same command, since that's exactly what a real multi-rendition
    // pipeline looks like.
    const rendition1080p: Rendition = {
      id: "1080p",
      resolution: { width: 1920, height: 1080 },
      fps: 60,
      videoBitrateKbps: 6000,
      audioBitrateKbps: 160,
      keyframeIntervalSec: 2,
      encoderPreference: ["h264_nvenc"],
    };
    const renditionSource: Rendition = {
      id: "source-res",
      resolution: "source",
      fps: 60,
      videoBitrateKbps: 3500,
      audioBitrateKbps: 128,
      keyframeIntervalSec: 2,
      encoderPreference: ["h264_amf"],
    };
    const targets: RenditionEncodeTarget[] = [
      { rendition: rendition1080p, encoder: "h264_nvenc", outputUrl: "rtmp://127.0.0.1:1935/rendition/1080p/live" },
      { rendition: renditionSource, encoder: "h264_amf", outputUrl: "rtmp://127.0.0.1:1935/rendition/source-res/live" },
    ];

    const argv = buildCombinedRelayAndRenditionsArgv(
      "rtmp://127.0.0.1:1935/ingest/live",
      "rtmp://127.0.0.1:1935/relay/live",
      relayOpts,
      targets,
    );

    // Single decode, single -i — the whole point of the fix.
    expect(argv.filter((tok) => tok === "-i")).toHaveLength(1);

    const filterIdx = argv.indexOf("-filter_complex");
    expect(filterIdx).toBeGreaterThan(-1);
    const filterComplex = argv[filterIdx + 1];
    expect(filterComplex).toContain("split=2"); // 2 renditions, one decode, no separate relay branch
    expect(filterComplex).toContain("scale=1920:1080"); // only the 1080p branch scales
    expect(filterComplex.match(/scale=/g)).toHaveLength(1); // source-res branch must NOT get a scale filter

    // 2 outputs total (2 renditions, no relay mezzanine branch) => audio mapped twice, one encoder instance each.
    expect(argv.filter((tok) => tok === "0:a")).toHaveLength(2);
    expect(argv.filter((tok) => tok === "-map")).toHaveLength(4); // one video + one audio map per output

    // No separate relay mezzanine branch anymore — nothing in the codebase
    // ever subscribed to it (every leg reads its own rendition URL
    // directly), so it's no longer built or published at all.
    expect(argv).not.toContain("rtmp://127.0.0.1:1935/relay/live");
    expect(argv).not.toContain("ull");

    // 1080p rendition branch: NVENC bitrate-mode flags, published to its own rendition URL.
    expect(argv).toContain("rtmp://127.0.0.1:1935/rendition/1080p/live");
    const nvencBitrateIdx = argv.indexOf("6000k");
    expect(nvencBitrateIdx).toBeGreaterThan(-1);

    // source-res rendition branch: AMF flags (-quality speed, no -tune), published to its own URL.
    expect(argv).toContain("rtmp://127.0.0.1:1935/rendition/source-res/live");
    expect(argv).toContain("-quality");
    expect(argv).toContain("speed");

    // Every video map target is a bracketed filter-graph label, never a raw stream specifier.
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "-map" && argv[i + 1] !== "0:a") {
        expect(argv[i + 1]).toMatch(/^\[.+\]$/);
      }
    }
  });

  it("maps a source-resolution-only rendition set straight to their raw split labels (no scale filter at all)", () => {
    const rendition: Rendition = {
      id: "source-only",
      resolution: "source",
      fps: 60,
      videoQuality: { mode: "cq", value: 19 },
      audioBitrateKbps: 192,
      keyframeIntervalSec: 2,
      encoderPreference: ["h264_nvenc"],
    };
    const argv = buildCombinedRelayAndRenditionsArgv(
      "rtmp://127.0.0.1:1935/ingest/live",
      "rtmp://127.0.0.1:1935/relay/live",
      relayOpts,
      [{ rendition, encoder: "h264_nvenc", outputUrl: "rtmp://127.0.0.1:1935/rendition/source-only/live" }],
    );
    const filterComplex = argv[argv.indexOf("-filter_complex") + 1];
    expect(filterComplex).toBe("[0:v]split=1[vr0]");
    expect(argv).toContain("[vr0]");
    expect(argv).not.toContain("-vf"); // scaling happens inside filter_complex, not as a separate -vf
  });

  describe("decodeHwaccel (CUDA decode/scale — real nvidia-smi dmon finding: enc busy, dec idle)", () => {
    it("omits -hwaccel and uses plain scale when decodeHwaccel is not set (default off)", () => {
      const rendition: Rendition = {
        id: "r1",
        resolution: { width: 1920, height: 1080 },
        fps: 60,
        videoBitrateKbps: 6000,
        audioBitrateKbps: 160,
        keyframeIntervalSec: 2,
        encoderPreference: ["h264_nvenc"],
      };
      const argv = buildCombinedRelayAndRenditionsArgv(
        "rtmp://127.0.0.1:1935/ingest/live",
        "rtmp://127.0.0.1:1935/relay/live",
        relayOpts,
        [{ rendition, encoder: "h264_nvenc", outputUrl: "rtmp://127.0.0.1:1935/rendition/r1/live" }],
      );
      expect(argv).not.toContain("-hwaccel");
      const filterComplex = argv[argv.indexOf("-filter_complex") + 1];
      expect(filterComplex).toContain("scale=1920:1080");
      expect(filterComplex).not.toContain("scale_cuda");
      expect(filterComplex).not.toContain("hwdownload");
    });

    it("adds -hwaccel cuda and uses scale_cuda for an all-NVENC target set, no hwdownload needed", () => {
      const rendition: Rendition = {
        id: "r1",
        resolution: { width: 1920, height: 1080 },
        fps: 60,
        videoBitrateKbps: 6000,
        audioBitrateKbps: 160,
        keyframeIntervalSec: 2,
        encoderPreference: ["h264_nvenc"],
      };
      const argv = buildCombinedRelayAndRenditionsArgv(
        "rtmp://127.0.0.1:1935/ingest/live",
        "rtmp://127.0.0.1:1935/relay/live",
        relayOpts,
        [{ rendition, encoder: "h264_nvenc", outputUrl: "rtmp://127.0.0.1:1935/rendition/r1/live" }],
        { decodeHwaccel: true },
      );
      const hwaccelIdx = argv.indexOf("-hwaccel");
      expect(hwaccelIdx).toBeGreaterThan(-1);
      expect(argv[hwaccelIdx + 1]).toBe("cuda");
      expect(argv).toContain("-hwaccel_output_format");
      // -hwaccel must come before -i so it applies to the input, not an output.
      expect(hwaccelIdx).toBeLessThan(argv.indexOf("-i"));

      const filterComplex = argv[argv.indexOf("-filter_complex") + 1];
      expect(filterComplex).toContain("scale_cuda=1920:1080");
      expect(filterComplex).not.toContain("hwdownload"); // NVENC consumes CUDA frames directly
      expect(argv).toContain("[vr0s]"); // mapped straight from the scaled CUDA label
    });

    it("downloads back to system memory only for a non-NVENC target when decodeHwaccel is on (mixed NVENC + libx264)", () => {
      const nvencRendition: Rendition = {
        id: "nvenc-target",
        resolution: { width: 1920, height: 1080 },
        fps: 60,
        videoBitrateKbps: 6000,
        audioBitrateKbps: 160,
        keyframeIntervalSec: 2,
        encoderPreference: ["h264_nvenc"],
      };
      const cpuRendition: Rendition = {
        id: "cpu-target",
        resolution: { width: 1280, height: 720 },
        fps: 60,
        videoBitrateKbps: 3500,
        audioBitrateKbps: 128,
        keyframeIntervalSec: 2,
        encoderPreference: ["libx264"],
      };
      const argv = buildCombinedRelayAndRenditionsArgv(
        "rtmp://127.0.0.1:1935/ingest/live",
        "rtmp://127.0.0.1:1935/relay/live",
        relayOpts,
        [
          { rendition: nvencRendition, encoder: "h264_nvenc", outputUrl: "rtmp://127.0.0.1:1935/rendition/nvenc-target/live" },
          { rendition: cpuRendition, encoder: "libx264", outputUrl: "rtmp://127.0.0.1:1935/rendition/cpu-target/live" },
        ],
        { decodeHwaccel: true },
      );

      const filterComplex = argv[argv.indexOf("-filter_complex") + 1];
      expect(filterComplex).toContain("scale_cuda=1920:1080"); // NVENC target: GPU scale, no download
      expect(filterComplex).toContain("scale_cuda=1280:720"); // CPU target: GPU scale first...
      expect(filterComplex).toContain("hwdownload,format=nv12"); // ...then downloaded before libx264
      expect(argv).toContain("[vr0s]"); // NVENC target maps from the CUDA-resident scaled label
      expect(argv).toContain("[vr1sd]"); // libx264 target maps from the downloaded label
    });
  });
});
