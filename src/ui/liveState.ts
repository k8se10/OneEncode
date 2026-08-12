import fs from "node:fs";
import path from "node:path";

const LOGS_DIR = path.resolve(process.cwd(), "logs");

export interface LegLiveStats {
  fps: number;
  bitrateKbps: number;
  dropFrames: number;
  dupFrames: number;
  speed: number;
  lastUpdatedAt: string;
}

type LogLine =
  | { event: "leg_stats_sample"; legId: string; fps: number; bitrateKbps: number; dropFrames: number; dupFrames: number; speed: number; timestamp: string }
  | { event: string; legId?: string; timestamp: string };

/**
 * Tails today's structured log continuously (byte-offset based, so it never
 * re-reads what it's already seen) and keeps an in-memory map of each leg's
 * most recent stats sample — the dashboard's live-status source. Decoupled
 * from the core supervisor the same way the benchmark scripts' jitter
 * report is (see src/logging/readLog.ts) — no live-callback threading
 * through health/monitor.ts needed.
 */
export class LiveStateTracker {
  private readonly latestByLegId = new Map<string, LegLiveStats>();
  private readOffset = 0;
  private currentLogPath = "";
  private timer: NodeJS.Timeout | undefined;
  private readonly onUpdate: (legId: string, stats: LegLiveStats) => void;

  constructor(onUpdate: (legId: string, stats: LegLiveStats) => void) {
    this.onUpdate = onUpdate;
  }

  start(pollIntervalMs = 1000): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getSnapshot(): Map<string, LegLiveStats> {
    return new Map(this.latestByLegId);
  }

  private poll(): void {
    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(LOGS_DIR, `oneencode-${today}.jsonl`);
    if (logPath !== this.currentLogPath) {
      this.currentLogPath = logPath;
      this.readOffset = 0; // a new day's log file — start from its beginning
    }
    if (!fs.existsSync(logPath)) return;

    const stat = fs.statSync(logPath);
    if (stat.size <= this.readOffset) return; // nothing new (or file was rotated/truncated — next poll's stat will catch a real new file)

    const fd = fs.openSync(logPath, "r");
    const length = stat.size - this.readOffset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, this.readOffset);
    fs.closeSync(fd);
    this.readOffset = stat.size;

    const lines = buffer.toString("utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: LogLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.event === "leg_stats_sample" && "fps" in parsed) {
        const stats: LegLiveStats = {
          fps: parsed.fps,
          bitrateKbps: parsed.bitrateKbps,
          dropFrames: parsed.dropFrames,
          dupFrames: parsed.dupFrames,
          speed: parsed.speed,
          lastUpdatedAt: parsed.timestamp,
        };
        this.latestByLegId.set(parsed.legId, stats);
        this.onUpdate(parsed.legId, stats);
      }
    }
  }
}
