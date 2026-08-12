import { describe, expect, it } from "vitest";
import { parseFfmpegStatsLine } from "../../src/legs/statsParser.js";

describe("parseFfmpegStatsLine", () => {
  it("parses a standard stats line", () => {
    const line =
      "frame= 1234 fps= 60 q=23.0 size=   12345kB time=00:00:20.55 bitrate=4921.2kbits/s dup=2 drop=3 speed=1.02x";
    const sample = parseFfmpegStatsLine(line);
    expect(sample).toEqual({
      frame: 1234,
      fps: 60,
      bitrateKbps: 4921.2,
      dropFrames: 3,
      dupFrames: 2,
      speed: 1.02,
      timeSec: 20.55,
    });
  });

  it("returns undefined for non-stats lines", () => {
    expect(parseFfmpegStatsLine("Input #0, flv, from 'rtmp://127.0.0.1/ingest/live':")).toBeUndefined();
    expect(parseFfmpegStatsLine("")).toBeUndefined();
  });

  it("handles a line with drop/dup absent", () => {
    const line = "frame=  200 fps= 30 q=28.0 size=  2048kB time=00:00:06.66 bitrate=2519.0kbits/s speed=1x";
    const sample = parseFfmpegStatsLine(line);
    expect(sample?.dropFrames).toBeUndefined();
    expect(sample?.dupFrames).toBeUndefined();
    expect(sample?.fps).toBe(30);
  });
});
