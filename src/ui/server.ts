import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import type { RunningPipeline } from "../pipeline.js";
import { loadOrCreateUiToken, requireUiToken, isValidUiTokenQuery } from "./auth.js";
import { createApiRouter } from "./api.js";
import { LiveStateTracker } from "./liveState.js";

const WEB_DIST_DIR = path.resolve(process.cwd(), "web/dist");

export interface UiServerHandle {
  port: number;
  token: string;
  close(): void;
}

/**
 * Starts the local dashboard: REST API + WebSocket live-stats push + static
 * frontend, all in the same process as the pipeline supervisor (per
 * CLAUDE.md architecture decision #8). Bound to 127.0.0.1 ONLY — this
 * server can control encode processes and (once built) touch destination
 * secrets, so it must never be reachable from the LAN, let alone the
 * internet.
 */
export function startUiServer(pipeline: RunningPipeline, port = 4771): UiServerHandle {
  const token = loadOrCreateUiToken();
  const sockets = new Set<WebSocket>();
  const liveState = new LiveStateTracker((legId, stats) => {
    const payload = JSON.stringify({ type: "stats", legId, stats });
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  });
  liveState.start();

  const app = express();
  app.use(express.json());

  app.use("/api", requireUiToken(token), createApiRouter(pipeline, liveState));

  if (fs.existsSync(WEB_DIST_DIR)) {
    app.use(express.static(WEB_DIST_DIR));
    app.get("*", (_req, res) => res.sendFile(path.join(WEB_DIST_DIR, "index.html")));
  } else {
    app.get("/", (_req, res) => {
      res.type("text/plain").send("OneEncode dashboard: frontend not built yet. Run `npm run web:build` in web/.");
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (!isValidUiTokenQuery(token, url.searchParams.get("token") ?? undefined)) {
      ws.close(4401, "unauthorized");
      return;
    }
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[oneencode-ui] dashboard listening on http://127.0.0.1:${port} (token required — see state/ui-token.txt)`);
  });

  return {
    port,
    token,
    close: () => {
      liveState.stop();
      for (const ws of sockets) ws.close();
      wss.close();
      server.close();
    },
  };
}
