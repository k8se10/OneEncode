# Troubleshooting

Symptom-first, distilled from this project's own real incident history (the
full unabridged record is in [PATCHNOTES.md](../PATCHNOTES.md) if you want
more detail than this doc covers).

---

## A destination platform's stream fails almost immediately — looks like a TLS/connection drop

**Likely cause**: your destination URL is missing a real "app" path segment.

ffmpeg's native RTMP protocol handler splits a destination URL's path into
an "app" name and a stream key ("fname") for the RTMP `publish` command. If
your platform's dashboard gives you a URL that's just a bare host with the
stream key as the *only* path segment (e.g. `rtmps://example-host/YOUR_KEY`,
no `/app/` or similar prefix), ffmpeg swallows the whole thing into "app"
and sends the actual publish command with an **empty stream name**. Some
platforms reject this silently in a way that looks exactly like a TLS
connection drop after a couple of seconds — the surface-level ffmpeg error
won't tell you this is what happened.

**Real example hit during development**: one platform's dashboard gave a
bare-host RTMPS URL. Adding an explicit `/app/` segment before the stream
key (matching the conventional structure for AWS IVS-based ingest) fixed
it — full-duration, clean pushes afterward.

**How to diagnose**: run ffmpeg directly against the destination with
`-loglevel debug` and look for the actual line:

```
Sending publish command for '<name>'
```

If `<name>` is empty (`''`), that confirms this exact issue — fix by adding
a path segment before the key in `config/secrets.local.yaml`. Compare a
platform that's *working* — its URL almost always already has two path
segments (e.g. `rtmp://live.twitch.tv/app/<key>`).

**Don't assume TLS/network** just because the failure happens quickly and
the surface error mentions I/O — verify with `-loglevel debug` first.

---

## A destination platform reports a lower framerate than OneEncode's own dashboard/stats show

**Likely cause**: GPU/NVENC contention or frame-pacing jitter upstream of
that platform's own ingest — not a bug in the leg itself.

OneEncode's own leg stats (`fps`/`bitrateKbps`/`drop`/`dup`/`speed` in the
dashboard) measure what OneEncode itself is producing and sending in
real-time. A `speed` value at or above `1.0x` with `drop=0 dup=0` means
OneEncode genuinely delivered frames at the target rate — but that doesn't
guarantee the destination platform's own ingest processed them evenly. A
platform's own stats/quality display can catch jitter that OneEncode's own
counters can't see (see the next section) — if delivery was bursty enough,
some platforms discard frames on their own end and report a lower effective
framerate, even though every frame technically arrived.

**Real example hit during development**: a rendition pushing 60fps showed
clean 60fps/drop=0/dup=0/speed≈1.01x in OneEncode's own dashboard the whole
time, while the destination platform's own stats display reported only
30fps for the same stream. Root cause was upstream GPU contention (see
below) causing jitter severe enough that the platform's own ingest was
effectively discarding roughly every other frame. Once the contention was
fixed and pacing cleaned up, the platform started reporting the correct
60fps with no changes to the leg itself.

**What to check**: is something else competing heavily for GPU/NVENC
capacity at the same time (OBS's own encoder, too many concurrent rendition
branches, other GPU-heavy applications)? Fixing that upstream contention is
the actual fix — there's nothing to configure on the leg itself for this.

---

## Stuttering / bad frame pacing, but no dropped-frame counters show anything wrong

**This is the core diagnostic lesson of this whole project — don't trust
`drop=`/`dup=` alone.**

ffmpeg's own `-stats` `drop=`/`dup=` counters measure *count*, not *timing
consistency*. A run can show `drop=0 dup=0` in both OneEncode's dashboard
and OBS's own indicator and still have visibly bad, bursty frame pacing —
frames arriving in clumps rather than evenly spaced, which reads as
stutter/low effective smoothness even though no frame was technically lost
or duplicated.

**Likely cause**: real GPU/NVENC encoder contention — too many concurrent
encode paths competing for the same hardware encoder capacity. This
project's own empirically-observed limit on a single machine: **more than
~2 concurrent encode paths (renditions + anything else using the GPU
encoder, including OBS's own encode) causes real contention.**

**What to do**:
- Run on the intended **dual-PC setup** — a separate gaming/capture PC and
  a dedicated streaming PC running OBS + OneEncode — rather than a single
  machine. This is the primary supported target; single-PC is a fallback
  with much less headroom.
- On a single-PC fallback, keep concurrent encode paths (renditions +
  OBS's own encode) to roughly 2 or fewer.
- Check what else is using the GPU's encoder (OBS's own usage percentage is
  a good first thing to check — it can be substantial on its own before
  OneEncode's branches even start).

---

## Trying to use HEVC or AV1

**Current state: H.264 only, everywhere in the pipeline** — even though the
config schema technically allows configuring `hevc_nvenc`, `hevc_amf`,
`libx265`, and the AV1 equivalents.

**Why**: the bundled local relay (MediaMTX) currently accepts HEVC on RTMP
*ingest* correctly, but refuses to serve it back out over RTMP — every
rendition in this pipeline gets read back out of the relay via RTMP
(`-c copy`, both platform legs and local-file legs), so an HEVC rendition
would silently fail at that step. This was confirmed via direct testing,
not assumed: MediaMTX correctly recognizes and accepts an HEVC publish, but
a reader pulling it back out over RTMP is rejected with an error listing
H265 as a "supported codec" despite refusing it moments after accepting it
as input. **This is a real, current gap in this specific MediaMTX version's
RTMP output-side codec support — not a fundamental RTMP protocol
limitation** (Enhanced RTMP, the 2023 spec extending RTMP/FLV to carry
HEVC/AV1, is real and does work in general — e.g. real OBS-to-YouTube
AV1 streaming exists). Worth re-checking against future MediaMTX releases.

**AV1 is additionally unavailable in hardware** on Turing-generation NVIDIA
GPUs (RTX 20-series) regardless of the above — no AV1 NVENC until
Ada/RTX 40-series or newer.

**What to do**: keep every rendition's `encoderPreference` H.264-only
(`h264_nvenc`, `h264_amf`, `libx264`) until this is resolved.

---

## AMD AMF hardware encoding fails or crashes

AMF is a documented, supported fallback option in `encoderPreference`, but
it's real hardware/driver-dependent behavior — it can fail outright with a
driver-level error on some machines even though it's correctly configured
and selected.

**What to do**: don't rely on AMF as your only fallback. Put `libx264` (CPU,
software encode — always works regardless of GPU/driver state) either ahead
of or immediately alongside `h264_amf` in `encoderPreference`, so a real AMF
failure on a given machine falls through to something that works:

```yaml
encoderPreference: [h264_nvenc, libx264, h264_amf]
```

Also worth checking your AMD driver version if AMF consistently fails on a
specific machine — this can be genuinely driver-specific.

---

## Dashboard token / login issues

The dashboard is gated by a local auth token, generated on first run into
`state/ui-token.txt` (gitignored, per-install).

- On normal startup, the orchestrator auto-opens the dashboard in your
  default browser with the token already embedded in the launch URL — no
  manual step needed. The frontend reads it once, saves it, and immediately
  strips it from the visible address bar.
- If you're opening the dashboard manually (a different browser, a second
  device, or after closing the auto-opened tab), you'll need to paste the
  token from `state/ui-token.txt` into the login screen yourself.
- If the token file is missing, it's regenerated automatically on the next
  startup — but this invalidates any previously-saved token, so you'll need
  to log in again with the new one.
- The dashboard only ever binds to `127.0.0.1` — it is never reachable from
  another machine on your network, by design.

---

## TikTok isn't supported

Unlike Twitch/YouTube/Kick/Facebook, **TikTok LIVE has no open self-serve
RTMP signup**. Getting a working RTMP credential requires either TikTok's
own in-app "LIVE Studio" feature (gated by a follower threshold in most
regions, and it issues a new session key every broadcast rather than a
stable one) or going through a TikTok LIVE agency/Creator Network — an
external account/business relationship, not something this app can obtain
for you. On top of that, TikTok separately requires any account using
third-party PC streaming tools to maintain a minimum share of gaming
content or risk having access revoked.

This is a platform-side constraint on TikTok's part, not a technical
limitation in OneEncode — there's currently nothing to configure here.
`config/platformProfiles.yaml` has a TikTok LIVE entry with the known
ingest spec (H.264, CFR required) ready for whenever a real, durable
credential path exists, but no leg type is wired up for it yet.

---

For the complete, unabridged incident history — including the full jitter
investigation, exact benchmark numbers, and every real bug found along the
way — see [PATCHNOTES.md](../PATCHNOTES.md).
