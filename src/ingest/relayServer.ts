import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { logEvent } from "../logging/logger.js";

const MEDIAMTX_EXE = path.resolve(process.cwd(), "tools/mediamtx/mediamtx.exe");
const MEDIAMTX_CONFIG = path.resolve(process.cwd(), "config/mediamtx.yml");

export interface RelayServerHandle {
  process: ChildProcess;
  /** Resolves once MediaMTX has logged that its RTMP listener is up. */
  ready: Promise<void>;
}

/**
 * Spawns the local MediaMTX relay server. This is the process that lets N
 * independent leg processes each read the mezzanine stream without any of
 * them touching the original source — see CLAUDE.md §1 for why this exists.
 */
export function startRelayServer(): RelayServerHandle {
  const child = spawn(MEDIAMTX_EXE, [MEDIAMTX_CONFIG], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

  const ready = new Promise<void>((resolve, reject) => {
    const onLine = (line: string) => {
      if (line.includes("[RTMP] started with listener")) {
        logEvent({ event: "relay_health", status: "up", detail: "mediamtx RTMP listener ready" });
        resolve();
      }
    };
    readline.createInterface({ input: child.stdout! }).on("line", onLine);
    readline.createInterface({ input: child.stderr! }).on("line", onLine);

    child.on("exit", (code) => {
      logEvent({ event: "relay_health", status: "down", detail: `mediamtx exited with code ${code} before becoming ready` });
      reject(new Error(`mediamtx exited with code ${code} before its RTMP listener came up`));
    });

    child.on("error", (err) => {
      reject(new Error(`failed to spawn mediamtx: ${err.message}`));
    });
  });

  child.on("exit", (code) => {
    logEvent({ event: "relay_health", status: "down", detail: `mediamtx exited with code ${code}` });
  });

  return { process: child, ready };
}

/**
 * MediaMTX has no graceful-quit stdin protocol like ffmpeg does, so a plain
 * kill is the correct shutdown path here. On Windows this is a tree-kill by
 * PID (taskkill /T) rather than child.kill() — plain child.kill() only
 * targets the immediate process and has been observed (Phase 1 testing) to
 * leave the process running when the parent Node process itself was
 * terminated abruptly rather than exiting through its own SIGINT handler.
 */
export function stopRelayServer(handle: RelayServerHandle): void {
  const pid = handle.process.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    handle.process.kill();
  }
}
