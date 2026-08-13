import type { LegConfig } from "../config/schema.js";

/**
 * Groups enabled legs by the rendition they reference. Legs sharing a
 * renditionId share exactly one encode branch within the combined process
 * (see src/legs/argvBuilder.ts's buildCombinedRelayAndRenditionsArgv) —
 * this is the dedup mechanism itself, kept as a small pure function so it's
 * trivially unit-testable independent of any process-spawning glue.
 */
export function groupLegsByRendition(legs: LegConfig[]): Map<string, LegConfig[]> {
  const groups = new Map<string, LegConfig[]>();
  for (const leg of legs) {
    if (!leg.enabled) continue;
    const existing = groups.get(leg.renditionId);
    if (existing) {
      existing.push(leg);
    } else {
      groups.set(leg.renditionId, [leg]);
    }
  }
  return groups;
}

/**
 * Full MediaMTX RTMP URL a rendition's encode publishes to and its legs
 * read from — derived from the existing relay URL's host/port rather than
 * a new config field, so there's one place (config.relay.url) that names
 * the MediaMTX instance.
 */
export function buildRenditionUrl(relayUrl: string, renditionId: string): string {
  const parsed = new URL(relayUrl);
  return `${parsed.protocol}//${parsed.host}/rendition/${renditionId}`;
}
