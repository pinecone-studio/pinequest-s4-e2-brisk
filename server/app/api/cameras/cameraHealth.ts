export type CameraHealthStatus = "online" | "offline" | "unknown";

export interface CameraHealth {
  status: CameraHealthStatus;
  lastSuccessfulConnection?: string;
}

const cameraHealth = new Map<string, CameraHealth>();

export function getCameraHealth(cameraId: string): CameraHealth {
  return cameraHealth.get(cameraId) ?? { status: "unknown" };
}

export function markCameraOnline(cameraId: string): CameraHealth {
  const health = {
    status: "online" as const,
    lastSuccessfulConnection: new Date().toISOString(),
  };
  cameraHealth.set(cameraId, health);
  console.info(`Camera health: ${cameraId} -> online`);
  return health;
}

export function markCameraOffline(cameraId: string): CameraHealth {
  const previous = cameraHealth.get(cameraId);
  const health = {
    status: "offline" as const,
    lastSuccessfulConnection: previous?.lastSuccessfulConnection,
  };
  cameraHealth.set(cameraId, health);
  console.info(`Camera health: ${cameraId} -> offline`);
  return health;
}
