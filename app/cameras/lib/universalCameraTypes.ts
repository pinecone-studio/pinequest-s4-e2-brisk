declare global {
  interface Window {
    JSMpeg?: {
      Player: new (
        url: string,
        options: {
          canvas: HTMLCanvasElement;
          autoplay?: boolean;
          audio?: boolean;
          pauseWhenHidden?: boolean;
          disableGl?: boolean;
          onSourceEstablished?: () => void;
          onSourceCompleted?: () => void;
        },
      ) => {
        destroy: () => void;
        play?: () => void;
        stop?: () => void;
      };
    };
  }
}

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
