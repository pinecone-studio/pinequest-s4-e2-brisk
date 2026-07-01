export const SERVICE_PORT = Number(process.env.CAMERA_SERVICE_PORT ?? 3001);

export const SCAN_PORTS = [554, 80, 8000, 888] as const;

export const RTSP_PORTS = [554, 8554, 7447] as const;

export const RTSP_PATH_CANDIDATES = [
  "/stream1",
  "/stream2",
  "/live",
  "/live.sdp",
  "/Streaming/Channels/101",
  "/Streaming/Channels/1",
  "/cam/realmonitor?channel=1&subtype=0",
  "/h264/ch1/main/av_stream",
  "/h264Preview_01_main",
];

export const DEFAULT_CREDENTIALS = [
  { username: "admin", password: "admin" },
  { username: "admin", password: "12345" },
  { username: "admin", password: "" },
  { username: "root", password: "root" },
];

export const PORT_SCAN_CONCURRENCY = 64;

export const PORT_PROBE_TIMEOUT_MS = 1500;

// WS-Discovery listen window. node-onvif's startProbe can hang if it never
// resolves, so we cap it.
export const ONVIF_PROBE_TIMEOUT_MS = 8000;

// Per-device SOAP init (GetCapabilities/GetProfiles). A device that accepts the
// TCP connection but never answers would otherwise hang the whole scan.
export const ONVIF_INIT_TIMEOUT_MS = 4000;
