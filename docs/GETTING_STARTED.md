# Getting Started with OneEncode

This walks you from a fresh clone of the repo to a working local test stream, and then to adding your first real platform destination. It assumes you're comfortable with a terminal and have (or can install) [OBS](https://obsproject.com/) as your source encoder. Windows only — OneEncode is not tested on other platforms.

For the full config schema, rendition/leg reference, and encoder details, see [`docs/CONFIGURATION.md`](./CONFIGURATION.md). For common problems, see [`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).

## 1. Prerequisites

**If you downloaded a standalone release build** (a folder with `oneencode.exe` in it, produced by `npm run package:win`), you can skip this whole section — FFmpeg, MediaMTX, and Node itself are all bundled in that folder already. Just go to the folder and run `oneencode.exe`; the rest of this tutorial (from step 3 onward) still applies for configuring it.

**If you're running from source** (`npm run dev`), you need:

- **FFmpeg**, available on your system `PATH`. Not committed to this repo — install it however you prefer (e.g. via [Chocolatey](https://community.chocolatey.org/packages/ffmpeg) on Windows: `choco install ffmpeg`), then confirm it's reachable:

  ```bash
  ffmpeg -version
  ```

  If you have an NVIDIA and/or AMD GPU, check that your FFmpeg build actually has hardware encoder support — not every build does:

  ```bash
  ffmpeg -encoders | findstr nvenc
  ffmpeg -encoders | findstr amf
  ```

  You want to see `h264_nvenc` and/or `h264_amf` in the output. If neither shows up, OneEncode will still work — it falls back to the CPU encoder `libx264` — just at a higher CPU cost.

- **Node.js 20+**. Confirm with `node --version`.

- **MediaMTX**, the local RTMP relay server OneEncode uses internally. As of this writing there is no automated fetch script for it yet — you need to download it yourself:
  1. Grab the Windows build from the [MediaMTX releases page](https://github.com/bluenviron/mediamtx/releases).
  2. Extract `mediamtx.exe` into `tools/mediamtx/mediamtx.exe` in this repo (create the folder if it doesn't exist).
  3. That's it — `config/mediamtx.yml` (already committed in this repo) configures it; you don't need to touch MediaMTX's own config yourself.

If you'd rather build the standalone package yourself instead of continuing with the source path below, run `npm run package:win` from a working dev setup (i.e. after finishing this prerequisites section) — it produces a `dist-release/OneEncode/` folder with `oneencode.exe` and every dependency (Node, FFmpeg, MediaMTX) bundled in, ready to copy to another machine.

## 2. Clone and install

```bash
git clone <this-repo-url>
cd OneEncode
npm install
npm run web:install    # installs the dashboard frontend's own dependencies
```

## 3. First-time config

OneEncode reads two gitignored local files that never get committed — copy the templates:

```bash
cp config/legs.example.yaml config/legs.local.yaml
cp config/secrets.local.example.yaml config/secrets.local.yaml
```

Two concepts you need before editing these:

- **Renditions** describe *what to encode* — resolution, fps, bitrate, codec preference. They're named, reusable objects.
- **Legs** describe *where it goes* — a destination platform (`rtmp-push`) or a local file (`local-file`) — and each leg references a rendition by id. If two legs point at the same rendition, OneEncode only encodes it once and cheaply copies the result to both destinations.

`config/legs.local.yaml` is where both live. `config/secrets.local.yaml` holds only the real destination URLs/stream keys for `rtmp-push` legs, referenced from `legs.local.yaml` by env-var name — never inlined. See `docs/CONFIGURATION.md` for the full schema.

## 4. A minimal first config (no real platform needed yet)

Open `config/legs.local.yaml` and replace its contents with the smallest useful config: one rendition, one local-file leg. This proves the pipeline works end-to-end before you touch any real credentials.

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

renditions:
  - id: local-test-720p
    resolution: { width: 1280, height: 720 }
    fps: 30
    videoBitrateKbps: 3000
    audioBitrateKbps: 128
    keyframeIntervalSec: 2
    encoderPreference: [h264_nvenc, h264_amf, libx264]

legs:
  - id: local-archive
    enabled: true
    type: local-file
    renditionId: local-test-720p
    outputDir: "recordings"
    filenamePattern: "test_{timestamp}.mp4"
    priority: 1

restartPolicy:
  maxRestartsPerHour: 5
  backoffInitialMs: 2000
  backoffMaxMs: 60000
```

If your machine doesn't have an NVIDIA GPU, change `encoder: h264_nvenc` under `relay` to `h264_amf` (AMD) or `libx264` (CPU), matching whatever you actually have. `encoderPriority` and each rendition's `encoderPreference` will still fall back automatically, but the top-level `relay.encoder` is not itself a fallback list, so set it to something you know exists.

You don't need to touch `config/secrets.local.yaml` at all for this step — it stays as the placeholder template since this config has no `rtmp-push` legs yet.

## 5. Point OBS at the local ingest

In OBS: **Settings → Stream → Service: Custom...**

- **Server**: `rtmp://127.0.0.1:1935/ingest/live`
- **Stream Key**: leave blank

Don't click "Start Streaming" yet — start the orchestrator first (next step), since MediaMTX needs to be up before OBS can connect.

## 6. Start the orchestrator

```bash
npm run dev
```

A healthy startup looks roughly like this in the console:

```
[oneencode-ui] dashboard listening on http://127.0.0.1:4771 (token required — see state/ui-token.txt)
[oneencode] relay_health: {"event":"relay_health","status":"up",...}
[oneencode] Press Ctrl+C to stop.
```

If it exits immediately with a `config_validation_error`, re-check your YAML against the example above — a common first mistake is a bad indent or a `renditionId` that doesn't match a rendition's `id`.

## 7. Open the dashboard

The orchestrator automatically opens your default browser to the dashboard, already logged in — no manual steps needed. This works by putting a one-time login token in the launch URL, which the dashboard immediately strips out of the address bar after reading it.

If the browser doesn't open automatically (or you're connecting from a different point in time), the dashboard is at `http://127.0.0.1:4771`, and the login token is in `state/ui-token.txt` — paste it into the login screen.

## 8. Confirm the local-file leg is working

1. In OBS, click **Start Streaming**.
2. In the OneEncode dashboard, you should see the `local-test-720p` rendition card show live stats (fps, bitrate) within a second or two, and the `local-archive` leg's status badge turn `RUNNING`.
3. Stop streaming in OBS after a few seconds, then check the `recordings/` folder in this repo — you should have a new `test_<timestamp>.mp4` file that plays back correctly.

If you see this, the whole pipeline — ingest, decode, rendition encode, leg output — is confirmed working.

## 9. Adding your first real platform leg

Twitch is a reasonable first real destination to add (see `docs/CONFIGURATION.md` for why it's the platform this project treats as the reference case). You'll need a real stream key from your Twitch dashboard (**Creator Dashboard → Settings → Stream**).

You can add the leg either through the dashboard or by hand-editing YAML:

**Via the dashboard**: use the **"+ Add rendition"** form (optionally prefill sensible defaults from the "Prefill from a platform's recommended settings" dropdown), then **"+ Add leg"**, choosing type `rtmp-push`, the rendition you just created, and pasting your real Twitch server URL + stream key into the leg's stream URL field. This gets written straight to `config/legs.local.yaml` / `config/secrets.local.yaml` for you, validated against the same schema the orchestrator loads at boot.

**By hand**: add a rendition and a leg to `config/legs.local.yaml` (a leg needs `type: rtmp-push` and a `destinationUrlEnv` name), then add the matching entry to `config/secrets.local.yaml`:

```yaml
ONEENCODE_TWITCH_MAIN_URL: "rtmp://live.twitch.tv/app/YOUR_STREAM_KEY"
```

Either way, **you'll need to restart the orchestrator** (`Ctrl+C`, then `npm run dev` again) for a config change to take effect — there's no hot-reload yet.

### The broadcast-arm safety gate

This is important: **`rtmp-push` legs never start automatically, even if `enabled: true`.** On every orchestrator startup they sit in a `staged` state until you take two deliberate actions in the dashboard:

1. Click **"Arm for broadcast"** (the banner at the top of the dashboard) — a global switch, off by default on every restart.
2. Click **"Go Live"** on the specific leg you want to actually push.

Nothing reaches a real platform until both are true. This exists specifically so a config with real, `enabled: true` platform legs can never accidentally start broadcasting the moment you launch the orchestrator — you always have to explicitly say "go" twice. Disarming broadcasting also immediately stops every currently-live `rtmp-push` leg, so it doubles as a kill switch. `local-file` legs are unaffected by any of this and always auto-start, since they have no external side effect.

## What's next

- [`docs/CONFIGURATION.md`](./CONFIGURATION.md) — full rendition/leg schema, encoder selection and NVENC session limits, rendition dedup, and per-platform notes.
- [`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — common problems and their fixes.
