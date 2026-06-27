import type { CameraView } from "./cameraTypes";
import { buildStreamProxyUrl, parseRtspUrl } from "./rtspUtils";

interface DiscoveredCameraResponse {
  host: string;
  port: number;
  rtsp_url: string;
  path?: string;
  username?: string | null;
  password?: string | null;
}

export type DiscoveryStatus = "running" | "completed" | "failed" | "timeout";

interface DiscoveryResultsResponse {
  status: DiscoveryStatus;
  discovered_cameras?: DiscoveredCameraResponse[];
}

export interface DiscoveryResults {
  status: DiscoveryStatus;
  cameras: CameraView[];
}

function discoveredCameraToView(camera: DiscoveredCameraResponse): CameraView {
  const id = `discovered-${camera.host}-${camera.port}`;
  const lastOctet = camera.host.split(".").pop();
  const parsed = parseRtspUrl(camera.rtsp_url);
  const rtspPath = camera.path ?? parsed.path;

  return {
    id,
    name: lastOctet ? `Camera ${lastOctet}` : camera.host,
    host: camera.host,
    rtsp_port: camera.port,
    rtsp_path: rtspPath,
    floor: 0,
    zone: "Discovered",
    stream_url: buildStreamProxyUrl(camera.rtsp_url),
    enabled: true,
    online: true,
    status: "online",
  };
}

export async function fetchDiscoveryResults(): Promise<DiscoveryResults> {
  const response = await fetch("/api/cameras/discovery/results", { cache: "no-store" });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Discovery API returned non-JSON response (${response.status})`);
  }

  const data = (await response.json()) as DiscoveryResultsResponse;
  if (!response.ok) {
    throw new Error(`Failed to load discovered cameras: ${response.status}`);
  }

  if (data.status === "failed" || data.status === "timeout") {
    return {
      status: data.status,
      cameras: (data.discovered_cameras ?? []).map(discoveredCameraToView),
    };
  }

  return {
    status: data.status,
    cameras: (data.discovered_cameras ?? []).map(discoveredCameraToView),
  };
}

export async function fetchDiscoveredCameras(): Promise<CameraView[]> {
  const { cameras } = await fetchDiscoveryResults();
  return cameras;
}

async function parseApiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string; detail?: string };
    return body.error ?? body.message ?? body.detail ?? `Request failed with status ${response.status}`;
  } catch {
    return `Request failed with status ${response.status}`;
  }
}

export async function fetchDiscoverySubnet(): Promise<string> {
  const response = await fetch("/api/cameras/discovery/subnet", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }
  const body = (await response.json()) as { subnet: string };
  return body.subnet;
}

export async function startDiscoveryScan(subnet: string): Promise<void> {
  const response = await fetch("/api/cameras/discovery/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targets: [subnet] }),
  });
  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }
}

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

export { buildRtspUrl, buildStreamProxyUrl, parsePasswordList } from "./rtspUtils";
