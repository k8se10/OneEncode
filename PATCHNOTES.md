# PATCHNOTES

## v0.2.0

Summary of what's new since v0.1.0 — full detail in the entries below, oldest at the bottom of this block.

- **CBR bitrate fix**: `-bufsize` tightened from 2x to 1x the target bitrate on the NVENC and libx264 rate-control paths — a real Twitch Inspector capture showed the old 2x buffer letting delivered bitrate swing bursty enough to look like VBR.
- **Auto-detected GPU decode**: `relay.decodeHwaccel` (default `"auto"`) empirically probes whether this machine can do NVDEC decode + `scale_cuda` GPU-side scaling at every startup and turns it on automatically wherever it works — fixes a real idle-decode-engine-while-encode-ran-near-90% finding, no manual config needed.
- **Hot-reload + non-destructive config writes**: editing `config/legs.local.yaml` (dashboard or by hand) now applies automatically within about a second, restarting only what actually needs it — never the whole app. Dashboard writes now preserve hand-added comments and are atomic. An `rtmp-push` leg always lands staged after any edit, even if it was live — no silent auto-resumed broadcast.
- **Graceful startup + a "waiting for OBS" indicator**: the dashboard is now reachable the instant OneEncode starts, not only after a source connects — with a pulsating "Waiting for OBS connection…" badge that flashes "Connected" once real frames flow. General dashboard polish (transitions, fade-ins, tactile buttons) landed in the same pass.

## Added — graceful startup, a "waiting for OBS" indicator, and general dashboard polish

Direct user request: starting OneEncode then quickly switching to OBS was awkward — OBS won't let you start streaming until it can actually connect, and there was no way to tell from OneEncode's side whether it was ready, since the dashboard itself didn't exist yet during that wait.

### Root cause and the real fix
`startPipeline()` used to block on `combinedEncode.ready` — the combined decode/rendition process's own first real stats sample — before returning, which meant `startUiServer()` never ran until a source connected. Removing that block outright was the first attempt, but it introduced a **real regression, found via live testing**: with the block gone, every destination leg started immediately too, all in parallel with the combined process's own connection retries — N+1 processes all hammering MediaMTX with connection attempts at once. This made even the combined process's read of a genuinely live, actively-pushing source fail repeatedly until its restart cap was exhausted (`leg_failed_permanent`), confirmed by manually running the exact same combined-process command in isolation, which connected instantly with no contention.

**The actual fix**: `startPipeline()` now returns immediately (dashboard reachable right away), but destination legs still wait for `combinedEncode.ready` internally before starting — restoring the original one-source-of-truth-at-a-time connection behavior for legs, while decoupling *only* the dashboard's own availability from that wait. Legs populate into the same live state the dashboard already reads from, so they simply appear once the source connects, rather than existing pre-emptively.

### Waiting-for-connection indicator
- A pulsating "Waiting for OBS connection…" badge, top-right, visible whenever the combined process is starting/restarting and has never yet produced a real stats sample.
- Transitions to a brief "✓ Connected" flash (auto-fades after ~3s) the moment real stats arrive.
- Computed client-side from existing status data (no new backend state needed) — `encode.state` plus whether any rendition/leg has ever reported stats.

### General UI polish
- Rendition cards fade in on load.
- Every button gets a subtle press/tactile transition; tabs and the arm banner transition color smoothly instead of snapping.
- Badges transition color smoothly on state changes.

## Added — hot-reload and non-destructive config writes

Direct user request: "make sure the app non destructively updates configs and also hot reload is essential now." Previously every config change — dashboard or hand-edit — needed a full manual restart, and dashboard writes re-serialized the whole config from scratch, silently wiping any hand-added YAML comments.

### Hot-reload
- `src/config/watcher.ts` watches `config/legs.local.yaml` and `config/secrets.local.yaml` (via the directory, filtered by filename — survives editors that save via temp-file-then-rename) and applies a change within about half a second, no restart.
- `src/config/reconcile.ts`'s `planReconciliation()` — pure, unit-tested decision logic (9 cases): any `ingest`/`relay`/`encoderPriority`/`renditions` change restarts the combined decode/encode process; leg add/remove/edit only touches that one leg's own process.
- `src/pipeline.ts`'s new `RunningPipeline.reconcile()` executes the plan. `combinedEncode`/`legIds`/`config` all became getters over live closure state so callers never see a stale snapshot after a reconcile.
- **Safety preserved**: an `rtmp-push` leg always lands staged after any edit — even if it was live and armed — never a silent auto-resumed real-platform push. A combined-process restart doesn't force live legs back to staged; they just briefly lose input and reconnect, same as today's manual restart already does.
- An invalid edit is logged loudly; the pipeline keeps running unchanged on its last-known-good config. A typo can never crash or interrupt a live broadcast.
- Also detects a rotated secret (stream key changed, leg config otherwise unchanged) — invisible to a pure config diff, since `LegConfig` never contains the actual secret value — by separately comparing resolved destination URLs.

### Two real bugs found and fixed via live testing
1. **Spurious combined-process restart on every single reload**, including a pure no-op re-save. Cause: `relay.decodeHwaccel` resolves from `"auto"` to a real boolean once at startup, but a freshly-loaded file still has the raw `"auto"` — comparing those directly made every reload look like a relay change. Fixed to resolve the same way inside `reconcile()`, re-probing only when actually necessary.
2. **Rotated secrets were invisible to the diff** (see above) — found and closed before it could cause a real "I updated my stream key and nothing happened" surprise.

### Non-destructive writes
- `src/ui/configApi.ts` switched from `js-yaml`'s whole-file `dump()` to the `yaml` package's comment-preserving `Document`/`YAMLSeq` API — add/edit/delete now operate on the specific rendition/leg node, so hand-added comments elsewhere in the file survive a dashboard save.
- Every write (both config files) is now atomic — temp file + rename, so a crash mid-write can never leave a torn/corrupt file.
- Verified the exact `yaml` package API via a real throwaway script before writing any production code.

### Verified live, end to end
Real orchestrator run against the real dev config, fed a real synthetic RTMP source so the pipeline actually came up (a completely idle ingest blocks startup indefinitely — a real discovery from this same pass). Confirmed live: no-op re-save → no restart; leg add → only that leg starts; leg remove → only that leg stops; rendition bitrate change → combined process restarts with the new value correctly applied, pipeline healthy immediately after. Real dev config backed up and restored byte-identical afterward.

New tests: `tests/config/reconcile.test.ts` (9 cases), `tests/config/watcher.test.ts` (5 cases), plus a new `non-destructive writes` block in `tests/ui/configApi.test.ts` proving comments survive real add/delete operations and no temp file is ever left behind.

## Added — auto-detected GPU-side decode (NVDEC), fixing an idle decode engine while encode ran near 90%

User observation via `nvidia-smi dmon`: the encode (`enc`) engine ran as high as 90% while decode (`dec`) sat flat at 0% the whole time. Root cause, confirmed in code: `buildCombinedRelayAndRenditionsArgv` never passed any `-hwaccel` flag on the input side — every rendition's *encoder* was hardware (NVENC), but the *decode* of the incoming source was always plain software/CPU decode via libavcodec. The GPU's decode engine was never used at all.

### Added
- New config field `relay.decodeHwaccel`. When active:
  - `-hwaccel cuda -hwaccel_output_format cuda` decodes the ingest via NVDEC.
  - Scaling for any target also moves to GPU (`scale_cuda` instead of `scale`), so an NVENC-encoded rendition never leaves GPU memory between decode and encode — a genuine zero-copy pipeline, not just decode offload.
  - A rendition falling back to a non-NVENC encoder (AMF/libx264/libx265) still works: its branch gets an explicit `hwdownload,format=nv12` step back to system memory, since only NVENC can consume CUDA-resident frames directly.
- Confirmed this exact ffmpeg build (gyan.dev essentials, `--enable-cuda-llvm --enable-nvdec --enable-ffnvcodec`) has both `h264_cuvid` and `scale_cuda` available before writing any code — not assumed.

### Corrected — this is auto-detected by default, not a manual flag
First version of this shipped `decodeHwaccel: false` by default (explicit opt-in). Direct user pushback: "i dont like you disabling optimizations we need to detect hardware and set accordingly." Rebuilt: `relay.decodeHwaccel` now defaults to `"auto"`, resolved via a real, fast (~250ms) empirical probe (`src/nvenc/decodeHwaccelProbe.ts`) that runs once at every orchestrator startup — generates a tiny real H.264 clip, decodes it through the exact same `-hwaccel cuda` → `split` → two `scale_cuda` branches → `hwdownload` shape the real pipeline uses, and checks whether that actually succeeds. `src/pipeline.ts`'s `resolveDecodeHwaccel()` resolves this to a definite boolean once at startup (logged clearly either way) before anything downstream ever sees it. Explicit `true`/`false` are still accepted as an escape hatch if the auto-probe is ever wrong for a specific driver/GPU combination, but detection is now the default — no manual config step required for this to work on a machine that supports it. Full suite + typecheck clean; new test `tests/nvenc/decodeHwaccelProbe.test.ts` (mocked spawn — success, non-zero exit, spawn-error paths) plus a real functional run against this actual dev machine confirming the true implementation resolves `true` in ~270ms.

### A real bug found and fixed during verification, not shipped blind
Initial testing (via `-stream_loop` to extend a short synthetic source for a longer `nvidia-smi dmon` sampling window) hit a real, reproducible crash: `Impossible to convert between the formats supported by the filter 'Parsed_scale_cuda_1' and the filter 'auto_scale_0'` (error -40), consistently at the exact frame count where the loop wrapped. Reproduced identically in both an all-NVENC two-rendition case and a mixed NVENC+libx264 case — ruling out "mixed encoder" as the cause. Isolated by removing the artificial variable: the **identical filter graph ran clean end-to-end with no `-stream_loop`**, both as a fast non-real-time pass and as a `-re` real-time-paced 45-second run. Conclusion: the crash was a `-stream_loop` filter-graph-reinitialization artifact specific to that synthetic-test technique, not a flaw in the CUDA decode/scale pipeline itself. Documented directly in the code comment so a future benchmark script using `-stream_loop` against this path doesn't mistake that failure mode for a real regression. A separate pitfall hit while building the auto-probe itself: an initial synthetic `color=`-source input (to avoid generating a real compressed clip) produced a different, misleading failure (`Invalid output format nv12 for hwframe download`) purely from an incompatible pixel format — not a real capability gap — fixed by having the probe generate a real tiny H.264 clip instead.

### Verified live
A real-time-paced (`-re`), non-looping, 45-second two-rendition run (1080p60 + 720p60, both NVENC) — the closest a local test can get to how a real continuous RTMP/OBS source actually behaves — showed `nvidia-smi dmon`'s `dec` column move from a flat 0% to ~19-20% while `enc` ran 44-49% for both branches combined, `speed` held at 1.00-1.01x the entire time (never fell behind real-time), clean exit code, both output files correctly sized. Windows Task Manager's independent GPU monitor corroborated a real Video Decode spike during an earlier (crashed) attempt too, before the `-stream_loop` issue was isolated and removed. **After the auto-detection rewrite, re-verified end-to-end against the real dev config**: `npm run dev` against the real `legs.local.yaml` (unchanged, no config edits) logged `GPU decode (NVDEC) auto-detected: available` and the real spawned combined-process argv correctly carried `-hwaccel cuda`/`scale_cuda` for both real renditions. **Not yet run against a real OBS/live-platform stream** — the next real broadcast should be spot-checked the same way (`nvidia-smi dmon` during the stream) before this is considered fully proven end to end, same honesty standard as the CBR bufsize fix above.

## Fixed — "CBR" was allowed to swing like VBR, found via Twitch Inspector

Real destination-side evidence, same lesson as the earlier YouTube-30fps investigation (a destination platform's own tooling can catch things purely local stats can't): Twitch Inspector's bitrate graph for `shared-1080p60` (target 6000kbps CBR) showed a spiky, noisy delivered bitrate swinging roughly 4000–8500+ Kbps over a 2-hour stream — average right on target (6018 vs 6000), but Twitch's own Configuration Check flagged "average bitrate too high... could cause buffering" on the peaks. OneEncode's own leg stats wouldn't have caught this — `drop=`/`dup=`/`speed` don't measure bitrate consistency, only frame counts and pacing.

**Root cause**: `videoEncodeArgs` (`src/legs/argvBuilder.ts`) set `-bufsize` to **2x** the target bitrate for both the NVENC (`-rc cbr`) and libx264 bitrate-based branches. A VBV buffer that large gives the rate controller a 2-second averaging window — still nominally "CBR" (bounded over that window) but with plenty of room for short-term bursts/dips before the constraint actually bites, which is exactly the bursty pattern in the graph.

**Fix**: tightened `-bufsize` to **1x** the target bitrate (a 1-second window) on both branches — the standard setting for live-stream CBR tightness; a looser buffer is more appropriate for local VBR/CQ recording where burstiness doesn't matter. Regression tests added (`tests/legs/argvBuilder.test.ts`) locking the bufsize value down on both the NVENC and libx264 paths so this can't silently drift back.

**Verification status, stated honestly**: this fix is grounded in standard, well-established NVENC/libx264 CBR-streaming practice, not guesswork — but it has **not yet been re-verified against a fresh live Twitch Inspector capture**. Next real stream against `shared-1080p60` should be checked to confirm the bitrate graph actually flattens out as expected before this gets marked closed the way the YouTube-30fps investigation was.

## v0.1.0 — First public release

Everything below this entry (and the entries following it) is the development history that led here. Summary of what's actually shipping in this first tagged release:

- **Core pipeline**: single decode of the source, split into N rendition-encode branches inside one combined FFmpeg process, with rendition-level dedup (identical profiles share one encode) and per-destination failure isolation (every leg is its own supervised OS process).
- **Platform support**: YouTube, Twitch, and Kick are live-tested working `rtmp-push` legs. Local-file archival works for any rendition. TikTok is investigated but not implemented — a real platform-side access constraint, not a code gap (see docs/TROUBLESHOOTING.md).
- **Encoder handling**: NVENC → AMF → CPU fallback per rendition, with a real probed NVENC session ceiling (never assumed).
- **Local web dashboard**: live per-leg status, full rendition/leg CRUD, stop/restart controls, a manual broadcast-arm safety gate in front of every real-platform push, token-gated and bound to `127.0.0.1` only.
- **First-run UX**: a safe default config auto-generates on a fresh install (see the entry directly below) — genuinely zero-config to first working local recording.
- **Standalone release packaging**: `oneencode.exe` with FFmpeg, MediaMTX, and the dashboard all bundled — click-and-run, no separate installs.
- **Operational hygiene**: size-bounded/rotated logging, redacted secrets at the logging layer (with a real incident and fix behind that rule), a full pre-release git-history audit and scrub.
- **Known limitations, stated plainly**: H.264 only right now (a current MediaMTX RTMP-output limitation, not fundamental); designed for a dual-PC setup as the primary target, single-PC works as a fallback with less headroom; NVENC ceilings vary by machine and must be probed, not assumed.
- **Docs**: README, `docs/GETTING_STARTED.md`, `docs/CONFIGURATION.md`, `docs/TROUBLESHOOTING.md` — all cross-checked against the real current source, not just summarized history.

Full unabridged incident-by-incident history follows below, oldest work at the bottom.

## First-run UX — no more manual config copy just to get the app to start

Direct user feedback: "it should also make default configs and such the ux is terrible rn." Previously, a missing `config/legs.local.yaml` was a hard startup error telling you to go copy-and-edit `legs.example.yaml` by hand — real friction, especially now that the standalone release is supposed to be click-and-run.

### Added
- `config/legs.default.yaml` — a new committed template distinct from `legs.example.yaml`: a single `local-file` leg, no real platform credentials needed, no external side effect. The safest possible thing to auto-start.
- `src/config/load.ts`'s `loadConfig()` now auto-generates `config/legs.local.yaml` from this default **only when the file doesn't exist at all** — an existing-but-invalid config still fails loudly with the same validation error as before, so this never papers over a real mistake, only a genuinely fresh install.
- Surfaced, not silent: a clear startup console log line, plus a new `usingDefaultConfig` flag threaded through `loadConfig()` → `startUiServer()`/`createApiRouter()` → `GET /api/status` → a dashboard banner (`web/src/App.tsx`) with a one-click jump to the Configure tab.
- `scripts/package-win.ps1` now also bundles `config/legs.default.yaml` into the release folder — without this the packaged exe's own "click and run" promise would have been broken on a truly fresh install (caught before it caused a real bug, not after).
- `tests/config/load.test.ts` (new, first config test file this project has had) — real fs against the real `config/` directory with backup/restore (same pattern as `readLog.test.ts`), covering auto-generation on a missing file, no-overwrite of an existing file, and a clear error if `legs.default.yaml` itself is ever missing too.

### Verified live
Two separate real runs, both with the actual local config temporarily removed/backed-up: `npm run dev` from source, and the freshly-rebuilt packaged `oneencode.exe` with `ffmpeg` also stripped from `PATH` (the strictest possible "nothing pre-installed" test). Both started cleanly against the auto-generated default — MediaMTX healthy, the combined encode process spawned and running, `config/legs.local.yaml` correctly created on disk — with only the expected "no real OBS source connected" errors. Real dev-machine config restored afterward in both cases, confirmed byte-identical to before.

## Standalone release is now genuinely click-and-run — ffmpeg and MediaMTX both bundled

Requested directly by the user: "everything should be in the release - all dependencies... it needs to be click and run." Previously `scripts/package-win.ps1` only produced a bare `oneencode.exe`, with ffmpeg and MediaMTX left as separate required installs even for the packaged-exe path — real friction for anyone downloading a release rather than setting up a dev environment.

### Changed
- `scripts/package-win.ps1` now assembles a full `dist-release/OneEncode/` release folder, not just a bare exe: `oneencode.exe`, the built dashboard (`web/dist/`), committed config templates, and — new — MediaMTX (`tools/mediamtx/mediamtx.exe` + its LICENSE, MIT, no redistribution concerns) and ffmpeg (`ffmpeg.exe` + a generated `ffmpeg-LICENSE.txt`) both bundled directly alongside the exe.
- ffmpeg resolution: Chocolatey installs `ffmpeg.exe` on `PATH` as a tiny .NET shim, not the real ~100MB binary — the script now finds the real one under Chocolatey's `lib` folder first, falling back to a size-sanity-checked PATH resolution (rejects anything under 10MB, i.e. a shim) or an explicit `-FfmpegPath` override. Bundled build in practice: gyan.dev's essentials build, `--enable-gpl`/`--enable-version3` (GPLv3, since `libx264`/`libx265` — this project's universal CPU fallback encoder — require `--enable-gpl`).
- **Real, deliberate licensing-policy change, not an oversight**: CLAUDE.md/AGENTS.md §6 previously said ffmpeg is "never bundled/redistributed by this repo." That statement was about the git repo's own source, not packaged binary releases, but the personal-transfer exception carved out earlier this session made that ambiguous. Now explicit: the git repo's source never bundles ffmpeg; every standalone packaged release does, going forward, at the user's direct instruction. GPL compliance for the bundled binary: `ffmpeg-LICENSE.txt` (auto-generated by the packaging script) states the exact build/config, links the full GPLv3 text, and notes FFmpeg's own source is always public upstream (no source re-bundling needed). This doesn't touch OneEncode's own source-available license — ffmpeg is invoked as a separate child process, never linked as a library, so GPL's copyleft doesn't propagate to OneEncode's own code.

### Fixed
- `config/legs.example.yaml`'s own committed template failed its own schema validation — a rendition id (`720p60-3.5M`) contained a `.`, which the schema's URL-path-safe rule (`^[a-zA-Z0-9_-]+$`) rejects, since rendition ids become part of an internal URL path. Found by actually running the freshly-packaged exe end-to-end with the example config (not just building it and assuming it works) — the orchestrator refused to start with a clear `config_validation_error`. Fixed to `720p60-3_5M`.

### Verified live
Ran the freshly-built `dist-release/OneEncode/oneencode.exe` with `ffmpeg` deliberately stripped from `PATH` (simulating a machine with nothing pre-installed) — the combined decode/rendition process spawned successfully using the bundled, co-located `ffmpeg.exe`, no `ENOENT`, confirming the existing PATH-prepend fix (from the original standalone-exe work) still correctly resolves a co-located binary regardless of which ffmpeg build is bundled. MediaMTX started cleanly (`relay_health: up`). The only errors logged were the expected "no real OBS source connected" ffmpeg I/O errors — a healthy failure mode with a placeholder config, not a bundling problem. Also confirmed the bundled `ffmpeg.exe` itself runs standalone (`-version` output intact, not a corrupted copy).

## Public-release prep — log rotation/size bounding, git history scrub, flaky test-suite fix

Getting ready for the first public release. Three separate pieces of work:

### Fixed — two real personal identifiers were live on the public GitHub repo

Audited the full git history (not just the working tree — a full `git log --all -p` grep) for anything personal/secret. Found two real leaks, both already pushed to `origin/master`: (1) the user's real Kick account ingest subdomain (`fa723fc1b171.global-contribute.live-video.net`) baked into a `tests/logging/redact.test.ts` fixture and mentioned in an earlier PATCHNOTES entry, and (2) the user's real Windows username in a local file path quoted in a PATCHNOTES entry. **No actual stream key was found anywhere in history** — confirmed via a full-history grep for fragments of all three real platform keys, clean. Per the user's explicit choice, fully purged via `git filter-repo --replace-text` (run against a fresh clone, not the primary working copy) followed by a force-push to `origin/master`, then the local repo was `git fetch`+`reset --hard` to match. Verified with a fresh full-history grep afterward — zero remaining occurrences of either string anywhere. Every commit hash changed as a result (expected/unavoidable with a history rewrite). Caveat noted to the user: this only scrubs GitHub's copy — any pre-existing clone/fork elsewhere would still have the old commits, though there's no evidence any exist (repo went public this same session).

### Added — bounded log rotation, so a long-running install's `logs/` directory can't grow forever

Both the structured JSONL logger (`logger.ts`) and the always-on console mirror (`consoleMirror.ts`) previously rotated only by calendar day, with no cap on how big a single day's file could get and no pruning of old files at all — a real gap for a public release meant to run unattended on someone else's machine. New shared module `src/logging/logRotation.ts`:
- `appendRotatingLog(baseName, ext, line)` rolls to a new numbered file (`oneencode-<date>.2.jsonl`, `.3.jsonl`, ...) once the current dated file would exceed `MAX_LOG_FILE_BYTES` (10MB) — a single oversized line is still accepted into a fresh file rather than looping forever.
- Every time a new file is opened, prunes the oldest `oneencode-`-prefixed files across the whole `logs/` directory (both JSONL and console-mirror files combined) until total size is back under `MAX_TOTAL_LOG_BYTES` (200MB).
- `listTodaysRotatedFiles(baseName, ext)` is the shared read-side helper — both `readLog.ts` (benchmark jitter analysis, which now reads every rotated file for a date, not just the base one) and `ui/liveState.ts` (the dashboard's live-tailing, which now follows rotation forward instead of freezing once the base file stops growing) use it, so a rotation mid-broadcast doesn't silently break either.
- New tests: `tests/logging/logRotation.test.ts` (real-fs rotation/oversized-line behavior at the real 10MB scale) and `tests/logging/logRotationPrune.test.ts` (mocked-fs pruning behavior — deliberately mocked rather than writing a real 200MB fixture in a unit test).

### Fixed — a real, pre-existing flaky-test bug found while testing the above

No `vitest.config.ts` existed, so vitest's default test-file glob picked up stale compiled `dist/tests/**/*.test.js` files (left over from an earlier `tsc`/packaging build — `tsconfig.json` compiles `tests/**/*.ts` alongside `src/`) *in addition to* the real `tests/**/*.test.ts` sources. Both copies ran in the same pass and raced on the same real files (`logs/oneencode-<date>.jsonl` in `readLog.test.ts`), causing an intermittent `ENOENT`. Not something this session introduced, but surfaced while verifying the rotation change. Added `vitest.config.ts` excluding `dist/`, `dist-pkg/`, `dist-release/`, and `web/` from test discovery, and removed the stale `dist/` directory. Full suite now passes cleanly and deterministically: 14 files, 70 tests, 0 flakes, clean `tsc --noEmit`.

## Investigated — TikTok LIVE access model, next platform under consideration

Researched how third-party multistreaming tools (se.live/StreamElements et al.) actually get TikTok working, ahead of adding it as a real leg. Unlike Twitch/YouTube/Kick/Facebook, **TikTok LIVE has no open self-serve RTMP signup**. TikTok's own in-app "LIVE Studio"/"Cast to PC" feature is eligibility-gated and, critically, **issues a new RTMP server URL + stream key every broadcast session** rather than a stable long-lived credential.

**Correction, same investigation**: initially assumed se.live/StreamElements get TikTok working purely via an agency/MCN relationship — re-checked after the user correctly pointed out these tools let you connect TikTok directly in-app. Their actual mechanism is an **OAuth account-login inside the plugin** (not a manual key paste), but it still requires the same underlying "TikTok grants LIVE access" gate — StreamElements/Streamlabs just have a **negotiated partnership with TikTok** that expedites that review and wires the credential up automatically. Confirmed there's no public "TikTok LIVE ingest API" a solo project could similarly integrate against. Realistic paths for OneEncode remain unchanged: native session-key RTMP export, or the **TikTok LIVE agency/Creator Network (MCN)** path (external business step, not code) the user is pursuing — unconfirmed whether that yields a stable or session-based key.

**Further fragility, same day**: user reports that under ~1,000 followers, TikTok LIVE access granted through these third-party flows can be revoked after a single stream, and the RTMP key is never even surfaced to the user in the OAuth-partnership flows (SE.Live/Streamlabs keep it internal to their own pipeline) — so a working SE.Live connection couldn't be harvested for OneEncode's own use regardless. Separately confirmed via search: TikTok requires **50%+ gaming content** for any third-party-PC-streaming account (effective July 2025) or access gets revoked (14-day reapplication wait, ongoing compliance bar after). This project's own OBS/gaming use case already satisfies that rule — the account-standing/follower-threshold risk is the real open question now, not the content-mix rule. TikTok access is fragile on an ongoing basis, not a one-time signup hurdle.

Config/UX design (static secret vs. a "paste tonight's session key" dashboard action) stays deliberately deferred until the real credential type is known and access has proven durable. Added a `TikTok LIVE` entry to `config/platformProfiles.yaml` (ingest spec only — H.264, 1080p30 @ 6000kbps default, 2s keyframe interval, CFR required) so the rendition groundwork is ready once a real credential exists; no leg/secret/UI work started. Full detail in CLAUDE.md/AGENTS.md's architecture decision #10 section.

## Confirmed — the YouTube "stats for nerds" 30fps report was the pre-fix jitter, not a new bug

Following the GPU-contention fix below, user reported the `youtube-1440p60` leg's YouTube-reported fps (30, despite OneEncode's own `-stats` showing a clean 60fps/25.1Mbps/drop=0/dup=0/speed=1.01x) is now gone — YouTube correctly reports 60fps. No code change was needed; this was root-caused as a downstream symptom of the same jitter this session's `buildCombinedRelayAndRenditionsArgv` relay-branch-removal fix (and the earlier task #24 combined-process redesign) already fixed. Before that fix, jitter/bursty frame delivery to YouTube's ingest — real per this project's own diagnostic-history note (a periodic drop/dup counter can't see pacing problems) — was apparently severe enough that YouTube's own transcoder discarded roughly every other frame and reported the result as 30fps, even though OneEncode's own leg-level throughput counters looked perfectly healthy throughout (they measure OneEncode's own encode rate, not what YouTube's ingest actually does with the delivered frames). Once frame pacing was cleaned up (GPU contention removed, jitter gone), YouTube stopped needing to do that. **Closing note for task #24**: this is now the second independent confirmation (after the clean 3-leg OBS CoV=0.0283 result) that the combined-process fix resolved the real underlying pacing problem, not just the synthetic-test metrics used to detect it.

## Fixed — removed a fully unused NVENC encode branch, real GPU contention during the 3-platform test

User reported major lag with just 3 platforms / 2 rendition profiles — "the encoder absolutely maxing out" — visually a stuttery mess with very low effective fps, but **neither OneEncode's own `drop=`/`dup=` counters nor OBS's own dropped-frame indicator showed anything wrong**. This is exactly this project's own oldest documented concern (see PROJECT OVERVIEW's diagnostic-history note, present since before any code was written): a periodic drop/dup counter measures count, not timing consistency, and can read clean while the real GPU/NVENC encoder is genuinely falling behind real-time under contention. Contributing factor confirmed by the user: OBS's own encode was already using ~47% of the GPU's encoder capacity before OneEncode's own branches even started.

**Root cause found and fixed**: `buildCombinedRelayAndRenditionsArgv` (`src/legs/argvBuilder.ts`) was still building and publishing a separate "relay" mezzanine branch (`-map "[vrelay]"`, full source resolution, 40Mbps, lowest-latency preset — the single most expensive branch in the whole combined process) left over from *before* the task #24 combined-process redesign. A full grep confirmed **nothing in the codebase ever subscribes to it** — every leg reads its own `/rendition/<id>` path directly, never `relay.url`/`/relay/live` itself. With the user's real config (2 rendition profiles: `shared-1080p60` shared by 3 legs, `youtube-1440p60` shared by 2 legs), this meant **3 concurrent NVENC sessions running when only 2 were ever actually needed** — one of them for a branch nothing consumed. `src/pipeline.ts` was also reserving a phantom NVENC-tracker slot for that same dead branch, compounding it.

**Fixed**: the relay branch is no longer built or published when there are rendition targets (the normal case) — `buildCombinedRelayAndRenditionsArgv` now splits into exactly N branches, one per rendition, nothing extra. The phantom NVENC reservation in `pipeline.ts` was removed in the same pass. `config.relay.url`'s host/port is still used as the base address every rendition URL is derived from — only the separate encode+publish of that URL is gone. Two `tests/legs/argvBuilder.test.ts` tests updated to assert the corrected (smaller) argv shape; full suite (128/128) and typecheck clean. **Not yet re-verified live against the real 3-platform config** — that's the next step.

## Fixed — Kick RTMPS was never a TLS issue, it was a malformed destination URL

Real root cause of `kick-main` dying at a consistent ~2s, found by testing the destination URL directly against Kick's real ingest with verbose ffmpeg logging (`-loglevel debug`), isolated from the rest of the pipeline: Kick's URL (`rtmps://<host>/<KEY>`, one path segment) has no separate "app" path segment. ffmpeg's native RTMP protocol handler splits a URL's path into an "app" name and a stream key ("fname") — with only one segment, the whole thing became the app name and the actual publish command was sent with an **empty** stream name (confirmed in the debug log: `Sending publish command for ''`), which Kick's server silently rejected. Compare Twitch's working URL (`rtmp://live.twitch.tv/app/<KEY>`, two segments) — the difference was never TLS.

**Fix**: `ONEENCODE_KICK_MAIN_URL` now has an explicit `/app/` segment before the key (`rtmps://REDACTED-HOST.global-contribute.live-video.net/app/<KEY>`), matching the conventional RTMPS URL structure for AWS IVS-based ingest (Kick's underlying infrastructure, given its `global-contribute.live-video.net` domain). **Verified live**: a real 15-second H.264 test stream pushed successfully to Kick's actual ingest, full duration, clean shutdown, zero errors.

The v0.18.0 ffmpeg TLS-backend swap (GnuTLS → SChannel) below was **not** the actual fix — it's kept anyway since it's a reasonable general improvement, but it wasn't what resolved this. Worth remembering for any future single-path destination URL (a platform whose dashboard gives just a bare host with no app segment).

## Investigated — HEVC/AV1: MediaMTX v1.20.0 accepts them in, can't serve them back out via RTMP

Re-investigated after the user correctly pushed back on this project's own earlier "RTMP can't do HEVC" finding as too broad (real-world OBS→YouTube AV1 streaming does exist, via the 2023 "Enhanced RTMP" spec that Twitch/YouTube/OBS all support, which ffmpeg's flv muxer has implemented since v6.1).

Confirmed via a real synthetic test (`hevc_nvenc` → this project's actual bundled MediaMTX v1.20.0): the original ingest-side bug (MediaMTX's AMF0 `fourCcList` parser choking on HEVC, [mediamtx#3188](https://github.com/bluenviron/mediamtx/issues/3188)) was fixed upstream in v1.7.0 and no longer reproduces — MediaMTX correctly logs `"stream is available and online, 1 track (H265)"` on publish. **But a second, different, currently-real MediaMTX limitation was found in the same test**: a reader pulling that same stream back out via RTMP is rejected — `"the stream doesn't contain any supported codec, which are currently AV1, VP9, H265, H264, ..."` — despite H265 being in that exact list and having just been accepted as input. MediaMTX's RTMP *ingest* supports Enhanced RTMP; its RTMP *serving* side does not, as of v1.20.0.

Since every rendition in this pipeline gets read back out of MediaMTX via RTMP (`-c copy`, both destination legs and local-file legs), this is a real blocker for HEVC/AV1 anywhere in the current architecture — specific to MediaMTX's current output-side codec support, not a fundamental RTMP protocol limitation. Also confirmed AV1 hardware encoding isn't viable on either the dev machine (RTX 2080 Ti) or the streaming PC (RTX 2070) regardless — both are Turing-generation, no AV1 NVENC (needs RTX 40-series/Ada or newer). HEVC (`hevc_nvenc`) *is* available on both. CLAUDE.md/AGENTS.md's task #24 entry corrected to reflect this — no code changes from this investigation, config never touched HEVC/AV1.

## v0.18.0 — swap bundled ffmpeg to an OpenSSL/SChannel-TLS build (Kick RTMPS investigation)

The real 3-platform test found `kick-main` dying at a consistent ~2s every attempt (`[tls] Error in the pull function / IO error: End of file`), while Twitch/YouTube worked fine. The bundled ffmpeg (gyan.dev's essentials build) is compiled `--enable-gnutls`, and GnuTLS-based ffmpeg RTMPS builds have documented real-world compatibility gaps with some ingest servers that OpenSSL/native-TLS builds don't share. Swapped the bundled `ffmpeg.exe` (personal-package-only, see v0.13.0's ffmpeg-bundling note) to BtbN's `win64-gpl` build (`github.com/BtbN/FFmpeg-Builds`), which is `--enable-schannel` (Windows' own native TLS stack, not GnuTLS — corrected from an initial assumption it was OpenSSL) — same GPL license category, `ffmpeg-LICENSE.txt` updated accordingly. Also confirmed this build carries full HEVC (`libx265`, `hevc_nvenc`, `hevc_amf`) and AV1 (`libaom`, `libsvtav1`, `av1_nvenc`, `av1_amf`) encoder support. **Not yet verified against the real Kick failure** — needs a real retest on the streaming PC.

## v0.17.0 — always write console output to a log file

Requested directly by the user after debugging a real Kick RTMPS failure needed the raw ffmpeg stderr tail — which only ever went to `console.error`, never to the structured JSONL log `logger.ts` already writes — so a run launched by double-clicking the exe (no terminal to scroll back through) left no record of it at all.

### Added
- `src/logging/consoleMirror.ts` (`mirrorConsoleToFile()`, called first thing in `src/index.ts`): wraps `console.log`/`console.warn`/`console.error` to also append every call to `logs/oneencode-console-<date>.log`, in addition to printing normally. Every line is redacted the same way `logger.ts`'s own writes are (CLAUDE.md §2A) — defense in depth in case a future call site ever passes something unredacted straight to `console.error`.
- Test added (`tests/logging/consoleMirror.test.ts`) covering both the pass-through behavior and the redaction-of-embedded-secret case.

## v0.16.0 — auto-login: the auto-launched dashboard tab is now zero-manual-step

User feedback after v0.15.0: opening the browser automatically was good, but you still had to manually copy the token out of `state/ui-token.txt` and paste it into the login screen every time. Fixed with the user's explicit sign-off, since this touches CLAUDE.md's "the token is never displayed in a URL" rule.

### Changed
- `src/index.ts`'s auto-launch URL now includes `?token=...`.
- `web/src/App.tsx` reads it once on load (`getUrlToken`), persists it to `localStorage` the same as a manual paste would, and immediately strips it from the address bar via `history.replaceState` so it doesn't linger visibly in the URL/browser history any longer than that one initial load.
- CLAUDE.md/AGENTS.md's "never in a URL" rule updated to document this as a second narrow, deliberate exception (alongside the pre-existing WebSocket one) — explicitly scoped to the orchestrator's own auto-launched tab only, not any other link/redirect, and explicitly noted as a tradeoff accepted for the single-user dedicated-streaming-PC target rather than a shared machine.

## v0.15.0 — auto-open the dashboard in the default browser on startup

Requested directly by the user ("I hate the localhost approach, UI should be internal") — clarified down to: keep the existing server+browser architecture, just stop requiring a manual URL visit. `src/index.ts` now spawns `cmd /c start "" <dashboard-url>` right after the UI server comes up (same point in startup as before — still gated on the pipeline actually being ready, same known behavior as always). Best-effort: wrapped in try/catch, a failure to launch a browser logs a warning and never crashes the orchestrator.

## v0.14.0 — fix: bundled ffmpeg wasn't found by the packaged exe; a spawn failure crashed the whole orchestrator

Found while actually bundling ffmpeg.exe alongside `oneencode.exe` for a personal streaming-PC transfer (not a public-repo redistribution — see CLAUDE.md §6/§2A additions).

### Fixed
- **`spawn ffmpeg ENOENT` even with `ffmpeg.exe` sitting right next to `oneencode.exe`.** `child_process.spawn` on Windows resolves a bare command name ("ffmpeg") only via the `PATH` env var — unlike Windows' own `CreateProcess`, it does *not* also fall back to checking the launching process's own directory. `src/index.ts` now prepends `path.dirname(process.execPath)` to `PATH` on Windows at startup, which is a no-op in normal dev (`process.execPath` is just `node.exe`'s own location there) but correctly resolves a co-located `ffmpeg.exe` when running the packaged exe (`process.execPath` is the exe itself in that case).
- **A spawn failure crashed the entire orchestrator, not just the one leg** — `spawnLegProcess` (`src/legs/legProcess.ts`) had no `"error"` handler on the child process, so an `ENOENT` (or any spawn-time failure) was an unhandled exception that killed every other leg along with it, directly undermining the per-leg failure isolation CLAUDE.md §5 exists to guarantee. Now treated as a normal (if distinct — `spawnError` field added to the `leg_exit` log event) exit, so the existing restart/backoff loop in `health/monitor.ts` handles it like any other failure. Regression test added (`tests/legs/legProcess.test.ts`) simulating the ENOENT case via a mocked `child_process.spawn`.

### Verified
Rebuilt `oneencode.exe`, re-ran the standalone smoke test with chocolatey's `ffmpeg` deliberately removed from `PATH` (so only the bundled copy could satisfy it) — confirmed it now spawns the bundled `ffmpeg.exe` and reaches the expected "no OBS live" ffmpeg error, instead of `ENOENT`. Full test suite (123/123) and typecheck clean.

## v0.13.0 — standalone Windows exe for the streaming PC (no Node.js install required)

Requested directly by the user to deploy OneEncode on the dedicated streaming PC (CLAUDE.md's primary dual-PC target) without installing Node.js there.

### Added
- `scripts/package-win.ps1` (`npm run package:win`): bundles the ESM backend to a single CJS file (esbuild, since this project is `"type": "module"` and Node's Single Executable Application feature wants one entry file), generates a SEA blob, copies the locally-installed `node.exe`, strips its Authenticode signature (required before injection — auto-locates `signtool.exe` under the Windows SDK path), and injects the blob via `postject` to produce `oneencode.exe`.
- `oneencode.exe` resolves `config/`, `tools/mediamtx/`, and `web/dist/` relative to its *working directory*, same as the normal `tsx src/index.ts` entrypoint (nothing in the codebase used `__dirname`/`import.meta.url`-relative paths, which is what made this straightforward) — so it can be dropped anywhere alongside those folders and run standalone. ffmpeg remains a separate required install on the target machine (never bundled, per §6's licensing/redistribution stance) — `tools/mediamtx/` and `web/dist/` are copied alongside it since those *are* this project's own build output, not a third-party redistribution concern.
- New dev dependencies: `esbuild`, `postject`.

### Verified
Smoke-tested the packaged exe standalone (no `node_modules`, no Node install in the test directory) twice: (1) in a directory with no `config/` present — correctly hit the same `config_validation_error` path as the normal dev entrypoint and exited cleanly; (2) in a directory staged with the real `config/`, `tools/mediamtx/`, and `web/dist/` — correctly started MediaMTX, loaded all 3 real renditions, exercised the NVENC session-limit fallback (correctly fell back `kick-1080p60` to `h264_amf` under a conservative default ceiling), and retried the ingest connection with proper backoff (no OBS was live during this test, which is the expected/correct behavior — no destination legs run without frames). Confirmed clean shutdown with no orphaned `mediamtx.exe`/`ffmpeg.exe` processes.

## v0.12.0 — fix: real secret leaked into a log file (ffmpeg stderr not redacted mid-string)

**Found during the first real 3-platform test.** Kick's RTMPS leg failed (see the TLS connectivity note logged separately) and its ffmpeg process's own stderr output — `"Error opening output rtmps://host/KEY: I/O error"` — was logged to disk with the **real Kick stream key in plaintext**, directly violating CLAUDE.md §2A's mandatory redaction rule ("any destination URL that might contain a stream key must be passed through a redaction helper before it is ever written to a log line").

### Root cause
`src/logging/redact.ts`'s URL-matching regex was anchored to the start of the string (`^rtmps?:\/\//`). That correctly redacts a bare URL value (an argv array element, e.g.) but misses a URL **embedded mid-sentence** inside a longer string — exactly the shape of ffmpeg's own error messages, which is not a case the original test suite exercised (its coverage was whole-string/array-element values only).

### Fixed
`redactString` now does an unanchored, global search-and-replace for any `rtmps?://` occurrence anywhere in a string, not just when the whole string is one. Added a regression test using the actual leaked-line shape. All existing redaction tests still pass unchanged.

### Cleanup
The scratch log file this session's test run wrote to (`oneencode-run.log`, gitignored, never staged) contained the leaked key 10 times and was deleted outright rather than redacted in place. Confirmed via search that no other log file (`logs/*.jsonl`, the Bash tool's own background-task capture files) picked it up.

## v0.11.0 — broadcast arm switch: manual gate before any rtmp-push leg starts

Ahead of the first real 3-platform test (Kick, Twitch, YouTube configured with real credentials), added a deliberate safety gate so a config with `enabled: true` platform legs can never silently start broadcasting the moment the orchestrator boots.

### Added
- `src/health/broadcastArm.ts`: an in-memory-only armed/disarmed switch. Always starts disarmed on every orchestrator restart — no persisted "armed" state can survive a crash and let a leg start unattended.
- `rtmp-push` legs now start **staged, not running**, at `startPipeline` regardless of `enabled: true` — see `src/pipeline.ts`. `local-file` legs are unaffected (no external side effect, still auto-start as before).
- `restartManaged` (the same function backing both "Restart" and the new "Go Live" dashboard action) now throws if the target leg is `rtmp-push` and the broadcast switch is disarmed — one enforcement point, not two.
- `RunningPipeline` gained `isArmed()`, `arm()`, and `disarm()`. `disarm()` is a real kill switch, not just a future-start block — it immediately stops every currently-running `rtmp-push` leg, returning the ids it stopped.
- New endpoints (`src/ui/api.ts`): `GET /api/broadcast/armed`, `POST /api/broadcast/arm`, `POST /api/broadcast/disarm`. `GET /api/status` now also reports `broadcastArmed`.
- Dashboard (`web/src/App.tsx`): a persistent arm/disarm banner (red when armed, since that's the state where real data can leave the machine). Per-leg controls show "Go Live" instead of "Restart" for a staged `rtmp-push` leg, disabled with a tooltip when disarmed.

### Verified
Typecheck clean (backend + web), full existing test suite still green (60/60 — no unit test coverage added for this yet, it's an integration-level gate; live dashboard verification pending the actual 3-platform run).

## v0.10.0 — dashboard: clearer platform-destination setup, no more raw env-var field

Follows real-world feedback after the OBS validation above: the dashboard could add an RTMP-push leg, but the flow was confusing — it asked for a "destination env var name" (an internal config-loader detail no streamer should need to understand) and a single "Stream URL / key" field the user had to manually assemble, even though platforms like Twitch and YouTube give you the server and stream key as two separate fields in their own dashboard.

### Changed
- `src/ui/configApi.ts`: `destinationUrlEnv` is now derived server-side from the leg's own id (`ONEENCODE_<ID>_URL`) instead of being a UI-facing field. Editing a leg preserves its existing env-var name rather than re-deriving one (re-deriving would orphan the secret already stored under the old name).
- New `GET /api/config/platform-profiles` endpoint serves `config/platformProfiles.yaml` (Twitch/YouTube/Kick/Facebook Live recommended settings, architecture decision #10 — built 2026-08-13, never wired into anything until now) to the dashboard.
- `web/src/ConfigManager.tsx`: the rendition form gained an optional "Prefill from a platform" dropdown that fills in resolution/fps/bitrate from that platform's published recommendations — suggestion only, never overrides an already-set value, matches decision #10's hard rule exactly. The leg form's "Type" field is now "Send this to" with plain-language options, and the old single "Stream URL / key" input is now two fields — "RTMP server" and "Stream key" — joined client-side into the URL the backend expects, matching how platforms actually present the information instead of asking the user to concatenate it themselves.
- 4 new backend tests (`tests/ui/configApi.test.ts`): destinationUrlEnv auto-derivation on create, preservation on edit, and the new platform-profiles endpoint (empty-list fallback + real data).

### Verified live (real browser)
Logged into the dashboard, confirmed the "Encode pipeline" single-control card (from the combined-process fix above) renders correctly with live stats. Opened the platform-prefill dropdown on a new rendition, selected YouTube Live, confirmed video bitrate changed 6000→9000 and audio 160→128 exactly matching `platformProfiles.yaml`. Created an rtmp-push leg with separate server (`rtmp://live.twitch.tv/app/`, deliberately with a trailing slash) and key fields, confirmed the on-disk secret joined them correctly with no double slash (`rtmp://live.twitch.tv/app/live_FAKE_KEY_ABC123`) and the env-var name was auto-derived (`ONEENCODE_TWITCH_TEST2_URL`). Cleaned up both test legs through the UI, confirmed config and secrets files returned to their original clean state.

---

## Task #24 CLOSED — combined-process fix shipped, root mechanism fully characterized, validated against a real OBS feed (2026-08-13)

Closing entry for the rendition-dedup jitter investigation. Summary of the full chain, newest findings first (earlier entries below have the detailed evidence for each step).

**Shipped fix**: `src/legs/argvBuilder.ts`'s `buildCombinedRelayAndRenditionsArgv` folds the relay's decode and every rendition's encode into one ffmpeg process (`-filter_complex split`), eliminating the relay→rendition RTMP roundtrip that the original design had. `src/pipeline.ts`/`src/ingest/decodeRelay.ts` were restructured accordingly; `src/rendition/renditionProcess.ts` (the old per-rendition-process spawner) is gone. Destination legs are untouched — still fully independent processes, still `-c copy` from their rendition's RTMP path, still isolated from each other and from the encode side. The dashboard's per-rendition stop/restart controls were replaced with a single "Encode pipeline" control (`/api/encode/stop|restart`) since renditions no longer have independent processes to control — restarting any of them now honestly restarts the shared relay+all-renditions process, which is documented behavior, not a regression, since renditions already implicitly depended on the relay being alive.

**Root mechanism, fully characterized (not just narrowed) via further isolation after the fix shipped**:
- A pure remux of an already-perfect file (zero encoding involved at all), republished through MediaMTX and read back by a separate `-c copy` process, still measured CoV≈0.06 versus the source's CoV=0.0000 — proving MediaMTX's own publish/relay/subscribe mechanism introduces jitter independent of encoding (`scripts/jitterMediaMtxRelayTest.ts`).
- A plain OS-level stdio pipe between two processes (RTMP/MediaMTX removed entirely) measured CoV=0.09 — *worse*, not better — proving the mechanism isn't RTMP- or MediaMTX-specific either (`scripts/jitterStdioPipeTest.ts`, mislabeled during development as a "named pipe" test — Windows named pipes need a server created explicitly, which ffmpeg doesn't do automatically; the working test uses Node's own child-process stdio piping instead, a real OS pipe).
- Conclusion: **the jitter is inherent to crossing any process boundary at all**, scaling with how many concurrent processes/branches are contending for the machine (`scripts/jitterMultiBranchTest.ts`: 1 branch=CoV 0.028 floor, 2 branches=~0.056 regardless of encoder mix, 2 NVENC branches specifically=~0.087). This is a direct consequence of this project's own foundational, deliberate architecture decision (process-per-destination failure isolation, locked before any code was written) — not a bug in any specific transport or library. Baseline's historical CoV=0.0000 was only possible because it has zero internal process hops; any design that keeps destination-level isolation (the boundary that actually matters for a live-streaming tool: a flaky platform shouldn't take down other destinations) pays some jitter cost for it. There is no further transport swap that escapes this while keeping that isolation.

**A custom pacing/normalization relay was built, found working, then found buggy, then fixed, then judged unnecessary**: `scripts/jitterSmoothingRelayStressTest.ts`'s `FanOutPacingRelay` buffers a priming window and releases bytes at a steady, measured rate, decoupling output pacing from input arrival jitter. Single-writer short tests hit CoV=0.0000 (reproduced twice). A proper multi-leg, 3-minute stress test (explicitly requested rather than trusting the short test) caught a real bug the short test couldn't show: the buffer grew unbounded (0→48MB) because `setInterval(fn, 10)` doesn't reliably fire every 10ms under the real 7+-process load — measured firing at only ~55-64% of nominal rate by two independent forked debugging sessions (one auditing the relay's own byte accounting, one checking Node stream backpressure; both ruled out their assigned hypothesis and independently converged on the same timer-precision root cause). Fixed by computing release volume from actual measured elapsed time instead of the assumed fixed interval — buffer now stays correctly bounded. But the underlying *jitter* didn't improve after the fix (CoV stayed ~0.053, tested at 10ms/50ms/200ms tick granularity with no difference) — confirming the residual jitter comes from downstream process scheduling under contention, not from this relay's own timing precision, consistent with everything above. **Not integrated into production** — real-world testing (next section) showed it isn't needed.

**Real OBS validation — the gap flagged since day one, finally closed**: every test above used a synthetic lavfi source. Live-tested with real OBS output for the first time. Two real, separate bugs surfaced and were fixed:
- **HEVC over RTMP silently drops the video track.** Not a OneEncode bug — standard RTMP (the FLV-based protocol this pipeline's ingest is built on) has no HEVC support; MediaMTX/ffmpeg only saw an audio track when OBS was configured for HEVC. OBS's video encoder must be H.264 for this pipeline's ingest.
- **Live RTMP sources can need more probe time than ffmpeg's defaults** (`analyzeduration`=5s, `probesize`=5MB) before `-filter_complex` can bind streams — `[0:v] matches no streams` at filtergraph-binding time. Fixed by setting both to 10s/10MB on the combined process's input. (This turned out not to be the actual cause of the specific failure hit during testing — that was the HEVC issue above — but it's a real, independent gap the synthetic source never exercised, and is worth keeping regardless.)

With those fixed and a real H.264 OBS feed at 1080p60, the shipped combined-process pipeline (2 renditions, 3 legs, real dedup in effect) measured **CoV=0.0283 across all three legs, max single-frame delta 17ms, drop=0/dup=0** — the cleanest multi-leg result of this entire investigation, well below the ~0.05-0.09 seen in synthetic multi-process stress tests, and comfortably under the ~33-50ms judder reference point used earlier to reason about perceptibility. The recording was visually reviewed (not just measured) and confirmed smooth/performant. Real-world conditions are meaningfully cleaner than the worst-case synthetic stress tests, most likely because a real deployment doesn't carry this investigation's own test-harness overhead.

**Status: closed.** The architecture fix is real, shipped, and validated against actual live usage. The deeper cross-process-contention mechanism is now fully understood as an inherent property of the failure-isolation design this project chose deliberately on day one — not a defect, and not something further tunable without giving up that isolation. Real-world numbers are good. If a future real platform destination (Phase 2) or a much busier multi-rendition config ever shows visibly-bad results, the diagnostic tools built during this investigation (`npm run investigate:jitter-*`, `verify:jitter-fix`) are the starting point, and the pacing relay is a proven, working (if currently unneeded) fallback.

---

## Root cause CONFIRMED — jitter regression (task #24): the relay->rendition RTMP roundtrip itself is the mechanism (2026-08-13)

Direct, decisive confirmation, via `scripts/jitterNoRtmpHopTest.ts` (new, `npm run verify:jitter-fix`): one ffmpeg process decodes the ingest exactly once and splits the decoded frames (`-filter_complex split`) into two encode branches — branch A is the relay's normal ull encode, published to the real relay RTMP path exactly as today; branch B is a rendition-style 1080p6M encode written **directly to a local file, no RTMP publish, no MediaMTX, no second process**. Same total GPU/encode workload as the real pipeline (both branches run concurrently, same settings as every prior test), with exactly one variable changed: no RTMP demux/remux roundtrip between the decode and the rendition-style encode.

**Result: CoV = 0.0000 — perfectly uniform, matching baseline exactly.**

This is decisive: the jitter is not caused by encoding twice, not NVENC, not libx264, not GPU/session contention (all already ruled out) — it's specifically the RTMP publish/subscribe roundtrip through MediaMTX between the relay and the rendition encode. The moment that roundtrip is removed (same encode work, same process boundary count otherwise unchanged for branch A), the rendition-style branch is indistinguishable from baseline.

**The real tension this surfaces**: MediaMTX/RTMP was deliberately chosen for the relay->rendition and rendition->leg boundaries specifically *to decouple readers* for failure isolation (see architecture decision on rejecting a single monolithic `-filter_complex` process — CLAUDE.md §1). This experiment proves that exact decoupling mechanism is what introduces the jitter. There is a real tradeoff to make here, not a free fix: collapsing the relay->rendition boundary into one process (mirroring this test) would fix the jitter for renditions but reintroduce the coupling risk a rendition-stage crash was designed to avoid — though notably, legs/destinations (the boundary that actually matters most for isolation, since a destination failing shouldn't affect encoding) can likely stay on separate processes/RTMP reads unaffected, since this test didn't touch that boundary. **Task #24's root cause is now CONFIRMED, not just narrowed — the next step is an architecture decision about which process boundaries can safely absorb this fix and which must keep isolation, not further diagnostic work.**

**Caveat, not yet addressed**: every experiment in this investigation, including this one, uses the same synthetic lavfi test source, not real OBS output. OBS's own capture/encode pipeline has its own overhead and pacing characteristics that could differ from the synthetic source — this investigation isolates the relay->rendition boundary specifically, using an identical ingest across every comparison, but real-OBS validation of the eventual fix is still a separate, open follow-up before calling this production-proven.

---

## Investigated — jitter regression (task #24): root cause narrowed to live re-encode of an already-relayed stream; a third fix (`-fps_mode cfr`) tried and rejected (2026-08-13)

Continuing from the entry directly below (two candidate fixes already rejected: `nobuffer`/`low_delay`, `writeQueueSize` both directions). Built three new isolation tools (`scripts/jitterHopIsolation.ts`, `scripts/jitterFpsModeTest.ts`, `scripts/jitterEncoderTest.ts`, all now permanent — `npm run investigate:jitter[-fpsmode|-encoder]`) to stop guessing at the architecture level and directly measure which hop introduces the jitter.

**1. Hop isolation, via zero-encode `-c copy` taps at each stage (ingest / post-relay / post-rendition) simultaneously.** In this run all three taps read back essentially the same CoV (≈0.028), including the raw ingest tap itself — meaning a pure remux of the live ingest is not perfectly uniform either, and neither encode hop measurably added jitter on top of what a plain copy already showed. This didn't match the earlier 0.0000-vs-0.0740 finding, which was the first sign the effect isn't simply "more hops = more jitter" in a way a copy tap can see — copy-based taps don't re-time anything, so they can only reveal jitter already baked into arrival timing, not jitter an encoder itself introduces.

**2. Reproduced the official 0.0740 finding in a minimal, single-rendition-off-the-live-relay setup** (previously only ever measured via the full multi-leg pipeline) — confirms the earlier finding is real and not an artifact of the specific benchmark script. In the same run, a second concurrent rendition encoder with `-fps_mode cfr` explicitly forced scored *worse*, not better (0.0771 vs 0.0740), and introduced actual frame duplication (`dup=56` throughout, a duplicated frame roughly every second) — the forced-CFR frames still weren't evenly spaced (max delta 0.033s, a full doubled frame gap). **`-fps_mode cfr` is ruled out as a fix** — third candidate rejected.

**3. Tested whether this is NVENC-specific** by re-running the same single-rendition-off-the-live-relay setup with `libx264` (CPU) instead. Still elevated — 0.0598 CoV, roughly 8x the copy-tap floor — meaning **this is not an NVENC real-time session-pacing quirk**; a completely different encoder backend shows the same qualitative effect, just at a somewhat lower magnitude.

**4. Ruled out raw GPU/NVENC session-count contention as the mechanism.** The original baseline benchmark runs 2 concurrent NVENC sessions (`local-archive-1` + `local-archive-2`, both independently decoding the *original* ingest, no relay) and still measures ground-truth CoV≈0.0000 — near-perfect. A *single* rendition-stage encode session (regardless of encoder) reading from the relay already shows the full jitter. So contention/session-count isn't the differentiator — hop distance from the true origin is.

**Sharper characterization of the mechanism, still not a full explanation:** a live, real-time re-encode of a stream that itself came from another live ffmpeg process (the relay) measurably amplifies frame-pacing jitter in its own output, across at least two different encoder backends — while a live re-encode of the *original* true-origin ingest does not, even under comparable or higher concurrent session load. The remaining open question is *why* ffmpeg's live encode path treats these two input sources differently at the timestamp-generation level — that would need either instrumenting ffmpeg itself or testing further input-side variables (e.g. does normalizing the relay's own output timestamps before republishing help?), neither attempted yet. **Task #24 stays open** — three candidate fixes now rejected with real data (`nobuffer`/`low_delay`, `writeQueueSize`, `-fps_mode cfr`), but the root cause is meaningfully narrower than before: it's an encoder-agnostic effect of re-encoding a relayed live stream specifically, not a tunable buffer/pacing flag, not NVENC-specific, and not raw contention.

---

## Investigated — jitter regression (task #24): writeQueueSize ruled out both directions; ground-truth PTS cross-check makes the finding starker, not weaker (2026-08-13)

Continuing from the earlier "Investigated" entries below (`nobuffer`/`low_delay` tried and rejected — made things dramatically worse). Two more real steps taken:

**1. MediaMTX's `writeQueueSize` tried in both directions — neither helped.** Tested at 128 (below the 512 default) with the same `bench:oneencode` methodology used throughout: CoV 0.089-0.090, statistically indistinguishable from the untouched-default run's 0.090-0.092. (A larger value had reportedly been tried and rejected in an earlier pass of this same investigation, before default was reverted to for this final comparison — not independently re-verified with saved data, but consistent with this result.) **Reverted to the default** — no override left in `config/mediamtx.yml`, just a comment recording what was tried and that neither direction measurably helped.

**2. Completed the ground-truth cross-check flagged as still-open in the earlier entry**: extracted real per-frame PTS values via `ffprobe` from actual recorded output files (not the periodic `-stats` samples) and computed jitter directly (`scripts/ptsJitter.py`, new permanent tool). **This produced a starker result than the `-stats`-based CoV metric showed**:

| design | ground-truth PTS-delta CoV |
|---|---|
| baseline (naive, one process per destination) | **0.0000** — frame deltas ranged 0.016666-0.016667s, essentially perfectly uniform |
| this design (rendition-dedup) | **0.0740** — frame deltas ranged 0.015-0.018s, real ±10% swing around the 60fps target |

The `-stats`-based metric (CoV ≈0.05-0.07 baseline vs ≈0.09 this design) was directionally correct but *understated* how clean the baseline's actual frame delivery is — real ground truth shows the baseline isn't just "steadier," it's essentially perfectly uniform, while this design has genuine, measurable per-frame timing jitter. This is likely the actual mechanism behind the kind of visible stutter this project exists to fix, now captured with precise data rather than a periodic proxy.

**Root cause still not isolated after two real hypotheses tested and rejected with data** (`nobuffer`/`low_delay`, `writeQueueSize` both directions). Both were plausible, both were tested rigorously, neither explained it. Remaining candidates for a future session, not yet tried: something more fundamental to the extra-hop architecture itself (more concurrent OS processes competing for CPU/GPU scheduling time, inherent to any 3-hop chain vs. baseline's 1-hop) rather than a tunable buffer parameter — which would mean this needs an architectural answer, not a config tweak, if it's going to be fixed. **Task #24 stays open.** Per CLAUDE.md §8: this project's architecture remains CPU/GPU-efficiency-correct and failure-isolation-correct, but confirmed — now with sharper evidence than before — NOT to reduce the frame-pacing symptom it exists to fix.

---

## Docs — project licensed, source-available (2026-08-13)

Added a real `LICENSE` file at the repo root, mirroring the structure of this author's sibling MW3 controller project's own license (read directly from that project's real `LICENSE` file, not guessed/templated from memory): source is fully open/viewable/forkable, but the software and any fork/derivative must always remain free to end users — no charging for it by anyone other than the copyright holder. This is a deliberate restriction, so the project is accurately described as **source-available**, not OSI open-source, going forward in any doc/README. Adapted the MW3 license's game/Activision-specific clause into an equivalent for OneEncode's actual context (no rights granted to any third-party streaming platform's trademarks/APIs/services). CLAUDE.md §6 updated with the real per-dependency licensing detail (FFmpeg — external, never bundled; MediaMTX — MIT, confirmed by reading its actual downloaded LICENSE file directly).

---

## v0.9.0 — add/edit/remove legs through the dashboard, live-verified

Closes the one documented gap from v0.7.0's Phase 6 dashboard: config changes required hand-editing YAML + a restart. That restart requirement is unchanged (no hot-reload), but the hand-editing is no longer required.

### Added
- `src/ui/configApi.ts` — full CRUD REST API for renditions and legs, mounted at `/api/config` behind the same token gate as the rest of the dashboard. Every write is validated through the exact same `rootConfigSchema`/`legSchema`/`renditionSchema` (`src/config/schema.ts`) the orchestrator itself loads with, so a config the API accepts is guaranteed to be one the orchestrator will actually start with. Deleting a rendition still referenced by a leg is refused with a clear error naming the dependent leg(s), not a silent orphan reference.
- Secrets are write-only through the whole stack: a leg write accepts an optional `secretValue`, written straight to `config/secrets.local.yaml`, never returned by any GET response — the API only ever reports `secretSet: true/false`. Deleting an rtmp-push leg deletes its associated secret too.
- `web/src/ConfigManager.tsx` + `web/src/configApi.ts` — a "Configure" tab alongside the existing "Monitor" tab, with add/edit/delete forms for both renditions and legs. Secret fields are password-style inputs, never pre-filled with a real value on edit ("leave blank to keep as-is").
- Every successful config write shows a persistent "Config saved — restart required, no hot-reload yet" notice banner in the dashboard, so the restart requirement is visible, not a silent gap.
- `encoderName`/`renditionSchema` widened from module-private to exported in `src/config/schema.ts`, needed by the new config API for validation and to populate the frontend's encoder-selection options.
- 9 new backend unit tests (`tests/ui/configApi.test.ts`) — notably, `node:fs` is fully mocked so these tests never touch the real `config/*.yaml` on disk (this project's dev config is shared with whatever else might be running against it).

### Verified live (real browser, real file I/O this time — not mocked)
- Logged into the dashboard, opened the new Configure tab: both existing renditions and legs rendered correctly in tables.
- Created a new rendition (`test-540p`, 960x540) through the form: it appeared in the table immediately, the "restart required" notice appeared, and `config/legs.local.yaml` on disk was confirmed to contain the exact new entry, correctly formatted YAML.
- Deleted it through the UI: table and on-disk file both returned to their original state.
- Zero console errors throughout. This also incidentally confirmed the Express route-mounting order (`/api` then `/api/config`) works correctly — Express's router fall-through behavior does the right thing here, worth knowing given this project already found one real Express 5 routing surprise in v0.7.0.

---

## v0.8.0 — rtmp-push code path validated end-to-end; real relay-encoder bug found and fixed

Context: three parallel background agents were set to work on the open items from v0.7.0 (jitter root cause, add/edit/remove-leg UI, de-risking Phase 2 without real credentials). All three hit the session's account-level API rate limit mid-task and were cut off before finishing. This entry covers picking up and completing the Phase 2 de-risking work; the other two are covered separately below once reviewed and completed.

### Fixed — real bug, found via live testing, not assumed
- **`buildRelayArgv` unconditionally emitted NVENC-only flags** (`-tune ull`, `-rc cbr`) regardless of the configured `relay.encoder`. `EncoderName` is a schema-level union that explicitly permits `libx264`/`libx265`/AMF variants for `relay.encoder`, but passing NVENC-only flags to any of those makes ffmpeg reject the command outright at launch. **This went unnoticed through this entire project so far because every prior test used the schema default (`h264_nvenc`)** — it surfaced the moment a non-NVENC relay encoder was actually tried. Fixed by splitting relay encode-arg construction into per-encoder-family branches (`relayEncodeArgs`, mirroring the existing pattern in `videoEncodeArgs`): NVENC keeps `-tune ull`/`-rc cbr`; AMF uses `-quality speed` (ignoring the NVENC-shaped `preset` value); libx264/265 uses the real `-tune zerolatency` and no `-rc`. 2 new unit tests lock in the fix (one per non-NVENC family, asserting the NVENC-only flags are actually absent).

### Verified live — the rtmp-push code path, never exercised before in this project
Every leg tested anywhere in this project up to this point was `type: "local-file"` — the `rtmp-push` variant (`resolveRtmpDestination`, `buildCopyArgv` with an rtmp output sink, secrets resolution from `config/secrets.local.yaml`) had real code and real unit tests for its pieces, but had never actually been run end-to-end. Built a self-contained validation (spawned its own MediaMTX on port 1965, its own synthetic source, the real `buildRelayArgv`/`buildEncodeArgv`/`resolveRtmpDestination`/`buildCopyArgv` functions, pushed to a local stand-in "destination" path instead of a real platform, then acted as that platform — recorded 8s from the stand-in path and `ffprobe`'d it) — confirmed a real, valid, playable H.264/AAC stream was received (1280x720, correct codecs and duration). **RESULT: PASS.** This directly de-risks Phase 2 (adding the first real platform leg) — the plumbing between config, secrets resolution, and the actual RTMP push is now proven correct independent of having real platform credentials.

---

## v0.7.0 — Phase 6 dashboard frontend, live-verified in a real browser

### Added
- `web/` — Vite + React SPA per CLAUDE.md architecture decision #8. Token login gate (paste from `state/ui-token.txt`, cached in `localStorage`), a card per rendition (resolution/fps/bitrate/encoder-preference chain, live stats, Stop/Restart), a table of that rendition's dependent legs with color-coded state badges and their own Stop/Restart controls. Live data via WebSocket push with a 5s REST poll fallback.
- Root `package.json`: `web:install`/`web:build`/`web:dev` convenience scripts. `web:dev` proxies `/api` and `/ws` to the real backend (port 4771) for hot-reload iteration; production always serves the built static bundle directly from `src/ui/server.ts`.
- Removed unused default Vite scaffold assets (`hero.png`, `react.svg`, `vite.svg`, `icons.svg`) that nothing referenced.

### Fixed
- **Real startup-crashing bug, found via live testing**: Express 5's router (path-to-regexp v7+) rejects a bare `"*"` wildcard route — `src/ui/server.ts`'s SPA-fallback route used that syntax (`app.get("*", ...)`) and crashed the entire orchestrator at startup with `PathError: Missing parameter name at index 1: *` the moment `web/dist` actually existed. This had been silently unreachable in all of v0.6.0's "verified live" backend testing, because that testing happened before the frontend was built, so `web/dist` didn't exist yet and the server took the other branch. Fixed to the named-wildcard form Express 5 requires (`"/*splat"`) and re-verified.

### Verified live (real browser, not just curl)
- Navigated to `http://127.0.0.1:4771/` in an actual Chrome tab: login gate rendered correctly, entering the real token from `state/ui-token.txt` authenticated successfully.
- Dashboard rendered real live data: both renditions with correct resolution/fps/bitrate/encoder chains, all three legs correctly grouped under their rendition, live-updating stats matching what the orchestrator's own log showed.
- Clicked "Stop" on `local-720p-archive`'s row: its badge updated to `STOPPED` within seconds, no page reload, no console errors (`read_console_messages` confirmed clean).
- Sibling legs/renditions (which had independently hit their restart cap after the test source ended, showing `FAILED`) were correctly unaffected by the stop click — the UI accurately reflects true backend state per leg, not a shared/aggregated status.

### Still open (per plan Phase 6)
- Add/edit/remove destination legs through the UI is not built — see v0.6.0 below and CLAUDE.md architecture decision #8 for the honest scope note. Config changes still require hand-editing YAML plus a restart.

---

## v0.6.0 — Phase 6 dashboard backend

### Added
- `src/ui/server.ts` — Express + WebSocket server, bound to `127.0.0.1` only, serving the REST API and (once built) the static frontend from `web/dist`.
- `src/ui/auth.ts` — local token auth, generated on first run to gitignored `state/ui-token.txt`, `Authorization: Bearer` for REST and a `?token=` query param for the WebSocket handshake (browser WS clients can't set custom headers).
- `src/ui/liveState.ts` — tails today's structured log continuously (byte-offset based, no re-reading) into an in-memory `legId -> latest stats` map, broadcasting updates over WebSocket. Decoupled from the core supervisor, same pattern as the benchmark scripts' jitter report.
- `src/ui/api.ts` — `GET /api/status` (full leg/rendition list with live state + stats, secrets never included since `LegConfig` only ever stores a destination env-var *name*, not a resolved value), `POST /api/legs/:id/stop|restart`, `POST /api/renditions/:id/stop|restart`.
- `src/pipeline.ts`: `stopManaged`/`restartManaged` — a manual restart respawns a fresh supervised process reusing the original argv-building closure and (for renditions) the originally-selected encoder, without re-running NVENC session selection (would double-reserve tracker slots otherwise).
- `src/rendition/renditionProcess.ts`: extracted `buildRenditionEncodeArgv` as a pure function, separated from `startRenditionEncode`'s side-effecting spawn — needed so a manual restart can rebuild the exact argv without spawning a throwaway process just to get it.

### Fixed
- **Caught and fixed mid-build**: an early version of `pipeline.ts`'s restart-descriptor plumbing accidentally called `startRenditionEncode` (which spawns a real process) just to probe a value, then discarded it — a real bug that would have spawned duplicate rendition-encode processes as a side effect of building an argv string. Caught before it ever ran, via the `buildRenditionEncodeArgv` extraction above.
- **Real logging accuracy bug, found and fixed**: `leg_exit`'s `wasExpected` field was hardcoded to `false` unconditionally — a deliberate stop (via the dashboard, orchestrator shutdown, or a watchdog-triggered restart) was logged identically to a genuine crash. Added `LegProcessHandle.markExpectedExit()`, called by `stopLegProcess` before it ever writes `q`/kills the process, so the log now correctly distinguishes "we stopped this on purpose" from "this died on its own."

### Verified live
- Auth: confirmed `/api/status` returns `401` with no/wrong token, and full data with the correct one.
- `/api/status` returns real live stats (fps/bitrate/drop/dup, updating in near-real-time) for every leg and rendition.
- Stop: stopped `local-720p-archive` via the API well before the test source ended (to avoid confounding with source-loss crash-looping seen in an earlier, noisier test); confirmed it stayed `state: "stopped"` with no restart, while `local-archive-1`/`local-archive-2` and both renditions kept running unaffected — failure isolation holds through the dashboard's own control path too, not just process kills.
- Restart: restarted the stopped leg via the API; confirmed it came back to `state: "running"` with fresh `drop=0` stats within seconds.

### Known limitation (documented, not silently omitted)
- **Add/edit/remove destination legs through the UI is not built.** Config changes still require hand-editing `config/legs.local.yaml`/`secrets.local.yaml` and an orchestrator restart, same as before this dashboard existed. The original locked scope (CLAUDE.md architecture decision #8) named this as first-version scope; it's deliberately deferred rather than rushed, and documented here as a real gap, not claimed as done.
- **Frontend not built yet** — the API has been verified via curl only. `web/` (Vite + React SPA) is the next piece.

---

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

**Root cause not yet isolated.** Until it's found and addressed, **the rendition-dedup and single-decode architecture is CPU/GPU-efficiency-correct and failure-isolation-correct, but confirmed NOT to reduce the frame-pacing/burstiness symptom this project exists to fix — it measurably makes that specific symptom worse in this test, not better**, even while using genuinely less redundant compute. This is now a confirmed finding, not a hypothesis, and is flagged prominently in CLAUDE.md.

**First root-cause hypothesis tested and REJECTED, same day: FFmpeg's own default RTMP input buffering on the copy leg.** Tried adding `-fflags nobuffer -flags low_delay` to `buildCopyArgv`'s input side (a real, targeted attempt to eliminate one candidate, not left as a TODO). Result was dramatically worse, not better: CoV jumped to 0.153-0.156 and actual playback stalls appeared (min fps dropped to 8-9, mean fps dropped to ~53 against a 60fps target — visible real degradation, not just a worse number). Reverted immediately. **Makes sense in hindsight**: `nobuffer`/`low_delay` trade buffer depth for latency — exactly backwards from this project's own locked priority order (consistency over minimum latency, see PROJECT OVERVIEW's "Success criteria" section). **This specific lever is ruled out** — the remaining candidates (MediaMTX's own internal buffering/queueing between publish and subscribe, or something else entirely in the extra hop) are still open for a future investigation session.

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
