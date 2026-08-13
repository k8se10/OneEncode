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

function scaleFilterExpr(rendition: Rendition): string | undefined {
  if (rendition.resolution === "source") return undefined;
  return `scale=${rendition.resolution.width}:${rendition.resolution.height}`;
}

function scaleFilterArgs(rendition: Rendition): string[] {
  const expr = scaleFilterExpr(rendition);
  return expr ? ["-vf", expr] : [];
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

/**
 * Encoder-specific low-latency args for the relay's mezzanine re-encode.
 * Split out because NVENC's `-tune ull`/`-rc cbr` are NOT generic ffmpeg
 * flags — they're NVENC-only syntax. Passing them to libx264/libx265/AMF
 * makes ffmpeg reject the command outright. This went unnoticed for a long
 * time because every test in this project so far used the schema default
 * (`h264_nvenc`) for `relay.encoder` — found via live testing once a
 * non-NVENC relay encoder was actually tried (see PATCHNOTES.md).
 */
function relayEncodeArgs(encoder: EncoderName, preset: string, bitrateKbps: number): string[] {
  const bufsizeK = Math.round(bitrateKbps / 2);
  switch (encoder) {
    case "h264_nvenc":
    case "hevc_nvenc":
    case "av1_nvenc":
      return [
        "-c:v", encoder,
        "-preset", preset,
        "-tune", "ull",
        "-rc", "cbr",
        "-b:v", `${bitrateKbps}k`, "-maxrate", `${bitrateKbps}k`, "-bufsize", `${bufsizeK}k`,
        "-g", "60", "-bf", "0",
      ];

    case "h264_amf":
    case "hevc_amf":
    case "av1_amf":
      // AMF has no direct equivalent of NVENC's "-tune ull" and doesn't use
      // a generic "-preset" value — "-quality speed" is its own low-latency
      // knob, same as the rendition encoder args use elsewhere in this file.
      return [
        "-c:v", encoder,
        "-quality", "speed",
        "-rc", "cbr",
        "-b:v", `${bitrateKbps}k`,
        "-g", "60",
      ];

    case "libx264":
    case "libx265":
      // libx264/265 has no "-rc" option and no NVENC-style numbered presets
      // ("p1" etc, the schema's default, is meaningless here) — the caller
      // is responsible for setting relay.preset to a real libx264 preset
      // name (e.g. "ultrafast") when choosing this encoder family; ffmpeg
      // will fail with a clear "unknown preset" error otherwise, not a
      // confusing crash.
      return [
        "-c:v", encoder,
        "-preset", preset,
        "-tune", "zerolatency",
        "-b:v", `${bitrateKbps}k`, "-maxrate", `${bitrateKbps}k`, "-bufsize", `${bufsizeK}k`,
        "-g", "60", "-bf", "0",
      ];
  }
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
    ...relayEncodeArgs(opts.encoder, opts.preset, opts.bitrateKbps),
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-f", "flv",
    relayPublishUrl,
  ];
}

/** One rendition's fully-resolved encode target within the combined process below. */
export interface RenditionEncodeTarget {
  rendition: Rendition;
  encoder: EncoderName;
  outputUrl: string;
}

/**
 * Builds a single ffmpeg command that decodes the ingest exactly once and
 * splits the decoded frames (`-filter_complex split`) into N+1 encode
 * branches: the relay's own mezzanine re-encode (published exactly as
 * `buildRelayArgv` would, unchanged for anything that reads it) plus one
 * branch per rendition target, each scaled/encoded to its own profile and
 * published straight to its own rendition-relay path.
 *
 * This replaces the previous design (decode/relay publishes over RTMP,
 * each rendition is a SEPARATE process that re-subscribes and re-encodes)
 * because a live re-encode of an already-relayed RTMP stream measurably
 * amplifies frame-pacing jitter — confirmed via
 * `scripts/jitterNoRtmpHopTest.ts` (task #24): the same split-from-one-
 * decode pattern used here measured CoV=0.0000 on the rendition branch,
 * matching baseline exactly, versus ~0.074 when that branch instead read
 * the relay back over RTMP from a separate process. See CLAUDE.md's
 * architecture section for the full writeup and the failure-isolation
 * tradeoff this accepts: a crash here now takes down the relay and every
 * rendition together (they already implicitly depended on the relay being
 * alive), where each used to fail independently. Destination legs — the
 * boundary that matters most, since a flaky platform shouldn't affect
 * encoding — are untouched and still run as fully independent processes.
 *
 * Falls back to a plain `buildRelayArgv` (no filter_complex) when there
 * are no rendition targets, rather than emitting a degenerate single-way
 * split.
 */
export function buildCombinedRelayAndRenditionsArgv(
  ingestUrl: string,
  relayPublishUrl: string,
  relayOpts: { encoder: EncoderName; preset: string; bitrateKbps: number },
  renditionTargets: RenditionEncodeTarget[],
): string[] {
  if (renditionTargets.length === 0) {
    return buildRelayArgv(ingestUrl, relayPublishUrl, relayOpts);
  }

  const splitLabels = ["vrelay", ...renditionTargets.map((_, i) => `vr${i}`)];
  const filterParts = [`[0:v]split=${splitLabels.length}${splitLabels.map((l) => `[${l}]`).join("")}`];

  const renditionMapLabels = renditionTargets.map((target, i) => {
    const rawLabel = splitLabels[1 + i];
    const scaleExpr = scaleFilterExpr(target.rendition);
    if (!scaleExpr) return rawLabel;
    const scaledLabel = `${rawLabel}s`;
    filterParts.push(`[${rawLabel}]${scaleExpr}[${scaledLabel}]`);
    return scaledLabel;
  });

  const argv: string[] = [
    "-hide_banner",
    "-loglevel", "warning",
    "-stats",
    // A real live RTMP source (unlike the synthetic lavfi source every
    // prior test in this project used) can need more time/data than
    // ffmpeg's defaults (analyzeduration=5s, probesize=5MB) allow before
    // its stream layout is fully known -- without this, filtergraph
    // binding can fail outright ("[0:v] matches no streams") if the
    // filter_complex graph gets built before probing finishes. Only
    // surfaced via real OBS testing; the synthetic source's stream info
    // is always instantly and deterministically available.
    "-analyzeduration", "10000000", "-probesize", "10000000",
    "-i", ingestUrl,
    "-filter_complex", filterParts.join(";"),
    "-map", "[vrelay]", "-map", "0:a",
    ...relayEncodeArgs(relayOpts.encoder, relayOpts.preset, relayOpts.bitrateKbps),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-f", "flv", relayPublishUrl,
  ];

  renditionTargets.forEach((target, i) => {
    argv.push(
      "-map", `[${renditionMapLabels[i]}]`, "-map", "0:a",
      ...videoEncodeArgs(target.encoder, target.rendition),
      "-c:a", "aac", "-b:a", `${target.rendition.audioBitrateKbps}k`, "-ar", "48000",
      "-f", "flv", target.outputUrl,
    );
  });

  return argv;
}
