import { redactObject } from "./redact.js";
import { appendRotatingLog } from "./logRotation.js";

/**
 * Mirrors every console.log/warn/error call to a plain-text file, in
 * addition to printing normally. Requested directly by the user after
 * debugging a real Kick RTMPS failure needed the raw ffmpeg stderr tail,
 * which only ever went to console.error — never to the structured JSONL
 * log logger.ts already writes — so a run launched by double-clicking the
 * exe (no capturable terminal, no manual `> run.log 2>&1` redirect) left no
 * record of it at all. Every line is redacted the same way logger.ts's own
 * writes are (CLAUDE.md §2A: redact at the logging layer itself, don't rely
 * on the caller to remember) — defense in depth in case a future call site
 * ever passes something unredacted to console.error directly.
 */
export function mirrorConsoleToFile(): void {
  const wrap = (original: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      original(...args);
      try {
        const today = new Date().toISOString().slice(0, 10);
        const line = args.map((a) => redactObject(typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        appendRotatingLog(`oneencode-console-${today}`, ".log", `[${new Date().toISOString()}] ${line}\n`);
      } catch {
        // Logging must never be the reason the app itself crashes.
      }
    };
  };

  console.log = wrap(console.log.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
}
