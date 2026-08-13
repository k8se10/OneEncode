import { describe, expect, it } from "vitest";
import { redactObject, redactUrl } from "../../src/logging/redact.js";

describe("redactUrl", () => {
  it("strips the stream key from the path but keeps the host", () => {
    const result = redactUrl("rtmp://a.example.com/live/SUPER_SECRET_KEY");
    expect(result).toContain("a.example.com");
    expect(result).not.toContain("SUPER_SECRET_KEY");
  });

  it("redacts wholesale for an unparseable URL", () => {
    expect(redactUrl("not a url")).toBe("***REDACTED***");
  });
});

describe("redactObject", () => {
  it("redacts fields whose key name looks secret-ish", () => {
    const input = {
      legId: "platform-a",
      destinationUrl: "rtmp://a.example.com/live/SUPER_SECRET_KEY",
      argv: ["-i", "rtmp://a.example.com/live/SUPER_SECRET_KEY"],
      nested: { apiToken: "abc123" },
    };
    const result = redactObject(input) as typeof input;
    expect(JSON.stringify(result)).not.toContain("SUPER_SECRET_KEY");
    expect(JSON.stringify(result)).not.toContain("abc123");
    expect(result.legId).toBe("platform-a");
  });

  it("redacts an rtmp(s):// URL embedded mid-sentence in free text, not just a bare whole-string value", () => {
    // Regression test: a real Kick stream key reached oneencode-run.log in
    // plaintext because ffmpeg's own stderr lines embed the destination URL
    // inside a longer message ("Error opening output rtmps://host/KEY: I/O
    // error") rather than as the whole line — an earlier anchored
    // (^rtmps?://) pattern only caught the whole-string case.
    const line =
      "[out#0/flv @ 0x1] Error opening output rtmps://REDACTED-HOST.global-contribute.live-video.net/sk_us-west-2_REAL_SECRET: I/O error";
    const result = redactObject(line);
    expect(result).not.toContain("sk_us-west-2_REAL_SECRET");
    expect(result).toContain("REDACTED-HOST.global-contribute.live-video.net");
    expect(result).toContain("***REDACTED***");
  });
});
