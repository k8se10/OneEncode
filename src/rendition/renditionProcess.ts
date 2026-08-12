import type { RootConfig, Rendition } from "../config/schema.js";
import { buildEncodeArgv } from "../legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "../health/monitor.js";
import { buildRenditionUrl } from "./group.js";

export type RenditionEncodeController = LegSupervisor;

/**
 * Spawns the one encode process for a given rendition: reads the mezzanine
 * relay, applies this rendition's scale/encode profile exactly once, and
 * republishes to a rendition-specific MediaMTX path. Every leg referencing
 * this rendition reads from that path via a cheap stream-copy (see
 * legs/argvBuilder.ts: buildCopyArgv) instead of each re-encoding — this is
 * the dedup mechanism (CLAUDE.md architecture decision #9).
 *
 * If this process crashes, dependent legs will simply fail their own reads
 * and retry with backoff (the same connection-race handling every leg
 * already has) until this comes back — no extra coordination needed.
 */
export function startRenditionEncode(config: RootConfig, rendition: Rendition, encoder: string): RenditionEncodeController {
  const renditionUrl = buildRenditionUrl(config.relay.url, rendition.id);
  const argv = buildEncodeArgv(config.relay.url, rendition, encoder as Rendition["encoderPreference"][number], {
    kind: "rtmp",
    url: renditionUrl,
  });
  return superviseLeg({
    legId: `rendition-${rendition.id}`,
    encoderLabel: encoder,
    buildArgv: () => argv,
    restartPolicy: config.restartPolicy,
  });
}
