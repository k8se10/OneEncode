/**
 * Redacts stream keys/credentials from an RTMP-style URL before it is ever
 * logged, even to a local file. Keeps the host/app path (useful for
 * debugging) but collapses the stream-key path segment.
 *
 * rtmp://a.example.com/live/SUPER_SECRET_KEY -> rtmp://a.example.com/live/***REDACTED***
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      segments[segments.length - 1] = "***REDACTED***";
    }
    parsed.pathname = "/" + segments.join("/");
    parsed.search = "";
    return parsed.toString();
  } catch {
    // Not a parseable URL — redact wholesale rather than risk leaking it.
    return "***REDACTED***";
  }
}

const SECRET_KEY_PATTERN = /url|key|token|password|secret|destination/i;

/**
 * Redacts a single string value: any rtmp(s):// URL is redacted regardless
 * of where it appears (an object property, a bare array element like an
 * ffmpeg argv token, an embedded substring inside a larger free-text line
 * like ffmpeg's own stderr output, etc.) — this is deliberately NOT anchored
 * to the start of the string and NOT limited to values sitting directly
 * under a secret-sounding key, because argv arrays carry destination URLs as
 * plain positional elements with no key name at all, and ffmpeg's error
 * messages embed the destination URL mid-sentence (e.g. "Error opening
 * output rtmps://host/KEY: I/O error") rather than as the whole string —
 * an earlier anchored (`^rtmps?://`) version of this pattern missed exactly
 * that case and let a real Kick stream key reach a log file in plaintext.
 * A secret-sounding key holding a non-URL string (a bare token) is masked
 * outright as a second, narrower line of defense.
 */
function redactString(value: string, key?: string): string {
  const replaced = value.replace(/rtmps?:\/\/[^\s"']+/gi, (match) => redactUrl(match));
  if (replaced !== value) return replaced;
  if (key && SECRET_KEY_PATTERN.test(key)) return "***REDACTED***";
  return value;
}

/**
 * Recursively redacts secrets out of an arbitrary value before it is logged
 * — every string is checked for a URL-with-credentials shape regardless of
 * its position (object property or bare array element), plus a key-name
 * fallback for non-URL secrets. See CLAUDE.md §2A: nothing here is optional.
 */
export function redactObject<T>(value: T, key?: string): T {
  if (typeof value === "string") {
    return redactString(value, key) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      result[k] = redactObject(val, k);
    }
    return result as unknown as T;
  }
  return value;
}
