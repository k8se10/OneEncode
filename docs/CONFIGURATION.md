# Configuration reference

This is the full reference for OneEncode's config system. If you haven't gone
through the basic setup yet, start with [GETTING_STARTED.md](GETTING_STARTED.md)
first — this document assumes you already have a working `config/legs.local.yaml`
and want to understand every field and how the pieces fit together.

## File layout

| File | Committed? | Purpose |
|---|---|---|
| `config/legs.example.yaml` | Yes | Documentation template — showcases every field (multiple renditions, rendition dedup, an `rtmp-push` leg shape) but isn't meant to run as-is (its `rtmp-push` legs reference secrets that don't exist). Copy this to `legs.local.yaml` as a starting point for real setup. |
| `config/legs.default.yaml` | Yes | The **actually-runnable** first-run default — one `local-file` leg, no real credentials needed. Auto-copied to `legs.local.yaml` if that file doesn't exist yet (see below); you won't normally edit this directly. |
| `config/legs.local.yaml` | **No** (gitignored) | Your real renditions, legs, ingest/relay settings, restart policy. |
| `config/secrets.local.example.yaml` | Yes | Placeholder template for secrets. |
| `config/secrets.local.yaml` | **No** (gitignored) | A flat map of `ENV_VAR_NAME: real-value` — real destination URLs and stream keys. Never referenced by literal value anywhere else in config; legs point at a secret by *name* only. |
| `config/platformProfiles.yaml` | Yes | Reference table of known platforms' published recommended encode settings — not a secret, just documentation data. Used to prefill new renditions in the dashboard. |
| `config/mediamtx.yml` | Yes | Config for the bundled local RTMP relay server (MediaMTX). You generally won't need to touch this. |

`legs.local.yaml` and `secrets.local.yaml` are both loaded and validated at
startup by `src/config/load.ts`. **If `legs.local.yaml` doesn't exist at all**,
it's auto-generated from `legs.default.yaml` so the orchestrator can start on
a completely fresh install — a startup log line and the dashboard's
`usingDefaultConfig` banner both make this visible, it's never silent. This
only fires when the file is *missing*; if it exists but **fails schema
validation**, or a leg references a secret env-var name that isn't resolvable
(missing from `secrets.local.yaml` *and* not set as a real process
environment variable), the orchestrator still refuses to start with a clear
error — a real, if broken, config is never silently replaced or
partial-started with some legs missing their credentials.

There is currently **no hot-reload**. Every config change (through the
dashboard or by hand-editing YAML) requires restarting the orchestrator to
take effect. The dashboard shows a "restart required" notice after any
config write for exactly this reason.

## Renditions: what to encode

A rendition describes an encode profile — resolution, framerate, bitrate,
codec — completely independent of where it's going. Example:

```yaml
renditions:
  - id: 1080p60-6M
    resolution: { width: 1920, height: 1080 }
    fps: 60
    videoBitrateKbps: 6000
    audioBitrateKbps: 160
    keyframeIntervalSec: 2
    encoderPreference: [h264_nvenc, h264_amf, libx264]
```

Fields (from `src/config/schema.ts`'s `renditionSchema`):

- **`id`** (required) — must match `^[a-zA-Z0-9_-]+$` (letters, digits, `-`,
  `_` only) since it becomes part of an internal URL path
  (`rtmp://<relay-host>/rendition/<id>`). Must be unique across all
  renditions.
- **`resolution`** (required) — either an explicit `{ width, height }` object,
  or the literal string `"source"` to skip scaling entirely and encode at
  whatever resolution the incoming source actually is. No `-vf scale` filter
  is applied for `"source"`.
- **`fps`** — defaults to `60` if omitted. **Note**: this value is *not*
  used to force the output frame rate (no `-r`/`fps=` filter is applied
  anywhere) — it's used purely to compute the GOP/keyframe-interval size
  (`fps * keyframeIntervalSec`, rounded). The actual output frame rate is
  always whatever the source genuinely delivers.
- **`videoBitrateKbps`** *or* **`videoQuality`** — exactly one style of rate
  control, not both:
  - `videoBitrateKbps: 6000` — a fixed CBR-style bitrate target (`-b:v`,
    `-maxrate`, `-bufsize` at 2x the bitrate).
  - `videoQuality: { mode: cq, value: 19 }` (or `mode: cbr`/`vbr`) — quality-based
    encoding (`-cq`/`-crf` depending on encoder family) instead of a fixed
    bitrate. Lower `value` = higher quality/bigger files.
  - If neither is set, config validation fails with a clear error naming the
    rendition.
- **`audioBitrateKbps`** — defaults to `160`. Audio is always AAC, 48kHz.
- **`keyframeIntervalSec`** — defaults to `2`. Used with `fps` to compute the
  GOP size passed to the encoder.
- **`encoderPreference`** (required, non-empty array) — an ordered fallback
  list from `h264_nvenc | hevc_nvenc | av1_nvenc | h264_amf | hevc_amf |
  av1_amf | libx264 | libx265`. The orchestrator walks this list at startup,
  skipping NVENC entries once the probed session ceiling is reached (see
  "Encoder selection" below).

  **Only H.264 encoders are currently usable end-to-end** (`h264_nvenc`,
  `h264_amf`, `libx264`) — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for
  why HEVC/AV1 don't work with the bundled relay yet, even though the schema
  itself permits configuring them.

### Rendition dedup — why sharing an `id` matters

Two or more legs that reference the **same `renditionId`** share exactly one
encode branch inside the single combined decode process — the second (and
third, etc.) leg is a cheap `-c copy` stream-copy, not a redundant
decode+scale+encode. This is the whole point of separating renditions from
legs.

Concrete example: if you're pushing 1080p60 to both Twitch and Kick, give
both legs the same `renditionId` (e.g. `shared-1080p60`) instead of two
separate renditions with identical settings — one encode branch runs, both
legs remux from it. Only give two legs *different* rendition ids when they
actually need different resolutions/bitrates/codecs (e.g. a 1440p rendition
for YouTube alongside a 1080p rendition for everything else).

## Legs: where it goes

A leg references a rendition by id and describes a destination. Two types:

```yaml
legs:
  - id: twitch-main
    enabled: true
    type: rtmp-push
    renditionId: shared-1080p60
    destinationUrlEnv: ONEENCODE_TWITCH_MAIN_URL
    priority: 20

  - id: local-archive-1
    enabled: true
    type: local-file
    renditionId: shared-1080p60
    outputDir: recordings
    filenamePattern: "archive_{timestamp}.mp4"
    priority: 10
```

Common fields (every leg type):

- **`id`** (required, unique).
- **`enabled`** — defaults to `true`. A disabled leg is skipped entirely —
  its rendition branch isn't even built if no other enabled leg needs it.
- **`renditionId`** (required) — must reference an existing rendition; the
  config fails validation otherwise (with the specific leg named in the
  error).
- **`priority`** — defaults to `0`. Used for display/ordering; doesn't
  affect encode behavior.

`type: rtmp-push` fields:
- **`destinationUrlEnv`** (required) — the *name* of an environment
  variable/secrets-file key holding the real destination URL (e.g.
  `rtmp://live.twitch.tv/app/<stream-key>`). Never the URL itself — that
  lives in `secrets.local.yaml`, resolved at load time.
  In the dashboard, this is derived automatically from the leg's own id
  (`ONEENCODE_<ID>_URL`) — you never see or edit the raw env-var name there,
  just separate "RTMP server" and "Stream key" fields that get joined
  client-side.
- **rtmp-push legs never auto-start.** See "Broadcast arm" below — they
  start staged and need an explicit arm + Go Live action, even with
  `enabled: true`.

`type: local-file` fields:
- **`outputDir`** (required) — relative to the working directory (typically
  `recordings/`).
- **`filenamePattern`** — defaults to `"archive_{timestamp}.mp4"`. `{timestamp}`
  is substituted at record-start time. Regenerated on every restart, so a
  crash-restart never reopens/overwrites a prior partial file.
- Local-file legs **auto-start** — no arm/Go Live gate, since nothing leaves
  the machine.

### One destination URL needs a real path, not just a bare host

Worth calling out here since it's config, not code: some platforms' own
dashboards give you a destination URL that's just a bare host with the
stream key as the only path segment (e.g. `rtmps://example-host/KEY`). If
your platform does this, add an explicit `/app/` (or whatever segment your
platform's docs show) before the key. See
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) for why this matters — ffmpeg's RTMP
handler will otherwise silently send an empty stream name and the platform
will reject the connection in a way that looks exactly like a TLS failure.

## Ingest, relay, and restart policy

```yaml
ingest:
  listenUrl: "rtmp://127.0.0.1:1935/ingest/live"

relay:
  url: "rtmp://127.0.0.1:1935/relay/live"
  encoder: h264_nvenc
  preset: p1
  tuneLowLatency: true
  bitrateKbps: 40000

encoderPriority:
  - h264_nvenc
  - h264_amf
  - libx264

restartPolicy:
  maxRestartsPerHour: 5
  backoffInitialMs: 2000
  backoffMaxMs: 60000
```

- **`ingest.listenUrl`** — where your local encoder (OBS) publishes the
  source. You normally never need to change this from the default.
- **`relay.url`** — its host:port is the base every rendition's real
  internal URL is derived from (`rtmp://<relay-host>/rendition/<id>`). The
  relay no longer runs a separate mezzanine encode+publish of its own (that
  branch was removed as dead weight — see PATCHNOTES.md) — only its
  host/port are actually used now. `relay.encoder`/`preset`/`tuneLowLatency`/
  `bitrateKbps` only matter for the degenerate zero-rendition fallback case
  and can be left at their defaults.
- **`relay.decodeHwaccel`** (default `false`) — decode the incoming source
  via the GPU's NVDEC engine (`-hwaccel cuda`) instead of software/CPU
  decode, with GPU-side scaling (`scale_cuda`) for any rendition using an
  NVENC encoder. Off by default — explicit opt-in, since it needs a real
  NVIDIA GPU and this project never assumes hardware presence (same
  posture as the NVENC session ceiling). Turn it on if `nvidia-smi dmon`
  shows your encode (`enc`) engine busy while decode (`dec`) sits at 0% —
  that means decode is running on the CPU instead of the otherwise-idle GPU
  decode engine. A rendition that falls back to AMF/libx264/libx265 still
  works with this on; its branch gets an extra `hwdownload` step back to
  system memory, since only NVENC can consume GPU-resident frames directly.
- **`encoderPriority`** — the default fallback order used if a rendition
  doesn't set its own `encoderPreference` explicitly. (In practice, always
  set `encoderPreference` per-rendition — the dashboard always does.)
- **`restartPolicy`** — applies uniformly to every leg and to the combined
  encode process. `maxRestartsPerHour` is a rolling-hour cap past which a
  leg is marked permanently failed and surfaced loudly rather than looping
  forever; backoff is exponential between `backoffInitialMs` and
  `backoffMaxMs`.

## Encoder selection and the NVENC session ceiling

`encoderPreference` is walked in order at orchestrator startup. NVENC-family
encoders (`h264_nvenc`, `hevc_nvenc`, `av1_nvenc`) are tracked against a
concurrent-session ceiling — once reached, the tracker skips remaining NVENC
entries in the list and falls through to the next non-NVENC option, logging
an `encoder_fallback` event.

**That ceiling is never hardcoded.** Consumer NVIDIA cards have historically
capped concurrent NVENC sessions in the driver, and the real number varies
by GPU/driver. Run:

```
npm run probe:nvenc
```

This empirically launches synthetic `h264_nvenc` sessions one at a time
against a test source until one fails, and writes the real ceiling to
`state/nvenc-ceiling.json` (gitignored — this is per-machine). If you've
never run the probe, the orchestrator uses a conservative fallback ceiling
of 3, with a loud warning telling you to run the probe. Re-run it after any
NVIDIA driver update.

Encoder choice is made once per rendition at orchestrator startup, not
re-evaluated on every crash-restart — a reasonable simplification since
renditions are stable for a run's duration. If NVENC genuinely can't be
acquired at runtime despite the tracker's count, it surfaces as a normal
ffmpeg launch failure and the existing restart/backoff loop takes over.

## The broadcast arm switch

`rtmp-push` legs (anything that sends real data to a real external
platform) start **staged, not running**, when the orchestrator boots — even
with `enabled: true`. Two gates, both reset to off on every restart (no
persisted armed state can survive a crash and let a leg start unattended):

1. **A global arm switch** — the dashboard's persistent arm/disarm banner,
   or `POST /api/broadcast/arm` / `POST /api/broadcast/disarm`.
2. **A per-leg "Go Live" action** — refused unless the global switch is
   armed.

Disarming is a real kill switch, not just a block on future starts — it
immediately stops every currently-running `rtmp-push` leg.

`local-file` legs are completely unaffected by any of this — no external
side effect, they auto-start as always.

## The dashboard: what's configurable there vs. what needs a hand-edit

The dashboard (`http://127.0.0.1:4771` by default) talks to the same
`config/legs.local.yaml`/`secrets.local.yaml` files directly — there's no
separate database to fall out of sync.

**Configurable through the dashboard's "Configure" tab** (`src/ui/configApi.ts`,
mounted at `/api/config`):
- Full create/edit/delete for **renditions** and **legs**.
- Every write is validated through the exact same schema the orchestrator
  loads with — the dashboard cannot produce a config the orchestrator would
  then reject at startup.
- Deleting a rendition still referenced by a leg is refused with an error
  naming the dependent leg(s).
- A leg's stream key/URL is write-only end to end — the API only ever
  reports `secretSet: true/false`, never the real value, even to an
  already-authenticated client.
- A rendition can be prefilled from `config/platformProfiles.yaml`'s
  recommendations (see below) via a dropdown — suggestion only, never
  overwrites an already-set field.

**Not configurable through the dashboard — requires hand-editing YAML +
restart:**
- `ingest.listenUrl`
- `relay.*` settings
- `encoderPriority`
- `restartPolicy`

## `platformProfiles.yaml` — seeding sensible defaults

A committed, non-secret reference table of well-known platforms' *published*
recommended encode settings, used only to prefill a brand-new rendition's
resolution/fps/bitrate in the dashboard. **Hard rule: it never overrides a
value you've already set** — it only ever seeds an unset field on a new
rendition, or shows as a visible suggestion.

Platforms currently in the table: **Twitch, YouTube Live, Kick, Facebook
Live, TikTok LIVE** (the TikTok entry is ingest-spec documentation only —
TikTok isn't wired up as an actual leg type yet, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md)). Each entry carries a
`confidence` rating and a `sourcedDate` — these are compiled from each
platform's public documentation, not fetched live, and should be
re-verified against the platform's current docs before you rely on them for
a real broadcast, especially if the date looks old.

## Logging

Two log outputs, both under `logs/` (gitignored):

- **Structured JSONL** (`logs/oneencode-<date>.jsonl`) — one line per
  event (leg starts/exits/restarts, stats samples, encoder fallbacks,
  config errors). This is what the dashboard's live stats and the benchmark
  scripts' jitter reports read back.
- **Console mirror** (`logs/oneencode-console-<date>.log`) — every
  `console.log`/`warn`/`error` call, mirrored to a plain-text file in
  addition to printing normally. Exists so a run launched by double-clicking
  the packaged exe (no visible terminal) still leaves a debuggable record.

Both are **redacted before every write** — any URL that looks like it might
carry a stream key is scrubbed, matching mid-string occurrences (e.g.
embedded in an ffmpeg error message), not just clean structured values.

Both are also **size-bounded**, added ahead of the first public release so a
long-running, unattended install can't fill a disk: each dated file rolls to
a new numbered file (`.2`, `.3`, ...) once it would exceed 10MB, and the
oldest files across the whole `logs/` directory are pruned once total size
exceeds 200MB. Both the dashboard's live tailing and the benchmark scripts'
log-reading correctly follow rotation, so this is transparent during normal
use.
