import type { EncoderName, Rendition } from "../config/schema.js";
import { isNvencEncoder } from "../nvenc/sessionTracker.js";

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
          // A 1x-bitrate VBV buffer (1s window) instead of 2x -- a wider
          // buffer still satisfies "CBR" on average but lets short-term
          // bitrate swing much further before the constraint bites, which
          // is exactly the spiky, bursty-looking delivered bitrate a real
          // Twitch Inspector capture showed (avg right on target, but wide
          // per-second swings). 1x matches standard live-CBR-streaming
          // guidance; a looser buffer is more appropriate for local
          // VBR/CQ recording where burstiness doesn't matter.
          "-bufsize", `${bv}k`,
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
          // Same tightened 1x-bitrate VBV buffer as the NVENC branch above --
          // see that comment for why (real Twitch Inspector evidence of a
          // too-loose 2x buffer producing bursty delivered bitrate).
          "-bufsize", `${bv}k`,
          "-g", gop,
        ];
      }
  }
}

function scaleFilterExpr(rendition: Rendition, useCuda = false): string | undefined {
  if (rendition.resolution === "source") return undefined;
  const filterName = useCuda ? "scale_cuda" : "scale";
  return `${filterName}=${rendition.resolution.width}:${rendition.resolution.height}`;
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
 * splits the decoded frames (`-filter_complex split`) into one encode
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
 * NO LONGER publishes a separate "[vrelay]" mezzanine branch (removed
 * 2026-08-13, real GPU contention found during the 3-platform test — this
 * branch was running at full source resolution/40Mbps/lowest-latency
 * preset, the single most expensive branch in the whole process, and
 * nothing in the codebase ever subscribed to it: every leg reads its own
 * `/rendition/<id>` path directly, never `relay.url` itself, confirmed via
 * a full grep before removing it). Cutting it drops the NVENC session
 * count by one for every config, with zero functional loss. `relayOpts`
 * (the relay's own encoder/preset/bitrate) is now only used by the
 * `buildRelayArgv` fallback below, for the degenerate zero-rendition case.
 *
 * Falls back to a plain `buildRelayArgv` (no filter_complex) when there
 * are no rendition targets, rather than emitting a degenerate zero-way
 * split.
 *
 * `decodeHwaccel` (config: `relay.decodeHwaccel`, off by default): decodes
 * the ingest via NVDEC (`-hwaccel cuda -hwaccel_output_format cuda`)
 * instead of software/CPU decode. Found via a real `nvidia-smi dmon`
 * observation — the encode (`enc`) engine ran up to ~90% while decode
 * (`dec`) sat at 0%, because nothing here ever told ffmpeg to use the
 * GPU's decode engine for the input side; only the encoders were hardware.
 * When on, scaling for any target also moves to GPU (`scale_cuda` instead
 * of `scale`), so an NVENC-encoded target never leaves GPU memory between
 * decode and encode. A target using a non-NVENC encoder (AMF/libx264/
 * libx265 — e.g. after NVENC session-ceiling fallback) still works: its
 * branch gets an explicit `hwdownload,format=nv12` step back to system
 * memory before that encoder, since only NVENC can consume CUDA frames
 * directly.
 *
 * **Live-verified 2026-08-15**, not just built: a real-time-paced
 * (`-re`, matching how a live RTMP source actually arrives), non-looping,
 * 45s two-rendition run (1080p60 + 720p60, both NVENC) showed `nvidia-smi
 * dmon`'s `dec` column go from a flat 0% to ~19-20% while `enc` ran
 * 44-49% for the two branches combined, speed held at 1.00-1.01x
 * throughout, clean exit, both outputs byte-sane. **Caveat found and worth
 * keeping**: an EARLIER attempt using `-stream_loop` to extend a short
 * synthetic source hit a real, reproducible `scale_cuda` filter-graph
 * reinitialization error exactly at the loop boundary ("Impossible to
 * convert... auto_scale_0", error -40) — isolated to the loop-induced
 * stream discontinuity itself (a `-stream_loop` artifact), not a flaw in
 * this filter graph: the identical graph ran clean for the full duration
 * once tested without looping. Relevant if a future benchmark/test script
 * exercises this path with `-stream_loop` — don't mistake that specific
 * failure mode for a real bug here without re-confirming against a
 * non-looping or genuinely live source first.
 */
export function buildCombinedRelayAndRenditionsArgv(
  ingestUrl: string,
  relayPublishUrl: string,
  relayOpts: { encoder: EncoderName; preset: string; bitrateKbps: number },
  renditionTargets: RenditionEncodeTarget[],
  options: { decodeHwaccel?: boolean } = {},
): string[] {
  if (renditionTargets.length === 0) {
    return buildRelayArgv(ingestUrl, relayPublishUrl, relayOpts);
  }

  const useCuda = options.decodeHwaccel === true;
  const splitLabels = renditionTargets.map((_, i) => `vr${i}`);
  const filterParts = [`[0:v]split=${splitLabels.length}${splitLabels.map((l) => `[${l}]`).join("")}`];

  const renditionMapLabels = renditionTargets.map((target, i) => {
    let currentLabel = splitLabels[i];

    const scaleExpr = scaleFilterExpr(target.rendition, useCuda);
    if (scaleExpr) {
      const scaledLabel = `${currentLabel}s`;
      filterParts.push(`[${currentLabel}]${scaleExpr}[${scaledLabel}]`);
      currentLabel = scaledLabel;
    }

    if (useCuda && !isNvencEncoder(target.encoder)) {
      const downloadedLabel = `${currentLabel}d`;
      filterParts.push(`[${currentLabel}]hwdownload,format=nv12[${downloadedLabel}]`);
      currentLabel = downloadedLabel;
    }

    return currentLabel;
  });

  const argv: string[] = [
    "-hide_banner",
    "-loglevel", "warning",
    "-stats",
    ...(useCuda ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"] : []),
    // NVDEC/CUVID has a hard internal cap of 32 decode surfaces. ffmpeg's
    // default auto-threading (-threads 0) picks a decode thread count based
    // on CPU core count, and on a machine with enough cores that pushes the
    // requested surface count over 32, making cuvidCreateDecoder fail with
    // CUDA_ERROR_INVALID_VALUE -- real failure hit on a live streaming-PC
    // deployment (13 threads -> 34 surfaces requested), confirmed via
    // ffmpeg's own stderr, which explicitly suggests lowering the thread
    // count. Hardware NVDEC decode barely benefits from more CPU threads
    // anyway (the actual decode work runs on the GPU), so capping this low
    // is effectively free. Only applies to the CUDA/NVDEC decode path --
    // software decode doesn't hit this surface limit and benefits from more
    // threads, so it's left on ffmpeg's own default there.
    ...(useCuda ? ["-threads", "4"] : []),
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
