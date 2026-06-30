import { RTSP_PORTS, SCAN_PORTS } from "../config";
import type { DiscoveredCamera } from "../types";
import { cameraFromPortScan, discoverOnvifCameras } from "./onvifDiscovery";
import { scanSubnetPorts } from "./portScanner";
import { probeRtspUrl } from "./rtspProber";
import { getAllLocalSubnets, hostsFromCidr } from "./subnet";

function resolveSubnets(subnet?: string): string[] {
  if (!subnet) {
    return getAllLocalSubnets();
  }
  return subnet.split(",").map((part) => part.trim()).filter(Boolean);
}

export async function discoverCameras(
  subnet?: string,
  onProgress?: (cameras: DiscoveredCamera[]) => void,
): Promise<DiscoveredCamera[]> {
  const subnets = resolveSubnets(subnet);
  const byHost = new Map<string, DiscoveredCamera>();

  const onvifCameras = await discoverOnvifCameras();
  for (const camera of onvifCameras) {
    byHost.set(camera.host, camera);
  }
  onProgress?.(Array.from(byHost.values()));

  for (const targetSubnet of subnets) {
    const hosts = hostsFromCidr(targetSubnet);
    await scanSubnetPorts(hosts, SCAN_PORTS, async (host, openPorts) => {
      const rtspPort = RTSP_PORTS.find((port) => openPorts.includes(port));
      if (!rtspPort || byHost.has(host)) return;
      const rtspUrl = await probeRtspUrl(host, rtspPort);
      const camera = {
        ...cameraFromPortScan(host, rtspPort),
        rtspUrl,
      };
      byHost.set(host, camera);
      onProgress?.(Array.from(byHost.values()));
    });
  }

  return Array.from(byHost.values());
}
