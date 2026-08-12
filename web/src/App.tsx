import { useEffect, useMemo, useState } from "react";
import {
  AuthError,
  clearStoredToken,
  fetchStatus,
  getStoredToken,
  openLiveSocket,
  restartLeg,
  restartRendition,
  stopLeg,
  stopRendition,
  storeToken,
  type LegRow,
  type LegStats,
  type RenditionRow,
} from "./api";
import { ConfigManager } from "./ConfigManager";
import "./App.css";

function resolutionLabel(resolution: "source" | { width: number; height: number }): string {
  return resolution === "source" ? "source" : `${resolution.width}x${resolution.height}`;
}

function StatsCell({ stats }: { stats: LegStats | null }) {
  if (!stats) return <span className="muted">—</span>;
  const dropWarn = stats.dropFrames > 0 || stats.dupFrames > 0;
  return (
    <span className={dropWarn ? "stats-warn" : ""}>
      {stats.fps.toFixed(0)}fps · {(stats.bitrateKbps / 1000).toFixed(1)}Mbps · drop={stats.dropFrames} dup=
      {stats.dupFrames} · {stats.speed.toFixed(2)}x
    </span>
  );
}

function StateBadge({ state }: { state: string }) {
  return <span className={`badge badge-${state}`}>{state}</span>;
}

function LoginGate({ onAuthed }: { onAuthed: (token: string) => void }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    setChecking(true);
    setError(null);
    try {
      await fetchStatus(input.trim());
      storeToken(input.trim());
      onAuthed(input.trim());
    } catch {
      setError("Invalid token — check state/ui-token.txt in the project directory.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="login-gate">
      <h1>OneEncode Dashboard</h1>
      <p>Paste the dashboard token (printed at orchestrator startup, or in <code>state/ui-token.txt</code>):</p>
      <input
        type="password"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="dashboard token"
        autoFocus
      />
      <button onClick={submit} disabled={checking || !input.trim()}>
        {checking ? "Checking..." : "Connect"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function App() {
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [tab, setTab] = useState<"monitor" | "configure">("monitor");
  const [legs, setLegs] = useState<LegRow[]>([]);
  const [renditions, setRenditions] = useState<RenditionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [restartNotice, setRestartNotice] = useState(false);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await fetchStatus(token);
        if (cancelled) return;
        setLegs(status.legs);
        setRenditions(status.renditions);
        setError(null);
      } catch (err) {
        if (err instanceof AuthError) {
          clearStoredToken();
          setToken(null);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void refresh();
    const pollInterval = setInterval(refresh, 5000); // status/config changes rarely; live stats come via WebSocket below

    const ws = openLiveSocket(token, (legId, stats) => {
      setLegs((prev) => prev.map((leg) => (leg.id === legId ? { ...leg, stats } : leg)));
      setRenditions((prev) => prev.map((r) => (`rendition-${r.id}` === legId ? { ...r, stats } : r)));
    });

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
      ws.close();
    };
  }, [token]);

  const withBusy = async (id: string, action: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const legsByRendition = useMemo(() => {
    const map = new Map<string, LegRow[]>();
    for (const leg of legs) {
      const list = map.get(leg.renditionId) ?? [];
      list.push(leg);
      map.set(leg.renditionId, list);
    }
    return map;
  }, [legs]);

  if (!token) return <LoginGate onAuthed={setToken} />;

  return (
    <div className="app">
      <header>
        <h1>OneEncode Dashboard</h1>
        <div className="tabs">
          <button className={tab === "monitor" ? "tab active" : "tab"} onClick={() => setTab("monitor")}>
            Monitor
          </button>
          <button className={tab === "configure" ? "tab active" : "tab"} onClick={() => setTab("configure")}>
            Configure
          </button>
        </div>
      </header>

      {restartNotice && (
        <div className="notice-banner">
          Config saved. Changes only take effect after the orchestrator is restarted — no hot-reload yet.{" "}
          <button className="link-button" onClick={() => setRestartNotice(false)}>
            Dismiss
          </button>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {tab === "configure" ? (
        <ConfigManager token={token} onConfigChanged={() => setRestartNotice(true)} />
      ) : (
        <>
          {renditions.length === 0 && <p className="muted">No renditions configured yet — switch to the Configure tab to add one.</p>}
          {renditions.map((rendition) => (
        <section key={rendition.id} className="rendition-card">
          <div className="rendition-header">
            <h2>{rendition.id}</h2>
            <StateBadge state={rendition.state} />
            <span className="muted">
              {resolutionLabel(rendition.resolution)} @ {rendition.fps}fps ·{" "}
              {rendition.videoBitrateKbps ? `${rendition.videoBitrateKbps}kbps` : "cq"} ·{" "}
              {rendition.encoderPreference.join(" → ")}
            </span>
            <div className="controls">
              <button
                disabled={busyIds.has(`rendition-${rendition.id}`)}
                onClick={() => withBusy(`rendition-${rendition.id}`, () => stopRendition(token, rendition.id))}
              >
                Stop
              </button>
              <button
                disabled={busyIds.has(`rendition-${rendition.id}`)}
                onClick={() => withBusy(`rendition-${rendition.id}`, () => restartRendition(token, rendition.id))}
              >
                Restart
              </button>
            </div>
            <StatsCell stats={rendition.stats} />
          </div>

          <table className="legs-table">
            <thead>
              <tr>
                <th>Leg</th>
                <th>Type</th>
                <th>State</th>
                <th>Stats</th>
                <th>Controls</th>
              </tr>
            </thead>
            <tbody>
              {(legsByRendition.get(rendition.id) ?? []).map((leg) => (
                <tr key={leg.id}>
                  <td>{leg.id}</td>
                  <td>{leg.type}</td>
                  <td>
                    <StateBadge state={leg.state} />
                  </td>
                  <td>
                    <StatsCell stats={leg.stats} />
                  </td>
                  <td className="controls">
                    <button disabled={busyIds.has(leg.id)} onClick={() => withBusy(leg.id, () => stopLeg(token, leg.id))}>
                      Stop
                    </button>
                    <button disabled={busyIds.has(leg.id)} onClick={() => withBusy(leg.id, () => restartLeg(token, leg.id))}>
                      Restart
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
          ))}
        </>
      )}
    </div>
  );
}

export default App;
