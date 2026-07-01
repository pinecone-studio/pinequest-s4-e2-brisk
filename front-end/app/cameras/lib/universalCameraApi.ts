import type { UniversalCamera, UniversalScanState } from "./universalCameraTypes";

const httpBase =
  process.env.NEXT_PUBLIC_CAMERA_SERVICE_HTTP ??
  (typeof window !== "undefined" ? "" : "http://localhost:3001");

const wsBase =
  process.env.NEXT_PUBLIC_CAMERA_SERVICE_WS ??
  (typeof window !== "undefined" ? `ws://${window.location.hostname}:3001` : "ws://localhost:3001");

export function cameraServiceHttp(path: string): string {
  if (httpBase) {
    return `${httpBase}${path}`;
  }
  return `/api/camera-service${path.replace(/^\/api/, "")}`;
}

export function cameraStreamWsUrl(cameraId: string): string {
  return `${wsBase}/api/stream/${encodeURIComponent(cameraId)}`;
}

export function jsmpegScriptUrl(): string {
  return cameraServiceHttp("/api/stream/script.js");
}

export async function fetchUniversalSubnet(): Promise<string> {
  const response = await fetch(cameraServiceHttp("/api/discover/subnet"), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Subnet detection failed (${response.status})`);
  }
  const body = (await response.json()) as { subnet: string };
  return body.subnet;
}

export async function fetchUniversalScanResults(): Promise<UniversalScanState> {
  const response = await fetch(cameraServiceHttp("/api/discover/results"), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Discovery results failed (${response.status})`);
  }
  return (await response.json()) as UniversalScanState;
}

export async function startUniversalScan(subnet?: string): Promise<UniversalScanState> {
  const response = await fetch(cameraServiceHttp("/api/discover/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subnet ? { subnet } : {}),
  });
  if (!response.ok) {
    throw new Error(`Discovery start failed (${response.status})`);
  }
  return (await response.json()) as UniversalScanState;
}

export async function fetchUniversalCameras(): Promise<UniversalCamera[]> {
  const response = await fetch(cameraServiceHttp("/api/cameras"), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Camera list failed (${response.status})`);
  }
  const body = (await response.json()) as { cameras: UniversalCamera[] };
  return body.cameras;
}

export function gridColumns(count: number): 1 | 2 | 3 {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  return 3;
}
