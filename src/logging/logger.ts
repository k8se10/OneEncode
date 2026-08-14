import { redactObject } from "./redact.js";
import { appendRotatingLog } from "./logRotation.js";

export type LogEvent =
  | { event: "relay_health"; status: "up" | "down"; detail?: string }
  | { event: "leg_start"; legId: string; argv: string[]; encoder: string; pid: number }
  | {
      event: "leg_stats_sample";
      legId: string;
      fps: number;
      bitrateKbps: number;
      dropFrames: number;
      dupFrames: number;
      speed: number;
    }
  | {
      event: "leg_exit";
      legId: string;
      exitCode: number | null;
      signal: string | null;
      uptimeMs: number;
      wasExpected: boolean;
      /** Set when the process never actually started (e.g. ENOENT — the binary isn't on PATH) rather than started and exited. */
      spawnError?: string;
    }
  | { event: "leg_restart"; legId: string; attemptNumber: number; backoffMs: number; reason: string }
  | { event: "leg_failed_permanent"; legId: string; totalRestarts: number; lastExitCode: number | null }
  | { event: "encoder_fallback"; legId: string; requestedEncoder: string; actualEncoder: string; reason: string }
  | { event: "config_validation_error"; message: string };

/**
 * Structured, append-only JSON-Lines logger. Every write goes through
 * redactObject() first — secrets must never reach a log file, even locally.
 * Rotates past MAX_LOG_FILE_BYTES/day and prunes past MAX_TOTAL_LOG_BYTES
 * overall (see logRotation.ts) so a long-running install's logs/ directory
 * can't grow without bound.
 */
export function logEvent(entry: LogEvent): void {
  const record = {
    timestamp: new Date().toISOString(),
    ...redactObject(entry),
  };
  const line = JSON.stringify(record) + "\n";
  const today = new Date().toISOString().slice(0, 10);
  appendRotatingLog(`oneencode-${today}`, ".jsonl", line);

  const isLoud = entry.event === "leg_failed_permanent" || entry.event === "config_validation_error";
  if (isLoud) {
    console.error(`[oneencode] ${JSON.stringify(record)}`);
  } else {
    console.log(`[oneencode] ${entry.event}: ${JSON.stringify(redactObject(entry))}`);
  }
}
