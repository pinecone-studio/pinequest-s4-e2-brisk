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
// Defaults so a fresh device (e.g. the demo screen) streams without anyone
// typing credentials. Set via client/.env.local (NEXT_PUBLIC_DEFAULT_CAMERA_*).
const DEFAULT_USERNAME = process.env.NEXT_PUBLIC_DEFAULT_CAMERA_USER ?? "admin";
const DEFAULT_PASSWORDS = process.env.NEXT_PUBLIC_DEFAULT_CAMERA_PASSWORDS ?? "";

export function loadGlobalCredentials(): GlobalCredentials {
  if (typeof window === "undefined") {
    return { username: DEFAULT_USERNAME, passwords: DEFAULT_PASSWORDS };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { username: DEFAULT_USERNAME, passwords: DEFAULT_PASSWORDS };
    const parsed = JSON.parse(raw) as Partial<GlobalCredentials>;
    return {
      username: parsed.username ?? DEFAULT_USERNAME,
      // Fall back to defaults if the saved list is empty.
      passwords: parsed.passwords || DEFAULT_PASSWORDS,
    };
  } catch {
    return { username: DEFAULT_USERNAME, passwords: DEFAULT_PASSWORDS };
  }
}

export function saveGlobalCredentials(credentials: GlobalCredentials) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
}
