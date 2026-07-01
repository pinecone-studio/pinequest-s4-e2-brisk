import type { D1Database } from "./d1Types";

/** Persisted evidence row (camelCase API shape). */
export interface EvidenceEventRecord {
  id: string;
  cameraId: string;
  label: string;
  confidence: number;
  occurredAt: number;
  r2Key: string;
  summary: string | null;
  createdAt: number;
}

export interface InsertEvidenceEventInput {
  id: string;
  cameraId: string;
  label: string;
  confidence: number;
  occurredAt: number;
  r2Key: string;
  summary?: string | null;
  createdAt?: number;
}

export interface ListEvidenceEventsOptions {
  cameraId?: string;
  limit?: number;
  offset?: number;
}

interface EvidenceEventRow {
  id: string;
  camera_id: string;
  label: string;
  confidence: number;
  occurred_at: number;
  r2_key: string;
  summary: string | null;
  created_at: number;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function rowToRecord(row: EvidenceEventRow): EvidenceEventRecord {
  return {
    id: row.id,
    cameraId: row.camera_id,
    label: row.label,
    confidence: row.confidence,
    occurredAt: row.occurred_at,
    r2Key: row.r2_key,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

export async function insertEvidenceEvent(
  db: D1Database,
  input: InsertEvidenceEventInput,
): Promise<EvidenceEventRecord> {
  const createdAt = input.createdAt ?? Date.now();
  const summary = input.summary ?? null;

  const result = await db
    .prepare(
      `INSERT INTO evidence_events (
        id, camera_id, label, confidence, occurred_at, r2_key, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.cameraId,
      input.label,
      input.confidence,
      input.occurredAt,
      input.r2Key,
      summary,
      createdAt,
    )
    .run();

  if (!result.success) {
    throw new Error(result.error ?? "Failed to insert evidence event");
  }

  return {
    id: input.id,
    cameraId: input.cameraId,
    label: input.label,
    confidence: input.confidence,
    occurredAt: input.occurredAt,
    r2Key: input.r2Key,
    summary,
    createdAt,
  };
}

/** Most recent first; optional camera filter and pagination. */
export async function listEvidenceEvents(
  db: D1Database,
  options: ListEvidenceEventsOptions = {},
): Promise<EvidenceEventRecord[]> {
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT),
    MAX_LIST_LIMIT,
  );
  const offset = Math.max(0, options.offset ?? 0);

  let query = `SELECT id, camera_id, label, confidence, occurred_at, r2_key, summary, created_at
    FROM evidence_events`;
  const binds: unknown[] = [];

  if (options.cameraId) {
    query += ` WHERE camera_id = ?`;
    binds.push(options.cameraId);
  }

  query += ` ORDER BY occurred_at DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);

  const stmt = db.prepare(query);
  const bound = binds.length > 0 ? stmt.bind(...binds) : stmt;
  const { results, success, error } = await bound.all<EvidenceEventRow>();

  if (!success) {
    throw new Error(error ?? "Failed to list evidence events");
  }

  return results.map(rowToRecord);
}
