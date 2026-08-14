import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, ConfigError } from "./config/load.js";
import { logEvent } from "./logging/logger.js";
import { mirrorConsoleToFile } from "./logging/consoleMirror.js";
import { startPipeline } from "./pipeline.js";
import { startUiServer } from "./ui/server.js";

// First thing, before anything else can log — every console.log/warn/error
// call for the rest of this process's lifetime now also lands in
// logs/oneencode-console-<date>.log, not just whatever terminal happens to
// be watching (or isn't, if the exe was double-clicked rather than launched
// from a console). See consoleMirror.ts for why this exists.
mirrorConsoleToFile();

/**
 * When running as the packaged standalone exe (npm run package:win),
 * ffmpeg.exe may be dropped in the same directory as the exe rather than
 * installed system-wide (see scripts/package-win.ps1). child_process.spawn
 * on Windows resolves a bare command name ("ffmpeg") ONLY via the PATH env
 * var — unlike Windows' own CreateProcess, it does NOT also fall back to
 * checking the launching process's own directory, so a co-located
 * ffmpeg.exe silently isn't found (confirmed: bundling it next to the exe
 * alone produced "spawn ffmpeg ENOENT"). Prepending process.execPath's
 * directory to PATH here fixes that. In a normal `tsx src/index.ts` dev run
 * process.execPath is just node.exe's own location, so this is a harmless
 * no-op there — it only does something useful for the packaged exe, where
 * process.execPath correctly points at the exe itself.
 */
if (process.platform === "win32") {
  process.env.PATH = `${path.dirname(process.execPath)};${process.env.PATH ?? ""}`;
}

/**
 * Auto-launches the system default browser to the dashboard on startup —
 * requested directly by the user, who didn't want to manually navigate to
 * the localhost URL every time. Best-effort only: a failure here (no
 * default browser configured, `start` unavailable, etc.) must never crash
 * the orchestrator itself, since the dashboard is still reachable manually.
 * `cmd /c start "" <url>` is the standard way to invoke the OS "open with
 * default app" behavior on Windows from a spawned child process — the empty
 * "" is required, otherwise `start` treats the URL as its window-title
 * argument instead of the target to open.
 */
function openBrowser(url: string): void {
  if (process.platform !== "win32") return;
  try {
    spawn("cmd", ["/c", "start", "", url], { windowsHide: true, stdio: "ignore", detached: true }).unref();
  } catch (err) {
    console.warn(`[oneencode] couldn't auto-open the dashboard in a browser: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Orchestrator entrypoint. Pipeline-building logic lives in src/pipeline.ts
 * (shared with scripts/benchOneEncode.ts) — this file is just startup,
 * config-error handling, and graceful shutdown wiring.
 */
async function main(): Promise<void> {
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logEvent({ event: "config_validation_error", message: err.message });
      process.exit(1);
    }
    throw err;
  }
  const { config, destinations, usingDefaultConfig } = loaded;
  if (usingDefaultConfig) {
    console.log(
      `[oneencode] no config/legs.local.yaml found — generated a safe default (config/legs.default.yaml: one local-file leg, no real platform credentials needed). Customize it via the dashboard or config/legs.local.yaml; see docs/CONFIGURATION.md.`,
    );
  }

  const pipeline = await startPipeline(config, destinations);
  const ui = startUiServer(pipeline, { usingDefaultConfig });
  // Passing the token in the auto-launch URL is a deliberate, documented
  // relaxation of "never put the token in a URL" (CLAUDE.md's UI code
  // rules) — same exception already carved out for the WebSocket connection
  // (browsers can't attach a custom header there either). The frontend
  // strips it from the address bar immediately after reading it. Requested
  // directly by the user to make the dashboard fully zero-manual-step on
  // launch; acceptable for the primary single-user dedicated-streaming-PC
  // target, less so on a machine shared with other local users.
  openBrowser(`http://127.0.0.1:${ui.port}/?token=${ui.token}`);
  console.log(`[oneencode] Press Ctrl+C to stop.`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[oneencode] shutting down...`);
    ui.close();
    await pipeline.stopAll();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[oneencode] fatal error:`, err);
  process.exit(1);
});
