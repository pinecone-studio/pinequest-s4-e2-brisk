import { promises as fs } from "fs";
import path from "path";
import type { CameraView } from "../../cameras/lib/cameraTypes";

interface RawCamera {
  id?: string;
  name?: string;
  rtsp_url?: string;
  remote_rtsp_url?: string;
  stream_url?: string;
  connection_mode?: CameraConnectionMode;
  host?: string;
  ip?: string;
  location?: string;
  description?: string;
  floor?: number;
  zone?: string;
  enabled?: boolean;
}

interface RawCameraConfig {
  cameras?: RawCamera[];
  rtsp_template?: string;
  connection_mode?: CameraConnectionMode;
}

interface CameraStreamSource {
  id: string;
  name: string;
  host?: string;
  rtsp_url?: string;
  enabled: boolean;
  connection_mode: CameraConnectionMode;
  config_error?: string;
}

type CameraConnectionMode = "local" | "remote";

export async function loadCameraConfig(): Promise<CameraView[]> {
  const config = await loadRawCameraConfig();
  return normalizeCameraConfig(config);
}

export async function loadCameraStreamSource(cameraId: string): Promise<CameraStreamSource | undefined> {
  const config = await loadRawCameraConfig();
  const rawCamera = (config.cameras ?? []).find((camera) => camera.id === cameraId);
  if (!rawCamera) return undefined;
  const connectionMode = resolveCameraConnectionMode(rawCamera, config);
  const rtspUrl = resolveCameraStreamUrl(rawCamera, config);
  const configError = validateCameraStreamConfig(rawCamera, connectionMode);

  return {
    id: rawCamera.id ?? cameraId,
    name: rawCamera.name ?? cameraId,
    host: rawCamera.host ?? rawCamera.ip ?? getRtspHost(rtspUrl),
    rtsp_url: rtspUrl,
    enabled: rawCamera.enabled ?? true,
    connection_mode: connectionMode,
    config_error: configError,
  };
}

async function loadRawCameraConfig(): Promise<RawCameraConfig> {
  const configPath = path.join(process.cwd(), "cameras.json");
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
}

export function normalizeCameraConfig(config: RawCameraConfig): CameraView[] {
  return (config.cameras ?? []).map((camera, index) => normalizeCamera(camera, index + 1, config));
}

export function getEnabledCameras(cameras: CameraView[]): CameraView[] {
  return cameras.filter((camera) => camera.enabled !== false);
}

export function getCameraById(cameras: CameraView[], cameraId: string): CameraView | undefined {
  return cameras.find((camera) => camera.id === cameraId);
}

export function buildCameraStreamUrl(cameraId: string): string {
  return `/api/stream/${cameraId}`;
}

export function resolveCameraStreamUrl(
  camera: RawCamera,
  config?: RawCameraConfig,
): string | undefined {
  const connectionMode = resolveCameraConnectionMode(camera, config);
  if (connectionMode === "remote") {
    return camera.remote_rtsp_url;
  }
  return camera.rtsp_url ?? camera.stream_url;
}

function resolveCameraConnectionMode(
  camera: RawCamera,
  config?: RawCameraConfig,
): CameraConnectionMode {
  return camera.connection_mode ?? config?.connection_mode ?? "local";
}

function validateCameraStreamConfig(
  camera: RawCamera,
  connectionMode: CameraConnectionMode,
): string | undefined {
  if (connectionMode === "remote" && !camera.remote_rtsp_url) {
    return `Camera ${camera.id ?? "<unknown>"} is configured for remote mode but remote_rtsp_url is missing`;
  }
  return undefined;
}

function normalizeCamera(
  camera: RawCamera,
  index: number,
  config: RawCameraConfig,
): CameraView {
  const id = camera.id ?? `cam_${String(index).padStart(2, "0")}`;
  const floor = camera.floor ?? 0;
  const zone = camera.zone ?? camera.description ?? "unknown";
  const rtspUrl = resolveCameraStreamUrl(camera, config);

  return {
    id,
    name: camera.name ?? id,
    host: camera.host ?? camera.ip ?? getRtspHost(rtspUrl),
    floor,
    zone,
    location: camera.location ?? (floor ? `Floor ${floor}` : undefined),
    description: camera.description ?? titleCase(zone),
    stream_url: buildCameraStreamUrl(id),
    enabled: camera.enabled ?? true,
    online: false,
    status: camera.enabled === false ? "disabled" : "unknown",
  };
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getRtspHost(rtspUrl?: string): string | undefined {
  if (!rtspUrl) return undefined;
  try {
    return new URL(rtspUrl).hostname;
  } catch {
    return undefined;
  }
}
