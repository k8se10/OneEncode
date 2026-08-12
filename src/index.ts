import { loadConfig, ConfigError } from "./config/load.js";
import { logEvent } from "./logging/logger.js";
import { startPipeline } from "./pipeline.js";

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
  console.log(`[oneencode] Press Ctrl+C to stop.`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[oneencode] shutting down...`);
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
