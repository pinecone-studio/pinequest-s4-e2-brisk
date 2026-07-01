export function createCameraLogger(cameraId: string) {
  const prefix = `[${cameraId}]`;

  return {
    info(message: string, ...args: unknown[]): void {
      console.log(`${prefix} ${message}`, ...args);
    },
    warn(message: string, ...args: unknown[]): void {
      console.warn(`${prefix} ${message}`, ...args);
    },
    error(message: string, ...args: unknown[]): void {
      console.error(`${prefix} ${message}`, ...args);
    },
  };
}

export type CameraLogger = ReturnType<typeof createCameraLogger>;
