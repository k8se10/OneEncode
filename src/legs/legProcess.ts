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
}

/**
 * Spawns one ffmpeg leg (or the decode/relay process, using the same
 * mechanics) and wires stderr stats parsing + structured logging.
 *
 * Phase 1 scope: spawn + observe only. Restart/backoff/health-state-machine
 * logic is Phase 4 (see health/monitor.ts, not yet built).
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
    child.on("exit", (code, signal) => {
      rl.close();
      logEvent({
        event: "leg_exit",
        legId,
        exitCode: code,
        signal,
        uptimeMs: Date.now() - startedAt,
        wasExpected: false,
      });
      if (code !== 0 && stderrTail.length > 0) {
        const redactedTail = stderrTail.map((line) => redactObject(line));
        console.error(`[oneencode] leg "${legId}" exited with code ${code} — last stderr lines:\n${redactedTail.join("\n")}`);
      }
      resolve({ code, signal });
    });
  });

  return { legId, process: child, startedAt, exited };
}

export interface RetryingLegController {
  /** Resolves once the process has produced its first real stats sample. */
  ready: Promise<void>;
  stop(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawns a leg (or the decode/relay process) and retries with backoff if it
 * exits before producing its first stats sample — covering the ordinary
 * startup race where this leg's own upstream (the ingest source, or the
 * decode/relay's own publish to MediaMTX) isn't live yet. Confirmed live
 * during Phase 1 testing: MediaMTX rejects a reader immediately ("no stream
 * is available") rather than blocking until a publisher appears, so without
 * this every leg would need its human-in-the-loop start ordering to be
 * exactly right, which isn't realistic.
 *
 * This is deliberately narrow — retry only applies to "never got going in
 * the first place." Once a leg is running, this does not restart it if it
 * later crashes; that full health/restart state machine is Phase 4
 * (health/monitor.ts, not built yet).
 */
export function spawnLegWithRetry(legId: string, argv: string[], encoderLabel: string): RetryingLegController {
  let stopped = false;
  let sawFirstSample = false;
  let currentHandle: LegProcessHandle | undefined;
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  async function attemptLoop(): Promise<void> {
    let attempt = 0;
    while (!stopped && !sawFirstSample) {
      attempt++;
      const handle = spawnLegProcess(legId, argv, encoderLabel, () => {
        if (!sawFirstSample) {
          sawFirstSample = true;
          resolveReady();
        }
      });
      currentHandle = handle;
      await handle.exited;

      if (stopped || sawFirstSample) return;

      const waitMs = Math.min(2000 * attempt, 10000);
      if (attempt === 1 || attempt % 5 === 0) {
        console.log(`[oneencode] leg "${legId}": not producing frames yet (attempt ${attempt}) — retrying in ${waitMs}ms`);
      }
      await delay(waitMs);
    }
  }

  void attemptLoop();

  return {
    ready,
    stop: async () => {
      stopped = true;
      if (currentHandle) await stopLegProcess(currentHandle);
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
