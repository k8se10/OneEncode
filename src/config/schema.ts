import { z } from "zod";

const encoderName = z.enum([
  "h264_nvenc",
  "hevc_nvenc",
  "av1_nvenc",
  "h264_amf",
  "hevc_amf",
  "av1_amf",
  "libx264",
  "libx265",
]);

const resolution = z.union([
  z.literal("source"),
  z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
]);

const videoQuality = z.object({
  mode: z.enum(["cbr", "cq", "vbr"]),
  value: z.number().positive(),
});

const legBase = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  resolution,
  fps: z.number().positive().default(60),
  videoBitrateKbps: z.number().positive().optional(),
  videoQuality: videoQuality.optional(),
  audioBitrateKbps: z.number().positive().default(160),
  keyframeIntervalSec: z.number().positive().default(2),
  encoderPreference: z.array(encoderName).min(1),
  priority: z.number().int().default(0),
});

const rtmpPushLeg = legBase.extend({
  type: z.literal("rtmp-push"),
  destinationUrlEnv: z.string().min(1),
});

const localFileLeg = legBase.extend({
  type: z.literal("local-file"),
  outputDir: z.string().min(1),
  filenamePattern: z.string().min(1).default("archive_{timestamp}.mp4"),
});

export const legSchema = z.discriminatedUnion("type", [rtmpPushLeg, localFileLeg]);
export type LegConfig = z.infer<typeof legSchema>;

export const relayConfigSchema = z.object({
  url: z.string().url(),
  encoder: encoderName.default("h264_nvenc"),
  preset: z.string().default("p1"),
  tuneLowLatency: z.boolean().default(true),
  bitrateKbps: z.number().positive().default(40000),
});

export const restartPolicySchema = z.object({
  maxRestartsPerHour: z.number().int().positive().default(5),
  backoffInitialMs: z.number().int().positive().default(2000),
  backoffMaxMs: z.number().int().positive().default(60000),
});

export const rootConfigSchema = z.object({
  ingest: z.object({
    listenUrl: z.string().url(),
  }),
  relay: relayConfigSchema,
  encoderPriority: z.array(encoderName).min(1),
  legs: z.array(legSchema).min(1),
  restartPolicy: restartPolicySchema.default({}),
});

export type RootConfig = z.infer<typeof rootConfigSchema>;
export type EncoderName = z.infer<typeof encoderName>;
export type RestartPolicy = z.infer<typeof restartPolicySchema>;
