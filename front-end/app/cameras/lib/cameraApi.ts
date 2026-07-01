import type { CameraView } from "./cameraTypes";
import { buildStreamProxyUrl, buildSubstreamProxyUrl, parseRtspUrl } from "./rtspUtils";

export type DiscoveryStatus = "running" | "completed" | "failed" | "timeout";

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

async function fetchFromCameraService(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${cameraServiceBase()}/api${path}`, { cache: "no-store", ...init });
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

export async function fetchDiscoveryResults(): Promise<DiscoveryResults> {
  const fromService = await tryCameraServiceResults();
  if (fromService) {
    return fromService;
  }
  throw new Error(`Camera discovery service is unavailable. ${SERVICE_HINT}`);
}

/** Fast discovery fetch — returns null on timeout/unavailable instead of throwing. */
export async function tryFetchDiscoveryResults(
  timeoutMs = 4_000,
): Promise<DiscoveryResults | null> {
  try {
    return await Promise.race([
      fetchDiscoveryResults(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  }
}

/** Prefer configured cameras; append discovered devices without duplicating ids. */
export function mergeCameraLists(
  configured: CameraView[],
  discovered: CameraView[],
): CameraView[] {
  const byId = new Map<string, CameraView>();
  for (const camera of configured) {
    byId.set(camera.id, camera);
  }
  for (const camera of discovered) {
    if (!byId.has(camera.id)) {
      byId.set(camera.id, camera);
    }
  }
  return Array.from(byId.values());
}

export async function fetchDiscoveredCameras(): Promise<CameraView[]> {
  const { cameras } = await fetchDiscoveryResults();
  return cameras;
}

export async function fetchDiscoverySubnet(): Promise<string> {
  const serviceResponse = await fetchFromCameraService("/discover/subnet");
  if (!serviceResponse.ok) {
    throw new Error(await parseApiError(serviceResponse));
  }
  const body = (await serviceResponse.json()) as { subnet: string; subnets?: string[] };
  return body.subnets?.join(", ") ?? body.subnet;
}

export async function startDiscoveryScan(): Promise<void> {
  const serviceResponse = await fetchFromCameraService("/discover/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!serviceResponse.ok) {
    throw new Error(await parseApiError(serviceResponse));
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

export function buildCameraSubstreamUrl(camera: CameraView): string {
  if (!camera.stream_url) {
    return `/api/stream/${camera.id}`;
  }
  return buildSubstreamProxyUrl(camera.stream_url);
}

export {
  buildRtspUrl,
  buildStreamProxyUrl,
  buildSubstreamProxyUrl,
  parsePasswordList,
} from "./rtspUtils";
