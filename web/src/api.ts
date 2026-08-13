export interface LegStats {
  fps: number;
  bitrateKbps: number;
  dropFrames: number;
  dupFrames: number;
  speed: number;
  lastUpdatedAt: string;
}

export interface LegRow {
  id: string;
  enabled: boolean;
  renditionId: string;
  priority: number;
  type: "rtmp-push" | "local-file";
  state: string;
  stats: LegStats | null;
}

export interface RenditionRow {
  id: string;
  resolution: "source" | { width: number; height: number };
  fps: number;
  videoBitrateKbps?: number;
  audioBitrateKbps: number;
  encoderPreference: string[];
  state: string;
  stats: LegStats | null;
}

export interface EncodeStatus {
  state: string;
}

export interface StatusResponse {
  legs: LegRow[];
  renditions: RenditionRow[];
  encode: EncodeStatus;
  broadcastArmed: boolean;
}

const TOKEN_KEY = "oneencode-ui-token";

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class AuthError extends Error {}

async function apiFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("unauthorized");
  return res;
}

export async function fetchStatus(token: string): Promise<StatusResponse> {
  const res = await apiFetch("/api/status", token);
  if (!res.ok) throw new Error(`status fetch failed: ${res.status}`);
  return res.json();
}

export async function stopLeg(token: string, id: string): Promise<void> {
  const res = await apiFetch(`/api/legs/${encodeURIComponent(id)}/stop`, token, { method: "POST" });
  if (!res.ok) throw new Error(`stop failed: ${res.status}`);
}

export async function restartLeg(token: string, id: string): Promise<void> {
  const res = await apiFetch(`/api/legs/${encodeURIComponent(id)}/restart`, token, { method: "POST" });
  if (!res.ok) throw new Error(`restart failed: ${res.status}`);
}

// The relay and every rendition share one process (see CLAUDE.md, task
// #24) — there is deliberately no per-rendition stop/restart anymore.
export async function stopEncode(token: string): Promise<void> {
  const res = await apiFetch(`/api/encode/stop`, token, { method: "POST" });
  if (!res.ok) throw new Error(`stop failed: ${res.status}`);
}

export async function restartEncode(token: string): Promise<void> {
  const res = await apiFetch(`/api/encode/restart`, token, { method: "POST" });
  if (!res.ok) throw new Error(`restart failed: ${res.status}`);
}

// Broadcast arm switch: the gate in front of every rtmp-push leg (real
// external platforms). Disarmed by default on every orchestrator start.
export async function armBroadcast(token: string): Promise<void> {
  const res = await apiFetch(`/api/broadcast/arm`, token, { method: "POST" });
  if (!res.ok) throw new Error(`arm failed: ${res.status}`);
}

export async function disarmBroadcast(token: string): Promise<void> {
  const res = await apiFetch(`/api/broadcast/disarm`, token, { method: "POST" });
  if (!res.ok) throw new Error(`disarm failed: ${res.status}`);
}

export function openLiveSocket(token: string, onStats: (legId: string, stats: LegStats) => void): WebSocket {
  const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "stats") onStats(msg.legId, msg.stats);
    } catch {
      // ignore malformed frames
    }
  };
  return ws;
}
