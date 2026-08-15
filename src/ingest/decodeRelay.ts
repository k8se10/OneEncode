import type { RootConfig } from "../config/schema.js";
import { buildCombinedRelayAndRenditionsArgv, type RenditionEncodeTarget } from "../legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "../health/monitor.js";

export type CombinedEncodeController = LegSupervisor;

/**
 * Pure argv construction for the combined process, split out so a manual
 * restart (see src/pipeline.ts) can rebuild the exact same command without
 * spawning a throwaway process just to get the argv back — same pattern
 * rendition/renditionProcess.ts used to use before it was folded in here.
 */
export function buildCombinedEncodeArgv(config: RootConfig, renditionTargets: RenditionEncodeTarget[]): string[] {
  return buildCombinedRelayAndRenditionsArgv(
    config.ingest.listenUrl,
    config.relay.url,
    { encoder: config.relay.encoder, preset: config.relay.preset, bitrateKbps: config.relay.bitrateKbps },
    renditionTargets,
    { decodeHwaccel: config.relay.decodeHwaccel },
  );
}

/**
 * Spawns the single combined decode+encode process: pulls the real
 * ingest, decodes it exactly once, and produces the relay's own mezzanine
 * re-encode plus one encode branch per unique rendition actually
 * referenced by an enabled leg — all from that one decode, in one
 * process. Destination legs still read the resulting rendition paths over
 * RTMP exactly as before; only the relay->rendition hop changed.
 *
 * This replaced a design where each rendition was its own process that
 * re-subscribed to the relay's RTMP publish and re-encoded it, because
 * that RTMP roundtrip itself measurably amplified frame-pacing jitter
 * (task #24, root cause confirmed via scripts/jitterNoRtmpHopTest.ts — see
 * argvBuilder.ts's buildCombinedRelayAndRenditionsArgv for the full
 * writeup). Supervised the same way as any destination leg (see
 * health/monitor.ts) — if the source drops mid-stream or this process
 * crashes, it gets restarted with backoff rather than taking the whole
 * pipeline down. Restarting it restarts the relay AND every rendition
 * together — they already implicitly depended on the relay being alive
 * (a rendition can't produce frames if the relay isn't decoding), so this
 * changes "each independently retries until the relay is back" into
 * "everything restarts together," not a materially new coupling risk.
 * Destination legs, the boundary that matters most for isolation since a
 * flaky platform shouldn't affect encoding, are unaffected — they remain
 * fully independent processes.
 */
export function startCombinedRelay(config: RootConfig, renditionTargets: RenditionEncodeTarget[]): CombinedEncodeController {
  const argv = buildCombinedEncodeArgv(config, renditionTargets);
  return superviseLeg({
    legId: "relay",
    encoderLabel: config.relay.encoder,
    buildArgv: () => argv,
    restartPolicy: config.restartPolicy,
  });
}
