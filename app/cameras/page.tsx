"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import CameraGrid from "./components/CameraGrid";
import { fetchCameraConfig } from "./lib/cameraApi";
import type { CameraView } from "./lib/cameraTypes";

interface Stats {
  total: number;
  smoking: number;
  garbage: number;
  cameras_online: number;
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
  const [cameras, setCameras] = useState<CameraView[]>([]);
  const [cameraLoadError, setCameraLoadError] = useState<string | null>(null);
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const [violations] = useState<Violation[]>([]);
  const stats = useMemo<Stats>(
    () => ({
      total: violations.length,
      smoking: violations.filter((violation) => violation.type === "smoking").length,
      garbage: violations.filter((violation) => violation.type === "garbage").length,
      cameras_online: cameras.filter((camera) => camera.online).length,
    }),
    [cameras, violations],
  );

  function refreshCameraStatus() {
    fetchCameraConfig()
      .then((cams) => {
        setCameras(cams);
        setCameraLoadError(null);
        const affected = cams.find((c) => c.enabled && !c.inference_enabled);
        setModelWarning(
          affected
            ? `YOLO inference disabled: ${
                affected.model_error ?? `model not loaded from ${affected.model_path}`
              }`
            : null,
        );
      })
      .catch((err) => {
        setCameraLoadError(err instanceof Error ? err.message : "Failed to load cameras");
      });
  }

  useEffect(() => {
    refreshCameraStatus();

    const statusTimer = setInterval(refreshCameraStatus, 3000);

    return () => {
      clearInterval(statusTimer);
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

      {modelWarning && (
        <div
          style={{
            margin: "0 24px 16px",
            padding: "10px 12px",
            border: "1px solid rgba(234, 179, 8, 0.55)",
            borderRadius: 8,
            background: "rgba(234, 179, 8, 0.12)",
            color: "var(--yellow)",
            fontSize: 12,
          }}
        >
          {modelWarning}
        </div>
      )}

      <div className="main">
        <div className="min-w-0">
          <div className="section-title">Live Camera Feeds</div>
          {cameraLoadError ? (
            <div className="flex aspect-video items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-xs text-[var(--red)]">
              {cameraLoadError}
            </div>
          ) : (
            <CameraGrid cameras={cameras} />
          )}
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
