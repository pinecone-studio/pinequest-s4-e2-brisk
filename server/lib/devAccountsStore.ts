import type { D1Database, D1PreparedStatement, D1Result, D1RunResult } from "./d1Types";
import { DEMO_ACCOUNTS_SEED } from "./demoAccountsSeed";

export interface AccountRow {
  id: string;
  name: string;
  created_at: number;
  last_active_at: number;
}

export interface CameraConfigRow {
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

/** In-memory D1 for accounts/camera_configs, local `npm run dev` only (EVIDENCE_DEV_STORAGE=memory). */
export function createDevAccountsBindings(): { db: D1Database; reset: () => void } {
  const accounts: AccountRow[] = [];
  const cameraConfigs: CameraConfigRow[] = [];

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
          if (query.includes("INSERT INTO accounts")) {
            accounts.push({
              id: bound[0] as string,
              name: bound[1] as string,
              created_at: bound[2] as number,
              last_active_at: bound[3] as number,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (query.includes("INSERT INTO camera_configs")) {
            cameraConfigs.push({
              id: bound[0] as string,
              account_id: bound[1] as string,
              camera_id: bound[2] as string,
              name: (bound[3] as string | null) ?? null,
              rtsp_url: (bound[4] as string | null) ?? null,
              remote_rtsp_url: (bound[5] as string | null) ?? null,
              connection_mode: (bound[6] as string) ?? "local",
              username: (bound[7] as string | null) ?? null,
              password: (bound[8] as string | null) ?? null,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (query.includes("UPDATE accounts")) {
            const lastActiveAt = bound[0] as number;
            const id = bound[1] as string;
            const row = accounts.find((a) => a.id === id);
            if (row) {
              row.last_active_at = lastActiveAt;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: false, error: "unsupported query in dev accounts D1" };
        },
        async all<T>(): Promise<D1Result<T>> {
          if (query.includes("FROM accounts")) {
            const sorted = [...accounts].sort((a, b) => b.last_active_at - a.last_active_at);
            return { success: true, results: sorted as T[] };
          }
          if (query.includes("FROM camera_configs")) {
            const accountId = bound[0] as string;
            const filtered = cameraConfigs.filter((c) => c.account_id === accountId);
            return { success: true, results: filtered as T[] };
          }
          return { success: false, results: [], error: "unsupported query in dev accounts D1" };
        },
      };
      return stmt;
    },
  };

  function reset() {
    accounts.length = 0;
    cameraConfigs.length = 0;
  }

  function seedIfEmpty() {
    if (accounts.length > 0) return;
    for (const seed of DEMO_ACCOUNTS_SEED) {
      accounts.push({
        id: seed.account.id,
        name: seed.account.name,
        created_at: seed.account.createdAt,
        last_active_at: seed.account.lastActiveAt,
      });
      for (const camera of seed.cameraConfigs) {
        cameraConfigs.push({
          id: camera.id,
          account_id: seed.account.id,
          camera_id: camera.cameraId,
          name: camera.name ?? null,
          rtsp_url: camera.rtspUrl ?? null,
          remote_rtsp_url: camera.remoteRtspUrl ?? null,
          connection_mode: camera.connectionMode ?? "local",
          username: camera.username ?? null,
          password: camera.password ?? null,
        });
      }
    }
  }

  seedIfEmpty();

  return { db, reset };
}

let devSingleton: ReturnType<typeof createDevAccountsBindings> | null = null;

/** Local dev accounts store — auto-seeded with demo accounts on first use so `npm run dev` demos work with no extra setup. */
export function getDevAccountsBindings(): ReturnType<typeof createDevAccountsBindings> {
  if (!devSingleton) {
    devSingleton = createDevAccountsBindings();
  }
  return devSingleton;
}
