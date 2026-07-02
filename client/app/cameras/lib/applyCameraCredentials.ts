import type { CameraCredentials } from "../components/CameraCredentialsModal";
import type { GlobalCredentials } from "../components/CredentialsPanel";
import type { CameraView } from "./cameraTypes";
import { buildRtspUrl, buildStreamProxyUrl, parsePasswordList } from "./rtspUtils";

export function applyCredentialsToCamera(
  camera: CameraView,
  globalCredentials: GlobalCredentials,
  cameraCredentials: Record<string, CameraCredentials>,
  passwordAttempts: Record<string, number>,
  retryKeys: Record<string, number>,
): CameraView {
  const perCamera = cameraCredentials[camera.id];
  const passwordList = resolvePasswordList(perCamera, globalCredentials.passwords);
  const attemptIndex = passwordAttempts[camera.id] ?? 0;
  const password = passwordList[attemptIndex] ?? passwordList[0] ?? "";
  const username = perCamera?.username ?? globalCredentials.username;

  if (!camera.host || !camera.rtsp_port) {
    return camera;
  }

  const rtspPath = camera.rtsp_path ?? "/";
  const rtspUrl = buildRtspUrl(camera.host, camera.rtsp_port, rtspPath, username, password);
  const cacheBuster = retryKeys[camera.id] ?? 0;

  return {
    ...camera,
    stream_url: buildStreamProxyUrl(rtspUrl, cacheBuster),
  };
}

function resolvePasswordList(
  perCamera: CameraCredentials | undefined,
  globalPasswords: string,
): string[] {
  if (perCamera?.password.trim()) {
    return [perCamera.password];
  }
  return parsePasswordList(globalPasswords);
}

export function getPasswordListForCamera(
  cameraId: string,
  globalCredentials: GlobalCredentials,
  cameraCredentials: Record<string, CameraCredentials>,
): string[] {
  return resolvePasswordList(cameraCredentials[cameraId], globalCredentials.passwords);
}

/** Per-account camera setup, as returned by GET /api/session/last-used (Skip Login). */
export interface AccountCameraConfig {
  id: string;
  cameraId: string;
  name: string | null;
  rtspUrl: string | null;
  remoteRtspUrl: string | null;
  connectionMode: "local" | "remote";
  username: string | null;
  password: string | null;
}

export interface AccountSession {
  accountId: string;
  accountName: string;
  cameraConfigs: AccountCameraConfig[];
}

/** Per-camera credentials keyed by camera id, mirroring the shape used for manual per-camera overrides. */
export function buildCameraCredentialsFromAccountConfigs(
  configs: AccountCameraConfig[],
): Record<string, CameraCredentials> {
  const result: Record<string, CameraCredentials> = {};
  for (const config of configs) {
    if (!config.username && !config.password) continue;
    result[config.cameraId] = {
      username: config.username ?? "admin",
      password: config.password ?? "",
    };
  }
  return result;
}

/** Renders an account's saved camera setup directly, so it appears with no extra clicks after Skip Login. */
export function buildCameraViewsFromAccountConfigs(configs: AccountCameraConfig[]): CameraView[] {
  return configs.map((config) => {
    const rtspUrl = config.connectionMode === "remote" ? config.remoteRtspUrl : config.rtspUrl;
    let host: string | undefined;
    let rtspPort: number | undefined;
    let rtspPath: string | undefined;
    if (rtspUrl) {
      try {
        const parsed = new URL(rtspUrl);
        host = parsed.hostname;
        rtspPort = parsed.port ? Number.parseInt(parsed.port, 10) : 554;
        rtspPath = parsed.pathname || "/";
      } catch {
        // leave host/port/path undefined if the stored URL can't be parsed
      }
    }

    return {
      id: config.cameraId,
      name: config.name ?? config.cameraId,
      host,
      rtsp_port: rtspPort,
      rtsp_path: rtspPath,
      floor: 0,
      zone: "My Cameras",
      online: false,
    };
  });
}

const ACCOUNT_SESSION_STORAGE_KEY = "guardai-account-session";

export function saveAccountSession(session: AccountSession) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACCOUNT_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function loadAccountSession(): AccountSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACCOUNT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AccountSession;
  } catch {
    return null;
  }
}

const STORAGE_KEY = "guardai-global-credentials";

export function loadGlobalCredentials(): GlobalCredentials {
  if (typeof window === "undefined") {
    return { username: "admin", passwords: "" };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { username: "admin", passwords: "" };
    const parsed = JSON.parse(raw) as Partial<GlobalCredentials>;
    return {
      username: parsed.username ?? "admin",
      passwords: parsed.passwords ?? "",
    };
  } catch {
    return { username: "admin", passwords: "" };
  }
}

export function saveGlobalCredentials(credentials: GlobalCredentials) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
}
