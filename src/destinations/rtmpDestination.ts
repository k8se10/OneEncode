import type { LegConfig } from "../config/schema.js";
import type { ResolvedDestinations } from "../config/load.js";

/**
 * Looks up a leg's real, resolved RTMP destination URL. The URL itself is
 * never logged raw (see src/logging/redact.ts) — this function just hands
 * the value to argvBuilder, which passes it straight into ffmpeg's argv.
 */
export function resolveRtmpDestination(
  leg: Extract<LegConfig, { type: "rtmp-push" }>,
  destinations: ResolvedDestinations,
): string {
  const url = destinations.rtmpUrlByLegId.get(leg.id);
  if (!url) {
    throw new Error(`No resolved destination URL for rtmp-push leg "${leg.id}" — config loader should have caught this`);
  }
  return url;
}
