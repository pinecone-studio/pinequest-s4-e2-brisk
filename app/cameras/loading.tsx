export default function CamerasLoading() {
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
          flex-shrink: 0;
        }
        .stats-bar { display: flex; gap: 16px; padding: 16px 24px; flex-wrap: wrap; }
        .stat-card {
          background: var(--card); border: 1px solid var(--border);
          border-radius: 10px; padding: 16px 24px; flex: 1; min-width: 140px;
        }
        .stat-card .label {
          font-size: 11px; color: var(--muted); text-transform: uppercase;
          letter-spacing: 0.08em; margin-bottom: 6px;
        }
        .stat-card .value { font-size: 32px; font-weight: 700; line-height: 1; color: var(--muted); }
        .main {
          display: grid; grid-template-columns: 1fr 380px;
          gap: 16px; padding: 0 24px 24px;
        }
        @media (max-width: 1000px) { .main { grid-template-columns: 1fr; } }
        .section-title {
          font-size: 12px; font-weight: 600; color: var(--muted);
          text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px;
        }
        .loading-panel {
          background: var(--card); border: 1px solid var(--border);
          border-radius: 10px; min-height: 300px;
          display: flex; align-items: center; justify-content: center;
          color: var(--muted); font-size: 13px;
        }
      `}</style>

      <header>
        <div className="status-dot" />
        <div>
          <h1>GuardAI</h1>
          <div className="subtitle">Apartment Building Surveillance &bull; Live</div>
        </div>
      </header>

      <div className="stats-bar">
        <div className="stat-card">
          <div className="label">Total Violations Today</div>
          <div className="value">&mdash;</div>
        </div>
        <div className="stat-card">
          <div className="label">Smoking</div>
          <div className="value">&mdash;</div>
        </div>
        <div className="stat-card">
          <div className="label">Garbage</div>
          <div className="value">&mdash;</div>
        </div>
        <div className="stat-card">
          <div className="label">Cameras Online</div>
          <div className="value">&mdash;</div>
        </div>
      </div>

      <div className="main">
        <div>
          <div className="section-title">Live Camera Feeds</div>
          <div className="loading-panel">Loading camera dashboard...</div>
        </div>
        <div>
          <div className="section-title">Violation Feed</div>
          <div className="loading-panel">Loading feed...</div>
        </div>
      </div>
    </>
  );
}
