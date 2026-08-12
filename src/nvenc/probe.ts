import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * Empirically probes this machine's real concurrent NVENC session ceiling.
 * Consumer NVIDIA cards have historically capped simultaneous NVENC
 * sessions in the driver — never assume a number, measure it (CLAUDE.md
 * architecture decision #4). Launches synthetic h264_nvenc encodes against
 * a lavfi test source one at a time, holding each one open, until a new
 * launch fails — that failure count minus one is the real ceiling. Writes
 * the result to a gitignored state file for the runtime encoder-fallback
 * logic to read (not yet wired up — see plan Phase 5).
 *
 * Usage: npm run probe:nvenc
 */

const STATE_DIR = path.resolve(process.cwd(), "state");
const STATE_FILE = path.join(STATE_DIR, "nvenc-ceiling.json");
const MAX_ATTEMPTS = 16;
const STARTUP_CHECK_MS = 4000;

interface ProbeAttemptResult {
  succeeded: boolean;
  stderrTail: string[];
}

function spawnHolder(index: number): { process: ChildProcess; result: Promise<ProbeAttemptResult> } {
  const argv = [
    "-hide_banner",
    "-loglevel", "warning",
    "-stats",
    "-f", "lavfi",
    "-i", "testsrc=size=1280x720:rate=30",
    "-t", "120",
    "-c:v", "h264_nvenc",
    "-preset", "p1",
    "-f", "null",
    "-",
  ];
  const child = spawn("ffmpeg", argv, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const stderrTail: string[] = [];
  let sawStats = false;

  const rl = readline.createInterface({ input: child.stderr! });
  rl.on("line", (line) => {
    stderrTail.push(line);
    if (stderrTail.length > 15) stderrTail.shift();
    if (line.includes("frame=") && line.includes("fps=")) sawStats = true;
  });

  const result = new Promise<ProbeAttemptResult>((resolve) => {
    let settled = false;
    const finishWithCurrentState = () => {
      if (settled) return;
      settled = true;
      resolve({ succeeded: sawStats, stderrTail: [...stderrTail] });
    };
    child.on("exit", () => {
      rl.close();
      finishWithCurrentState();
    });
    // If it hasn't exited and has produced at least one stats sample within
    // the check window, treat it as a successful session and let it keep
    // running in the background (it'll be killed in the cleanup pass).
    setTimeout(() => {
      if (sawStats) finishWithCurrentState();
    }, STARTUP_CHECK_MS);
  });

  return { process: child, result };
}

async function main(): Promise<void> {
  console.log(`[nvenc-probe] launching h264_nvenc encodes one at a time (up to ${MAX_ATTEMPTS}) until one fails...`);

  const holders: ChildProcess[] = [];
  let ceiling = 0;
  let failureStderr: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { process: child, result } = spawnHolder(attempt);
    const outcome = await result;

    if (outcome.succeeded) {
      holders.push(child);
      ceiling = attempt;
      console.log(`[nvenc-probe] attempt ${attempt}: succeeded (${attempt} concurrent session(s) now held open)`);
    } else {
      failureStderr = outcome.stderrTail;
      console.log(`[nvenc-probe] attempt ${attempt}: FAILED — this machine's real ceiling is ${ceiling}`);
      console.log(`[nvenc-probe] raw stderr from the failing attempt (for human confirmation):\n${outcome.stderrTail.join("\n")}`);
      break;
    }
  }

  if (ceiling === MAX_ATTEMPTS) {
    console.log(
      `[nvenc-probe] reached MAX_ATTEMPTS (${MAX_ATTEMPTS}) without a failure — this machine's ceiling is at ` +
        `least ${MAX_ATTEMPTS}, real limit not found. Increase MAX_ATTEMPTS in src/nvenc/probe.ts if you need the exact number.`,
    );
  }

  console.log(`[nvenc-probe] cleaning up ${holders.length} held session(s)...`);
  for (const child of holders) child.kill();

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        ceiling,
        ceilingIsExact: ceiling < MAX_ATTEMPTS,
        probedAt: new Date().toISOString(),
        failureStderr,
      },
      null,
      2,
    ),
  );
  console.log(`[nvenc-probe] result written to ${STATE_FILE}: ceiling=${ceiling}`);
  console.log(`[nvenc-probe] re-run this probe after any NVIDIA driver update — the ceiling can change.`);

  process.exit(0);
}

main().catch((err) => {
  console.error(`[nvenc-probe] fatal error:`, err);
  process.exit(1);
});
