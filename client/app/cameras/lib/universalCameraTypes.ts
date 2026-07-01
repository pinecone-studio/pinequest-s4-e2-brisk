export type UniversalCamera = {
  id: string;
  name: string;
  host: string;
  port: number;
  rtspUrl: string;
  manufacturer?: string;
  model?: string;
  source: "onvif" | "port-scan";
};

export type UniversalScanStatus = "idle" | "running" | "completed" | "failed";

export type UniversalScanState = {
  status: UniversalScanStatus;
  cameras: UniversalCamera[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type TileConnectionState = "idle" | "loading" | "live" | "error" | "reconnecting";
