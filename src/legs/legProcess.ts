import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { logEvent } from "../logging/logger.js";
import { redactObject } from "../logging/redact.js";
import { parseFfmpegStatsLine } from "./statsParser.js";

export interface LegProcessHandle {
  legId: string;
  process: ChildProcess;
  startedAt: number;
  /** Resolves when the process exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Call before intentionally stopping this process, so its leg_exit log entry correctly records wasExpected: true instead of looking like a crash. */
  markExpectedExit(): void;
}

/**
 * Spawns one ffmpeg leg (or the decode/relay process, using the same
 * mechanics) and wires stderr stats parsing + structured logging.
 *
 * This is the single-attempt primitive — one spawn, one exit. Retry-until-
 * ready, ongoing crash restart with backoff, and the rolling-hour failure
 * cap all live one layer up in health/monitor.ts's superviseLeg(), which
 * calls this repeatedly as needed. Don't reach for this directly outside
 * that supervisor unless you deliberately want a single, non-retried spawn.
 */
export function spawnLegProcess(
  legId: string,
  argv: string[],
  encoderLabel: string,
  onStats?: (sample: ReturnType<typeof parseFfmpegStatsLine>) => void,
): LegProcessHandle {
  // stdin stays a pipe (not "ignore") so stopLegProcess() can send ffmpeg's
  // own "q" quit key for a graceful shutdown that flushes output files
  // properly (mp4 moov atom, RTMP FIN) — see stopLegProcess()'s own note on
  // why plain process-kill semantics on Windows aren't enough here.
  const child = spawn("ffmpeg", argv, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  const startedAt = Date.now();
  let expectedExit = false;

  logEvent({ event: "leg_start", legId, argv, encoder: encoderLabel, pid: child.pid ?? -1 });

  // Non-stats stderr lines (errors, warnings) are otherwise silently
  // dropped, which makes an early failure (e.g. the source isn't publishing
  // yet) undiagnosable from the logs alone — keep a rolling tail so a bad
  // exit can always be explained, not just observed.
  const STDERR_TAIL_SIZE = 20;
  const stderrTail: string[] = [];

  const rl = readline.createInterface({ input: child.stderr! });
  rl.on("line", (line) => {
    const sample = parseFfmpegStatsLine(line);
    if (!sample) {
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_SIZE) stderrTail.shift();
      return;
    }
    onStats?.(sample);
    logEvent({
      event: "leg_stats_sample",
      legId,
      fps: sample.fps ?? 0,
      bitrateKbps: sample.bitrateKbps ?? 0,
      dropFrames: sample.dropFrames ?? 0,
      dupFrames: sample.dupFrames ?? 0,
      speed: sample.speed ?? 0,
    });
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const settleOnce = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };

    // A spawn failure (e.g. the binary isn't on PATH) emits "error" instead
    // of "exit" — the process never actually started. Left unhandled, this
    // is an uncaught exception that crashes the ENTIRE orchestrator, not
    // just this one leg, defeating the whole point of per-leg failure
    // isolation (CLAUDE.md §5). Treat it as a normal (if unusual) exit so
    // the existing restart/backoff loop in health/monitor.ts picks it up
    // like any other failure, instead of taking every other leg down with it.
    child.on("error", (err) => {
      rl.close();
      logEvent({
        event: "leg_exit",
        legId,
        exitCode: null,
        signal: null,
        uptimeMs: Date.now() - startedAt,
        wasExpected: expectedExit,
        spawnError: err.message,
      });
      console.error(`[oneencode] leg "${legId}" failed to start: ${err.message}`);
      settleOnce(null, null);
    });

    child.on("exit", (code, signal) => {
      rl.close();
      logEvent({
        event: "leg_exit",
        legId,
        exitCode: code,
        signal,
        uptimeMs: Date.now() - startedAt,
        wasExpected: expectedExit,
      });
      if (code !== 0 && stderrTail.length > 0) {
        const redactedTail = stderrTail.map((line) => redactObject(line));
        console.error(`[oneencode] leg "${legId}" exited with code ${code} — last stderr lines:\n${redactedTail.join("\n")}`);
      }
      settleOnce(code, signal);
    });
  });

  return {
    legId,
    process: child,
    startedAt,
    exited,
    markExpectedExit: () => {
      expectedExit = true;
    },
  };
}

/**
 * Graceful stop: Node's child_process signal emulation on Windows doesn't
 * deliver a real POSIX signal to a console app — it's equivalent to a hard
 * kill. ffmpeg instead listens for a "q" keypress on stdin to quit cleanly
 * (flushing the mp4 moov atom / closing the RTMP stream properly), so that's
 * what we send here, falling back to a hard kill only if it doesn't exit in
 * time (e.g. it's already wedged).
 */
export function stopLegProcess(handle: LegProcessHandle, timeoutMs = 5000): Promise<void> {
  handle.markExpectedExit();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    handle.exited.then(finish);

    try {
      handle.process.stdin?.write("q");
    } catch {
      // Process may already be gone — fall through to the timeout/hard-kill path.
    }

    setTimeout(() => {
      if (settled) return;
      handle.process.kill();
      finish();
    }, timeoutMs);
  });
}
