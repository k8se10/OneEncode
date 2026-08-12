/**
 * Frame-pacing/jitter analysis — closes a real gap found in this project's
 * own benchmark methodology (see CLAUDE.md §8 and PROJECT OVERVIEW's
 * "Diagnostic history" note): the original stutter symptom this project
 * exists to fix was frame-pacing/burstiness, not raw average throughput —
 * OBS's reported average FPS didn't match visibly smooth playback. A
 * `drop=0` run can still stutter if frames arrive in bursts rather than
 * evenly spaced. ffmpeg's periodic `-stats` samples aren't true per-frame
 * timing, but their fps-per-sample series is a real, measurable proxy for
 * burstiness: a steady stream holds a tight fps band between samples, a
 * bursty one swings widely even at a similar average.
 */
export interface JitterStats {
  count: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
  /** stddev / mean — unitless, comparable across legs with different target fps. Lower is steadier. */
  coefficientOfVariation: number;
}

export function computeJitterStats(fpsSamples: number[]): JitterStats {
  const samples = fpsSamples.filter((v) => Number.isFinite(v) && v > 0);
  if (samples.length === 0) {
    return { count: 0, mean: 0, stddev: 0, min: 0, max: 0, coefficientOfVariation: 0 };
  }
  const count = samples.length;
  const mean = samples.reduce((sum, v) => sum + v, 0) / count;
  const variance = samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / count;
  const stddev = Math.sqrt(variance);
  return {
    count,
    mean,
    stddev,
    min: Math.min(...samples),
    max: Math.max(...samples),
    coefficientOfVariation: mean > 0 ? stddev / mean : 0,
  };
}
