export interface CameraView {
  id: string;
  name?: string;
  host?: string;
  rtsp_port?: number;
  rtsp_path?: string;
  floor: number;
  zone: string;
  location?: string;
  description?: string;
  stream_url?: string;
  enabled?: boolean;
  online: boolean;
  status?: "live" | "online" | "offline" | "unknown" | "stream_unavailable" | "disabled";
  lastSuccessfulConnection?: string;
}
