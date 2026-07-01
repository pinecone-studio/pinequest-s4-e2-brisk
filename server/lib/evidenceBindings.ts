import type { D1Database } from "./d1Types";
import { EVIDENCE_R2_BINDING, type R2Bucket } from "./r2Types";

/** Intended Wrangler D1 binding name — wired in issue #8. */
export const EVIDENCE_D1_BINDING = "EVIDENCE_DB" as const;

export interface EvidenceBindings {
  db: D1Database;
  bucket: R2Bucket;
}

type CloudflareEnv = Record<string, unknown>;

function readCloudflareEnv(): CloudflareEnv | null {
  const env = (globalThis as { env?: CloudflareEnv }).env;
  return env ?? null;
}

/** Resolves D1 + R2 bindings from the Workers `env` object (available after #8). */
export function getEvidenceBindings(): EvidenceBindings | null {
  const env = readCloudflareEnv();
  if (!env) return null;

  const db = env[EVIDENCE_D1_BINDING] as D1Database | undefined;
  const bucket = env[EVIDENCE_R2_BINDING] as R2Bucket | undefined;
  if (!db || !bucket) return null;

  return { db, bucket };
}
