import fs from "node:fs";
import path from "node:path";

const LOGS_DIR = path.resolve(process.cwd(), "logs");

interface StatsSampleLine {
  event: "leg_stats_sample";
  legId: string;
  fps: number;
  timestamp: string;
}

function todaysLogPath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `oneencode-${today}.jsonl`);
}

/**
 * Reads today's structured log and returns every `leg_stats_sample` fps
 * value recorded for the given legIds since `since`, in the order logged.
 * Used by the benchmark scripts to compute frame-pacing/jitter stats after
 * a run (see legs/statsAnalysis.ts) — reading the persisted log back rather
 * than threading a live callback through the supervisor keeps this analysis
 * fully decoupled from the core process-supervision code.
 *
 * `since` matters: the log is append-only for the whole day, and leg ids
 * (e.g. "relay") are reused across every run started that day, so without a
 * time cutoff a report would silently mix in samples from unrelated earlier
 * runs and corrupt the comparison.
 */
export function readFpsSamplesForLegs(legIds: string[], since: Date): Map<string, number[]> {
  const result = new Map<string, number[]>(legIds.map((id) => [id, []]));
  const logPath = todaysLogPath();
  if (!fs.existsSync(logPath)) return result;

  const legIdSet = new Set(legIds);
  const sinceMs = since.getTime();
  const lines = fs.readFileSync(logPath, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: StatsSampleLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.event !== "leg_stats_sample" || !legIdSet.has(parsed.legId)) continue;
    if (Date.parse(parsed.timestamp) < sinceMs) continue;
    result.get(parsed.legId)!.push(parsed.fps);
  }
  return result;
}
