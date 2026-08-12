import { readFpsSamplesForLegs } from "../src/logging/readLog.js";
import { computeJitterStats } from "../src/legs/statsAnalysis.js";

/**
 * Prints a drop/dup + frame-pacing jitter summary for the given legs,
 * reading back today's structured log. Run after both scripts/benchBaseline.ts
 * and `npm start` (or a future scripts/benchOneEncode.ts) to get an actual
 * side-by-side comparison instead of eyeballing raw JSONL — see CLAUDE.md §8's
 * note on why drop=/dup= counters alone aren't sufficient.
 */
export function printJitterReport(label: string, legIds: string[]): void {
  const samplesByLeg = readFpsSamplesForLegs(legIds);
  console.log(`\n[${label}] frame-pacing summary (fps variance across -stats samples, lower CoV = steadier):`);
  console.log(`${"legId".padEnd(28)}${"samples".padEnd(10)}${"mean fps".padEnd(12)}${"stddev".padEnd(10)}${"min".padEnd(8)}${"max".padEnd(8)}CoV`);
  for (const [legId, fpsSamples] of samplesByLeg) {
    const stats = computeJitterStats(fpsSamples);
    console.log(
      `${legId.padEnd(28)}${String(stats.count).padEnd(10)}${stats.mean.toFixed(1).padEnd(12)}` +
        `${stats.stddev.toFixed(2).padEnd(10)}${stats.min.toFixed(0).padEnd(8)}${stats.max.toFixed(0).padEnd(8)}` +
        `${stats.coefficientOfVariation.toFixed(3)}`,
    );
  }
  console.log(
    `[${label}] CoV (coefficient of variation) is unitless and comparable across legs at different target ` +
      `fps — this is the actual number to compare between a baseline run and this design's run, not just drop=/dup=.`,
  );
}
