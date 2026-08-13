import path from "node:path";
import { loadConfig, ConfigError } from "./config/load.js";
import { logEvent } from "./logging/logger.js";
import { startPipeline } from "./pipeline.js";
import { startUiServer } from "./ui/server.js";

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
  const { config, destinations } = loaded;

  const pipeline = await startPipeline(config, destinations);
  const ui = startUiServer(pipeline);
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
