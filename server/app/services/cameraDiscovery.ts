import { createConnection } from "net";
import os from "os";
import { loadCameraConfig } from "@/app/api/cameras/serverCameraConfig";

export type DiscoveredCamera = {
  id: string;
  name: string;
  host: string;
  port: number;
  rtspUrl: string;
  source: "onvif" | "port-scan" | "config";
  manufacturer?: string;
  model?: string;
};

export type DiscoveryStatus = "idle" | "running" | "completed" | "failed";

export type DiscoveryState = {
  status: DiscoveryStatus;
  cameras: DiscoveredCamera[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

const RTSP_PORT = 554;
const PROBE_TIMEOUT_MS = 400;
const PROBE_CONCURRENCY = 48;

let scanState: DiscoveryState = {
  status: "idle",
  cameras: [],
};

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function subnetFromIp(ip: string): string | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

export function detectLocalSubnets(): string[] {
  const subnets = new Set<string>();
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const subnet = subnetFromIp(entry.address);
      if (subnet) subnets.add(subnet);
    }
  }
  return Array.from(subnets);
}

export function getPrimarySubnet(): string {
  const subnets = detectLocalSubnets();
  return subnets[0] ?? "192.168.1.0/24";
}

function hostsForSubnet(subnet: string): string[] {
  const [base] = subnet.split("/");
  const parts = base.split(".");
  if (parts.length !== 4) return [];
  const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
  return Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`);
}

function parseManualTargets(): string[] {
  const raw = process.env.CAMERA_DISCOVERY_TARGETS?.trim();
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => isPrivateIpv4(value));
}

async function probeRtspHost(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: RTSP_PORT });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function probeHosts(hosts: string[]): Promise<string[]> {
  const matches: string[] = [];
  for (let index = 0; index < hosts.length; index += PROBE_CONCURRENCY) {
    const batch = hosts.slice(index, index + PROBE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (host) => ((await probeRtspHost(host)) ? host : null)),
    );
    for (const host of results) {
      if (host) matches.push(host);
    }
  }
  return matches;
}

function cameraFromHost(host: string, index: number): DiscoveredCamera {
  const id = `discovered_${host.replace(/\./g, "_")}`;
  return {
    id,
    name: `Camera ${host}`,
    host,
    port: RTSP_PORT,
    rtspUrl: `rtsp://${host}:${RTSP_PORT}/`,
    source: "port-scan",
  };
}

async function camerasFromConfig(): Promise<DiscoveredCamera[]> {
  const configured = await loadCameraConfig();
  const discovered: DiscoveredCamera[] = [];

  for (const camera of configured) {
    const host = camera.host?.trim();
    if (!host || !isPrivateIpv4(host)) continue;
    discovered.push({
      id: camera.id,
      name: camera.name ?? camera.id,
      host,
      port: camera.rtsp_port ?? RTSP_PORT,
      rtspUrl: `rtsp://${host}:${camera.rtsp_port ?? RTSP_PORT}${camera.rtsp_path ?? "/"}`,
      source: "config",
    });
  }

  return discovered;
}

function mergeDiscovered(cameras: DiscoveredCamera[]): DiscoveredCamera[] {
  const byHost = new Map<string, DiscoveredCamera>();
  for (const camera of cameras) {
    const existing = byHost.get(camera.host);
    if (!existing || existing.source === "port-scan") {
      byHost.set(camera.host, camera);
    }
  }
  return Array.from(byHost.values());
}

export function getDiscoveryState(): DiscoveryState {
  return scanState;
}

export async function startDiscoveryScan(subnet?: string): Promise<DiscoveryState> {
  if (scanState.status === "running") {
    return scanState;
  }

  const targetSubnet = subnet?.trim() || getPrimarySubnet();
  scanState = {
    status: "running",
    cameras: [],
    startedAt: new Date().toISOString(),
  };

  void (async () => {
    try {
      const manualHosts = parseManualTargets();
      const scannedHosts = manualHosts.length > 0 ? manualHosts : await probeHosts(hostsForSubnet(targetSubnet));
      const scanned = scannedHosts.map((host, index) => cameraFromHost(host, index));
      const configured = await camerasFromConfig();
      scanState = {
        status: "completed",
        cameras: mergeDiscovered([...configured, ...scanned]),
        startedAt: scanState.startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (error) {
      scanState = {
        status: "failed",
        cameras: [],
        error: error instanceof Error ? error.message : "Discovery scan failed",
        startedAt: scanState.startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  })();

  return scanState;
}
