import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Probes whether this machine can actually decode+scale on the GPU
 * (`-hwaccel cuda` + `scale_cuda`) — the real question behind
 * `relay.decodeHwaccel: "auto"` (the default). Never assumed from GPU
 * vendor/name alone, same "never assume hardware" posture as the NVENC
 * session ceiling probe in this same directory: a machine can have an
 * NVIDIA GPU and still lack the right driver/ffmpeg-build support for
 * this specific filter chain.
 *
 * Tests the real risk surface found via live testing 2026-08-15, not a
 * shortcut: a synthetic `color=`-source input isn't pixel-format-compatible
 * with a direct `hwdownload` (produces a real but misleading failure) and
 * doesn't exercise real NVDEC decode at all — so this generates a tiny
 * real H.264 clip first (~0.2s, libx264 ultrafast, on disk briefly) and
 * decodes THAT via the same split -> two scale_cuda branches -> one
 * hwdownload shape the real combined process uses, exactly reproducing
 * the configuration that had a real (later-isolated-as-unrelated)
 * `-stream_loop` fragility during manual testing. Whole probe takes well
 * under a second.
 */
export async function probeDecodeHwaccel(): Promise<boolean> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oneencode-hwaccel-probe-"));
  const clipPath = path.join(tmpDir, "probe.mp4");
  try {
    const generated = await runFfmpeg([
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10:duration=0.3",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      clipPath, "-y",
    ]);
    if (!generated) return false;

    return await runFfmpeg([
      "-hide_banner", "-loglevel", "error",
      "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
      "-i", clipPath,
      "-filter_complex",
      "[0:v]split=2[a][b];[a]scale_cuda=32:32,hwdownload,format=nv12[ao];[b]scale_cuda=16:16[bo]",
      "-map", "[ao]", "-f", "null", "-",
      "-map", "[bo]", "-f", "null", "-",
    ]);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

function runFfmpeg(argv: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ffmpeg", argv, { stdio: "ignore" });
    } catch {
      finish(false);
      return;
    }
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 10_000);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      finish(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timeout);
      finish(false);
    });
  });
}
