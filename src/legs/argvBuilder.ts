import type { EncoderName, LegConfig } from "../config/schema.js";

/**
 * Encoder-specific rate-control args. Kept isolated here so adding a new
 * encoder means touching exactly one place, not every call site.
 */
function videoEncodeArgs(
  encoder: EncoderName,
  leg: LegConfig,
): string[] {
  const gop = String(Math.round(leg.fps * leg.keyframeIntervalSec));
  const quality = leg.videoQuality;
  const bitrateK = leg.videoBitrateKbps;

  const requireBitrateK = (): number => {
    if (bitrateK === undefined) {
      throw new Error(
        `Leg "${leg.id}": must set videoBitrateKbps when videoQuality isn't set (config schema should have caught this)`,
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

function scaleFilterArgs(leg: LegConfig): string[] {
  if (leg.resolution === "source") return [];
  return ["-vf", `scale=${leg.resolution.width}:${leg.resolution.height}`];
}

export interface BuildLegArgvOptions {
  leg: LegConfig;
  relayUrl: string;
  encoder: EncoderName;
  /** Required when leg.type === "rtmp-push"; the resolved real destination URL (never logged raw). */
  destinationUrl?: string;
  /** Required when leg.type === "local-file"; the fully resolved output file path. */
  resolvedOutputPath?: string;
}

/**
 * Builds an ffmpeg argv array for one destination leg, reading from the local
 * relay (never the original ingest). Always an array, never a shell string —
 * every value here may originate from config, so no shell interpolation.
 */
export function buildLegArgv(opts: BuildLegArgvOptions): string[] {
  const { leg, relayUrl, encoder } = opts;

  const argv: string[] = [
    "-hide_banner",
    "-loglevel", "warning",
    "-stats",
    "-i", relayUrl,
    ...scaleFilterArgs(leg),
    ...videoEncodeArgs(encoder, leg),
    "-c:a", "aac",
    "-b:a", `${leg.audioBitrateKbps}k`,
    "-ar", "48000",
  ];

  if (leg.type === "rtmp-push") {
    if (!opts.destinationUrl) {
      throw new Error(`buildLegArgv: leg "${leg.id}" is rtmp-push but no destinationUrl was provided`);
    }
    argv.push("-f", "flv", opts.destinationUrl);
  } else {
    if (!opts.resolvedOutputPath) {
      throw new Error(`buildLegArgv: leg "${leg.id}" is local-file but no resolvedOutputPath was provided`);
    }
    argv.push("-movflags", "+faststart", opts.resolvedOutputPath);
  }

  return argv;
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
