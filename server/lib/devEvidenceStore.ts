import type { D1Database, D1PreparedStatement, D1Result, D1RunResult } from "./d1Types";
import type { R2Bucket, R2Object, R2PutOptions } from "./r2Types";

type EvidenceRow = {
  id: string;
  camera_id: string;
  label: string;
  confidence: number;
  occurred_at: number;
  r2_key: string;
  summary: string | null;
  created_at: number;
  status: string;
  handled_at: number | null;
};

/** In-memory D1 + R2 for local `npm run dev` (enable with EVIDENCE_DEV_STORAGE=memory). */
export function createDevEvidenceBindings(): {
  db: D1Database;
  bucket: R2Bucket;
  reset: () => void;
} {
  const rows: EvidenceRow[] = [];
  const objects = new Map<string, Uint8Array>();

  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      let bound: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          const all = await stmt.all<T>();
          return all.results[0] ?? null;
        },
        async run(): Promise<D1RunResult> {
          if (query.includes("INSERT INTO evidence_events")) {
            rows.push({
              id: bound[0] as string,
              camera_id: bound[1] as string,
              label: bound[2] as string,
              confidence: bound[3] as number,
              occurred_at: bound[4] as number,
              r2_key: bound[5] as string,
              summary: bound[6] as string | null,
              created_at: bound[7] as number,
              status: (bound[8] as string) ?? "active",
              handled_at: null,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (query.includes("UPDATE evidence_events")) {
            const status = bound[0] as string;
            const handledAt = (bound[1] as number | null) ?? null;
            const id = bound[2] as string;
            const row = rows.find((r) => r.id === id);
            if (row) {
              row.status = status;
              row.handled_at = handledAt;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: false, error: "unsupported query in dev D1" };
        },
        async all<T>(): Promise<D1Result<T>> {
          if (query.includes("FROM evidence_events")) {
            let filtered = [...rows];
            if (query.includes("WHERE camera_id")) {
              const cameraId = bound[0] as string;
              filtered = filtered.filter((r) => r.camera_id === cameraId);
            }
            const limit = (bound.at(-2) as number) ?? 50;
            const offset = (bound.at(-1) as number) ?? 0;
            filtered.sort((a, b) => b.occurred_at - a.occurred_at);
            return {
              success: true,
              results: filtered.slice(offset, offset + limit) as T[],
            };
          }
          return { success: false, results: [], error: "unsupported query in dev D1" };
        },
      };
      return stmt;
    },
  };

  const bucket: R2Bucket = {
    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
      _options?: R2PutOptions,
    ): Promise<R2Object | null> {
      if (value === null) return null;
      let bytes: Uint8Array;
      if (value instanceof Uint8Array) bytes = value;
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else return null;
      objects.set(key, bytes);
      return { key, size: bytes.byteLength, etag: "dev" };
    },
  };

  return {
    db,
    bucket,
    reset() {
      rows.length = 0;
      objects.clear();
    },
  };
}

let devSingleton: ReturnType<typeof createDevEvidenceBindings> | null = null;

export function getDevEvidenceBindings(): ReturnType<typeof createDevEvidenceBindings> {
  if (!devSingleton) {
    devSingleton = createDevEvidenceBindings();
  }
  return devSingleton;
}

export function isDevEvidenceStorageEnabled(): boolean {
  return process.env.EVIDENCE_DEV_STORAGE?.trim().toLowerCase() === "memory";
}
