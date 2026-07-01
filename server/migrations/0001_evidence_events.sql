-- Evidence metadata (image bytes live in R2; see AEGIS_AI_PIPELINE_ARCHITECTURE.md §3)
CREATE TABLE evidence_events (
  id          TEXT PRIMARY KEY,
  camera_id   TEXT NOT NULL,
  label       TEXT NOT NULL,
  confidence  REAL NOT NULL,
  occurred_at INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  summary     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_evidence_camera_time ON evidence_events (camera_id, occurred_at);
