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

export function parsePasswordList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
