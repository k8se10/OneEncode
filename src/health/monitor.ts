import type { RestartPolicy } from "../config/schema.js";
import { logEvent } from "../logging/logger.js";
import { spawnLegProcess, stopLegProcess, type LegProcessHandle } from "../legs/legProcess.js";
import type { parseFfmpegStatsLine } from "../legs/statsParser.js";

export type LegSupervisorState = "starting" | "running" | "restarting" | "failed" | "stopped";

export interface LegSupervisorOptions {
  legId: string;
  encoderLabel: string;
  /** Called fresh on every (re)start — lets a local-file leg pick a new timestamped filename per attempt, rather than reusing/overwriting a prior partial file. */
  buildArgv: () => string[];
  restartPolicy: RestartPolicy;
  /** Milliseconds with no stats sample while the process is alive before it's treated as hung and force-restarted. */
  watchdogTimeoutMs?: number;
}

export interface LegSupervisor {
  legId: string;
  getState(): LegSupervisorState;
  /** Resolves once the leg has produced its first stats sample (initial "ready"), on any attempt. */
  ready: Promise<void>;
  stop(): Promise<void>;
}

const DEFAULT_WATCHDOG_TIMEOUT_MS = 20_000;

/** Exponential backoff, capped — pure function, unit tested directly. */
export function computeBackoffMs(attempt: number, policy: Pick<RestartPolicy, "backoffInitialMs" | "backoffMaxMs">): number {
  const raw = policy.backoffInitialMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, policy.backoffMaxMs);
}

/** Rolling-hour restart cap check — pure function, unit tested directly. */
export function isOverRestartCap(
  restartTimestamps: number[],
  nowMs: number,
  policy: Pick<RestartPolicy, "maxRestartsPerHour">,
): boolean {
  const oneHourAgo = nowMs - 60 * 60 * 1000;
  const recentCount = restartTimestamps.filter((t) => t > oneHourAgo).length;
  return recentCount >= policy.maxRestartsPerHour;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns a leg's (or the decode/relay process's) full lifecycle: spawn, watch
 * for the initial connection race (see the leg_start/leg_exit trail from
 * Phase 1 testing — an upstream not being live yet is normal, not fatal),
 * keep watching for as long as it runs (a watchdog restart if stats samples
 * stop arriving while the process is still alive, since some ffmpeg failure
 * modes hang rather than exit), and restart with exponential backoff on any
 * exit that wasn't a deliberate stop() — up to a rolling-hour cap, after
 * which the leg is marked "failed" and surfaced loudly rather than looping
 * forever. One leg's restart loop and backoff state is fully independent of
 * every other leg's — a crash loop on one destination must never affect a
 * sibling (see CLAUDE.md §5's "isolate failures per leg").
 */
export function superviseLeg(opts: LegSupervisorOptions): LegSupervisor {
  const watchdogTimeoutMs = opts.watchdogTimeoutMs ?? DEFAULT_WATCHDOG_TIMEOUT_MS;

  let state: LegSupervisorState = "starting";
  let stopped = false;
  let sawFirstSample = false;
  let currentHandle: LegProcessHandle | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;
  const restartTimestamps: number[] = [];

  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  function clearWatchdog(): void {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  }

  function armWatchdog(): void {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      if (stopped || !currentHandle) return;
      console.warn(`[oneencode] leg "${opts.legId}": no stats for ${watchdogTimeoutMs}ms — treating as hung, forcing restart`);
      // stopLegProcess resolves once the process actually exits, which
      // triggers the same exit-handling path (including the restart
      // decision) as any other exit — no separate restart call needed here.
      void stopLegProcess(currentHandle);
    }, watchdogTimeoutMs);
  }

  function onStats(sample: ReturnType<typeof parseFfmpegStatsLine>): void {
    if (!sample) return;
    armWatchdog();
    if (!sawFirstSample) {
      sawFirstSample = true;
      state = "running";
      resolveReady();
    }
  }

  async function runLoop(): Promise<void> {
    let attempt = 0;
    while (!stopped) {
      attempt++;
      const argv = opts.buildArgv();
      const handle = spawnLegProcess(opts.legId, argv, opts.encoderLabel, onStats);
      currentHandle = handle;
      armWatchdog();

      await handle.exited;
      clearWatchdog();

      if (stopped) {
        state = "stopped";
        return;
      }

      const now = Date.now();
      restartTimestamps.push(now);

      if (isOverRestartCap(restartTimestamps, now, opts.restartPolicy)) {
        state = "failed";
        logEvent({
          event: "leg_failed_permanent",
          legId: opts.legId,
          totalRestarts: restartTimestamps.length,
          lastExitCode: null,
        });
        return;
      }

      state = "restarting";
      const backoffMs = computeBackoffMs(attempt, opts.restartPolicy);
      logEvent({
        event: "leg_restart",
        legId: opts.legId,
        attemptNumber: attempt,
        backoffMs,
        reason: sawFirstSample ? "crashed after running" : "not producing frames yet",
      });
      await delay(backoffMs);
    }
    state = "stopped";
  }

  void runLoop();

  return {
    legId: opts.legId,
    getState: () => state,
    ready,
    stop: async () => {
      stopped = true;
      clearWatchdog();
      if (currentHandle) await stopLegProcess(currentHandle);
      state = "stopped";
    },
  };
}
