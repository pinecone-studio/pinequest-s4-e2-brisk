/**
 * Smoke-test evidenceEventsDb against an in-memory mock D1 (no Cloudflare account).
 * Run: npx tsx scripts/verify-evidence-db.ts
 */
import {
  insertEvidenceEvent,
  listEvidenceEvents,
} from "../lib/evidenceEventsDb";
import type { D1Database, D1PreparedStatement, D1Result, D1RunResult } from "../lib/d1Types";

type Row = {
  id: string;
  camera_id: string;
  label: string;
  confidence: number;
  occurred_at: number;
  r2_key: string;
  summary: string | null;
  created_at: number;
};

function createMockD1(): D1Database {
  const rows: Row[] = [];

  function prepare(query: string): D1PreparedStatement {
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
          const [id, camera_id, label, confidence, occurred_at, r2_key, summary, created_at] =
            bound as Row[keyof Row][];
          rows.push({
            id: id as string,
            camera_id: camera_id as string,
            label: label as string,
            confidence: confidence as number,
            occurred_at: occurred_at as number,
            r2_key: r2_key as string,
            summary: summary as string | null,
            created_at: created_at as number,
          });
          return { success: true };
        }
        return { success: false, error: "unsupported query in mock" };
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
        return { success: false, results: [], error: "unsupported query in mock" };
      },
    };

    return stmt;
  }

  return { prepare };
}

async function main() {
  const db = createMockD1();

  const inserted = await insertEvidenceEvent(db, {
    id: "evt_test_1",
    cameraId: "cam_010",
    label: "Litter",
    confidence: 0.83,
    occurredAt: 1_751_470_000_000,
    r2Key: "evidence/cam_010/1751470000000-litter.jpg",
    summary: "Test event",
    createdAt: 1_751_470_001_200,
  });

  if (inserted.id !== "evt_test_1") {
    throw new Error("insertEvidenceEvent returned unexpected id");
  }

  const all = await listEvidenceEvents(db);
  if (all.length !== 1 || all[0].cameraId !== "cam_010") {
    throw new Error("listEvidenceEvents returned unexpected rows");
  }

  await insertEvidenceEvent(db, {
    id: "evt_test_2",
    cameraId: "cam_020",
    label: "Cigarette",
    confidence: 0.9,
    occurredAt: 1_751_480_000_000,
    r2Key: "evidence/cam_020/x.jpg",
    createdAt: 1_751_480_001_000,
  });

  const filtered = await listEvidenceEvents(db, { cameraId: "cam_010" });
  if (filtered.length !== 1 || filtered[0].id !== "evt_test_1") {
    throw new Error("cameraId filter failed");
  }

  console.log("verify-evidence-db: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
