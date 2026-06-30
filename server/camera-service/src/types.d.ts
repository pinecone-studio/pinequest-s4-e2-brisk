declare module "node-onvif" {
  interface ProbeDevice {
    urn: string;
    name: string;
    hardware: string;
    xaddrs: string[];
  }

  interface OnvifProfile {
    token: string;
    stream?: {
      rtsp?: string;
      http?: string;
      udp?: string;
    };
  }

  class OnvifDevice {
    constructor(params: { xaddr?: string; address?: string; user?: string; pass?: string });
    init(): Promise<unknown>;
    getProfileList(): OnvifProfile[];
  }

  const onvif: {
    OnvifDevice: typeof OnvifDevice;
    startProbe(): Promise<ProbeDevice[]>;
  };

  export default onvif;
}

declare module "rtsp-relay" {
  import type { Application, Request } from "express";

  export default function rtspRelay(app: Application): {
    proxy: (options: {
      url: string;
      transport?: string;
      verbose?: boolean;
    }) => (ws: unknown, req: Request) => void;
    scriptUrl: string;
  };
}
