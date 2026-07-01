"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildCameraStreamUrl } from "../lib/cameraApi";
import type { CameraView } from "../lib/cameraTypes";
import { subscribeToSnapshots } from "../lib/snapshotScheduler";
import type { StreamLoadState } from "./CameraGrid";
import type { Detection } from "@/lib/detection";
import type { EvidenceEvent } from "@/lib/evidence";
import {
  EVIDENCE_COOLDOWN_MS,
  FRAME_HISTORY_MS,
  GEMINI_BURST_FRAMES,
  GEMINI_BURST_INTERVAL_MS,
  GEMINI_COOLDOWN_MS,
  GEMINI_FETCH_TIMEOUT_MS,
  GEMINI_VIOLATION_THRESHOLD,
} from "@/lib/aiConfig";
import {
  captureBurstForGemini,
  captureEvidenceFromSource,
  CIGARETTE_KIND,
  imageToGeminiDataUrl,
  LITTER_KIND,
  VAPE_KIND,
} from "@/lib/cameraAiUtils";
import { detectMotion, type MotionSample } from "@/lib/motionGate";

const STREAM_LOAD_TIMEOUT_MS = 25000;
const ALERT_FLASH_MS = 5000;

type ViolationLabel = "Cigarette" | "Vape" | "Litter";

const VIOLATION_COLORS: Record<ViolationLabel, string> = {
  Cigarette: "#ef4444",
  Vape: "#a855f7",
  Litter: "#f97316",
};

function detectEndpoint(cameraId: string): string {
  return `/api/gemini/${encodeURIComponent(cameraId)}`;
}

function cameraTitle(camera: CameraView) {
  return camera.name || camera.id;
}

export default function CameraCard({
  camera,
  label,
  streamState,
  selected,
  deferSnapshots = false,
  clock,
  onSelect,
  onStreamSettled,
  onCredentialsRequest,
  aiReady = false,
  onEvent,
}: {
  camera: CameraView;
  label: string;
  streamState: StreamLoadState;
  selected?: boolean;
  deferSnapshots?: boolean;
  clock?: string;
  onSelect?: () => void;
  onStreamSettled: (state: "online" | "stream_unavailable") => void;
  onCredentialsRequest?: () => void;
  aiReady?: boolean;
  onEvent?: (event: EvidenceEvent) => void;
}) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [activeAlert, setActiveAlert] = useState<{
    label: ViolationLabel;
    confidence: number;
  } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const onEventRef = useRef(onEvent);
  const onStreamSettledRef = useRef(onStreamSettled);
  const snapshotUrlRef = useRef<string | null>(null);
  const lastCaptureRef = useRef({ cigarette: 0, vape: 0, litter: 0 });
  const motionSampleRef = useRef<MotionSample | null>(null);
  const frameHistoryRef = useRef<{ dataUrl: string; at: number }[]>([]);
  const lastGeminiAtRef = useRef(0);
  const verifyInFlightRef = useRef(false);
  const aiMonitoringRef = useRef(false);
  const alertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const streamUrl = buildCameraStreamUrl(camera);
  const streamActive =
    camera.enabled !== false && (streamState === "loading" || streamState === "online");
  const showStream = streamActive;
  const aiMonitoring = aiReady && streamState === "online" && imageLoaded;
  aiMonitoringRef.current = aiMonitoring;

  const isDisabled = camera.enabled === false;
  const isUnavailable = streamState === "stream_unavailable";
  const isOnline = streamState === "online";

  const dotColor = isDisabled
    ? "#5c5c5c"
    : isUnavailable
      ? "#ef4444"
      : isOnline
        ? aiMonitoring
          ? "#f0652c"
          : "#22c55e"
        : "#eab308";

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    onStreamSettledRef.current = onStreamSettled;
  }, [onStreamSettled]);

  useEffect(() => {
    return () => {
      if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setImageLoaded(false);
    setSnapshotUrl(null);
    setActiveAlert(null);
    if (snapshotUrlRef.current) {
      URL.revokeObjectURL(snapshotUrlRef.current);
      snapshotUrlRef.current = null;
    }
    lastCaptureRef.current = { cigarette: 0, vape: 0, litter: 0 };
    motionSampleRef.current = null;
    frameHistoryRef.current = [];
    lastGeminiAtRef.current = 0;
  }, [camera.id, camera.stream_url, camera.enabled]);

  const flashAlert = useCallback((label: ViolationLabel, confidence: number) => {
    setActiveAlert({ label, confidence });
    if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
    alertTimerRef.current = setTimeout(() => setActiveAlert(null), ALERT_FLASH_MS);
  }, []);

  const runGeminiVerify = useCallback(async () => {
    if (verifyInFlightRef.current || !aiMonitoringRef.current) return;

    const img = imgRef.current;
    if (!img || img.naturalWidth === 0) return;

    verifyInFlightRef.current = true;
    lastGeminiAtRef.current = Date.now();
    setAnalyzing(true);

    try {
      const now = Date.now();
      const history = frameHistoryRef.current.filter((f) => now - f.at < FRAME_HISTORY_MS);
      let images =
        history.length >= 2
          ? [history[history.length - 2].dataUrl, history[history.length - 1].dataUrl]
          : history.length === 1
            ? [history[0].dataUrl]
            : [];

      if (images.length < GEMINI_BURST_FRAMES) {
        const burst = await captureBurstForGemini(
          img,
          GEMINI_BURST_FRAMES,
          GEMINI_BURST_INTERVAL_MS,
          () => imgRef.current,
        );
        if (burst.length > 0) images = burst;
      }

      if (images.length === 0) return;

      const controller = new AbortController();
      const fetchTimeout = window.setTimeout(
        () => controller.abort(),
        GEMINI_FETCH_TIMEOUT_MS,
      );

      let data: { detections?: Detection[]; summary?: string };
      try {
        const res = await fetch(detectEndpoint(camera.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Gemini HTTP ${res.status}`);
        }
        data = (await res.json()) as { detections?: Detection[]; summary?: string };
      } finally {
        window.clearTimeout(fetchTimeout);
      }

      const raw = Array.isArray(data.detections) ? data.detections : [];
      const dets = raw.filter(
        (d) => d.label === "Person" || d.confidence >= GEMINI_VIOLATION_THRESHOLD,
      );
      const summary = (data.summary ?? "").trim();

      const liveImg = imgRef.current;
      if (!liveImg) return;

      const ts = Date.now();
      const best = (detLabel: string) =>
        dets
          .filter((d) => d.label === detLabel)
          .sort((a, b) => b.confidence - a.confidence)[0];

      const violations: {
        det: Detection | undefined;
        kind: typeof CIGARETTE_KIND;
        key: "cigarette" | "vape" | "litter";
        label: ViolationLabel;
      }[] = [
        { det: best("Cigarette"), kind: CIGARETTE_KIND, key: "cigarette", label: "Cigarette" },
        { det: best("Vape"), kind: VAPE_KIND, key: "vape", label: "Vape" },
        { det: best("Litter"), kind: LITTER_KIND, key: "litter", label: "Litter" },
      ];
      for (const { det, kind, key, label: violationLabel } of violations) {
        if (!det) continue;
        flashAlert(violationLabel, det.confidence);
        if (ts - lastCaptureRef.current[key] >= EVIDENCE_COOLDOWN_MS) {
          lastCaptureRef.current[key] = ts;
          void captureEvidenceFromSource(
            liveImg,
            camera.id,
            label,
            kind,
            det.confidence,
            onEventRef.current,
            summary || undefined,
          );
        }
      }
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (!isAbort) {
        console.warn(`[camera-ai:${camera.id}]`, err);
      }
    } finally {
      verifyInFlightRef.current = false;
      setAnalyzing(false);
    }
  }, [camera.id, flashAlert, label]);

  const handleFrameReady = useCallback(
    (img: HTMLImageElement) => {
      setImageLoaded(true);

      const dataUrl = imageToGeminiDataUrl(img);
      if (!dataUrl) return;

      const now = Date.now();
      frameHistoryRef.current = [
        ...frameHistoryRef.current.filter((f) => now - f.at < FRAME_HISTORY_MS),
        { dataUrl, at: now },
      ].slice(-3);

      if (!aiMonitoringRef.current) return;
      if (verifyInFlightRef.current) return;
      if (now - lastGeminiAtRef.current < GEMINI_COOLDOWN_MS) return;

      const motion = detectMotion(img, motionSampleRef.current);
      if (!motion) return;
      motionSampleRef.current = motion.sample;

      if (!motion.motionDetected) return;

      void runGeminiVerify();
    },
    [runGeminiVerify],
  );

  useEffect(() => {
    if (!deferSnapshots) return;
    onStreamSettledRef.current("online");
    setImageLoaded(true);
  }, [deferSnapshots, camera.id]);

  useEffect(() => {
    if (!showStream || !streamUrl || deferSnapshots) return undefined;

    const controls = subscribeToSnapshots({
      cameraId: camera.id,
      streamUrl,
      priority: selected ? "high" : "normal",
      onSnapshot: (blob) => {
        const nextUrl = URL.createObjectURL(blob);
        const previousUrl = snapshotUrlRef.current;
        snapshotUrlRef.current = nextUrl;
        setSnapshotUrl(nextUrl);
        onStreamSettledRef.current("online");
        if (previousUrl) {
          URL.revokeObjectURL(previousUrl);
        }
      },
      onError: () => {
        if (!snapshotUrlRef.current) {
          setImageLoaded(false);
        }
      },
    });

    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      return controls.unsubscribe;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        controls.setVisible(visible);
      },
      { rootMargin: "80px", threshold: 0.05 },
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
      controls.unsubscribe();
    };
  }, [camera.id, showStream, streamUrl, selected, deferSnapshots]);

  useEffect(() => {
    return () => {
      if (snapshotUrlRef.current) {
        URL.revokeObjectURL(snapshotUrlRef.current);
        snapshotUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (camera.enabled === false || streamState !== "loading" || deferSnapshots) return;

    const timeout = window.setTimeout(() => {
      if (!snapshotUrlRef.current) {
        onStreamSettledRef.current("stream_unavailable");
      }
    }, STREAM_LOAD_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [camera.id, camera.stream_url, camera.enabled, streamState]);

  const handleUnavailableClick = () => {
    if (isUnavailable && onCredentialsRequest) {
      onCredentialsRequest();
      return;
    }
    onSelect?.();
  };

  const toggleFullscreen = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void node.requestFullscreen?.().catch(() => undefined);
    }
  }, []);

  const alertColor = activeAlert ? VIOLATION_COLORS[activeAlert.label] : "#f0652c";

  return (
    <article
      ref={containerRef}
      title="Double-click for fullscreen"
      className={`group relative aspect-video w-full overflow-hidden rounded-[10px] bg-black transition-shadow duration-300 ${
        onSelect || onCredentialsRequest ? "cursor-pointer" : "cursor-default"
      } ${
        activeAlert
          ? "border-2 border-[#ef4444] shadow-[0_0_20px_rgba(239,68,68,0.4)] animate-[alert-pulse_1.2s_ease-in-out_infinite]"
          : selected
            ? "border-2 border-[#f0652c] shadow-[0_0_0_3px_rgba(240,101,44,0.14)]"
            : "border border-[#272727]"
      }`}
      onClick={handleUnavailableClick}
      onDoubleClick={toggleFullscreen}
    >
      {showStream ? (
        <>
          {deferSnapshots ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-[#0d0d0d] text-[#6b6b6b]">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">Live in preview</span>
            </div>
          ) : snapshotUrl ? (
            <img
              key={camera.id}
              ref={imgRef}
              src={snapshotUrl}
              alt={cameraTitle(camera)}
              className="block h-full w-full object-cover"
              onLoad={(event) => {
                handleFrameReady(event.currentTarget);
              }}
              onError={() => {
                setImageLoaded(false);
              }}
            />
          ) : null}
          {streamState === "loading" && !imageLoaded ? (
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

      {aiMonitoring && analyzing ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#f0652c] to-transparent animate-[scan-line_2s_linear_infinite]"
          aria-hidden
        />
      ) : null}

      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_top,rgba(0,0,0,0.55)_0%,rgba(0,0,0,0)_34%)]" />

      {/* Top-left: LIVE badge + timestamp (burned-in CCTV overlay) */}
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

      {/* Top-right: AI status */}
      {aiMonitoring ? (
        <div className="pointer-events-none absolute right-2.5 top-2.5">
          <span
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] backdrop-blur-sm ${
              analyzing
                ? "bg-[rgba(240,101,44,0.25)] text-[#ffb089]"
                : "bg-[rgba(240,101,44,0.15)] text-[#f0652c]"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full bg-[#f0652c] ${analyzing ? "animate-[pulse-dot_0.8s_ease-in-out_infinite]" : ""}`}
            />
            {analyzing ? "Analyzing" : "AI"}
          </span>
        </div>
      ) : null}

      {/* Center: violation alert banner */}
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

      {/* Bottom-left: camera name + status dot */}
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
        className="absolute right-2.5 bottom-2 w-6 h-6 flex items-center justify-center border-none bg-transparent text-[rgba(255,255,255,0.75)] cursor-pointer opacity-0 transition-opacity group-hover:opacity-100"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </button>
    </article>
  );
}
