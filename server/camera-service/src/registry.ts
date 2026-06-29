import type { DiscoveredCamera } from "./types";

const cameras = new Map<string, DiscoveredCamera>();

export function upsertCameras(entries: DiscoveredCamera[]): DiscoveredCamera[] {
  for (const camera of entries) {
    cameras.set(camera.id, camera);
  }
  return listCameras();
}

export function listCameras(): DiscoveredCamera[] {
  return Array.from(cameras.values());
}

export function getCamera(id: string): DiscoveredCamera | undefined {
  return cameras.get(id);
}
