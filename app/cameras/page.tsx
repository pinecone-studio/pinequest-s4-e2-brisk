"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

const CAMERAS = [
  { id: "cam_01", floor: 1, zone: "Entrance" },
  { id: "cam_02", floor: 2, zone: "Corridor" },
  { id: "cam_03", floor: 3, zone: "Corridor" },
  { id: "cam_04", floor: 4, zone: "Corridor" },
  { id: "cam_05", floor: 5, zone: "Lift" },
  { id: "cam_06", floor: 6, zone: "Corridor" },
  { id: "cam_07", floor: 7, zone: "Corridor" },
];

interface Stats {
  total: number;
  smoking: number;
  garbage: number;
  cameras_online: number;
}

interface CameraStatus {
  id: string;
  floor: number;
  zone: string;
  ip: string;
  online: boolean;
}

interface Violation {
  id: number;
  type: "smoking" | "garbage";
  camera_id: string;
  floor: number;
  zone: string;
  confidence: number;
  image_path: string | null;
  created_at: string;
}

export default function CamerasPage() {
  const [stats, setStats] = useState<Stats>({ total: 0, smoking: 0, garbage: 0, cameras_online: 0 });
  const [cameraStatus, setCameraStatus] = useState<Record<string, boolean>>({});
  const [snapshots, setSnapshots] = useState<Record<string, string>>({});
  const [violations, setViolations] = useState<Violation[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  function refreshStats() {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((data: Stats) => setStats(data))
      .catch(() => {});
  }

  function refreshCameraStatus() {
    fetch("/api/cameras")
      .then((r) => r.json())
      .then((cams: CameraStatus[]) => {
        const map: Record<string, boolean> = {};
        cams.forEach((c) => (map[c.id] = c.online));
        setCameraStatus(map);
      })
      .catch(() => {});
  }

  function refreshSnapshots() {
    const t = Date.now();
    const next: Record<string, string> = {};
    CAMERAS.forEach((c) => (next[c.id] = `/api/snapshot/${c.id}?t=${t}`));
    setSnapshots(next);
  }

  function loadInitialViolations() {
    fetch("/api/violations")
      .then((r) => r.json())
      .then((data: Violation[]) => setViolations(data))
      .catch(() => {});
  }

  function connectWS() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      try {
        const v: Violation = JSON.parse(evt.data);
        setViolations((prev) => [v, ...prev].slice(0, 100));
        setStats((prev) => ({
          ...prev,
          total: prev.total + 1,
          smoking: v.type === "smoking" ? prev.smoking + 1 : prev.smoking,
          garbage: v.type === "garbage" ? prev.garbage + 1 : prev.garbage,
        }));
      } catch {}
    };

    ws.onclose = () => setTimeout(connectWS, 3000);
    ws.onerror = () => ws.close();
  }

  useEffect(() => {
    refreshStats();
    refreshCameraStatus();
    loadInitialViolations();
    refreshSnapshots();
    connectWS();

    const snapshotTimer = setInterval(refreshSnapshots, 3000);
    const statusTimer = setInterval(refreshCameraStatus, 3000);
    const statsTimer = setInterval(refreshStats, 10000);

    return () => {
      clearInterval(snapshotTimer);
      clearInterval(statusTimer);
      clearInterval(statsTimer);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function formatTime(ts: string | null) {
    if (!ts) return "";
    const d = new Date(ts.replace(" ", "T"));
    return d.toLocaleTimeString("mn-MN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  return (
    <>
      <style>{`
        header {
          background: var(--card);
          border-bottom: 1px solid var(--border);
          padding: 14px 24px;
          display: flex;
          align-items: center;
          gap: 12px;
        }
        header h1 { font-size: 20px; font-weight: 700; letter-spacing: 0.05em; color: var(--accent); }
        header .subtitle { color: var(--muted); font-size: 12px; }
        .status-dot {
          width: 9px; height: 9px; border-radius: 50%;
          background: var(--green); box-shadow: 0 0 6px var(--green);
          animation: pulse 2s infinite; flex-shrink: 0;
        }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
        .stats-bar { display: flex; gap: 16px; padding: 16px 24px; flex-wrap: wrap; }
        .stat-card {
          background: var(--card); border: 1px solid var(--border);
          border-radius: 10px; padding: 16px 24px; flex: 1; min-width: 140px;
        }
        .stat-card .label {
          font-size: 11px; color: var(--muted); text-transform: uppercase;
          letter-spacing: 0.08em; margin-bottom: 6px;
        }
        .stat-card .value { font-size: 32px; font-weight: 700; line-height: 1; }
        .stat-total .value   { color: var(--accent); }
        .stat-smoking .value { color: var(--red); }
        .stat-garbage .value { color: var(--orange); }
        .stat-cameras .value { color: var(--green); }
        .main {
          display: grid; grid-template-columns: 1fr 380px;
          gap: 16px; padding: 0 24px 24px;
        }
        @media (max-width: 1000px) { .main { grid-template-columns: 1fr; } }
        .section-title {
          font-size: 12px; font-weight: 600; color: var(--muted);
          text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px;
        }
        .camera-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .camera-tile {
          background: var(--card); border: 1px solid var(--border);
          border-radius: 8px; overflow: hidden; position: relative;
        }
        .camera-tile img {
          width: 100%; aspect-ratio: 16/9; object-fit: cover;
          display: block; background: #111;
        }
        .camera-tile .cam-label {
          position: absolute; bottom: 0; left: 0; right: 0;
          background: linear-gradient(transparent, rgba(0,0,0,0.8));
          padding: 8px 8px 6px; font-size: 11px; color: #ccc;
        }
        .cam-id { font-weight: 700; color: #fff; }
        .cam-offline { opacity: 0.4; }
        .cam-badge {
          position: absolute; top: 6px; right: 6px;
          padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700;
        }
        .cam-badge-online  { background: var(--green); color: #000; }
        .cam-badge-offline { background: var(--red);   color: #fff; }
        .feed-panel { display: flex; flex-direction: column; }
        .feed-scroll {
          background: var(--card); border: 1px solid var(--border);
          border-radius: 10px; overflow-y: auto;
          max-height: calc(100vh - 220px); min-height: 300px;
        }
        .feed-item {
          display: flex; gap: 10px; padding: 12px;
          border-bottom: 1px solid var(--border); align-items: flex-start;
          animation: slideIn 0.3s ease;
        }
        @keyframes slideIn { from { opacity:0; transform:translateY(-8px) } to { opacity:1; transform:translateY(0) } }
        .feed-item:last-child { border-bottom: none; }
        .feed-thumb {
          width: 72px; height: 48px; object-fit: cover;
          border-radius: 4px; flex-shrink: 0; background: #111;
        }
        .feed-info { flex: 1; min-width: 0; }
        .feed-badge {
          display: inline-block; padding: 2px 8px; border-radius: 4px;
          font-size: 11px; font-weight: 700; letter-spacing: 0.04em; margin-bottom: 4px;
        }
        .feed-badge-smoking { background: var(--red);    color: #fff; }
        .feed-badge-garbage { background: var(--orange); color: #fff; }
        .feed-meta { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .feed-time { font-size: 11px; color: #555; margin-top: 2px; }
        .feed-empty { padding: 48px 24px; text-align: center; color: var(--muted); }
        .conf-bar { height: 3px; background: var(--border); border-radius: 2px; margin-top: 5px; overflow: hidden; }
        .conf-fill { height: 100%; border-radius: 2px; background: var(--accent); }
      `}</style>

      <header>
        <div className="status-dot" />
        <div>
          <h1>GuardAI</h1>
          <div className="subtitle">Apartment Building Surveillance &bull; Live</div>
        </div>
      </header>

      <div className="stats-bar">
        <div className="stat-card stat-total">
          <div className="label">Total Violations Today</div>
          <div className="value">{stats.total || "—"}</div>
        </div>
        <div className="stat-card stat-smoking">
          <div className="label">Smoking</div>
          <div className="value">{stats.smoking || "—"}</div>
        </div>
        <div className="stat-card stat-garbage">
          <div className="label">Garbage</div>
          <div className="value">{stats.garbage || "—"}</div>
        </div>
        <div className="stat-card stat-cameras">
          <div className="label">Cameras Online</div>
          <div className="value">{stats.cameras_online || "—"}</div>
        </div>
      </div>

      <div className="main">
        <div>
          <div className="section-title">Live Camera Feeds</div>
          <div className="camera-grid">
            {CAMERAS.map((cam) => {
              const online = cameraStatus[cam.id] ?? false;
              return (
                <div key={cam.id} className={`camera-tile${!online ? " cam-offline" : ""}`}>
                  {snapshots[cam.id] && (
                    <img src={snapshots[cam.id]} alt={cam.id} />
                  )}
                  <span className={`cam-badge ${online ? "cam-badge-online" : "cam-badge-offline"}`}>
                    {online ? "LIVE" : "OFFLINE"}
                  </span>
                  <div className="cam-label">
                    <span className="cam-id">CAM {cam.id.slice(-2).toUpperCase()}</span>
                    {" "}&bull; Floor {cam.floor} &bull; {cam.zone}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="feed-panel">
          <div className="section-title">Violation Feed</div>
          <div className="feed-scroll">
            {violations.length === 0 ? (
              <div className="feed-empty">No violations recorded today</div>
            ) : (
              violations.map((v) => {
                const confPct = Math.round((v.confidence || 0) * 100);
                const thumbSrc = v.image_path
                  ? `/evidence/${v.image_path.replace(/^evidence\//, "")}`
                  : "";
                return (
                  <div key={v.id} className="feed-item">
                    {thumbSrc && (
                      <img className="feed-thumb" src={thumbSrc} alt="evidence" />
                    )}
                    <div className="feed-info">
                      <span className={`feed-badge feed-badge-${v.type}`}>
                        {v.type.toUpperCase()}
                      </span>
                      <div className="feed-meta">
                        {v.camera_id} &bull; Floor {v.floor} &bull; {v.zone}
                      </div>
                      <div className="feed-time">
                        {formatTime(v.created_at)} &bull; {confPct}% conf
                      </div>
                      <div className="conf-bar">
                        <div className="conf-fill" style={{ width: `${confPct}%` }} />
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div style={{ padding: "12px 24px", borderTop: "1px solid var(--border)" }}>
        <Link href="/" style={{ color: "var(--muted)", fontSize: 12 }}>
          &larr; Back to demo
        </Link>
      </div>
    </>
  );
}
