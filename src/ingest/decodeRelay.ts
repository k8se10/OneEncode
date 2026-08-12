import type { RootConfig } from "../config/schema.js";
import { buildRelayArgv } from "../legs/argvBuilder.js";
import { superviseLeg, type LegSupervisor } from "../health/monitor.js";

export type DecodeRelayController = LegSupervisor;

/**
 * Spawns the single decode/relay ffmpeg process: pulls the real ingest,
 * decodes it exactly once, and republishes a cheap mezzanine re-encode to
 * the local MediaMTX relay path. Every destination leg reads from that
 * relay path — none of them touch the original ingest. Supervised the same
 * way as any destination leg (see health/monitor.ts) — if the source drops
 * mid-stream or this process crashes, it gets restarted with backoff rather
 * than taking the whole pipeline down.
 */
export function startDecodeRelay(config: RootConfig): DecodeRelayController {
  const argv = buildRelayArgv(config.ingest.listenUrl, config.relay.url, {
    encoder: config.relay.encoder,
    preset: config.relay.preset,
    bitrateKbps: config.relay.bitrateKbps,
  });
  return superviseLeg({
    legId: "relay",
    encoderLabel: config.relay.encoder,
    buildArgv: () => argv,
    restartPolicy: config.restartPolicy,
  });
}
