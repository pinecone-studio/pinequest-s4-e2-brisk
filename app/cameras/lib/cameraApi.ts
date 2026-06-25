import type { CameraView } from "./cameraTypes";

export async function fetchCameraConfig(): Promise<CameraView[]> {
  const response = await fetch("/api/cameras");
  if (!response.ok) {
    throw new Error(`Failed to load camera config: ${response.status}`);
  }
  return response.json();
}

export function buildCameraStreamUrl(camera: CameraView): string {
  return camera.stream_url ?? `/api/stream/${camera.id}`;
}
