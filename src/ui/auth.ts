import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const STATE_DIR = path.resolve(process.cwd(), "state");
const TOKEN_FILE = path.join(STATE_DIR, "ui-token.txt");

/**
 * Loads the local dashboard auth token, generating a new one on first run.
 * Defense in depth per CLAUDE.md architecture decision #8: the server is
 * already bound to 127.0.0.1 only, but this stops any other local
 * process/user on a shared machine from hitting the API without the token.
 */
export function loadOrCreateUiToken(): string {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (fs.existsSync(TOKEN_FILE)) {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  console.log(`[oneencode-ui] generated a new dashboard auth token at ${TOKEN_FILE}`);
  return token;
}

/**
 * Express middleware requiring the token via `Authorization: Bearer <token>`.
 * Never logs the token itself — a failed-auth line only ever notes the
 * attempt, not the value that was tried.
 */
export function requireUiToken(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization");
    const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (provided !== token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

/** Same check for the WebSocket handshake, which can't set custom headers from a browser client — token comes via query string instead. */
export function isValidUiTokenQuery(token: string, providedQuery: string | undefined): boolean {
  return providedQuery === token;
}
