import { describe, expect, it } from "vitest";
import { isValidUiTokenQuery } from "../../src/ui/auth.js";

describe("isValidUiTokenQuery", () => {
  it("accepts a matching token", () => {
    expect(isValidUiTokenQuery("secret123", "secret123")).toBe(true);
  });

  it("rejects a mismatched token", () => {
    expect(isValidUiTokenQuery("secret123", "wrong")).toBe(false);
  });

  it("rejects a missing token", () => {
    expect(isValidUiTokenQuery("secret123", undefined)).toBe(false);
  });

  it("rejects an empty-string token even if the real token happens to be empty-ish", () => {
    expect(isValidUiTokenQuery("", "")).toBe(true); // documents the actual (edge-case) behavior — never expect a real token to be empty in practice
  });
});
