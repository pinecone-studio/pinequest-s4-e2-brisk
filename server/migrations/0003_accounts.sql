-- Demo accounts + per-account camera setup, for the "Skip Login" bypass
-- (restores whichever account was most recently active). See §Skip Login
-- in docs/remote-camera-setup.md for the camera field meanings.
CREATE TABLE accounts (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE INDEX idx_accounts_last_active ON accounts (last_active_at);

CREATE TABLE camera_configs (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  camera_id       TEXT NOT NULL,
  name            TEXT,
  rtsp_url        TEXT,
  remote_rtsp_url TEXT,
  connection_mode TEXT NOT NULL DEFAULT 'local',
  username        TEXT,
  password        TEXT
);

CREATE INDEX idx_camera_configs_account ON camera_configs (account_id);
