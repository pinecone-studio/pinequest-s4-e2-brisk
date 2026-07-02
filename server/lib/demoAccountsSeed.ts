/**
 * Shared demo seed data: 2-3 accounts, each with a distinct camera setup, used by
 * both the local in-memory dev store (auto-seeded, see devAccountsStore.ts) and
 * scripts/seed-accounts.ts (emits SQL for a real D1 database).
 */

export interface DemoCameraConfigSeed {
  id: string;
  cameraId: string;
  name?: string;
  rtspUrl?: string;
  remoteRtspUrl?: string;
  connectionMode?: "local" | "remote";
  username?: string;
  password?: string;
}

export interface DemoAccountSeed {
  account: {
    id: string;
    name: string;
    createdAt: number;
    lastActiveAt: number;
  };
  cameraConfigs: DemoCameraConfigSeed[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

export const DEMO_ACCOUNTS_SEED: DemoAccountSeed[] = [
  {
    account: {
      id: "acct_lobby_demo",
      name: "Lobby Demo",
      createdAt: NOW - 14 * DAY_MS,
      // Most recently active — this is who "Skip Login" restores by default.
      lastActiveAt: NOW - 5 * 60 * 1000,
    },
    cameraConfigs: [
      {
        id: "cfg_lobby_north",
        cameraId: "cam_lobby_north",
        name: "Lobby North",
        rtspUrl: "rtsp://192.168.1.50:554/Streaming/Channels/101",
        connectionMode: "local",
        username: "admin",
        password: "demo1234",
      },
      {
        id: "cfg_lobby_south",
        cameraId: "cam_lobby_south",
        name: "Lobby South",
        rtspUrl: "rtsp://192.168.1.51:554/Streaming/Channels/101",
        connectionMode: "local",
        username: "admin",
        password: "demo1234",
      },
    ],
  },
  {
    account: {
      id: "acct_warehouse_demo",
      name: "Warehouse Demo",
      createdAt: NOW - 30 * DAY_MS,
      lastActiveAt: NOW - 2 * DAY_MS,
    },
    cameraConfigs: [
      {
        id: "cfg_warehouse_dock",
        cameraId: "cam_warehouse_dock",
        name: "Loading Dock",
        rtspUrl: "rtsp://192.168.2.20:554/live",
        connectionMode: "local",
        username: "svc_warehouse",
        password: "dockcam!42",
      },
      {
        id: "cfg_warehouse_floor",
        cameraId: "cam_warehouse_floor",
        name: "Warehouse Floor",
        remoteRtspUrl: "rtsp://relay.example.com:8554/warehouse-floor",
        connectionMode: "remote",
        username: "svc_warehouse",
        password: "dockcam!42",
      },
    ],
  },
  {
    account: {
      id: "acct_campus_demo",
      name: "Campus Demo",
      createdAt: NOW - 60 * DAY_MS,
      lastActiveAt: NOW - 9 * DAY_MS,
    },
    cameraConfigs: [
      {
        id: "cfg_campus_gate",
        cameraId: "cam_campus_gate",
        name: "Main Gate",
        rtspUrl: "rtsp://10.0.4.10:554/h264",
        connectionMode: "local",
        username: "campus_ops",
        password: "gate-view-9",
      },
    ],
  },
];
