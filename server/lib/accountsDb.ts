import type { D1Database } from "./d1Types";

export type CameraConnectionMode = "local" | "remote";

/** Persisted camera setup row (camelCase API shape), scoped to an account. */
export interface CameraConfigRecord {
  id: string;
  cameraId: string;
  name: string | null;
  rtspUrl: string | null;
  remoteRtspUrl: string | null;
  connectionMode: CameraConnectionMode;
  username: string | null;
  password: string | null;
}

export interface AccountRecord {
  id: string;
  name: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface AccountWithCameraConfigs extends AccountRecord {
  cameraConfigs: CameraConfigRecord[];
}

export interface InsertAccountInput {
  id: string;
  name: string;
  createdAt?: number;
  lastActiveAt?: number;
}

export interface InsertCameraConfigInput {
  id: string;
  accountId: string;
  cameraId: string;
  name?: string | null;
  rtspUrl?: string | null;
  remoteRtspUrl?: string | null;
  connectionMode?: CameraConnectionMode;
  username?: string | null;
  password?: string | null;
}

interface AccountRow {
  id: string;
  name: string;
  created_at: number;
  last_active_at: number;
}

interface CameraConfigRow {
  id: string;
  account_id: string;
  camera_id: string;
  name: string | null;
  rtsp_url: string | null;
  remote_rtsp_url: string | null;
  connection_mode: string;
  username: string | null;
  password: string | null;
}

function rowToAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

function rowToCameraConfig(row: CameraConfigRow): CameraConfigRecord {
  return {
    id: row.id,
    cameraId: row.camera_id,
    name: row.name,
    rtspUrl: row.rtsp_url,
    remoteRtspUrl: row.remote_rtsp_url,
    connectionMode: row.connection_mode === "remote" ? "remote" : "local",
    username: row.username,
    password: row.password,
  };
}

export async function insertAccount(
  db: D1Database,
  input: InsertAccountInput,
): Promise<AccountRecord> {
  const createdAt = input.createdAt ?? Date.now();
  const lastActiveAt = input.lastActiveAt ?? createdAt;

  const result = await db
    .prepare(`INSERT INTO accounts (id, name, created_at, last_active_at) VALUES (?, ?, ?, ?)`)
    .bind(input.id, input.name, createdAt, lastActiveAt)
    .run();

  if (!result.success) {
    throw new Error(result.error ?? "Failed to insert account");
  }

  return { id: input.id, name: input.name, createdAt, lastActiveAt };
}

export async function insertCameraConfig(
  db: D1Database,
  input: InsertCameraConfigInput,
): Promise<CameraConfigRecord> {
  const connectionMode = input.connectionMode ?? "local";

  const result = await db
    .prepare(
      `INSERT INTO camera_configs (
        id, account_id, camera_id, name, rtsp_url, remote_rtsp_url, connection_mode, username, password
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.accountId,
      input.cameraId,
      input.name ?? null,
      input.rtspUrl ?? null,
      input.remoteRtspUrl ?? null,
      connectionMode,
      input.username ?? null,
      input.password ?? null,
    )
    .run();

  if (!result.success) {
    throw new Error(result.error ?? "Failed to insert camera config");
  }

  return {
    id: input.id,
    cameraId: input.cameraId,
    name: input.name ?? null,
    rtspUrl: input.rtspUrl ?? null,
    remoteRtspUrl: input.remoteRtspUrl ?? null,
    connectionMode,
    username: input.username ?? null,
    password: input.password ?? null,
  };
}

/** Bump an account's last_active_at (e.g. on Skip Login). Returns false if the account doesn't exist. */
export async function touchAccountLastActive(
  db: D1Database,
  accountId: string,
  timestamp: number = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE accounts SET last_active_at = ? WHERE id = ?`)
    .bind(timestamp, accountId)
    .run();

  if (!result.success) {
    throw new Error(result.error ?? "Failed to update account");
  }
  return Number(result.meta?.changes ?? 0) > 0;
}

async function listCameraConfigsForAccount(
  db: D1Database,
  accountId: string,
): Promise<CameraConfigRecord[]> {
  const { results, success, error } = await db
    .prepare(
      `SELECT id, account_id, camera_id, name, rtsp_url, remote_rtsp_url, connection_mode, username, password
       FROM camera_configs WHERE account_id = ?`,
    )
    .bind(accountId)
    .all<CameraConfigRow>();

  if (!success) {
    throw new Error(error ?? "Failed to list camera configs");
  }
  return results.map(rowToCameraConfig);
}

/** The most-recently-active account plus its full camera setup, or null if no accounts exist. */
export async function getMostRecentAccountWithCameraConfigs(
  db: D1Database,
): Promise<AccountWithCameraConfigs | null> {
  const { results, success, error } = await db
    .prepare(
      `SELECT id, name, created_at, last_active_at FROM accounts ORDER BY last_active_at DESC LIMIT 1`,
    )
    .all<AccountRow>();

  if (!success) {
    throw new Error(error ?? "Failed to query accounts");
  }

  const row = results[0];
  if (!row) return null;

  const account = rowToAccount(row);
  const cameraConfigs = await listCameraConfigsForAccount(db, account.id);
  return { ...account, cameraConfigs };
}
