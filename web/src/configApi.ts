export type Resolution = "source" | { width: number; height: number };

export interface VideoQuality {
  mode: "cbr" | "cq" | "vbr";
  value: number;
}

export interface RenditionConfig {
  id: string;
  resolution: Resolution;
  fps: number;
  videoBitrateKbps?: number;
  videoQuality?: VideoQuality;
  audioBitrateKbps: number;
  keyframeIntervalSec: number;
  encoderPreference: string[];
}

export interface LegConfigBase {
  id: string;
  enabled: boolean;
  renditionId: string;
  priority: number;
}

export interface RtmpPushLegConfig extends LegConfigBase {
  type: "rtmp-push";
  destinationUrlEnv: string;
  secretSet?: boolean;
}

export interface LocalFileLegConfig extends LegConfigBase {
  type: "local-file";
  outputDir: string;
  filenamePattern: string;
}

export type LegConfigEntry = RtmpPushLegConfig | LocalFileLegConfig;

export interface ConfigResponse {
  renditions: RenditionConfig[];
  legs: LegConfigEntry[];
  encoderOptions: string[];
}

export class ConfigApiValidationError extends Error {}

async function configFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`/api/config${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 400 || res.status === 404) {
    const body = await res.json().catch(() => ({ error: `request failed: ${res.status}` }));
    throw new ConfigApiValidationError(body.error ?? `request failed: ${res.status}`);
  }
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res;
}

export async function fetchConfig(token: string): Promise<ConfigResponse> {
  const res = await configFetch("", token);
  return res.json();
}

export async function createRendition(token: string, rendition: Partial<RenditionConfig>): Promise<void> {
  await configFetch("/renditions", token, { method: "POST", body: JSON.stringify(rendition) });
}

export async function updateRendition(token: string, id: string, rendition: Partial<RenditionConfig>): Promise<void> {
  await configFetch(`/renditions/${encodeURIComponent(id)}`, token, { method: "PUT", body: JSON.stringify(rendition) });
}

export async function deleteRendition(token: string, id: string): Promise<void> {
  await configFetch(`/renditions/${encodeURIComponent(id)}`, token, { method: "DELETE" });
}

export interface LegWriteBody {
  id: string;
  enabled?: boolean;
  renditionId: string;
  priority?: number;
  type: "rtmp-push" | "local-file";
  destinationUrlEnv?: string;
  secretValue?: string;
  outputDir?: string;
  filenamePattern?: string;
}

export async function createLeg(token: string, leg: LegWriteBody): Promise<void> {
  await configFetch("/legs", token, { method: "POST", body: JSON.stringify(leg) });
}

export async function updateLeg(token: string, id: string, leg: LegWriteBody): Promise<void> {
  await configFetch(`/legs/${encodeURIComponent(id)}`, token, { method: "PUT", body: JSON.stringify(leg) });
}

export async function deleteLeg(token: string, id: string): Promise<void> {
  await configFetch(`/legs/${encodeURIComponent(id)}`, token, { method: "DELETE" });
}
