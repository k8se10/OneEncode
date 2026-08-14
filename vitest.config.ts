import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tsconfig.json's outDir ("dist") compiles tests/**/*.ts alongside
    // src/**/*.ts, so a stray `tsc`/build run leaves stale compiled
    // dist/tests/**/*.test.js files sitting next to the real TS sources.
    // Vitest's default glob has no opinion on dist/, so without this
    // exclusion both copies run in the same pass and race on the same real
    // files (e.g. logs/oneencode-<date>.jsonl in readLog.test.ts) --
    // exactly the kind of flake this exists to prevent.
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-pkg/**", "**/dist-release/**", "**/web/**"],
  },
});
