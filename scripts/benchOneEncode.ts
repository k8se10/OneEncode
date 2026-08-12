import { loadConfig } from "../src/config/load.js";
import { startPipeline } from "../src/pipeline.js";
import { printJitterReport } from "./reportUtil.js";

/**
 * Runs the real single-decode/rendition-dedup pipeline (the exact same
 * src/pipeline.ts code path `npm start` uses) for comparison against
 * scripts/benchBaseline.ts's naive-approach simulation, printing a
 * drop/dup + frame-pacing jitter report at shutdown so the two runs can be
 * compared directly instead of eyeballing raw JSONL logs.
 *
 * Usage: start the synthetic test source (or a real OBS source), then
 * `npm run bench:oneencode`. Let it run at least as long as the baseline
 * run for a fair comparison.
 */
async function main(): Promise<void> {
  const startedAt = new Date();
  const { config, destinations } = loadConfig();

  console.log(`[bench-oneencode] starting the real single-decode/rendition-dedup pipeline for comparison...`);
  const pipeline = await startPipeline(config, destinations);
  console.log(`[bench-oneencode] running. Press Ctrl+C to stop.`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[bench-oneencode] shutting down...`);
    await pipeline.stopAll();
    printJitterReport("bench-oneencode", [...pipeline.legIds, ...pipeline.renditionLegIds], startedAt);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[bench-oneencode] fatal error:`, err);
  process.exit(1);
});
