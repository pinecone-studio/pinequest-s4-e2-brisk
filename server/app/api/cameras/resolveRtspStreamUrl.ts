import { loadCameraStreamSource } from "./serverCameraConfig";

function decodeStreamParam(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolve the RTSP URL backing a snapshot/MJPEG request.
 * Accepts a direct rtsp(s) URL or a proxied `/api/stream/rtsp?url=...` streamUrl.
 */
export async function resolveRtspStreamUrl(
  cameraId: string,
  streamUrl: string,
  requestUrl: string,
): Promise<string | undefined> {
  const trimmed = streamUrl.trim();
  if (!trimmed) {
    const camera = await loadCameraStreamSource(cameraId);
    return camera?.rtsp_url;
  }

  if (trimmed.startsWith("rtsp://") || trimmed.startsWith("rtsps://")) {
    return trimmed;
  }

  if (trimmed.startsWith("/api/stream/rtsp")) {
    const parsed = new URL(trimmed, requestUrl);
    const embedded = decodeStreamParam(parsed.searchParams.get("url"));
    if (embedded?.startsWith("rtsp://") || embedded?.startsWith("rtsps://")) {
      return embedded;
    }
  }

  const camera = await loadCameraStreamSource(cameraId);
  return camera?.rtsp_url;
}
