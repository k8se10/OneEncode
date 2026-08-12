import fs from "node:fs";
import path from "node:path";
import type { EncoderName } from "../config/schema.js";
import { logEvent } from "../logging/logger.js";

const STATE_FILE = path.resolve(process.cwd(), "state/nvenc-ceiling.json");

/**
 * Conservative last-resort ceiling used only when `npm run probe:nvenc`
 * has never been run on this machine — the historical GeForce-driver
 * concurrent-session cap. Never treated as a confirmed fact, only a safe
 * starting assumption until the real probe result exists (see CLAUDE.md
 * architecture decision #4: never assume this number).
 */
const FALLBACK_CEILING_IF_UNPROBED = 3;

export function isNvencEncoder(encoder: EncoderName): boolean {
  return encoder.endsWith("_nvenc");
}

export function loadProbedCeiling(): { ceiling: number; isProbed: boolean } {
  if (!fs.existsSync(STATE_FILE)) {
    console.warn(
      `[oneencode] no NVENC ceiling probe found at ${STATE_FILE} — run "npm run probe:nvenc" first. ` +
        `Using a conservative default of ${FALLBACK_CEILING_IF_UNPROBED} until then.`,
    );
    return { ceiling: FALLBACK_CEILING_IF_UNPROBED, isProbed: false };
  }
  const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { ceiling: number };
  return { ceiling: data.ceiling, isProbed: true };
}

/** Tracks how many NVENC sessions are currently reserved, against a fixed ceiling. */
export class NvencSessionTracker {
  private activeCount = 0;
  constructor(private readonly ceiling: number) {}

  hasCapacity(): boolean {
    return this.activeCount < this.ceiling;
  }
  reserve(): void {
    this.activeCount++;
  }
  release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
  }
  get current(): number {
    return this.activeCount;
  }
}

/**
 * Walks an ordered encoder preference list, skipping NVENC-family entries
 * once the tracker's ceiling would be exceeded, reserving a slot for
 * whichever NVENC encoder is actually chosen. Non-NVENC encoders (AMF,
 * libx264/265) are never limited by this tracker. If every preference is
 * NVENC and all are full, falls back to the last preference anyway
 * (best-effort) rather than erroring outright — a genuine failure to get a
 * session surfaces as a normal ffmpeg launch failure, which the existing
 * restart/backoff loop (health/monitor.ts) already handles.
 */
export function selectEncoder(legId: string, preference: EncoderName[], tracker: NvencSessionTracker): EncoderName {
  const requested = preference[0];

  for (const encoder of preference) {
    if (!isNvencEncoder(encoder) || tracker.hasCapacity()) {
      if (isNvencEncoder(encoder)) tracker.reserve();
      if (encoder !== requested) {
        logEvent({
          event: "encoder_fallback",
          legId,
          requestedEncoder: requested,
          actualEncoder: encoder,
          reason: "nvenc_session_limit_exceeded",
        });
      }
      return encoder;
    }
  }

  const lastResort = preference[preference.length - 1];
  logEvent({
    event: "encoder_fallback",
    legId,
    requestedEncoder: requested,
    actualEncoder: lastResort,
    reason: "nvenc_session_limit_exceeded_no_non_nvenc_fallback_available",
  });
  return lastResort;
}
