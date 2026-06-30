// Minimal type declarations for `node-onvif`, which ships no types and has no
// @types package. Covers only the surface used in src/discovery/onvifDiscovery.ts:
// the default export's `OnvifDevice` class and `startProbe()`. Result shapes are
// returned as `unknown[]` since callers narrow them with their own `as` casts.

declare module "node-onvif" {
  export interface OnvifDeviceOptions {
    xaddr: string;
    user?: string;
    pass?: string;
  }

  export class OnvifDevice {
    constructor(options: OnvifDeviceOptions);
    init(): Promise<unknown>;
    getProfileList(): unknown[];
  }

  export function startProbe(): Promise<unknown[]>;

  const onvif: {
    OnvifDevice: typeof OnvifDevice;
    startProbe: typeof startProbe;
  };

  export default onvif;
}
