import { promises as fs } from "fs";
import path from "path";
import type { CameraView } from "../../cameras/lib/cameraTypes";

interface RawCamera {
  id?: string;
  name?: string;
  rtsp_url?: string;
  stream_url?: string;
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
}

interface CameraStreamSource {
  id: string;
  name: string;
  host?: string;
  rtsp_url?: string;
  enabled: boolean;
}

export async function loadCameraConfig(): Promise<CameraView[]> {
  const config = await loadRawCameraConfig();
  return normalizeCameraConfig(config);
}

export async function loadCameraStreamSource(cameraId: string): Promise<CameraStreamSource | undefined> {
  const config = await loadRawCameraConfig();
  const rawCamera = (config.cameras ?? []).find((camera) => camera.id === cameraId);
  if (!rawCamera) return undefined;

  return {
    id: rawCamera.id ?? cameraId,
    name: rawCamera.name ?? cameraId,
    host: rawCamera.host ?? rawCamera.ip,
    rtsp_url: rawCamera.rtsp_url ?? rawCamera.stream_url,
    enabled: rawCamera.enabled ?? true,
  };
}

async function loadRawCameraConfig(): Promise<RawCameraConfig> {
  const configPath = path.join(process.cwd(), "cameras.json");
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
}

export function normalizeCameraConfig(config: RawCameraConfig): CameraView[] {
  return (config.cameras ?? []).map((camera, index) => normalizeCamera(camera, index + 1));
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

function normalizeCamera(
  camera: RawCamera,
  index: number,
): CameraView {
  const id = camera.id ?? `cam_${String(index).padStart(2, "0")}`;
  const floor = camera.floor ?? 0;
  const zone = camera.zone ?? camera.description ?? "unknown";

  return {
    id,
    name: camera.name ?? id,
    host: camera.host ?? camera.ip,
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
