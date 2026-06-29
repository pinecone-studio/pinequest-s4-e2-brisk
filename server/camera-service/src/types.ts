export type ScanStatus = "idle" | "running" | "completed" | "failed";

export interface DiscoveredCamera {
  id: string;
  name: string;
  host: string;
  port: number;
  rtspUrl: string;
  manufacturer?: string;
  model?: string;
  source: "onvif" | "port-scan";
}

export interface ScanState {
  status: ScanStatus;
  cameras: DiscoveredCamera[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface CredentialPair {
  username: string;
  password: string;
}
