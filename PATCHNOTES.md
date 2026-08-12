# PATCHNOTES

## v0.1.0 (in progress) — Phase 1: single-decode/multi-leg mechanism

### Added
- Node.js/TypeScript orchestrator skeleton (`src/index.ts`) — loads config, starts the local MediaMTX relay, starts the single decode/relay FFmpeg process, starts one FFmpeg process per enabled destination leg, logs structured JSON-Lines events, shuts down cleanly on SIGINT/SIGTERM.
- Config schema + loader (`src/config/`) — zod-validated YAML leg configuration, gitignored real config (`config/legs.local.yaml`, `config/secrets.local.yaml`) with committed placeholder templates (`config/legs.example.yaml`, `config/secrets.local.example.yaml`).
- FFmpeg argv builder (`src/legs/argvBuilder.ts`) — builds per-leg and relay FFmpeg command lines as argument arrays (never shell strings), covering NVENC/AMF/libx264 rate-control variants.
- FFmpeg `-stats` parser (`src/legs/statsParser.ts`) and structured logger (`src/logging/logger.ts`) with mandatory secret redaction (`src/logging/redact.ts`) applied to every log write.
- Retry-until-ready process wrapper (`src/legs/legProcess.ts: spawnLegWithRetry`) — used by both the decode/relay process and every destination leg, to tolerate real startup ordering (source, relay, and legs may become available in any order).
- MediaMTX (v1.20.0) vendored as the local relay server, with a minimal RTMP-only config (`config/mediamtx.yml`).
- Synthetic 2560x1440@60 test source generator (`scripts/genTestSource.ts`) and a naive-baseline benchmark script (`scripts/benchBaseline.ts`) for before/after comparison.
- 11 unit tests covering argv construction, stats parsing, and secret redaction.

### Fixed (found via live testing, not assumed)
- **Real secret-leak bug**: `redactObject()` originally only redacted strings sitting directly under secret-sounding object keys, so a raw destination URL (with stream key) passed as a positional FFmpeg argv element — as `leg_start` events do — was never redacted. Fixed by scanning every string value for an `rtmp(s)://` pattern regardless of position, with the key-name check kept only as a secondary fallback for non-URL secrets. Caught by a unit test before this ever reached a real log file.
- **MediaMTX rejects a reader immediately** ("no stream is available") when nothing is publishing yet, rather than blocking until a publisher appears — confirmed live. Both the decode/relay process and every destination leg now retry with backoff until their upstream becomes available, instead of treating "not live yet" as a fatal error.
- **Orphaned MediaMTX process** observed when the orchestrator's outer process was terminated abruptly (not via its own SIGINT handler) — `stopRelayServer` now does a Windows tree-kill (`taskkill /T /F`) by PID rather than a bare `child.kill()`.
- Missing `paths:` section in the initial `mediamtx.yml` caused every RTMP path (including the intended dynamic `/ingest/live` and `/relay/live`) to be rejected outright; added the `all_others` catch-all.

### Verified live
- Sustained ~50s run: decode/relay process + 3 destination legs (1080p/NVENC, 720p/AMF, source-resolution/NVENC) all running concurrently, `drop=0 dup=0` throughout, speed consistently >1.0x (real-time-plus).
- 3 concurrent NVENC sessions + 1 concurrent AMF session ran simultaneously on this machine (RTX 2080 Ti + AMD integrated graphics) without hitting any session-limit error.
- Graceful shutdown via a real SIGINT correctly sent FFmpeg's `q` quit key to every process; all legs exited with code 0, and all three output `.mp4` files were confirmed valid (correct resolution/framerate/duration, both video and audio streams present) via `ffprobe`.

### Investigated — Phase 1 benchmark result is more nuanced than a clean win
Ran the naive baseline (3 independent FFmpeg processes, each pulling and decoding the same synthetic 2560x1440@60 source directly) against the new single-decode design, same leg definitions, same source, ~45-50s each.

- **Both approaches sustained `drop=0 dup=0`** at 3 legs on this machine (Ryzen 5 9600X, RTX 2080 Ti). This specific test, on this specific hardware, did not reproduce the dropped-frame symptom the project exists to fix — the machine is simply powerful enough not to show it yet at this leg count with a local synthetic source.
- **GPU decode-engine utilization was NOT meaningfully lower in the new design** (~59-61% vs. baseline's ~50-57%) — not the reduction expected going in. Root cause: every leg still has to decode *its own input* before it can scale/re-encode, whether that input is the original ingest (baseline) or the local relay's mezzanine stream (new design) — RTMP always carries compressed video, so a receiving FFmpeg process cannot skip decoding just because another process already decoded the same content once. The architecture's actual saved cost is specifically *N redundant decodes of the original external ingest* collapsing to one; in this test, both the original ingest and the relay were on localhost loopback with an already-fast synthetic source, so that specific saved cost was cheap either way and didn't show up as a visible difference. This nuance was actually anticipated in the implementation plan itself (`C:\Users\REDACTED\.claude\plans\modular-brewing-dragon.md`, NVENC/mezzanine section) but is being called out here because the live numbers confirm it rather than just theorize it.
- **Implication for next steps**: this benchmark needs to be re-run under conditions that actually stress the thing being fixed — a real capture-card/OBS source (not local synthetic), more simultaneous legs, and/or this pipeline running on weaker hardware than this development machine — before the dropped-frame fix can be called proven. Worth separately considering explicit hardware-accelerated decode (`-hwaccel cuda`) on each leg's own relay-read step, which wouldn't eliminate the "each leg decodes its own input" reality but would make each of those decodes cheaper than the current CPU/software decode path every leg is on today.

### Docs
- `CLAUDE.md`/`AGENTS.md` updated throughout with the locked architecture decisions and the local dashboard addition (see git history for the specific dated entries).
