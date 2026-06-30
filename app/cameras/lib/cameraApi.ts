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

interface NodeCameraResponse {
  id: string;
  name: string;
  host: string;
  port: number;
  rtspUrl: string;
  source?: string;
}

interface NodeScanResponse {
  status: "idle" | "running" | "completed" | "failed";
  cameras?: NodeCameraResponse[];
  error?: string;
}

export interface DiscoveryResults {
  status: DiscoveryStatus;
  cameras: CameraView[];
}

const SERVICE_HINT = "Run npm run dev:camera-service in a second terminal.";

function cameraServiceBase(): string {
  if (typeof window !== "undefined") {
    return (
      process.env.NEXT_PUBLIC_CAMERA_SERVICE_HTTP ?? `http://${window.location.hostname}:3001`
    );
  }
  return process.env.CAMERA_SERVICE_ORIGIN ?? "http://localhost:3001";
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

function nodeCameraToView(camera: NodeCameraResponse): CameraView {
  const parsed = parseRtspUrl(camera.rtspUrl);
  return {
    id: camera.id,
    name: camera.name,
    host: camera.host,
    rtsp_port: camera.port,
    rtsp_path: parsed.path,
    floor: 0,
    zone: "Discovered",
    stream_url: buildStreamProxyUrl(camera.rtspUrl),
    enabled: true,
    online: true,
    status: "online",
  };
}

function mapNodeStatus(status: NodeScanResponse["status"]): DiscoveryStatus {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return "completed";
}

async function parseApiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string; detail?: string };
    return body.error ?? body.message ?? body.detail ?? `Request failed with status ${response.status}`;
  } catch {
    return `Request failed with status ${response.status}`;
  }
}

function discoveryUnavailableError(response: Response): Error {
  if (response.status === 500 || response.status === 502 || response.status === 503) {
    return new Error(`Camera discovery service is unavailable. ${SERVICE_HINT}`);
  }
  return new Error(`Discovery API returned non-JSON response (${response.status})`);
}

async function fetchFromCameraService(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${cameraServiceBase()}/api${path}`, { cache: "no-store", ...init });
}

async function fetchFromPythonDiscovery(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api/cameras/discovery${path}`, { cache: "no-store", ...init });
}

async function tryCameraServiceResults(): Promise<DiscoveryResults | null> {
  const response = await fetchFromCameraService("/discover/results");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as NodeScanResponse;
  return {
    status: mapNodeStatus(data.status),
    cameras: (data.cameras ?? []).map(nodeCameraToView),
  };
}

async function tryPythonResults(): Promise<DiscoveryResults> {
  const response = await fetchFromPythonDiscovery("/results");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw discoveryUnavailableError(response);
  }

  const data = (await response.json()) as DiscoveryResultsResponse;
  if (!response.ok) {
    throw new Error(`Failed to load discovered cameras: ${response.status}`);
  }

  return {
    status: data.status,
    cameras: (data.discovered_cameras ?? []).map(discoveredCameraToView),
  };
}

export async function fetchDiscoveryResults(): Promise<DiscoveryResults> {
  const fromService = await tryCameraServiceResults();
  if (fromService) {
    return fromService;
  }
  return tryPythonResults();
}

export async function fetchDiscoveredCameras(): Promise<CameraView[]> {
  const { cameras } = await fetchDiscoveryResults();
  return cameras;
}

export async function fetchDiscoverySubnet(): Promise<string> {
  const serviceResponse = await fetchFromCameraService("/discover/subnet");
  if (serviceResponse.ok) {
    const body = (await serviceResponse.json()) as { subnet: string; subnets?: string[] };
    return body.subnets?.join(", ") ?? body.subnet;
  }

  const response = await fetchFromPythonDiscovery("/subnet");
  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }
  const body = (await response.json()) as { subnet: string; subnets?: string[] };
  return body.subnets?.join(", ") ?? body.subnet;
}

export async function startDiscoveryScan(subnet?: string): Promise<void> {
  const serviceResponse = await fetchFromCameraService("/discover/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  if (serviceResponse.ok) {
    return;
  }

  const response = await fetchFromPythonDiscovery("/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targets: subnet ? [subnet] : [] }),
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
