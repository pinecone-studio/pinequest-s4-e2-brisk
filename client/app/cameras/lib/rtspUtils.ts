export interface RtspParts {
  host: string;
  port: number;
  path: string;
}

export function parseRtspUrl(rtspUrl: string): RtspParts {
  try {
    const parsed = new URL(rtspUrl);
    return {
      host: parsed.hostname,
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 554,
      path: parsed.pathname || "/",
    };
  } catch {
    return { host: "", port: 554, path: "/" };
  }
}

export function encodeRtspCredential(value: string): string {
  return encodeURIComponent(value);
}

export function buildRtspUrl(
  host: string,
  port: number,
  path: string,
  username?: string,
  password?: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const auth =
    username && password
      ? `${encodeRtspCredential(username)}:${encodeRtspCredential(password)}@`
      : username
        ? `${encodeRtspCredential(username)}@`
        : "";
  return `rtsp://${auth}${host}:${port}${normalizedPath}`;
}

export function buildStreamProxyUrl(rtspUrl: string, cacheBuster = 0): string {
  const params = new URLSearchParams({
    url: rtspUrl,
    v: String(cacheBuster),
  });
  return `/api/stream/rtsp?${params.toString()}`;
}

export function extractRtspUrlFromStreamReference(streamReference: string): string | null {
  const trimmed = streamReference.trim();
  if (trimmed.startsWith("rtsp://") || trimmed.startsWith("rtsps://")) {
    return trimmed;
  }

  if (trimmed.startsWith("/api/stream/rtsp")) {
    try {
      const params = new URLSearchParams(trimmed.split("?")[1] ?? "");
      const embedded = params.get("url");
      if (!embedded) return null;
      return decodeURIComponent(embedded);
    } catch {
      return null;
    }
  }

  return null;
}

/** Map a main-stream RTSP URL to its lower-bandwidth substream when possible. */
export function toSubstreamRtspUrl(rtspUrl: string): string {
  try {
    const url = new URL(rtspUrl);
    const path = url.pathname;

    const hikvisionChannel = path.match(/^(\/Streaming\/Channels\/)(\d+)$/i);
    if (hikvisionChannel) {
      const channelNum = Number.parseInt(hikvisionChannel[2], 10);
      if (channelNum % 100 === 1) {
        url.pathname = `${hikvisionChannel[1]}${channelNum + 1}`;
        return url.toString();
      }
    }

    if (/subtype=0/i.test(url.search)) {
      url.search = url.search.replace(/subtype=0/gi, "subtype=1");
      return url.toString();
    }

    if (/\/(stream|video)1$/i.test(path)) {
      url.pathname = path.replace(/1$/i, "2");
      return url.toString();
    }

    if (/\/ch0_0$/i.test(path)) {
      url.pathname = path.replace(/ch0_0$/i, "ch0_1");
      return url.toString();
    }

    return rtspUrl;
  } catch {
    return rtspUrl;
  }
}

export function buildSubstreamProxyUrl(streamReference: string): string {
  const rtspUrl = extractRtspUrlFromStreamReference(streamReference);
  if (!rtspUrl) return streamReference;
  return buildStreamProxyUrl(toSubstreamRtspUrl(rtspUrl));
}

export function parsePasswordList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
