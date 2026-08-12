# OneEncode

A local, one-encode-to-many-transcode restreaming pipeline for Windows: decode a high-resolution (2K+) live source **exactly once**, then fan out to as many destination-tuned renditions as you need — each running as its own isolated, supervised process.

## The problem

Pushing one high-res source to multiple destinations the naive way means running a fully independent FFmpeg process per destination, each pulling and decoding the source separately. On anything above 1080p that redundant decode load causes real dropped frames, and different platforms have wildly inconsistent, often-shaky support for high-resolution ingest in the first place — pushing the same stream everywhere isn't actually the right move even before you hit the performance problem.

## The approach

1. **Decode once.** A local [MediaMTX](https://github.com/bluenviron/mediamtx) relay accepts the source (e.g. from OBS) and a single FFmpeg process decodes it once into a low-latency mezzanine relay stream.
2. **Encode per unique rendition, not per destination.** Destinations are described by *what they need* (resolution/fps/bitrate/codec) via named, reusable **renditions**. If two destinations want the same rendition, they share one encode process — no redundant work.
3. **Fan out cheaply.** Each actual destination is a lightweight `-c copy` stream-copy leg reading from its assigned rendition, pushed via RTMP or written to disk. One OS process per destination keeps failures isolated — one destination dying can't take the others down.
4. **Supervise everything.** A Node.js/TypeScript orchestrator spawns, health-checks, and restarts every process (relay, rendition encodes, destination legs) independently, with per-process exponential backoff and a capped restart budget.
5. **Watch NVENC session limits.** Consumer GPUs cap concurrent hardware-encode sessions. OneEncode probes the real ceiling on your machine rather than assuming a number, and falls back down an encoder preference list (NVENC → AMF → libx264/265) as needed.

```
source (OBS, etc.)
   │
   ▼
MediaMTX relay  ──▶  single decode/relay FFmpeg process (one decode, ever)
                          │
                          ▼
                  mezzanine relay stream
                    │              │
                    ▼              ▼
          rendition encode A   rendition encode B   ← one process per UNIQUE rendition
                │      │                │
                ▼      ▼                ▼
           leg (copy) leg (copy)   leg (copy)        ← one cheap process per destination
                │         │              │
                ▼         ▼              ▼
           platform A  platform C    platform B / local file
```

A local web dashboard (Express + WebSocket backend, Vite/React frontend, `127.0.0.1`-only, token-gated) gives live per-leg status and full config CRUD, reading/writing the exact same schema the orchestrator loads at boot.

## Status

- ✅ Single-decode/multi-leg pipeline — proven live
- ✅ Rendition-level dedup (decode once, branch many) — implemented and verified live
- ✅ Health supervision (restart/backoff/failure isolation) — implemented and verified live
- ✅ NVENC session-limit probing + encoder fallback — implemented and verified live
- ✅ Local web dashboard (live monitoring + config CRUD) — implemented and verified live
- 🔎 **Open investigation:** the rendition-dedup design shows measurably worse frame-pacing jitter than a naive per-destination baseline in local benchmarks (ground-truth PTS-delta CoV of ~0.07 vs ~0.00 for the same synthetic source). Root cause not yet isolated — two candidate fixes (FFmpeg low-latency flags, MediaMTX write-queue tuning) were tried and ruled out with real data. See `PATCHNOTES.md` for the full trail.
- ⏳ First real external platform leg (Twitch, designated reference platform) — blocked on real stream credentials, not yet started.

This project documents negative results and open problems as deliberately as finished features — see `PATCHNOTES.md` for the honest, dated history.

## Requirements

- Windows, with FFmpeg on `PATH` (built with NVENC/AMF support if you want hardware encode — not bundled or redistributed by this repo)
- Node.js 20+
- An NVIDIA and/or AMD GPU if you want hardware-accelerated encode; falls back to `libx264`/`libx265` otherwise

## Getting started

```bash
npm install
npm run web:install        # dashboard frontend deps

cp config/legs.example.yaml config/legs.local.yaml
cp config/secrets.local.example.yaml config/secrets.local.yaml
# edit both with your real renditions/legs/destination URLs — never commit these

npm run probe:nvenc        # measure this machine's real NVENC session ceiling

npm run dev                # start the orchestrator (+ dashboard) against legs.local.yaml
```

`config/legs.local.yaml` and `config/secrets.local.yaml` are gitignored on purpose — real destination URLs and stream keys never get committed. `config/legs.example.yaml` shows the full schema, including two destinations deliberately sharing one rendition to demonstrate the dedup path.

## Development

```bash
npm test                   # vitest unit suite
npm run bench:baseline     # naive per-destination baseline benchmark
npm run bench:oneencode    # single-decode/dedup design benchmark
```

## License

Source-available under a custom license — see [`LICENSE`](./LICENSE). Free to use, modify, and fork; the source may never be sold, paywalled, or otherwise charged for by anyone but the copyright holder.

[MediaMTX](https://github.com/bluenviron/mediamtx) (MIT License) is used as the local relay server and is fetched by setup tooling, not bundled in this repository. FFmpeg is a required external dependency, installed separately by the user.
