import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import path from "node:path";
import yaml from "js-yaml";

// Computed the same way configApi.ts computes them (path.resolve(process.cwd(), ...))
// so the in-memory mock keys always match regardless of where tests run from.
const LEGS_LOCAL_PATH = path.resolve(process.cwd(), "config/legs.local.yaml").replace(/\\/g, "/");
const SECRETS_LOCAL_PATH = path.resolve(process.cwd(), "config/secrets.local.yaml").replace(/\\/g, "/");

/**
 * The whole point of this test file: NEVER touch the real config/*.yaml on
 * disk. This project's dev config is shared with concurrent work (other
 * agents/processes may be running the real orchestrator against the real
 * config/legs.local.yaml right now), so node:fs is fully mocked to an
 * in-memory store — no real file I/O happens anywhere in this file.
 */

const files = new Map<string, string>();

vi.mock("node:fs", () => ({
  default: {
    existsSync: (p: string) => files.has(normalize(p)),
    readFileSync: (p: string) => {
      const content = files.get(normalize(p));
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFileSync: (p: string, content: string) => {
      files.set(normalize(p), content);
    },
  },
}));

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

const BASE_CONFIG = {
  ingest: { listenUrl: "rtmp://127.0.0.1:1935/ingest/live" },
  relay: { url: "rtmp://127.0.0.1:1935/relay/live", encoder: "h264_nvenc", preset: "p1", tuneLowLatency: true, bitrateKbps: 40000 },
  encoderPriority: ["h264_nvenc", "h264_amf", "libx264"],
  renditions: [
    {
      id: "shared-1080p60",
      resolution: { width: 1920, height: 1080 },
      fps: 60,
      videoBitrateKbps: 6000,
      audioBitrateKbps: 160,
      keyframeIntervalSec: 2,
      encoderPreference: ["h264_nvenc", "h264_amf", "libx264"],
    },
  ],
  legs: [
    {
      id: "local-archive-1",
      enabled: true,
      renditionId: "shared-1080p60",
      priority: 10,
      type: "local-file",
      outputDir: "recordings",
      filenamePattern: "archive1_{timestamp}.mp4",
    },
  ],
  restartPolicy: { maxRestartsPerHour: 5, backoffInitialMs: 2000, backoffMaxMs: 60000 },
};

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  files.clear();
  files.set(LEGS_LOCAL_PATH, yaml.dump(BASE_CONFIG));

  const { createConfigApiRouter } = await import("../../src/ui/configApi.js");
  const app = express();
  app.use(express.json());
  app.use("/api/config", createConfigApiRouter());
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/config`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.resetModules();
});

describe("GET /api/config", () => {
  it("returns renditions and legs with a secretSet flag, never a secret value", async () => {
    const res = await fetch(baseUrl);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.renditions).toHaveLength(1);
    expect(body.legs).toHaveLength(1);
    expect(body.legs[0].id).toBe("local-archive-1");
    expect(body.legs[0].secretSet).toBeUndefined(); // local-file legs have no secret concept
  });

  it("reports secretSet:true for an rtmp-push leg with a value in secrets.local.yaml, without ever returning the value", async () => {
    const configWithRtmpLeg = {
      ...BASE_CONFIG,
      legs: [
        ...BASE_CONFIG.legs,
        { id: "platform-a", enabled: true, renditionId: "shared-1080p60", priority: 5, type: "rtmp-push", destinationUrlEnv: "ONEENCODE_PLATFORM_A_URL" },
      ],
    };
    files.set(LEGS_LOCAL_PATH, yaml.dump(configWithRtmpLeg));
    files.set(SECRETS_LOCAL_PATH, yaml.dump({ ONEENCODE_PLATFORM_A_URL: "rtmp://real.example.com/live/SUPER_SECRET_KEY" }));

    const res = await fetch(baseUrl);
    const body = await res.json();
    const platformLeg = body.legs.find((l: { id: string }) => l.id === "platform-a");
    expect(platformLeg.secretSet).toBe(true);
    expect(JSON.stringify(body)).not.toContain("SUPER_SECRET_KEY");
  });
});

describe("POST /api/config/renditions", () => {
  it("creates a valid rendition and persists it", async () => {
    const res = await fetch(`${baseUrl}/renditions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "new-720p",
        resolution: { width: 1280, height: 720 },
        fps: 30,
        videoBitrateKbps: 3000,
        encoderPreference: ["h264_amf"],
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.restartRequired).toBe(true);

    const written = yaml.load(files.get(LEGS_LOCAL_PATH) as string) as typeof BASE_CONFIG;
    expect(written.renditions.some((r) => r.id === "new-720p")).toBe(true);
  });

  it("rejects a rendition with an invalid id (not URL-path-safe) and writes nothing", async () => {
    const before = files.get(LEGS_LOCAL_PATH);
    const res = await fetch(`${baseUrl}/renditions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bad id with spaces", resolution: "source", encoderPreference: ["h264_nvenc"] }),
    });
    expect(res.status).toBe(400);
    expect(files.get(LEGS_LOCAL_PATH)).toBe(before);
  });

  it("rejects a duplicate rendition id", async () => {
    const res = await fetch(`${baseUrl}/renditions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "shared-1080p60", resolution: "source", encoderPreference: ["h264_nvenc"] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/duplicate/i);
  });
});

describe("DELETE /api/config/renditions/:id", () => {
  it("refuses to delete a rendition still referenced by a leg", async () => {
    const res = await fetch(`${baseUrl}/renditions/shared-1080p60`, { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/local-archive-1/);
  });
});

describe("POST /api/config/legs", () => {
  it("creates an rtmp-push leg and writes the secret separately, never in legs.local.yaml", async () => {
    const res = await fetch(`${baseUrl}/legs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "platform-b",
        renditionId: "shared-1080p60",
        type: "rtmp-push",
        destinationUrlEnv: "ONEENCODE_PLATFORM_B_URL",
        secretValue: "rtmp://real.example.com/live/ANOTHER_SECRET",
      }),
    });
    expect(res.status).toBe(200);

    const legsYaml = files.get(LEGS_LOCAL_PATH) as string;
    expect(legsYaml).not.toContain("ANOTHER_SECRET");

    const secretsYaml = files.get(SECRETS_LOCAL_PATH) as string;
    expect(secretsYaml).toContain("ANOTHER_SECRET");
  });

  it("rejects a leg referencing an unknown renditionId", async () => {
    const res = await fetch(`${baseUrl}/legs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "orphan-leg", renditionId: "does-not-exist", type: "local-file", outputDir: "recordings" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/config/legs/:id", () => {
  it("deletes a leg and its associated secret", async () => {
    const configWithRtmpLeg = {
      ...BASE_CONFIG,
      legs: [
        ...BASE_CONFIG.legs,
        { id: "platform-a", enabled: true, renditionId: "shared-1080p60", priority: 5, type: "rtmp-push", destinationUrlEnv: "ONEENCODE_PLATFORM_A_URL" },
      ],
    };
    files.set(LEGS_LOCAL_PATH, yaml.dump(configWithRtmpLeg));
    files.set(SECRETS_LOCAL_PATH, yaml.dump({ ONEENCODE_PLATFORM_A_URL: "rtmp://real.example.com/live/KEY" }));

    const res = await fetch(`${baseUrl}/legs/platform-a`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const secretsYaml = files.get(SECRETS_LOCAL_PATH) as string;
    expect(secretsYaml).not.toContain("ONEENCODE_PLATFORM_A_URL");
  });
});
