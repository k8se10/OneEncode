import type { EncoderName, Rendition } from "../config/schema.js";

/**
 * Encoder-specific rate-control args. Kept isolated here so adding a new
 * encoder means touching exactly one place, not every call site.
 */
function videoEncodeArgs(encoder: EncoderName, rendition: Rendition): string[] {
  const gop = String(Math.round(rendition.fps * rendition.keyframeIntervalSec));
  const quality = rendition.videoQuality;
  const bitrateK = rendition.videoBitrateKbps;

  const requireBitrateK = (): number => {
    if (bitrateK === undefined) {
      throw new Error(
        `Rendition "${rendition.id}": must set videoBitrateKbps when videoQuality isn't set (config schema should have caught this)`,
      );
    }
    return bitrateK;
  };

  switch (encoder) {
    case "h264_nvenc":
    case "hevc_nvenc":
    case "av1_nvenc":
      if (quality) {
        return [
          "-c:v", encoder,
          "-preset", "p5",
          "-rc", quality.mode === "cq" ? "vbr" : quality.mode,
          "-cq", String(quality.value),
          "-g", gop, "-bf", "2",
        ];
      }
      {
        const bv = requireBitrateK();
        return [
          "-c:v", encoder,
          "-preset", "p4",
          "-rc", "cbr",
          "-b:v", `${bv}k`,
          "-maxrate", `${bv}k`,
          "-bufsize", `${bv * 2}k`,
          "-g", gop, "-bf", "2",
        ];
      }

    case "h264_amf":
    case "hevc_amf":
    case "av1_amf":
      return [
        "-c:v", encoder,
        "-quality", "speed",
        "-rc", "cbr",
        "-b:v", `${requireBitrateK()}k`,
        "-g", gop,
      ];

    case "libx264":
    case "libx265":
      if (quality) {
        return ["-c:v", encoder, "-preset", "veryfast", "-crf", String(quality.value), "-g", gop];
      }
      {
        const bv = requireBitrateK();
        return [
          "-c:v", encoder,
          "-preset", "veryfast",
          "-b:v", `${bv}k`,
          "-maxrate", `${bv}k`,
          "-bufsize", `${bv * 2}k`,
          "-g", gop,
        ];
      }
  }
}

function scaleFilterArgs(rendition: Rendition): string[] {
  if (rendition.resolution === "source") return [];
  return ["-vf", `scale=${rendition.resolution.width}:${rendition.resolution.height}`];
}

/** Where an encoded (or copied) stream ends up — shared by every argv builder below. */
export type EncodeOutputSink = { kind: "rtmp"; url: string } | { kind: "local-file"; path: string };

function outputSinkArgs(output: EncodeOutputSink): string[] {
  return output.kind === "rtmp" ? ["-f", "flv", output.url] : ["-movflags", "+faststart", output.path];
}

/**
 * Builds an ffmpeg argv array that decodes `inputUrl`, applies one
 * rendition's scale/encode profile, and writes to `output`. Used for the
 * per-rendition encode step (src/rendition/) and, in the baseline benchmark
 * script, to simulate today's naive "one full decode+encode per destination"
 * approach by pointing inputUrl at the original ingest directly instead of
 * the relay. Always an argv array, never a shell string.
 */
export function buildEncodeArgv(
  inputUrl: string,
  rendition: Rendition,
  encoder: EncoderName,
  output: EncodeOutputSink,
): string[] {
  return [
    "-hide_banner",
    "-loglevel", "warning",
    "-stats",
    "-i", inputUrl,
    ...scaleFilterArgs(rendition),
    ...videoEncodeArgs(encoder, rendition),
    "-c:a", "aac",
    "-b:a", `${rendition.audioBitrateKbps}k`,
    "-ar", "48000",
    ...outputSinkArgs(output),
  ];
}

/**
 * Builds a cheap stream-copy argv (`-c copy`, no decode/re-encode) from a
 * rendition-relay path to a leg's real destination. This is what makes
 * rendition dedup (CLAUDE.md architecture decision #9) actually cheap: N
 * destinations sharing one rendition each just remux the same already-
 * encoded bytes instead of re-encoding them.
 */
export function buildCopyArgv(inputUrl: string, output: EncodeOutputSink): string[] {
  return ["-hide_banner", "-loglevel", "warning", "-stats", "-i", inputUrl, "-c", "copy", ...outputSinkArgs(output)];
}

/** Builds the argv for the single decode/relay process (source -> local mezzanine relay). */
export function buildRelayArgv(ingestUrl: string, relayPublishUrl: string, opts: {
  encoder: EncoderName;
  preset: string;
  bitrateKbps: number;
}): string[] {
  return [
    "-hide_banner",
    "-loglevel", "warning",
    "-stats",
    "-i", ingestUrl,
    "-c:v", opts.encoder,
    "-preset", opts.preset,
    "-tune", "ull",
    "-rc", "cbr",
    "-b:v", `${opts.bitrateKbps}k`,
    "-maxrate", `${opts.bitrateKbps}k`,
    "-bufsize", `${Math.round(opts.bitrateKbps / 2)}k`,
    "-g", "60",
    "-bf", "0",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-f", "flv",
    relayPublishUrl,
  ];
}
