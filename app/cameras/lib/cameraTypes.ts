export interface CameraView {
  id: string;
  name?: string;
  host?: string;
  floor: number;
  zone: string;
  location?: string;
  description?: string;
  stream_url?: string;
  enabled?: boolean;
  online: boolean;
  status?: "live" | "unknown" | "stream_unavailable" | "disabled";
  inference_enabled?: boolean;
  model_path?: string;
  model_error?: string | null;
}
