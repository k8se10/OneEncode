import fs from "node:fs";
import path from "node:path";
import { loadConfig, ConfigError } from "./load.js";
import type { RunningPipeline } from "../pipeline.js";

const CONFIG_DIR = path.resolve(process.cwd(), "config");
const WATCHED_FILENAMES = new Set(["legs.local.yaml", "secrets.local.yaml"]);
const DEBOUNCE_MS = 500;

export interface ConfigWatcherHandle {
  close(): void;
}

/**
 * Watches config/legs.local.yaml and config/secrets.local.yaml for changes
 * and hot-reloads the running pipeline (see pipeline.ts's reconcile()) —
 * no manual restart required for a config edit (through the dashboard OR
 * by hand) to take effect. Watches the DIRECTORY rather than each file
 * directly: many editors save via a temp-file-then-rename sequence, which
 * changes the underlying inode a direct file watch can silently stop
 * tracking on some platforms — a directory watch filtered by filename
 * survives that. Debounced, since a single logical save can fire several
 * raw fs events in quick succession.
 *
 * Safety: an invalid edit (bad YAML, a value that fails schema validation,
 * an unresolvable secret) is logged loudly and the pipeline keeps running
 * on its last-known-good config — a typo must never crash or interrupt a
 * live broadcast. Reconciliation itself (pipeline.ts) never auto-starts an
 * rtmp-push leg regardless of what changed, so a hot-reloaded config can
 * never cause a new/edited real-platform push without an explicit manual
 * arm+go-live action.
 */
export function watchConfigForHotReload(pipeline: RunningPipeline): ConfigWatcherHandle {
  let debounceTimer: NodeJS.Timeout | undefined;
  let reloadInFlight = false;
  let reloadQueued = false;

  function scheduleReload(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runReload(), DEBOUNCE_MS);
  }

  async function runReload(): Promise<void> {
    if (reloadInFlight) {
      // A change arrived while a previous reload was still applying —
      // don't interleave two reconciles against the same pipeline;
      // catch up once the in-flight one finishes.
      reloadQueued = true;
      return;
    }
    reloadInFlight = true;
    try {
      const loaded = loadConfig();
      const summary = await pipeline.reconcile(loaded.config, loaded.destinations);
      if (!summary.noChanges) {
        const parts: string[] = [];
        if (summary.restartedCombinedProcess) parts.push(`combined process restarted (${summary.restartCombinedReason})`);
        if (summary.legsAdded.length) parts.push(`+${summary.legsAdded.length} leg(s): ${summary.legsAdded.join(", ")}`);
        if (summary.legsRemoved.length) parts.push(`-${summary.legsRemoved.length} leg(s): ${summary.legsRemoved.join(", ")}`);
        if (summary.legsRestarted.length) parts.push(`~${summary.legsRestarted.length} leg(s) rebuilt: ${summary.legsRestarted.join(", ")}`);
        console.log(`[oneencode] config reload applied — ${parts.join("; ")}`);
      }
    } catch (err) {
      const message = err instanceof ConfigError ? err.message : err instanceof Error ? err.message : String(err);
      console.error(`[oneencode] config reload FAILED — keeping the currently-running config unchanged:\n${message}`);
    } finally {
      reloadInFlight = false;
      if (reloadQueued) {
        reloadQueued = false;
        scheduleReload();
      }
    }
  }

  const dirWatcher = fs.watch(CONFIG_DIR, (_eventType, filename) => {
    if (filename && WATCHED_FILENAMES.has(filename)) scheduleReload();
  });

  return {
    close: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      dirWatcher.close();
    },
  };
}
