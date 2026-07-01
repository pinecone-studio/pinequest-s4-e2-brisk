/**
 * Smoke-test evidence POST handler (auth parsing + persist with mock bindings).
 * Run: CLIENT_SERVER_SECRET=test npx tsx scripts/verify-evidence-post.ts
 */
import { verifyClientServerAuth } from "../lib/evidenceAuth";
import {
  decodeEvidenceImage,
  parseEvidencePostBody,
  persistEvidenceEventWith,
} from "../lib/evidencePost";
import type { D1Database, D1PreparedStatement, D1Result, D1RunResult } from "../lib/d1Types";
import type { R2Bucket, R2Object, R2PutOptions } from "../lib/r2Types";

// --- mock D1 (same pattern as verify-evidence-db.ts) ---
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

function createMockD1(): D1Database & { rows: Row[] } {
  const rows: Row[] = [];
  return {
    rows,
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
            });
            return { success: true };
          }
          return { success: false, error: "unsupported" };
        },
        async all<T>(): Promise<D1Result<T>> {
          return { success: true, results: rows as T[] };
        },
      };
      return stmt;
    },
  };
}

function createMockR2(): R2Bucket & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async put(
      key: string,
      _value: unknown,
      _options?: R2PutOptions,
    ): Promise<R2Object | null> {
      keys.push(key);
      return { key, size: 4, etag: "mock" };
    },
  };
}

async function main() {
  process.env.CLIENT_SERVER_SECRET = "test-secret";

  if (verifyClientServerAuth(null) !== "Unauthorized") {
    throw new Error("expected unauthorized for missing header");
  }
  if (verifyClientServerAuth("Bearer wrong") !== "Unauthorized") {
    throw new Error("expected unauthorized for wrong token");
  }
  if (verifyClientServerAuth("Bearer test-secret") !== null) {
    throw new Error("expected auth success");
  }

  const bad = parseEvidencePostBody({ cameraId: "cam_1", label: "Fire" });
  if (!("error" in bad)) throw new Error("expected label validation error");

  const body = parseEvidencePostBody({
    cameraId: "cam_010",
    label: "Litter",
    confidence: 0.83,
    occurredAt: 1_751_470_000_000,
    summary: "Test",
    image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
  });
  if ("error" in body) throw new Error(body.error);

  const decoded = decodeEvidenceImage(`data:image/jpeg;base64,${body.image}`);
  if (decoded.byteLength !== 4) throw new Error("decode failed");

  const db = createMockD1();
  const bucket = createMockR2();
  const result = await persistEvidenceEventWith(db, bucket, body);

  if (!result.id.startsWith("evt_")) throw new Error("bad id");
  if (result.r2Key !== "evidence/cam_010/1751470000000-litter.jpg") {
    throw new Error(`bad r2Key: ${result.r2Key}`);
  }
  if (db.rows.length !== 1 || bucket.keys.length !== 1) {
    throw new Error("db/r2 not updated");
  }

  console.log("verify-evidence-post: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
