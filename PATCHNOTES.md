# PATCHNOTES

## Investigated — comparative benchmark re-run WITH the jitter metric (2026-08-12)

Ran `bench:baseline` and `bench:oneencode` back to back, same synthetic 2560x1440@60 source, same ~60s duration, same rendition definitions, using the newly time-windowed `printJitterReport`. This closes the "still open" item from v0.5.0 below — and the result is **not the clean win it might sound like from the architecture alone**, reported plainly rather than spun:

| leg (end-output stage only) | design | mean fps | CoV (lower = steadier) |
|---|---|---|---|
| archive-1 | baseline | 62.4 | **0.049** |
| archive-2 | baseline | 62.4 | **0.049** |
| 720p-archive | baseline | 63.1 | **0.067** |
| archive-1 | oneencode | 63.8 | **0.090** |
| archive-2 | oneencode | 63.8 | **0.090** |
| 720p-archive | oneencode | 63.8 | **0.090** |

**At the actual delivered-output stage, this design showed HIGHER jitter (CoV ~0.090) than the naive baseline (CoV ~0.049-0.067) in this run** — roughly 60% worse by this metric, not better. Interestingly, the *rendition-encode* stage itself (`rendition-shared-1080p60`: CoV 0.045, `rendition-local-720p`: CoV 0.064) was comparable to or slightly better than baseline's direct-encode legs — so the redundant-encode-elimination isn't the problem. **The likely cause is the extra RTMP hop the rendition-dedup design introduces**: baseline is ingest → leg's own decode+encode → output (one hop); this design is ingest → decode/relay → rendition encode → rendition-relay publish → leg's stream-copy → output (more hops, more places for scheduling/buffering jitter to accumulate), even though total redundant CPU/GPU work is genuinely lower.

**Update, same day: repeated both runs once more — the gap is confirmed real, not noise.** Ran `bench:oneencode` a second time: CoV 0.092/0.092/0.091 for the three archive legs (vs. 0.090/0.090/0.090 first run), 0.045/0.063/0.064 for relay+renditions (vs. 0.045/0.064/0.064 first run). Ran `bench:baseline` a second time: CoV 0.046/0.046/0.065 (vs. 0.049/0.049/0.067 first run). **Both designs are individually highly repeatable — each run lands within ~0.002-0.003 CoV of its own prior run** — which means the ~0.025-0.045 gap *between* the two designs is a genuine, systematic, repeatable effect, not a fluke from a single noisy run. The "no repeat-run noise floor" caveat from the original entry above is resolved: there is a real noise floor (very small, ~±0.003), and the between-design gap is roughly 10x larger than it.

**Root cause not yet isolated** — the likely candidates (MediaMTX-imposed buffering, FFmpeg's own RTMP read buffering on the copy leg, or something else in the extra hop) haven't been individually tested. Until the root cause is found and addressed, **the rendition-dedup and single-decode architecture is CPU/GPU-efficiency-correct and failure-isolation-correct, but confirmed NOT to reduce the frame-pacing/burstiness symptom this project exists to fix — it measurably makes that specific symptom worse in this test, not better**, even while using genuinely less redundant compute. This is now a confirmed finding, not a hypothesis, and is flagged prominently in CLAUDE.md.

---

## v0.5.0 — frame-pacing/jitter measurement, pipeline refactor

### Added
- `src/legs/statsAnalysis.ts: computeJitterStats` — mean/stddev/coefficient-of-variation over a leg's fps sample series, closing the real methodology gap found via recovered planning context (drop=/dup= counters can't see frame-pacing burstiness, which was the original reported symptom). 5 unit tests, including one proving a bursty series (30,90,30,90) is distinguishable from a steady one (60,60,60,60) at the same mean.
- `src/logging/readLog.ts: readFpsSamplesForLegs` — reads today's structured JSONL log back and extracts fps samples per legId, decoupling benchmark analysis from the core supervisor (no live-callback threading needed).
- `scripts/reportUtil.ts: printJitterReport` — prints a drop/dup + jitter summary table at benchmark shutdown; wired into both `scripts/benchBaseline.ts` and the newly-created `scripts/benchOneEncode.ts`.
- **`scripts/benchOneEncode.ts` created** — this was referenced in `package.json`'s `bench:oneencode` script since Phase 1 but never actually existed; `npm start` was used as a stand-in. Now runs the real pipeline via the shared `src/pipeline.ts` module and prints the same jitter report as the baseline script for a direct comparison.
- **Refactor**: extracted `src/index.ts`'s pipeline-building logic (relay, decode/relay, rendition grouping, NVENC tracking, leg supervision) into `src/pipeline.ts: startPipeline`, shared by both `index.ts` and `benchOneEncode.ts` — the benchmark now exercises the exact same code path as production instead of a parallel reimplementation.

### Verified live
- Ran `bench:oneencode` against the synthetic source; confirmed the refactored pipeline behaves identically to before (rendition dedup, restart/backoff, NVENC tracking all unaffected by the extraction).
- An extended run correctly hit the rolling-hour restart cap (`maxRestartsPerHour: 5`) once the source went away and stayed away, marking legs `leg_failed_permanent` rather than looping forever — unplanned but welcome real-world validation of that Phase 4 logic under a longer-than-usual outage.
- Verified the jitter report directly against real collected log data: `local-archive-1`/`local-archive-2` (the rendition-dedup pair from Phase 3.5) again reported byte-for-byte identical jitter stats (76 samples, mean 67.9fps, stddev 9.03, CoV 0.133) — an independent reconfirmation of the dedup correctness from a different angle than the earlier file-size check.

### Still open
- The tooling to measure frame-pacing jitter now exists, but the actual comparative baseline-vs-design benchmark re-run using it — to properly re-evaluate Phase 1's "more nuanced than a clean win" finding — has not been performed yet.

---

## v0.4.0 — NVENC probe, platform profiles, recovered planning context

### Added
- `src/nvenc/sessionTracker.ts` — `NvencSessionTracker` + `selectEncoder` walk a rendition's `encoderPreference` list, skipping NVENC entries once the probed ceiling is reached (falls back to a conservative default of 3 with a loud warning if the probe hasn't been run yet), logging an `encoder_fallback` event on any actual fallback. Wired into `src/index.ts` — encoder choice is made once per rendition at orchestrator startup (a scoped simplification: not re-evaluated on every crash-restart). 7 new unit tests. Live smoke-tested: pipeline runs unaffected with the tracker in place (ceiling of 16, only 2 NVENC sessions in use, no fallback triggered, as expected).
- `src/nvenc/probe.ts` (`npm run probe:nvenc`) — empirically probes this machine's real concurrent NVENC session ceiling by holding synthetic `h264_nvenc` encodes open one at a time until a launch fails, writing the result to gitignored `state/nvenc-ceiling.json`. **Run against this real machine (RTX 2080 Ti, current driver)**: no failure was hit up to 16 concurrent sessions — this driver has no observable NVENC session limit at that count, well above any realistic leg count for this project. `ceilingIsExact: false` in the state file reflects that the true ceiling (if any) is higher than 16, not that 16 is confirmed as the hard limit.
- `config/platformProfiles.yaml` — committed reference table of Twitch/YouTube Live/Kick/Facebook Live's published recommended encode settings, per CLAUDE.md architecture decision #10. Not yet wired into the config loader or a UI (lands with Phase 2/6). Each entry carries a `confidence` rating and `sourcedDate` — compiled from general knowledge of each platform's public docs, not a live fetch; flagged explicitly in the file's own header as needing periodic re-verification.

### Docs — recovered planning context folded into CLAUDE.md/AGENTS.md
A prior ChatGPT planning conversation (read in full via a forked sub-agent, 2026-08-13) turned up decisions and diagnostic history not yet captured anywhere in this repo:
- **Dual-PC deployment is the primary target**, not single-PC (gaming PC runs only game/capture; a separate streaming PC runs OBS + OneEncode, keeping all transcode load off the machine actually running the game). Single-PC, which is what this project's own development/testing has used so far, is a supported fallback — flagged so Phase 1's test results aren't assumed to transfer directly without saying so.
- **Explicit success-criteria priority order locked**: no dropped frames > game/OBS unaffected > every platform gets its required format > stable/consistent output (a steady 2s beats 2s→2s→6s→2s even at similar average) > low latency > minimum latency. ~3s end-to-end latency is an accepted cost of consistency. The actual bar: **the viewer must never notice.**
- **Twitch designated as the first real platform** for Phase 2 — described as the fussiest of the majors, treated as the reference case rather than whichever is easiest to wire up first.
- **Real diagnostic history surfaced a gap in Phase 1's own benchmark methodology**: the original symptom (before this project existed) was frame-pacing/burstiness — OBS's average FPS didn't match visibly smooth playback, and capping framerate (not resolution) was what actually helped. `drop=`/`dup=` counters, Phase 1's primary metric, measure counts, not timing consistency, and can show `drop=0` on a run that still stutters. Documented in CLAUDE.md §8 as a known, not-yet-closed gap — a frame-interval-variance/jitter metric is needed before the fix can be called fully proven.
- **A future architecture direction was captured** (not built, not yet scheduled to a phase): a shared upscale stage before the rendition split (only upscale when source < target, shared across renditions that need it — same "decode once, branch many" family as rendition dedup), plus workload staggering and small deliberate buffering as a delivery "shock absorber" in service of the consistency-over-latency priority above.

---

## v0.3.0 — Phase 3.5: rendition-level dedup

### Added
- Config schema split: `renditions` (what to encode — resolution/fps/bitrate/codec) are now separate, named, reusable objects; `legs` (where it goes — a platform push or local file) reference a rendition by `renditionId` instead of inlining their own encode spec. Schema-level validation rejects a leg referencing an unknown rendition, and duplicate rendition/leg ids, before anything starts.
- `src/rendition/group.ts` — `groupLegsByRendition` (pure, unit tested) groups enabled legs by shared rendition, `buildRenditionUrl` derives each rendition's MediaMTX path from the existing relay URL's host/port.
- `src/rendition/renditionProcess.ts` — one supervised encode process per unique rendition actually referenced by an enabled leg, publishing to `rtmp://<host>/rendition/<id>`.
- `src/legs/argvBuilder.ts`: `buildEncodeArgv` (generic decode+scale+encode, replaces the old leg-specific `buildLegArgv`) and `buildCopyArgv` (cheap `-c copy` stream-copy, used by every destination leg now that encoding happens once per rendition instead of once per leg).
- `src/index.ts` rewritten around the two-stage pipeline: group legs by rendition, spawn one supervised rendition-encode per unique profile, spawn one supervised stream-copy leg per destination.
- `config/legs.example.yaml` and `config/legs.local.yaml` updated to the new schema, both including a deliberate dedup case (two legs sharing one rendition) so the mechanism is demonstrated, not just described.
- 4 new unit tests for rendition grouping/URL derivation; argv-builder tests updated for the new function signatures. 22 tests total.

### Verified live
- Configured two local-file legs (`local-archive-1`, `local-archive-2`) against the same rendition id. Log confirmed exactly **one** `rendition-shared-1080p60` encode process ran while both legs' stream-copy processes reported byte-for-byte identical bitrate at every sample. Output files confirmed byte-identical via `ffprobe`/file size (23,817,338 bytes, 32.021167s duration, both files) — not just "close," the exact same encoded bytes remuxed twice.
- A third leg on a different rendition (`local-720p`) correctly got its own independent encode process, confirming dedup only collapses genuinely identical profiles, not everything.
- When the upstream source stopped (test script's configured duration elapsed), the whole chain (rendition encodes → dependent legs) correctly entered its restart/backoff loop rather than hanging or crashing the orchestrator — no special-case coordination code needed, since a rendition-encode outage is just "connection failed" from a dependent leg's point of view, handled by the same retry logic every leg already has.

---

## v0.2.0 — Phase 4: health/restart supervision

### Added
- `src/health/monitor.ts: superviseLeg` — full leg lifecycle supervisor superseding `legProcess.ts`'s narrower `spawnLegWithRetry`. Owns spawn, initial-connection-race retry, ongoing crash restart with exponential backoff (`computeBackoffMs`), a watchdog restart if no stats sample arrives for 20s while the process is still alive (some ffmpeg failure modes hang rather than exit), and a rolling-hour restart cap (`isOverRestartCap`) past which a leg is marked `failed` and surfaced loudly instead of looping forever. Each leg's supervisor state (attempt count, backoff, restart history) is fully independent of every other leg's.
- `src/index.ts`, `src/ingest/decodeRelay.ts`, and `scripts/benchBaseline.ts` all now use `superviseLeg` in place of the old retry-only wrapper. Local-file legs now regenerate their timestamped output filename on every restart (via a `buildArgv` closure re-invoked per attempt) rather than reusing a precomputed path, so a restart can't reopen/overwrite a prior partial file.
- 7 new unit tests for the two pure decision functions (`computeBackoffMs`, `isOverRestartCap`) — 18 tests total now passing.

### Verified live
- Killed one running leg's ffmpeg process directly (`local-720p`, mid-stream) while the relay and two other legs kept running. Confirmed via the structured log: only `local-720p` recorded a `leg_exit` (`exitCode: 1`, uptime matching the kill) — `relay`, `local-1080p`, and `local-source-res` recorded zero additional exits in that window and kept producing `drop=0` stats samples throughout. The killed leg logged `leg_restart` with backoff and resumed normal stats output afterward. This is the concrete failure-isolation proof the project's own rules require (CLAUDE.md §5/§8) — not just assumed from the architecture.

---

## v0.1.0 — Phase 1: single-decode/multi-leg mechanism

### Added
- Node.js/TypeScript orchestrator skeleton (`src/index.ts`) — loads config, starts the local MediaMTX relay, starts the single decode/relay FFmpeg process, starts one FFmpeg process per enabled destination leg, logs structured JSON-Lines events, shuts down cleanly on SIGINT/SIGTERM.
- Config schema + loader (`src/config/`) — zod-validated YAML leg configuration, gitignored real config (`config/legs.local.yaml`, `config/secrets.local.yaml`) with committed placeholder templates (`config/legs.example.yaml`, `config/secrets.local.example.yaml`).
- FFmpeg argv builder (`src/legs/argvBuilder.ts`) — builds per-leg and relay FFmpeg command lines as argument arrays (never shell strings), covering NVENC/AMF/libx264 rate-control variants.
- FFmpeg `-stats` parser (`src/legs/statsParser.ts`) and structured logger (`src/logging/logger.ts`) with mandatory secret redaction (`src/logging/redact.ts`) applied to every log write.
- Retry-until-ready process wrapper (originally `src/legs/legProcess.ts: spawnLegWithRetry`, since superseded by the full supervisor in v0.2.0 below) — used by both the decode/relay process and every destination leg, to tolerate real startup ordering (source, relay, and legs may become available in any order).
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
