"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildCameraStreamUrl } from "../lib/cameraApi";
import { useCameraScan } from "../lib/cameraScanStore";
import type { CameraView } from "../lib/cameraTypes";
import type { StreamLoadState } from "./CameraGrid";
import type { EvidenceEvent } from "@/lib/evidence";

const ALERT_FLASH_MS = 5000;

type ViolationLabel = "Cigarette" | "Vape" | "Litter" | "Person";

const VIOLATION_COLORS: Record<ViolationLabel, string> = {
  Cigarette: "#ef4444",
  Vape: "#a855f7",
  Litter: "#f97316",
  Person: "#22c55e",
};

function cameraTitle(camera: CameraView) {
  return camera.name || camera.id;
}

function scanStatusToStreamState(status: string): StreamLoadState {
  if (status === "online") return "online";
  if (status === "unavailable") return "stream_unavailable";
  return "loading";
}

export default function CameraCard({
  camera,
  label,
  streamState,
  selected,
  clock,
  liveStream = false,
  onSelect,
  onStreamSettled,
  onCredentialsRequest,
  aiReady = false,
  gridPaused = false,
  onSnapshotPreview,
}: {
  camera: CameraView;
  label: string;
  streamState: StreamLoadState;
  selected?: boolean;
  clock?: string;
  liveStream?: boolean;
  onSelect?: () => void;
  onStreamSettled: (state: "loading" | "online" | "stream_unavailable") => void;
  onCredentialsRequest?: () => void;
  aiReady?: boolean;
  aiActive?: boolean;
  gridPaused?: boolean;
  onEvent?: (event: EvidenceEvent) => void;
  onSnapshotPreview?: (previewUrl: string | null) => void;
}) {
  const scan = useCameraScan(camera.id);
  const [inView, setInView] = useState(true);
  const [activeAlert, setActiveAlert] = useState<{
    label: ViolationLabel;
    confidence: number;
  } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const onStreamSettledRef = useRef(onStreamSettled);
  const onSnapshotPreviewRef = useRef(onSnapshotPreview);
  const alertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPersonAlertRef = useRef(false);

  const streamUrl = buildCameraStreamUrl(camera);
  const snapshotUrl = scan.snapshotUrl;
  const hasCachedFrame = Boolean(snapshotUrl);
  const isOnline = scan.status === "online" || streamState === "online";
  const isUnavailable = scan.status === "unavailable" || streamState === "stream_unavailable";
  const isDisabled = camera.enabled === false;
  const streamActive = camera.enabled !== false && !isUnavailable;
  const showStream = streamActive;
  const showAi = aiReady && isOnline && hasCachedFrame;
  const analyzing = scan.analyzing;

  const liveActive = liveStream && isOnline && inView && !gridPaused && Boolean(streamUrl);
  const mjpegSrc = `/api/stream/mjpeg?${new URLSearchParams({
    cameraId: camera.id,
    streamUrl,
  }).toString()}`;

  const dotColor = isDisabled
    ? "#5c5c5c"
    : isUnavailable
      ? "#ef4444"
      : isOnline
        ? scan.hasPerson
          ? "#22c55e"
          : showAi
            ? "#f0652c"
            : "#22c55e"
        : "#eab308";

  useEffect(() => {
    onStreamSettledRef.current = onStreamSettled;
  }, [onStreamSettled]);

  useEffect(() => {
    onSnapshotPreviewRef.current = onSnapshotPreview;
  }, [onSnapshotPreview]);

  useEffect(() => {
    return () => {
      if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
    };
  }, []);

  const flashAlert = useCallback((violationLabel: ViolationLabel, confidence: number) => {
    setActiveAlert({ label: violationLabel, confidence });
    if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
    alertTimerRef.current = setTimeout(() => setActiveAlert(null), ALERT_FLASH_MS);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setInView(entry.isIntersecting);
      },
      { root: null, rootMargin: "120px 0px", threshold: 0 },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [camera.id]);

  useEffect(() => {
    onStreamSettledRef.current(scanStatusToStreamState(scan.status));
  }, [scan.status]);

  useEffect(() => {
    onSnapshotPreviewRef.current?.(snapshotUrl);
  }, [snapshotUrl]);

  useEffect(() => {
    if (scan.hasPerson && !lastPersonAlertRef.current) {
      flashAlert("Person", 1);
    }
    lastPersonAlertRef.current = scan.hasPerson;
  }, [flashAlert, scan.hasPerson]);

  const handleUnavailableClick = () => {
    if (isUnavailable && onCredentialsRequest) {
      onCredentialsRequest();
      return;
    }
    onSelect?.();
  };

  const alertColor = activeAlert ? VIOLATION_COLORS[activeAlert.label] : "#f0652c";

  return (
    <article
      ref={containerRef}
      className={`relative aspect-video w-full overflow-hidden rounded-[10px] bg-black transition-shadow duration-300 ${
        onSelect || onCredentialsRequest ? "cursor-pointer" : "cursor-default"
      } ${
        activeAlert
          ? "border-2 border-[#ef4444] shadow-[0_0_20px_rgba(239,68,68,0.4)] animate-[alert-pulse_1.2s_ease-in-out_infinite]"
          : selected
            ? "border-2 border-[#f0652c] shadow-[0_0_0_3px_rgba(240,101,44,0.14)]"
            : "border border-[#272727]"
      }`}
      onClick={handleUnavailableClick}
    >
      {showStream ? (
        <>
          {snapshotUrl ? (
            <img
              key={`${camera.id}:${scan.lastScanAt ?? "pending"}`}
              ref={imgRef}
              src={snapshotUrl}
              alt={cameraTitle(camera)}
              className="block h-full w-full object-cover"
            />
          ) : null}
          {liveActive ? (
            <img
              key={mjpegSrc}
              src={mjpegSrc}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 block h-full w-full object-cover"
            />
          ) : null}
          {!hasCachedFrame && scan.status === "loading" ? (
            <div className="absolute inset-0 flex items-center justify-center overflow-hidden bg-[#0d0d0d]">
              <div className="absolute inset-0 bg-[linear-gradient(110deg,#0d0d0d_0%,#181818_42%,#0d0d0d_78%)] opacity-80 animate-pulse" />
              <span className="relative text-[#8a8a8a] text-[12px] tracking-[0.08em]">
                LOADING
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-[#8a8a8a] text-[12px] tracking-[0.08em] bg-[#0d0d0d]">
          <span>{isDisabled ? "DISABLED" : isUnavailable ? "STREAM UNAVAILABLE" : "LOADING"}</span>
          {isUnavailable && onCredentialsRequest ? (
            <span className="text-[10px] tracking-[0.04em] text-[#5c5c5c]">
              Click to enter credentials
            </span>
          ) : null}
        </div>
      )}

      {showAi && analyzing ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#f0652c] to-transparent animate-[scan-line_2s_linear_infinite]"
          aria-hidden
        />
      ) : null}

      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_top,rgba(0,0,0,0.55)_0%,rgba(0,0,0,0)_34%)]" />

      <div className="pointer-events-none absolute left-2.5 top-2.5 flex items-center gap-1.5">
        {isOnline ? (
          <span className="flex items-center gap-1 rounded bg-[rgba(0,0,0,0.55)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-white backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444] animate-[live-blink_1.4s_ease-in-out_infinite]" />
            Live
          </span>
        ) : null}
        {isOnline && clock ? (
          <span className="rounded bg-[rgba(0,0,0,0.45)] px-1.5 py-0.5 font-mono text-[9px] text-[#d4d4d4] backdrop-blur-sm">
            {clock}
          </span>
        ) : null}
      </div>

      {showAi ? (
        <div className="pointer-events-none absolute right-2.5 top-2.5">
          <span
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] backdrop-blur-sm ${
              analyzing
                ? "bg-[rgba(240,101,44,0.25)] text-[#ffb089]"
                : scan.hasPerson
                  ? "bg-[rgba(34,197,94,0.2)] text-[#86efac]"
                  : "bg-[rgba(240,101,44,0.15)] text-[#f0652c]"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                scan.hasPerson ? "bg-[#22c55e]" : "bg-[#f0652c]"
              } ${analyzing ? "animate-[pulse-dot_0.8s_ease-in-out_infinite]" : ""}`}
            />
            {analyzing ? "Analyzing" : scan.hasPerson ? "Person" : "AI"}
          </span>
        </div>
      ) : null}

      {activeAlert ? (
        <div
          className="pointer-events-none absolute inset-x-2.5 top-1/2 -translate-y-1/2 rounded-lg border px-2.5 py-1.5 backdrop-blur-md"
          style={{ borderColor: `${alertColor}88`, background: `${alertColor}22` }}
        >
          <div
            className="text-center text-[11px] font-bold uppercase tracking-[0.08em]"
            style={{ color: alertColor }}
          >
            {activeAlert.label} — {Math.round(activeAlert.confidence * 100)}%
          </div>
        </div>
      ) : null}

      <div className="absolute left-3 bottom-2.5 flex items-center gap-[7px]">
        <span
          className="w-[7px] h-[7px] rounded-full shrink-0"
          style={{
            background: dotColor,
            boxShadow: isOnline ? `0 0 6px ${dotColor}` : "none",
          }}
        />
        <span className="text-[12px] font-semibold text-white tracking-[0.02em] [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
          {label}
        </span>
      </div>

      <button
        type="button"
        title="Enter camera credentials"
        onClick={(event) => {
          event.stopPropagation();
          onCredentialsRequest?.();
        }}
        className="absolute right-2.5 bottom-2 w-6 h-6 flex items-center justify-center border-none bg-transparent text-[rgba(255,255,255,0.75)] cursor-pointer"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </button>
    </article>
  );
}
