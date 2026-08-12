import type { RootConfig } from "../config/schema.js";
import { buildRelayArgv } from "../legs/argvBuilder.js";
import { spawnLegWithRetry, type RetryingLegController } from "../legs/legProcess.js";

export type DecodeRelayController = RetryingLegController;

/**
 * Spawns the single decode/relay ffmpeg process: pulls the real ingest,
 * decodes it exactly once, and republishes a cheap mezzanine re-encode to
 * the local MediaMTX relay path. Every destination leg reads from that
 * relay path — none of them touch the original ingest. Uses the shared
 * retry-until-ready wrapper (see legProcess.ts) since the ingest source
 * (OBS, the synthetic test source) may start publishing after this process
 * does, or vice versa.
 */
export function startDecodeRelay(config: RootConfig): DecodeRelayController {
  const argv = buildRelayArgv(config.ingest.listenUrl, config.relay.url, {
    encoder: config.relay.encoder,
    preset: config.relay.preset,
    bitrateKbps: config.relay.bitrateKbps,
  });
  return spawnLegWithRetry("relay", argv, config.relay.encoder);
}
