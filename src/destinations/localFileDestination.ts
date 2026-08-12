import fs from "node:fs";
import path from "node:path";
import type { LegConfig } from "../config/schema.js";

/**
 * Resolves a local-file leg's filename pattern into a concrete path.
 * Filename generation lives here (orchestrator-owned) rather than relying on
 * ffmpeg's own -strftime expansion, so naming/rotation logic stays in one
 * place regardless of ffmpeg version/build flags.
 */
export function resolveOutputPath(leg: Extract<LegConfig, { type: "local-file" }>): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = leg.filenamePattern.replace("{timestamp}", timestamp);
  const outputDir = path.resolve(process.cwd(), leg.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  return path.join(outputDir, filename);
}
