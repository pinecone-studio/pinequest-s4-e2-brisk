"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchUniversalScanResults,
  fetchUniversalSubnet,
  startUniversalScan,
} from "../../lib/universalCameraApi";
import type { UniversalCamera, UniversalScanStatus } from "../../lib/universalCameraTypes";
import CameraGrid from "./CameraGrid";

const POLL_MS = 2000;

export default function UniversalCameraDashboard() {
  const [cameras, setCameras] = useState<UniversalCamera[]>([]);
  const [status, setStatus] = useState<UniversalScanStatus>("idle");
  const [subnet, setSubnet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const mountedRef = useRef(true);

  const applyResults = useCallback((nextCameras: UniversalCamera[], nextStatus: UniversalScanStatus) => {
    setCameras(nextCameras);
    setStatus(nextStatus);
  }, []);

  const refresh = useCallback(async () => {
    const results = await fetchUniversalScanResults();
    if (!mountedRef.current) return results.status;
    applyResults(results.cameras, results.status);
    if (results.error) {
      setError(results.error);
    }
    return results.status;
  }, [applyResults]);

  const runScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const detectedSubnet = subnet ?? (await fetchUniversalSubnet());
      if (!mountedRef.current) return;
      setSubnet(detectedSubnet);
      const initial = await startUniversalScan(detectedSubnet);
      if (!mountedRef.current) return;
      applyResults(initial.cameras, initial.status);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Scan failed");
      setStatus("failed");
    } finally {
      if (mountedRef.current) {
        setScanning(false);
      }
    }
  }, [applyResults, subnet]);

  useEffect(() => {
    mountedRef.current = true;

    void (async () => {
      try {
        const detectedSubnet = await fetchUniversalSubnet();
        if (!mountedRef.current) return;
        setSubnet(detectedSubnet);
        const results = await fetchUniversalScanResults();
        if (!mountedRef.current) return;
        applyResults(results.cameras, results.status);
        if (results.cameras.length === 0 && results.status !== "running") {
          await startUniversalScan(detectedSubnet);
          if (!mountedRef.current) return;
          await refresh();
        }
      } catch (err) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to initialize discovery");
      }
    })();

    return () => {
      mountedRef.current = false;
    };
  }, [applyResults, refresh]);

  useEffect(() => {
    if (status !== "running") return undefined;

    const timer = setInterval(() => {
      void refresh().then((nextStatus) => {
        if (nextStatus === "completed" || nextStatus === "failed") {
          clearInterval(timer);
        }
      });
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [refresh, status]);

  const isBusy = scanning || status === "running";

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Universal Cameras</h1>
          <p className="mt-1 text-sm text-zinc-400">
            ONVIF and RTSP discovery with WebSocket live preview
            {subnet ? ` · ${subnet}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void runScan()}
          disabled={isBusy}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isBusy ? "Scanning…" : "Scan Network"}
        </button>
      </header>

      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
          <p className="mt-1 text-xs text-red-300/80">
            Ensure the camera service is running: npm run dev:camera-service
          </p>
        </div>
      ) : null}

      <CameraGrid cameras={cameras} />
    </div>
  );
}
