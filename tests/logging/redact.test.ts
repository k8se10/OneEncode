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
});
