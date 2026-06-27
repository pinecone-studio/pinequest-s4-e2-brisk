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
  const passwordList = perCamera
    ? [perCamera.password]
    : parsePasswordList(globalCredentials.passwords);
  const attemptIndex = passwordAttempts[camera.id] ?? 0;
  const password = passwordList[attemptIndex] ?? "";
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

export function getPasswordListForCamera(
  cameraId: string,
  globalCredentials: GlobalCredentials,
  cameraCredentials: Record<string, CameraCredentials>,
): string[] {
  const perCamera = cameraCredentials[cameraId];
  if (perCamera) {
    return [perCamera.password];
  }
  return parsePasswordList(globalCredentials.passwords);
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
