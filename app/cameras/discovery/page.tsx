"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 310_000;

interface DiscoveredCamera {
  ip: string;
  port: number;
  rtsp_route: string | null;
  username: string | null;
  password: string | null;
  is_accessible: boolean;
}

interface DiscoveryResult {
  status: "scanning" | "completed" | "error";
  scan_duration_seconds: number;
  cameras: DiscoveredCamera[];
  error: string | null;
}

type CameraStatus = "accessible" | "locked" | "auth_required";

type RawDiscoveredCamera = Partial<DiscoveredCamera> & {
  host?: string;
  path?: string;
  rtsp_url?: string;
};

type RawDiscoveryResult = Omit<Partial<DiscoveryResult>, "cameras" | "status"> & {
  status?: DiscoveryResult["status"] | "running" | "failed" | "timeout";
  cameras?: RawDiscoveredCamera[];
  discovered_cameras?: RawDiscoveredCamera[];
  errors?: Array<{ message?: string; detail?: string }>;
};

interface SubnetResponse {
  subnet: string;
}

function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.8s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

function ipSortValue(ip: string) {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return Number.MAX_SAFE_INTEGER;
  }

  return parts.reduce((value, part) => value * 256 + part, 0);
}

function cameraStatus(camera: DiscoveredCamera): CameraStatus {
  if (camera.is_accessible) return "accessible";
  return camera.username || camera.password ? "auth_required" : "locked";
}

function statusStyles(status: CameraStatus) {
  if (status === "accessible") {
    return { background: "var(--green)", color: "#000" };
  }

  if (status === "auth_required") {
    return { background: "var(--yellow)", color: "#000" };
  }

  return { background: "var(--red)", color: "#fff" };
}

async function parseApiError(response: Response) {
  try {
    const body = (await response.json()) as { error?: string; message?: string; detail?: string };
    return body.error ?? body.message ?? body.detail ?? `Request failed with status ${response.status}`;
  } catch {
    return `Request failed with status ${response.status}`;
  }
}

async function startDiscoveryScan(subnet: string) {
  const response = await fetch("/api/cameras/discovery/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targets: [subnet] }),
  });

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }
}

async function fetchDiscoverySubnet(): Promise<string> {
  const response = await fetch("/api/cameras/discovery/subnet", { cache: "no-store" });

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  const body = (await response.json()) as SubnetResponse;
  return body.subnet;
}

function isRunningScanStatus(status: RawDiscoveryResult["status"] | undefined): boolean {
  return status === "running";
}

async function fetchDiscoveryResults(): Promise<{ raw: RawDiscoveryResult; result: DiscoveryResult }> {
  const response = await fetch("/api/cameras/discovery/results", { cache: "no-store" });

  if (!response.ok) {
    throw new Error(await parseApiError(response));
  }

  const raw = (await response.json()) as RawDiscoveryResult;
  return { raw, result: normalizeDiscoveryResult(raw) };
}

function normalizeDiscoveryResult(raw: RawDiscoveryResult): DiscoveryResult {
  const status =
    raw.status === "running"
      ? "scanning"
      : raw.status === "failed" || raw.status === "timeout"
        ? "error"
        : raw.status ?? "completed";

  const cameras = raw.cameras ?? raw.discovered_cameras ?? [];
  const firstError = raw.error ?? raw.errors?.[0]?.message ?? raw.errors?.[0]?.detail ?? null;

  return {
    status,
    scan_duration_seconds: raw.scan_duration_seconds ?? 0,
    cameras: cameras.map((camera) => ({
      ip: camera.ip ?? camera.host ?? "",
      port: camera.port ?? 554,
      rtsp_route: camera.rtsp_route ?? camera.path ?? camera.rtsp_url ?? null,
      username: camera.username ?? null,
      password: camera.password ?? null,
      is_accessible: camera.is_accessible ?? Boolean(camera.ip || camera.host || camera.rtsp_url),
    })),
    error: status === "error" ? firstError : null,
  };
}

export default function CameraDiscoveryPage() {
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subnet, setSubnet] = useState<string | null>(null);

  const isScanning = result?.status === "scanning";
  const scanError = error ?? result?.error ?? null;

  const sortedCameras = useMemo(() => {
    return [...(result?.cameras ?? [])].sort((a, b) => {
      const ipCompare = ipSortValue(a.ip) - ipSortValue(b.ip);
      return ipCompare || a.port - b.port;
    });
  }, [result?.cameras]);

  const loadResults = useCallback(async () => {
    const { result: nextResult } = await fetchDiscoveryResults();
    setResult(nextResult);
    setError(nextResult.error);
    return nextResult;
  }, []);

  const handleStartScan = useCallback(async () => {
    if (!subnet) {
      setError("Detecting local subnet. Try again in a moment.");
      return;
    }

    setIsStarting(true);
    setError(null);
    setResult({
      status: "scanning",
      scan_duration_seconds: 0,
      cameras: [],
      error: null,
    });

    try {
      await startDiscoveryScan(subnet);
      await loadResults();
    } catch (err) {
      setResult((current) => ({
        status: "error",
        scan_duration_seconds: current?.scan_duration_seconds ?? 0,
        cameras: current?.cameras ?? [],
        error: err instanceof Error ? err.message : "Failed to start camera discovery scan.",
      }));
      setError(err instanceof Error ? err.message : "Failed to start camera discovery scan.");
    } finally {
      setIsStarting(false);
    }
  }, [loadResults, subnet]);

  useEffect(() => {
    fetchDiscoverySubnet()
      .then((detectedSubnet) => {
        setSubnet(detectedSubnet);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to detect local network subnet.");
      });
  }, []);

  useEffect(() => {
    if (!isScanning) return;

    let active = true;
    let intervalId: number | undefined;
    const pollDeadline = Date.now() + MAX_POLL_MS;

    const stopPolling = () => {
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
        intervalId = undefined;
      }
    };

    const pollOnce = async () => {
      if (!active) return;

      try {
        const { raw, result: nextResult } = await fetchDiscoveryResults();
        if (!active) return;

        setResult(nextResult);
        setError(nextResult.error);

        if (!isRunningScanStatus(raw.status)) {
          stopPolling();
          return;
        }

        if (Date.now() >= pollDeadline) {
          const timeoutMessage = "Scan timed out waiting for results.";
          setResult((current) => ({
            status: "error",
            scan_duration_seconds: current?.scan_duration_seconds ?? 0,
            cameras: nextResult.cameras.length > 0 ? nextResult.cameras : current?.cameras ?? [],
            error: timeoutMessage,
          }));
          setError(timeoutMessage);
          stopPolling();
        }
      } catch (err) {
        if (!active) return;

        const message =
          err instanceof Error ? err.message : "Failed to load camera discovery results.";
        setResult((current) => ({
          status: "error",
          scan_duration_seconds: current?.scan_duration_seconds ?? 0,
          cameras: current?.cameras ?? [],
          error: message,
        }));
        setError(message);
        stopPolling();
      }
    };

    intervalId = window.setInterval(() => {
      void pollOnce();
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      stopPolling();
    };
  }, [isScanning]);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--text)",
        padding: 16,
      }}
    >
      <section
        style={{
          minHeight: "calc(100vh - 32px)",
          background: "var(--panel)",
          border: "1px solid var(--border-soft)",
          borderRadius: 18,
          padding: 22,
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 22,
          }}
        >
          <div>
            <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 6 }}>Camera Discovery</div>
            <h1 style={{ fontSize: 24, lineHeight: 1.2, fontWeight: 700 }}>Network camera scan</h1>
            <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 8 }}>
              Scan {subnet ?? "your local network"} for RTSP cameras and connection status.
            </p>
          </div>

          <button
            type="button"
            onClick={handleStartScan}
            disabled={isStarting || isScanning || !subnet}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              minWidth: 142,
              height: 42,
              border: "1px solid var(--border)",
              borderRadius: 10,
              background: isStarting || isScanning || !subnet ? "var(--elevated)" : "var(--brand)",
              color: "#fff",
              cursor: isStarting || isScanning || !subnet ? "not-allowed" : "pointer",
              fontSize: 13,
              fontWeight: 700,
              opacity: isStarting || isScanning || !subnet ? 0.7 : 1,
            }}
          >
            {isStarting || isScanning || !subnet ? <Spinner /> : null}
            Scan cameras
          </button>
        </header>

        {scanError ? (
          <div
            role="alert"
            style={{
              marginBottom: 16,
              padding: "12px 14px",
              border: "1px solid rgba(239,68,68,0.45)",
              borderRadius: 10,
              background: "rgba(239,68,68,0.1)",
              color: "var(--red)",
              fontSize: 13,
            }}
          >
            {scanError}
          </div>
        ) : null}

        <div
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          {sortedCameras.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              {isScanning ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "12px 16px",
                    borderBottom: "1px solid var(--border)",
                    color: "var(--muted)",
                    fontSize: 13,
                  }}
                >
                  <Spinner size={16} />
                  Scanning network... showing cameras as they are discovered.
                </div>
              ) : null}
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
                <thead>
                  <tr style={{ color: "var(--faint)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                    <th style={{ padding: "13px 16px", textAlign: "left", borderBottom: "1px solid var(--border)" }}>IP</th>
                    <th style={{ padding: "13px 16px", textAlign: "left", borderBottom: "1px solid var(--border)" }}>Port</th>
                    <th style={{ padding: "13px 16px", textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                      Protocol
                    </th>
                    <th style={{ padding: "13px 16px", textAlign: "left", borderBottom: "1px solid var(--border)" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedCameras.map((camera) => {
                    const status = cameraStatus(camera);
                    return (
                      <tr key={`${camera.ip}:${camera.port}:${camera.rtsp_route ?? ""}`}>
                        <td style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-soft)", fontWeight: 600 }}>
                          {camera.ip}
                        </td>
                        <td style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-soft)", color: "var(--muted)" }}>
                          {camera.port}
                        </td>
                        <td style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-soft)", color: "var(--muted)" }}>
                          RTSP
                        </td>
                        <td style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-soft)" }}>
                          <span
                            style={{
                              display: "inline-block",
                              borderRadius: 4,
                              padding: "3px 8px",
                              fontSize: 10,
                              fontWeight: 700,
                              letterSpacing: "0.04em",
                              textTransform: "uppercase",
                              ...statusStyles(status),
                            }}
                          >
                            {status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : isScanning ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                minHeight: 240,
                color: "var(--muted)",
                fontSize: 14,
              }}
            >
              <Spinner size={22} />
              Scanning network...
            </div>
          ) : sortedCameras.length === 0 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 240,
                padding: 24,
                color: "var(--muted)",
                fontSize: 14,
                textAlign: "center",
              }}
            >
              No cameras found. Start a scan to discover cameras on your network.
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
