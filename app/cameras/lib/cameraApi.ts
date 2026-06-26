import type { CameraView } from "./cameraTypes";

export async function fetchCameraConfig(): Promise<CameraView[]> {
  const response = await fetch("/api/cameras");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Camera API returned non-JSON response (${response.status})`);
  }
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error ?? `Failed to load camera config: ${response.status}`);
  }
  return data;
}

export function buildCameraStreamUrl(camera: CameraView): string {
  return camera.stream_url ?? `/api/stream/${camera.id}`;
}
