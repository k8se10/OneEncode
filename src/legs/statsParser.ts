export interface FfmpegStatsSample {
  frame?: number;
  fps?: number;
  bitrateKbps?: number;
  dropFrames?: number;
  dupFrames?: number;
  speed?: number;
  timeSec?: number;
}

const FIELD_PATTERN = /(\w+)=\s*([^\s]+)/g;

function parseTimeToSeconds(value: string): number | undefined {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
  if (!match) return undefined;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * Parses one line of ffmpeg's periodic `-stats` progress output, e.g.:
 *   frame= 1234 fps= 60 q=23.0 size=   12345kB time=00:00:20.55
 *   bitrate=4921.2kbits/s dup=0 drop=3 speed=1.0x
 *
 * Returns undefined for lines that aren't a stats line (most stderr output
 * during normal operation is something else or nothing).
 */
export function parseFfmpegStatsLine(line: string): FfmpegStatsSample | undefined {
  if (!line.includes("frame=") || !line.includes("fps=")) return undefined;

  const fields: Record<string, string> = {};
  for (const match of line.matchAll(FIELD_PATTERN)) {
    fields[match[1]] = match[2];
  }
  if (!("frame" in fields)) return undefined;

  const sample: FfmpegStatsSample = {};
  if (fields.frame) sample.frame = Number(fields.frame);
  if (fields.fps) sample.fps = Number(fields.fps);
  if (fields.bitrate) sample.bitrateKbps = Number.parseFloat(fields.bitrate.replace(/kbits\/s$/, ""));
  if (fields.drop) sample.dropFrames = Number(fields.drop);
  if (fields.dup) sample.dupFrames = Number(fields.dup);
  if (fields.speed) sample.speed = Number.parseFloat(fields.speed.replace(/x$/, ""));
  if (fields.time) sample.timeSec = parseTimeToSeconds(fields.time);

  return sample;
}
