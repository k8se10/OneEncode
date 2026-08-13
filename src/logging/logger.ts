import fs from "node:fs";
import path from "node:path";
import { redactObject } from "./redact.js";

const LOGS_DIR = path.resolve(process.cwd(), "logs");

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

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function logFilePath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `oneencode-${today}.jsonl`);
}

/**
 * Structured, append-only JSON-Lines logger. Every write goes through
 * redactObject() first — secrets must never reach a log file, even locally.
 */
export function logEvent(entry: LogEvent): void {
  ensureLogsDir();
  const record = {
    timestamp: new Date().toISOString(),
    ...redactObject(entry),
  };
  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(logFilePath(), line, "utf8");

  const isLoud = entry.event === "leg_failed_permanent" || entry.event === "config_validation_error";
  if (isLoud) {
    console.error(`[oneencode] ${JSON.stringify(record)}`);
  } else {
    console.log(`[oneencode] ${entry.event}: ${JSON.stringify(redactObject(entry))}`);
  }
}
