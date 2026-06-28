"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import CameraGrid from "./cameras/components/CameraGrid";
import CameraCredentialsModal, {
  type CameraCredentials,
} from "./cameras/components/CameraCredentialsModal";
import CredentialsPanel, { type GlobalCredentials } from "./cameras/components/CredentialsPanel";
import {
  fetchDiscoveryResults,
  fetchDiscoverySubnet,
  startDiscoveryScan,
  type DiscoveryStatus,
} from "./cameras/lib/cameraApi";
import {
  applyCredentialsToCamera,
  getPasswordListForCamera,
  loadGlobalCredentials,
  saveGlobalCredentials,
} from "./cameras/lib/applyCameraCredentials";
import type { CameraView } from "./cameras/lib/cameraTypes";
import { loadModels, activeBackend } from "@/lib/inference";
import type { EvidenceEvent } from "@/lib/evidence";
import ModelStatusBadge from "@/components/ModelStatusBadge";
import EventsPanel from "@/components/EventsPanel";

const WebcamCanvas = dynamic(() => import("@/components/WebcamCanvas"), { ssr: false });

const MAX_EVENTS = 50;
const DISCOVERY_POLL_INTERVAL_MS = 2000;
const MAX_DISCOVERY_POLL_MS = 310_000;
type LayoutCols = 1 | 2 | 3;

const TERMINAL_DISCOVERY_STATUSES: DiscoveryStatus[] = ["completed", "failed", "timeout"];

function groupCameras(cameras: CameraView[]) {
  const groups = new Map<string, CameraView[]>();
  for (const camera of cameras) {
    const raw = camera.zone && camera.zone !== "unknown" ? camera.zone : "All Cameras";
    const key = raw.charAt(0).toUpperCase() + raw.slice(1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(camera);
  }
  return Array.from(groups.entries());
}

function cameraLabel(camera: CameraView) {
  return camera.name || camera.id;
}

export default function HomePage() {
  // — webcam AI (event source) —
  const [modelState, setModelState] = useState<"loading" | "ready" | "error">("loading");
  const [paused, setPaused] = useState(false);
  const [events, setEvents] = useState<EvidenceEvent[]>([]);

  const handleEvent = useCallback((event: EvidenceEvent) => {
    setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
  }, []);

  useEffect(() => {
    loadModels()
      .then(() => {
        console.info("[inference] backend:", activeBackend);
        setModelState("ready");
      })
      .catch((err) => {
        console.error("Model load failed:", err);
        setModelState("error");
      });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setPaused((p) => !p);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // — cameras / live monitoring state —
  const [cameras, setCameras] = useState<CameraView[]>([]);
  const [cameraLoadError, setCameraLoadError] = useState<string | null>(null);
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [columns, setColumns] = useState<LayoutCols>(2);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [globalCredentials, setGlobalCredentials] = useState<GlobalCredentials>({
    username: "admin",
    passwords: "",
  });
  const [cameraCredentials, setCameraCredentials] = useState<Record<string, CameraCredentials>>({});
  const [passwordAttempts, setPasswordAttempts] = useState<Record<string, number>>({});
  const [retryKeys, setRetryKeys] = useState<Record<string, number>>({});
  const [credentialsModalCameraId, setCredentialsModalCameraId] = useState<string | null>(null);
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus>("completed");
  const [isStartingScan, setIsStartingScan] = useState(false);
  const credentialsModalOpen = credentialsModalCameraId !== null;
  const credentialsModalOpenRef = useRef(false);
  credentialsModalOpenRef.current = credentialsModalOpen;

  const isScanning = discoveryStatus === "running";
  const showScanOverlay = isScanning || isStartingScan;

  useEffect(() => {
    setGlobalCredentials(loadGlobalCredentials());
  }, []);

  function bumpRetryKeys(cameraIds?: string[]) {
    setRetryKeys((current) => {
      const next = { ...current };
      const ids = cameraIds ?? cameras.map((camera) => camera.id);
      for (const id of ids) {
        next[id] = (next[id] ?? 0) + 1;
      }
      return next;
    });
  }

  function resetStreamAttempts(cameraIds?: string[]) {
    setPasswordAttempts((current) => {
      const next = { ...current };
      const ids = cameraIds ?? cameras.map((camera) => camera.id);
      for (const id of ids) {
        next[id] = 0;
      }
      return next;
    });
    bumpRetryKeys(cameraIds);
  }

  function handleApplyGlobalCredentials() {
    saveGlobalCredentials(globalCredentials);
    setCameraCredentials({});
    resetStreamAttempts();
  }

  function handleStreamFailed(cameraId: string) {
    const passwords = getPasswordListForCamera(cameraId, globalCredentials, cameraCredentials);
    const currentAttempt = passwordAttempts[cameraId] ?? 0;

    if (currentAttempt + 1 < passwords.length) {
      setPasswordAttempts((current) => ({
        ...current,
        [cameraId]: currentAttempt + 1,
      }));
      bumpRetryKeys([cameraId]);
    }
  }

  function handleSaveCameraCredentials(credentials: CameraCredentials) {
    if (!credentialsModalCameraId) return;

    setCameraCredentials((current) => ({
      ...current,
      [credentialsModalCameraId]: credentials,
    }));
    setPasswordAttempts((current) => ({
      ...current,
      [credentialsModalCameraId]: 0,
    }));
    bumpRetryKeys([credentialsModalCameraId]);
    setCredentialsModalCameraId(null);
  }

  const streamedCameras = useMemo(
    () =>
      cameras.map((camera) =>
        applyCredentialsToCamera(
          camera,
          globalCredentials,
          cameraCredentials,
          passwordAttempts,
          retryKeys,
        ),
      ),
    [cameras, globalCredentials, cameraCredentials, passwordAttempts, retryKeys],
  );

  const credentialsModalCamera = useMemo(
    () => cameras.find((camera) => camera.id === credentialsModalCameraId) ?? null,
    [cameras, credentialsModalCameraId],
  );

  const credentialsModalInitial = useMemo(
    () =>
      credentialsModalCameraId
        ? (cameraCredentials[credentialsModalCameraId] ?? {
            username: globalCredentials.username,
            password: "",
          })
        : null,
    [credentialsModalCameraId, cameraCredentials, globalCredentials.username],
  );

  const applyDiscoveryResults = useCallback((cams: CameraView[]) => {
    if (credentialsModalOpenRef.current) return;

    setCameras(cams);
    setCameraLoadError(null);
    setModelWarning(null);
    setSelectedId((current) => {
      if (current && cams.some((camera) => camera.id === current)) {
        return current;
      }
      return cams[0]?.id ?? null;
    });
  }, []);

  const refreshCameraStatus = useCallback(async (): Promise<DiscoveryStatus | null> => {
    if (credentialsModalOpenRef.current) return null;

    try {
      const { cameras: cams, status } = await fetchDiscoveryResults();
      setDiscoveryStatus(status);
      applyDiscoveryResults(cams);
      return status;
    } catch (err) {
      setCameraLoadError(err instanceof Error ? err.message : "Failed to load discovered cameras");
      return null;
    }
  }, [applyDiscoveryResults]);

  const handleScanNetwork = useCallback(async () => {
    if (isScanning || isStartingScan) return;

    setIsStartingScan(true);
    setCameraLoadError(null);
    setDiscoveryStatus("running");
    setCameras([]);
    setSelectedId(null);

    try {
      const subnet = await fetchDiscoverySubnet();
      await startDiscoveryScan(subnet);

      const afterStart = await fetchDiscoveryResults();
      setDiscoveryStatus(afterStart.status);
      applyDiscoveryResults(afterStart.cameras);
    } catch (err) {
      setDiscoveryStatus("failed");
      setCameraLoadError(
        err instanceof Error ? err.message : "Failed to start camera discovery scan",
      );
    } finally {
      setIsStartingScan(false);
    }
  }, [applyDiscoveryResults, isScanning, isStartingScan]);

  // Load last scan results on mount (no auto-scan).
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const initial = await fetchDiscoveryResults();
        if (cancelled) return;

        setDiscoveryStatus(initial.status);
        applyDiscoveryResults(initial.cameras);
      } catch (err) {
        if (cancelled) return;
        setCameraLoadError(
          err instanceof Error ? err.message : "Failed to load discovered cameras",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyDiscoveryResults]);

  // Poll for progressive results while scan is running; pause when credentials modal is open.
  useEffect(() => {
    if (credentialsModalOpen) return;

    if (TERMINAL_DISCOVERY_STATUSES.includes(discoveryStatus)) {
      void refreshCameraStatus();
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const pollDeadline = Date.now() + MAX_DISCOVERY_POLL_MS;

    const stopPolling = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const tick = async (): Promise<DiscoveryStatus | null> => {
      if (cancelled || credentialsModalOpenRef.current) return null;
      return refreshCameraStatus();
    };

    void tick();

    timer = setInterval(async () => {
      if (Date.now() >= pollDeadline) {
        setDiscoveryStatus("timeout");
        setCameraLoadError("Scan timed out waiting for results.");
        stopPolling();
        return;
      }

      const nextStatus = await tick();
      if (!nextStatus || TERMINAL_DISCOVERY_STATUSES.includes(nextStatus)) {
        stopPolling();
      }
    }, DISCOVERY_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [credentialsModalOpen, discoveryStatus, refreshCameraStatus]);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const filteredCameras = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return streamedCameras;
    return streamedCameras.filter(
      (c) =>
        cameraLabel(c).toLowerCase().includes(q) ||
        (c.host ?? "").toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q),
    );
  }, [streamedCameras, search]);

  const groups = useMemo(() => groupCameras(filteredCameras), [filteredCameras]);
  const onlineCount = useMemo(() => cameras.filter((c) => c.online).length, [cameras]);

  const dateLabel = now
    ? now.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : "";
  const timeLabel = now
    ? now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
    : "";

  return (
    <div className="flex h-screen p-4 bg-[#0a0a0a]">
      <div className="flex flex-1 min-w-0 overflow-hidden bg-[#141414] border border-[#1e1e1e] rounded-[18px]">
        {/* ── LIVE MONITORING ── */}
        <div className="flex flex-1 min-w-0 relative overflow-hidden">
          {showScanOverlay ? (
            <div
              className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 p-6 text-center bg-[rgba(8,8,8,0.82)] backdrop-blur-[6px]"
              role="status"
              aria-live="polite"
            >
              <div
                className="w-11 h-11 border-[3px] border-[rgba(255,255,255,0.12)] border-t-[#f0652c] rounded-full animate-[spin_0.85s_linear_infinite]"
                aria-hidden="true"
              />
              <div className="text-[16px] font-semibold text-[#e8e8e8]">Scanning local network for IP cameras…</div>
              <div className="text-[13px] text-[#8a8a8a] max-w-[360px] leading-normal">Please wait while we search your subnet for RTSP devices.</div>
            </div>
          ) : null}

          {/* sidebar: camera list */}
          <aside className="w-[300px] shrink-0 flex flex-col border-r border-[#1e1e1e] px-3 py-[18px] overflow-y-auto max-[1200px]:w-[240px]">
            <div className="flex items-center justify-between px-2 pb-[14px]">
              <span className="text-[15px] font-semibold text-[#e8e8e8]">Aegis</span>
            </div>
            {groups.length === 0 ? (
              <div className="p-2 text-[#5c5c5c] text-[13px]">
                {showScanOverlay
                  ? "Searching for cameras…"
                  : "No cameras found. Click Scan Network to search your local network."}
              </div>
            ) : (
              groups.map(([groupName, groupCams]) => (
                <div key={groupName}>
                  <div className="text-xs font-semibold text-[#5c5c5c] px-2 pt-[14px] pb-1.5">{groupName}</div>
                  {groupCams.map((camera) => {
                    const active = camera.id === selectedId;
                    const dot = camera.enabled === false
                      ? "#5c5c5c"
                      : camera.online ? "#22c55e" : "#eab308";
                    return (
                      <button
                        key={camera.id}
                        className={`flex items-center gap-2.5 w-full px-2 py-[9px] rounded-lg border-none cursor-pointer text-left text-[13.5px] transition-all ${
                          active
                            ? "text-[#f0652c] bg-[rgba(240,101,44,0.14)] font-semibold"
                            : "text-[#8a8a8a] bg-transparent hover:bg-[#1f1f1f] hover:text-[#e8e8e8]"
                        }`}
                        onClick={() => setSelectedId(camera.id)}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M23 7l-7 5 7 5zM1 5h15v14H1z" />
                        </svg>
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                          {cameraLabel(camera)}
                        </span>
                        <span className="ml-auto w-1.5 h-1.5 rounded-full" style={{ background: dot }} />
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </aside>

          {/* main: webcam AI feed + camera grid */}
          <section className="flex-1 min-w-0 flex flex-col overflow-hidden">
            <div className="flex items-center gap-4 px-[22px] py-4">
              <div className="flex-1 max-w-[520px] relative flex items-center">
                <svg className="absolute left-[14px] text-[#5c5c5c] pointer-events-none" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
                </svg>
                <input
                  className="w-full h-[42px] pl-10 pr-3.5 bg-[#1a1a1a] border border-[#272727] rounded-[10px] text-[#e8e8e8] text-[13.5px] outline-none focus:border-[#3a3a3a] placeholder:text-[#5c5c5c]"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search Camera"
                />
              </div>
              <div className="ml-auto flex items-center gap-[14px]">
                <button
                  type="button"
                  className="h-10 px-3.5 rounded-[10px] border border-[#272727] bg-[#1a1a1a] text-[#e8e8e8] cursor-pointer flex items-center gap-2 text-[13px] font-medium whitespace-nowrap transition-all enabled:hover:border-[#f0652c] enabled:hover:text-[#f0652c] disabled:opacity-[0.55] disabled:cursor-not-allowed"
                  onClick={() => void handleScanNetwork()}
                  disabled={showScanOverlay}
                  title="Scan local network for IP cameras"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7h10" />
                    <path d="M4 12h7" />
                    <path d="M4 17h6" />
                    <circle cx="17" cy="15" r="3" />
                    <path d="M19.2 17.2 22 20" />
                  </svg>
                  Scan Network
                </button>
                <CredentialsPanel
                  credentials={globalCredentials}
                  onChange={setGlobalCredentials}
                  onApply={handleApplyGlobalCredentials}
                />
                <div className="flex items-center gap-[7px] text-[12px] text-[#8a8a8a]">
                  <span
                    className="w-2 h-2 rounded-full bg-[#22c55e] shadow-[0_0_6px_#22c55e] animate-[pulse-dot_2s_infinite]"
                    style={showScanOverlay ? { background: "#eab308", boxShadow: "0 0 6px #eab308" } : undefined}
                  />
                  {showScanOverlay
                    ? "Scanning network…"
                    : `${onlineCount}/${cameras.length} online`}
                </div>
                <div className="flex items-center gap-[9px] cursor-pointer">
                  <div className="w-9 h-9 rounded-full bg-[linear-gradient(135deg,#4b5563,#1f2937)] flex items-center justify-center text-white text-[13px] font-semibold">A</div>
                  <span className="text-[13.5px] text-[#e8e8e8] font-medium">Administrator</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a8a8a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </div>
              </div>
            </div>

            <div className="flex items-center px-[22px] pt-1 pb-4">
              <div className="flex items-center gap-2.5 px-3.5 py-2 bg-[#1a1a1a] border border-[#272727] rounded-[10px] text-[13px] text-[#e8e8e8]">
                <svg className="text-[#f0652c]" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
                </svg>
                <span>{dateLabel || "—"}</span>
                <span className="text-[#8a8a8a]">{timeLabel}</span>
              </div>
              <div className="ml-auto flex gap-1 p-1 bg-[#1a1a1a] border border-[#272727] rounded-[10px]">
                {([1, 2, 3] as LayoutCols[]).map((c) => (
                  <button
                    key={c}
                    className={`w-8 h-[30px] rounded-[7px] border-none cursor-pointer flex items-center justify-center ${
                      columns === c ? "bg-[#1f1f1f] text-[#e8e8e8]" : "bg-transparent text-[#5c5c5c]"
                    }`}
                    onClick={() => setColumns(c)}
                    title={`${c} column${c > 1 ? "s" : ""}`}
                  >
                    {c === 1 ? (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="5" width="16" height="14" rx="1.5" /></svg>
                    ) : c === 2 ? (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="8" height="14" rx="1.5" /><rect x="13" y="5" width="8" height="14" rx="1.5" /></svg>
                    ) : (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="8" height="7" rx="1.2" /><rect x="13" y="4" width="8" height="7" rx="1.2" /><rect x="3" y="13" width="8" height="7" rx="1.2" /><rect x="13" y="13" width="8" height="7" rx="1.2" /></svg>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {modelWarning && (
              <div className="mx-[22px] mb-[14px] px-3 py-2.5 border border-[rgba(234,179,8,0.45)] rounded-lg bg-[rgba(234,179,8,0.1)] text-[#eab308] text-[12px]">
                {modelWarning}
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-[22px] pb-[22px]">
              {/* featured: live webcam AI feed (the event source) */}
              <div className="bg-[#1a1a1a] border border-[#272727] rounded-xl flex flex-col overflow-hidden min-w-0 mb-4 min-h-[380px] shadow-[0_0_0_1px_rgba(240,101,44,0.14)]">
                <div className="flex items-center justify-between gap-2.5 px-4 py-[13px] border-b border-[#272727] shrink-0">
                  <span className="inline-flex items-center gap-1.5 text-[10px] font-bold tracking-[0.05em] uppercase text-[#f0652c] bg-[rgba(240,101,44,0.14)] px-2 py-[3px] rounded-[5px]">
                    <span className="w-[7px] h-[7px] rounded-full bg-current" />
                    Webcam AI · Smoking &amp; Litter
                  </span>
                  <div className="flex items-center gap-2.5">
                    <ModelStatusBadge state={modelState} />
                    {modelState === "ready" && (
                      <button
                        className="flex items-center gap-[7px] h-[30px] px-3 rounded-lg border border-[#272727] text-[12px] font-semibold cursor-pointer"
                        onClick={() => setPaused((p) => !p)}
                        title={paused ? "Resume AI (Space)" : "Pause AI (Space)"}
                        style={{
                          background: paused ? "rgba(59,130,246,0.15)" : "#1f1f1f",
                          color: paused ? "#3b82f6" : "#e8e8e8",
                        }}
                      >
                        {paused ? (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                        ) : (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6zM14 5v14h4V5z" /></svg>
                        )}
                        {paused ? "Resume" : "Pause"}
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex-1 relative min-h-[340px] bg-[#0d0d0d] overflow-hidden rounded-b-xl">
                  {modelState === "loading" && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[#8a8a8a] text-[14px] z-10">
                      <div className="w-7 h-7 border-[3px] border-[#272727] border-t-[#3b82f6] rounded-full animate-[spin_0.8s_linear_infinite]" />
                      <span>Loading models&hellip;</span>
                      <span className="text-[11px] text-[#555]">First load may take 10–20s</span>
                    </div>
                  )}
                  {modelState === "error" && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[#ef4444] text-[14px] z-10">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></svg>
                      <span>Failed to load models</span>
                      <span className="text-[12px] text-[#8a8a8a]">Check console for details</span>
                    </div>
                  )}
                  {modelState === "ready" && (
                    <WebcamCanvas onEvent={handleEvent} paused={paused} />
                  )}
                </div>
              </div>

              {/* network cameras */}
              {cameraLoadError ? (
                <div className="flex aspect-video items-center justify-center rounded-[10px] border border-[#272727] bg-[#1a1a1a] text-[#ef4444] text-[13px]">
                  {cameraLoadError}
                </div>
              ) : (
                <CameraGrid
                  cameras={filteredCameras}
                  columns={columns}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onStreamFailed={handleStreamFailed}
                  onCredentialsRequest={setCredentialsModalCameraId}
                />
              )}
            </div>
          </section>

          {/* events sidebar */}
          <aside className="w-[340px] shrink-0 flex flex-col border-l border-[#1e1e1e] px-3.5 py-[18px] min-h-0 max-[1200px]:w-[280px]">
            <div className="flex items-center gap-[9px] px-1 pb-[14px]">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#f0652c" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <span className="text-[15px] font-semibold text-[#e8e8e8]">Events</span>
            </div>
            <EventsPanel events={events} live={modelState === "ready"} />
          </aside>

          {credentialsModalCamera && credentialsModalInitial ? (
            <CameraCredentialsModal
              key={credentialsModalCamera.id}
              camera={credentialsModalCamera}
              initialCredentials={credentialsModalInitial}
              onClose={() => setCredentialsModalCameraId(null)}
              onSave={handleSaveCameraCredentials}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
