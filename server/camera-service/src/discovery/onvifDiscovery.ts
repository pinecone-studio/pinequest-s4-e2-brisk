import onvif from "node-onvif";
import { DEFAULT_CREDENTIALS, ONVIF_INIT_TIMEOUT_MS, ONVIF_PROBE_TIMEOUT_MS } from "../config";
import type { DiscoveredCamera } from "../types";

/**
 * Race a promise against a timeout. node-onvif's network calls have no timeout
 * of their own, so without this a single unresponsive device (or a stalled
 * WS-Discovery socket) hangs the entire scan indefinitely.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  // If the timeout wins the race, `promise` may still settle later; swallow a
  // late rejection so it doesn't surface as an unhandledRejection.
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface ProbeDevice {
  urn: string;
  name: string;
  hardware: string;
  xaddrs: string[];
}

interface OnvifProfile {
  token: string;
  stream?: {
    rtsp?: string;
    http?: string;
    udp?: string;
  };
}

function cameraId(host: string, port: number): string {
  return `cam-${host.replace(/\./g, "-")}-${port}`;
}

function buildRtspUrl(
  host: string,
  port: number,
  path: string,
  username?: string,
  password?: string,
): string {
  const auth =
    username !== undefined ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? "")}@` : "";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `rtsp://${auth}${host}:${port}${normalizedPath}`;
}

function parseRtspEndpoint(rtspUrl: string): { host: string; port: number } {
  const match = rtspUrl.match(/^rtsp:\/\/(?:[^@]+@)?([^:/]+)(?::(\d+))?/i);
  const host = match?.[1] ?? "unknown";
  const port = Number(match?.[2] ?? 554);
  return { host, port };
}

async function resolveStreamUri(
  xaddr: string,
  username: string,
  password: string,
): Promise<string | null> {
  const device = new onvif.OnvifDevice({
    xaddr,
    user: username,
    pass: password,
  });

  await withTimeout(device.init(), ONVIF_INIT_TIMEOUT_MS, "onvif device.init");
  const profiles = device.getProfileList() as OnvifProfile[];
  for (const profile of profiles) {
    const uri = profile.stream?.rtsp;
    if (typeof uri === "string" && uri.length > 0) {
      return uri;
    }
  }
  return null;
}

async function probeDeviceCredentials(
  xaddr: string,
): Promise<{ rtspUrl: string; username: string; password: string } | null> {
  for (const cred of DEFAULT_CREDENTIALS) {
    try {
      const rtspUrl = await resolveStreamUri(xaddr, cred.username, cred.password);
      if (rtspUrl) {
        return { rtspUrl, username: cred.username, password: cred.password };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function discoverOnvifCameras(): Promise<DiscoveredCamera[]> {
  try {
    const devices = (await withTimeout(
      onvif.startProbe(),
      ONVIF_PROBE_TIMEOUT_MS,
      "onvif.startProbe",
    )) as ProbeDevice[];
    const cameras: DiscoveredCamera[] = [];
    const seen = new Set<string>();

    for (const device of devices) {
      const xaddr = device.xaddrs?.[0];
      if (!xaddr) continue;

      const resolved = await probeDeviceCredentials(xaddr);
      if (!resolved) continue;

      const { host, port } = parseRtspEndpoint(resolved.rtspUrl);
      if (seen.has(host)) continue;
      seen.add(host);

      cameras.push({
        id: cameraId(host, port),
        name: device.name || device.hardware || `Camera ${host.split(".").pop()}`,
        host,
        port,
        rtspUrl: resolved.rtspUrl,
        manufacturer: device.hardware,
        source: "onvif",
      });
    }

    return cameras;
  } catch {
    return [];
  }
}

export function cameraFromPortScan(host: string, rtspPort: number): DiscoveredCamera {
  return {
    id: cameraId(host, rtspPort),
    name: `Camera ${host.split(".").pop()}`,
    host,
    port: rtspPort,
    rtspUrl: buildRtspUrl(host, rtspPort, "/stream1"),
    source: "port-scan",
  };
}
