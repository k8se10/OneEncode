import { Fragment, useEffect, useState } from "react";
import {
  ConfigApiValidationError,
  createLeg,
  createRendition,
  deleteLeg,
  deleteRendition,
  fetchConfig,
  fetchPlatformProfiles,
  updateLeg,
  updateRendition,
  type ConfigResponse,
  type LegConfigEntry,
  type LegWriteBody,
  type PlatformProfile,
  type RenditionConfig,
  type Resolution,
} from "./configApi";

function resolutionLabel(resolution: Resolution): string {
  return resolution === "source" ? "source" : `${resolution.width}x${resolution.height}`;
}

interface RenditionFormState {
  id: string;
  resolutionMode: "source" | "custom";
  width: string;
  height: string;
  fps: string;
  rateMode: "bitrate" | "quality";
  videoBitrateKbps: string;
  qualityMode: "cq" | "vbr" | "cbr";
  qualityValue: string;
  audioBitrateKbps: string;
  keyframeIntervalSec: string;
  encoderPreference: string;
}

function blankRenditionForm(): RenditionFormState {
  return {
    id: "",
    resolutionMode: "custom",
    width: "1920",
    height: "1080",
    fps: "60",
    rateMode: "bitrate",
    videoBitrateKbps: "6000",
    qualityMode: "cq",
    qualityValue: "19",
    audioBitrateKbps: "160",
    keyframeIntervalSec: "2",
    encoderPreference: "h264_nvenc, h264_amf, libx264",
  };
}

function renditionToForm(r: RenditionConfig): RenditionFormState {
  return {
    id: r.id,
    resolutionMode: r.resolution === "source" ? "source" : "custom",
    width: r.resolution === "source" ? "1920" : String(r.resolution.width),
    height: r.resolution === "source" ? "1080" : String(r.resolution.height),
    fps: String(r.fps),
    rateMode: r.videoQuality ? "quality" : "bitrate",
    videoBitrateKbps: r.videoBitrateKbps ? String(r.videoBitrateKbps) : "6000",
    qualityMode: r.videoQuality?.mode ?? "cq",
    qualityValue: r.videoQuality ? String(r.videoQuality.value) : "19",
    audioBitrateKbps: String(r.audioBitrateKbps),
    keyframeIntervalSec: String(r.keyframeIntervalSec),
    encoderPreference: r.encoderPreference.join(", "),
  };
}

function formToRenditionBody(f: RenditionFormState): Partial<RenditionConfig> {
  const body: Partial<RenditionConfig> = {
    id: f.id.trim(),
    resolution: f.resolutionMode === "source" ? "source" : { width: Number(f.width), height: Number(f.height) },
    fps: Number(f.fps),
    audioBitrateKbps: Number(f.audioBitrateKbps),
    keyframeIntervalSec: Number(f.keyframeIntervalSec),
    encoderPreference: f.encoderPreference
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  if (f.rateMode === "bitrate") {
    body.videoBitrateKbps = Number(f.videoBitrateKbps);
  } else {
    body.videoQuality = { mode: f.qualityMode, value: Number(f.qualityValue) };
  }
  return body;
}

function RenditionForm({
  initial,
  platformProfiles,
  onCancel,
  onSubmit,
}: {
  initial: RenditionFormState;
  platformProfiles: PlatformProfile[];
  onCancel: () => void;
  onSubmit: (body: Partial<RenditionConfig>) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isEditing = initial.id !== "";

  const set = <K extends keyof RenditionFormState>(key: K, value: RenditionFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Suggestion only (CLAUDE.md architecture decision #10) -- prefills the
  // still-editable fields of a brand-new rendition, never touches an
  // already-set value or an existing rendition being edited.
  const applyPlatformPreset = (platformName: string) => {
    const profile = platformProfiles.find((p) => p.platformName === platformName);
    if (!profile) return;
    const { recommended } = profile;
    setForm((f) => ({
      ...f,
      resolutionMode: recommended.resolution === "source" ? "source" : "custom",
      width: recommended.resolution === "source" ? f.width : String(recommended.resolution.width),
      height: recommended.resolution === "source" ? f.height : String(recommended.resolution.height),
      fps: String(recommended.fps),
      rateMode: "bitrate",
      videoBitrateKbps: recommended.videoBitrateKbps ? String(recommended.videoBitrateKbps) : f.videoBitrateKbps,
      audioBitrateKbps: String(recommended.audioBitrateKbps),
      keyframeIntervalSec: String(recommended.keyframeIntervalSec),
    }));
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSubmit(formToRenditionBody(form));
    } catch (err) {
      setError(err instanceof ConfigApiValidationError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="form-card">
      {!isEditing && platformProfiles.length > 0 && (
        <label>
          Prefill from a platform's recommended settings (optional)
          <select defaultValue="" onChange={(e) => e.target.value && applyPlatformPreset(e.target.value)}>
            <option value="">— pick a platform to fill in reasonable defaults —</option>
            {platformProfiles.map((p) => (
              <option key={p.platformName} value={p.platformName}>
                {p.platformName}
              </option>
            ))}
          </select>
          <span className="muted">
            Just fills in the fields below with that platform's published recommendations — everything stays editable, and nothing here is applied automatically.
          </span>
        </label>
      )}
      <label>
        Rendition id
        <input value={form.id} onChange={(e) => set("id", e.target.value)} disabled={isEditing} placeholder="e.g. 1080p60-6M" />
      </label>
      <label>
        Resolution
        <select value={form.resolutionMode} onChange={(e) => set("resolutionMode", e.target.value as "source" | "custom")}>
          <option value="custom">Custom</option>
          <option value="source">Source (no scaling)</option>
        </select>
      </label>
      {form.resolutionMode === "custom" && (
        <div className="form-row">
          <label>
            Width
            <input type="number" value={form.width} onChange={(e) => set("width", e.target.value)} />
          </label>
          <label>
            Height
            <input type="number" value={form.height} onChange={(e) => set("height", e.target.value)} />
          </label>
        </div>
      )}
      <label>
        FPS
        <input type="number" value={form.fps} onChange={(e) => set("fps", e.target.value)} />
      </label>
      <label>
        Rate control
        <select value={form.rateMode} onChange={(e) => set("rateMode", e.target.value as "bitrate" | "quality")}>
          <option value="bitrate">Fixed bitrate</option>
          <option value="quality">Quality-based (CQ/VBR)</option>
        </select>
      </label>
      {form.rateMode === "bitrate" ? (
        <label>
          Video bitrate (kbps)
          <input type="number" value={form.videoBitrateKbps} onChange={(e) => set("videoBitrateKbps", e.target.value)} />
        </label>
      ) : (
        <div className="form-row">
          <label>
            Quality mode
            <select value={form.qualityMode} onChange={(e) => set("qualityMode", e.target.value as "cq" | "vbr" | "cbr")}>
              <option value="cq">CQ</option>
              <option value="vbr">VBR</option>
              <option value="cbr">CBR</option>
            </select>
          </label>
          <label>
            Value
            <input type="number" value={form.qualityValue} onChange={(e) => set("qualityValue", e.target.value)} />
          </label>
        </div>
      )}
      <label>
        Audio bitrate (kbps)
        <input type="number" value={form.audioBitrateKbps} onChange={(e) => set("audioBitrateKbps", e.target.value)} />
      </label>
      <label>
        Keyframe interval (sec)
        <input type="number" value={form.keyframeIntervalSec} onChange={(e) => set("keyframeIntervalSec", e.target.value)} />
      </label>
      <label>
        Encoder preference (comma-separated, in fallback order)
        <input value={form.encoderPreference} onChange={(e) => set("encoderPreference", e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button onClick={submit} disabled={saving || !form.id.trim()}>
          {saving ? "Saving..." : isEditing ? "Save changes" : "Create rendition"}
        </button>
        <button className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface LegFormState {
  id: string;
  renditionId: string;
  type: "local-file" | "rtmp-push";
  priority: string;
  enabled: boolean;
  outputDir: string;
  filenamePattern: string;
  rtmpServer: string;
  streamKey: string;
}

function blankLegForm(renditions: RenditionConfig[]): LegFormState {
  return {
    id: "",
    renditionId: renditions[0]?.id ?? "",
    type: "local-file",
    priority: "0",
    enabled: true,
    outputDir: "recordings",
    filenamePattern: "archive_{timestamp}.mp4",
    rtmpServer: "",
    streamKey: "",
  };
}

function legToForm(leg: LegConfigEntry): LegFormState {
  return {
    id: leg.id,
    renditionId: leg.renditionId,
    type: leg.type,
    priority: String(leg.priority),
    enabled: leg.enabled,
    outputDir: leg.type === "local-file" ? leg.outputDir : "recordings",
    filenamePattern: leg.type === "local-file" ? leg.filenamePattern : "archive_{timestamp}.mp4",
    rtmpServer: "",
    streamKey: "",
  };
}

function LegForm({
  initial,
  renditions,
  secretCurrentlySet,
  onCancel,
  onSubmit,
}: {
  initial: LegFormState;
  renditions: RenditionConfig[];
  secretCurrentlySet: boolean;
  onCancel: () => void;
  onSubmit: (body: LegWriteBody) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isEditing = initial.id !== "";

  const set = <K extends keyof LegFormState>(key: K, value: LegFormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Platforms give you the RTMP server and the stream key as two separate
  // fields in their own dashboard (Twitch, YouTube, etc.) -- collect them
  // the same way rather than making the user concatenate a URL by hand,
  // then join them the way ffmpeg needs it: server (no trailing slash) + "/" + key.
  const joinedStreamUrl = (): string => {
    const server = form.rtmpServer.trim().replace(/\/+$/, "");
    const key = form.streamKey.trim();
    if (!server && !key) return "";
    return key ? `${server}/${key}` : server;
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const streamUrl = joinedStreamUrl();
      const body: LegWriteBody = {
        id: form.id.trim(),
        renditionId: form.renditionId,
        type: form.type,
        priority: Number(form.priority),
        enabled: form.enabled,
        ...(form.type === "local-file"
          ? { outputDir: form.outputDir.trim(), filenamePattern: form.filenamePattern.trim() }
          : streamUrl
            ? { secretValue: streamUrl }
            : {}),
      };
      await onSubmit(body);
    } catch (err) {
      setError(err instanceof ConfigApiValidationError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="form-card">
      <label>
        Leg id
        <input value={form.id} onChange={(e) => set("id", e.target.value)} disabled={isEditing} placeholder="e.g. platform-a" />
      </label>
      <label>
        Rendition
        <select value={form.renditionId} onChange={(e) => set("renditionId", e.target.value)}>
          {renditions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} ({resolutionLabel(r.resolution)} @ {r.fps}fps)
            </option>
          ))}
        </select>
      </label>
      <label>
        Send this to
        <select value={form.type} onChange={(e) => set("type", e.target.value as "local-file" | "rtmp-push")} disabled={isEditing}>
          <option value="local-file">A local file on this machine</option>
          <option value="rtmp-push">A streaming platform (Twitch, YouTube, Kick, etc.)</option>
        </select>
      </label>
      <div className="form-row">
        <label>
          Priority
          <input type="number" value={form.priority} onChange={(e) => set("priority", e.target.value)} />
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          Enabled
        </label>
      </div>
      {form.type === "local-file" ? (
        <>
          <label>
            Output directory
            <input value={form.outputDir} onChange={(e) => set("outputDir", e.target.value)} />
          </label>
          <label>
            Filename pattern
            <input value={form.filenamePattern} onChange={(e) => set("filenamePattern", e.target.value)} />
          </label>
        </>
      ) : (
        <>
          <p className="muted">
            Get these from that platform's own stream/creator dashboard (e.g. Twitch → Creator Dashboard → Settings → Stream) — most
            platforms show the server and stream key as two separate fields there, same as here.
          </p>
          <label>
            RTMP server
            <input
              value={form.rtmpServer}
              onChange={(e) => set("rtmpServer", e.target.value)}
              placeholder="rtmp://live.twitch.tv/app"
            />
          </label>
          <label>
            Stream key {isEditing && <span className="muted">({secretCurrentlySet ? "currently set — " : "not set — "}leave blank to keep as-is)</span>}
            <input
              type="password"
              value={form.streamKey}
              onChange={(e) => set("streamKey", e.target.value)}
              placeholder="live_XXXXXXXX_XXXXXXXXXXXXXXXXXXXXXXXXXXXX"
              autoComplete="new-password"
            />
          </label>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button onClick={submit} disabled={saving || !form.id.trim() || !form.renditionId}>
          {saving ? "Saving..." : isEditing ? "Save changes" : "Create leg"}
        </button>
        <button className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ConfigManager({ token, onConfigChanged }: { token: string; onConfigChanged: () => void }) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [platformProfiles, setPlatformProfiles] = useState<PlatformProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingRenditionId, setEditingRenditionId] = useState<string | null>(null);
  const [addingRendition, setAddingRendition] = useState(false);
  const [editingLegId, setEditingLegId] = useState<string | null>(null);
  const [addingLeg, setAddingLeg] = useState(false);

  const reload = async () => {
    try {
      setConfig(await fetchConfig(token));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    fetchPlatformProfiles(token)
      .then(setPlatformProfiles)
      .catch(() => setPlatformProfiles([])); // optional convenience data -- a fetch failure shouldn't block config management
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const afterWrite = async () => {
    await reload();
    setEditingRenditionId(null);
    setAddingRendition(false);
    setEditingLegId(null);
    setAddingLeg(false);
    onConfigChanged();
  };

  if (!config) return <p className="muted">Loading config...</p>;

  return (
    <div className="config-manager">
      {error && <div className="error-banner">{error}</div>}

      <section className="config-section">
        <div className="config-section-header">
          <h2>Renditions</h2>
          <button onClick={() => setAddingRendition(true)} disabled={addingRendition}>
            + Add rendition
          </button>
        </div>
        {addingRendition && (
          <RenditionForm
            initial={blankRenditionForm()}
            platformProfiles={platformProfiles}
            onCancel={() => setAddingRendition(false)}
            onSubmit={async (body) => {
              await createRendition(token, body);
              await afterWrite();
            }}
          />
        )}
        <table className="config-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Resolution</th>
              <th>FPS</th>
              <th>Rate</th>
              <th>Encoders</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {config.renditions.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td>{r.id}</td>
                  <td>{resolutionLabel(r.resolution)}</td>
                  <td>{r.fps}</td>
                  <td>{r.videoQuality ? `${r.videoQuality.mode} ${r.videoQuality.value}` : `${r.videoBitrateKbps}kbps`}</td>
                  <td className="muted">{r.encoderPreference.join(" → ")}</td>
                  <td className="controls">
                    <button onClick={() => setEditingRenditionId(r.id)}>Edit</button>
                    <button
                      className="danger"
                      onClick={async () => {
                        try {
                          await deleteRendition(token, r.id);
                          await afterWrite();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
                {editingRenditionId === r.id && (
                  <tr>
                    <td colSpan={6}>
                      <RenditionForm
                        initial={renditionToForm(r)}
                        platformProfiles={platformProfiles}
                        onCancel={() => setEditingRenditionId(null)}
                        onSubmit={async (body) => {
                          await updateRendition(token, r.id, body);
                          await afterWrite();
                        }}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>

      <section className="config-section">
        <div className="config-section-header">
          <h2>Legs</h2>
          <button onClick={() => setAddingLeg(true)} disabled={addingLeg || config.renditions.length === 0}>
            + Add leg
          </button>
        </div>
        {addingLeg && (
          <LegForm
            initial={blankLegForm(config.renditions)}
            renditions={config.renditions}
            secretCurrentlySet={false}
            onCancel={() => setAddingLeg(false)}
            onSubmit={async (body) => {
              await createLeg(token, body);
              await afterWrite();
            }}
          />
        )}
        <table className="config-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Rendition</th>
              <th>Type</th>
              <th>Destination</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {config.legs.map((leg) => (
              <Fragment key={leg.id}>
                <tr>
                  <td>{leg.id}</td>
                  <td>{leg.renditionId}</td>
                  <td>{leg.type}</td>
                  <td>
                    {leg.type === "local-file"
                      ? leg.outputDir
                      : `${leg.destinationUrlEnv} (${leg.secretSet ? "key set" : "no key set"})`}
                  </td>
                  <td>{leg.enabled ? "yes" : "no"}</td>
                  <td className="controls">
                    <button onClick={() => setEditingLegId(leg.id)}>Edit</button>
                    <button
                      className="danger"
                      onClick={async () => {
                        try {
                          await deleteLeg(token, leg.id);
                          await afterWrite();
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
                {editingLegId === leg.id && (
                  <tr>
                    <td colSpan={6}>
                      <LegForm
                        initial={legToForm(leg)}
                        renditions={config.renditions}
                        secretCurrentlySet={leg.type === "rtmp-push" ? !!leg.secretSet : false}
                        onCancel={() => setEditingLegId(null)}
                        onSubmit={async (body) => {
                          await updateLeg(token, leg.id, body);
                          await afterWrite();
                        }}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
