import type { D1Database } from "./d1Types";
import { EVIDENCE_D1_BINDING } from "./evidenceBindings";
import { getDevAccountsBindings } from "./devAccountsStore";
import { isDevEvidenceStorageEnabled } from "./devEvidenceStore";

type CloudflareEnv = Record<string, unknown>;

function readCloudflareEnv(): CloudflareEnv | null {
  const env = (globalThis as { env?: CloudflareEnv }).env;
  return env ?? null;
}

/** Resolves the D1 binding for accounts/camera_configs — same database as evidence_events. */
export function getAccountsDb(): D1Database | null {
  const env = readCloudflareEnv();
  if (env) {
    const db = env[EVIDENCE_D1_BINDING] as D1Database | undefined;
    if (db) return db;
  }

  if (isDevEvidenceStorageEnabled()) {
    return getDevAccountsBindings().db;
  }

  return null;
}
