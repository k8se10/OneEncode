import fs from "node:fs";
import path from "node:path";

const LOGS_DIR = path.resolve(process.cwd(), "logs");

/** Once a dated log file would exceed this, further writes roll to a new numbered file. */
export const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
/** Across every rotated file this app writes (JSONL + console mirror combined), oldest files are pruned past this. */
export const MAX_TOTAL_LOG_BYTES = 200 * 1024 * 1024;

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Appends `line` under a dated base name (e.g. "oneencode-2026-08-14"),
 * rolling to a new numbered file (".2", ".3", ...) once the current one
 * would exceed MAX_LOG_FILE_BYTES, so a single busy day can't grow one file
 * without bound. Every time a new file is opened, also prunes the oldest
 * files across the whole logs/ directory so total disk usage stays capped
 * for a long-running install, not just per-file.
 */
export function appendRotatingLog(baseName: string, ext: string, line: string): void {
  ensureLogsDir();
  const lineBytes = Buffer.byteLength(line, "utf8");

  let filePath = path.join(LOGS_DIR, `${baseName}${ext}`);
  for (let index = 1; ; index++) {
    const candidate = index === 1 ? path.join(LOGS_DIR, `${baseName}${ext}`) : path.join(LOGS_DIR, `${baseName}.${index}${ext}`);
    const size = fs.existsSync(candidate) ? fs.statSync(candidate).size : 0;
    // size === 0 (a brand-new file) is always accepted even if the single
    // line itself exceeds the cap -- otherwise one oversized line would
    // loop forever hunting for a file that can never fit it.
    if (size === 0 || size + lineBytes <= MAX_LOG_FILE_BYTES) {
      filePath = candidate;
      break;
    }
  }

  const isNewFile = !fs.existsSync(filePath);
  fs.appendFileSync(filePath, line, "utf8");
  if (isNewFile) pruneOldLogs();
}

/**
 * Lists every rotated file for a dated base name that currently exists, in
 * write order (oldest/lowest-index first). Shared by every reader that
 * tails or replays a day's log — readLog.ts (benchmark jitter analysis) and
 * ui/liveState.ts (dashboard live tailing) — so both stay in sync with
 * appendRotatingLog's own naming scheme instead of re-deriving it.
 */
export function listTodaysRotatedFiles(baseName: string, ext: string): string[] {
  if (!fs.existsSync(LOGS_DIR)) return [];
  const rotatedPattern = new RegExp(`^${baseName}\\.(\\d+)${ext}$`);
  return fs
    .readdirSync(LOGS_DIR)
    .map((f) => {
      if (f === `${baseName}${ext}`) return { file: f, index: 1 };
      const match = rotatedPattern.exec(f);
      return match ? { file: f, index: Number(match[1]) } : null;
    })
    .filter((entry): entry is { file: string; index: number } => entry !== null)
    .sort((a, b) => a.index - b.index)
    .map((entry) => path.join(LOGS_DIR, entry.file));
}

function pruneOldLogs(): void {
  const entries = fs
    .readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith("oneencode-"))
    .map((f) => {
      const p = path.join(LOGS_DIR, f);
      const stat = fs.statSync(p);
      return { path: p, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let total = entries.reduce((sum, e) => sum + e.size, 0);
  for (const entry of entries) {
    if (total <= MAX_TOTAL_LOG_BYTES) break;
    fs.unlinkSync(entry.path);
    total -= entry.size;
  }
}
