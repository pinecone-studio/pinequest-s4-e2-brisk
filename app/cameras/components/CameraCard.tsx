"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildCameraStreamUrl } from "../lib/cameraApi";
import type { CameraView } from "../lib/cameraTypes";
import {
  GRID_SNAPSHOT_JITTER_MS,
  GRID_SNAPSHOT_POLL_MS,
  subscribeToSnapshots,
} from "../lib/snapshotScheduler";
import type { StreamLoadState } from "./CameraGrid";
import type { Detection } from "@/lib/detection";
import type { EvidenceEvent } from "@/lib/evidence";
import {
  EVIDENCE_COOLDOWN_MS,
  FRAME_HISTORY_MS,
  GEMINI_FETCH_TIMEOUT_MS,
  GEMINI_VIOLATION_THRESHOLD,
} from "@/lib/aiConfig";
import {
  captureEvidenceFromSource,
  CIGARETTE_KIND,
  imageToGeminiDataUrl,
  LITTER_KIND,
  VAPE_KIND,
} from "@/lib/cameraAiUtils";
import { detectMotion, type MotionSample } from "@/lib/motionGate";

const STREAM_LOAD_TIMEOUT_MS = 25000;
const ALERT_FLASH_MS = 5000;

// --- Two-stage detection ---------------------------------------------------
// Stage 1 (local, free): is there movement? Runs on every snapshot frame.
// Stage 2 (Gemini, only when Stage 1 fired): is anything illegal happening?
const VERIFY_COOLDOWN_MS = 3000; // min gap between Gemini calls per camera
const MOTION_ACTIVE_WINDOW_MS = 5000; // only call Gemini if motion is this recent
const RATE_LIMIT_BACKOFF_MS = 20000; // pause after a Gemini 429/503
const MAX_TEMPORAL_FRAMES = 2; // send at most 2 frames (carry -> drop change)

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
  clock,
  onSelect,
  onStreamSettled,
  onCredentialsRequest,
  aiReady = false,
  aiActive = false,
  gridPaused = false,
  onEvent,
  onSnapshotPreview,
}: {
  camera: CameraView;
  label: string;
  streamState: StreamLoadState;
  selected?: boolean;
  clock?: string;
  onSelect?: () => void;
  onStreamSettled: (state: "loading" | "online" | "stream_unavailable") => void;
  onCredentialsRequest?: () => void;
  aiReady?: boolean;
  aiActive?: boolean;
  gridPaused?: boolean;
  onEvent?: (event: EvidenceEvent) => void;
  onSnapshotPreview?: (previewUrl: string | null) => void;
}) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [inView, setInView] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [activeAlert, setActiveAlert] = useState<{
    label: ViolationLabel;
    confidence: number;
  } | null>(null);
  const pollStartedRef = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const onEventRef = useRef(onEvent);
  const onStreamSettledRef = useRef(onStreamSettled);
  const onSnapshotPreviewRef = useRef(onSnapshotPreview);
  const snapshotUrlRef = useRef<string | null>(null);
  const lastCaptureRef = useRef({ cigarette: 0, vape: 0, litter: 0 });
  const alertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Two-stage AI refs
  const showAiRef = useRef(false);
  const frameHistoryRef = useRef<{ dataUrl: string; at: number }[]>([]);
  const motionSampleRef = useRef<MotionSample | null>(null);
  const lastMotionAtRef = useRef(0);
  const lastGeminiAtRef = useRef(0);
  const backoffUntilRef = useRef(0);
  const verifyInFlightRef = useRef(false);

  const streamUrl = buildCameraStreamUrl(camera);
  const streamActive =
    camera.enabled !== false && (streamState === "loading" || streamState === "online");
  const snapshotsEnabled = streamActive && Boolean(streamUrl) && inView && !gridPaused;
  const showStream = streamActive;
  const showAi =
    aiReady && aiActive && streamState === "online" && imageLoaded && inView && !gridPaused;

  const isDisabled = camera.enabled === false;
  const isUnavailable = streamState === "stream_unavailable";
  const isOnline = streamState === "online";

  const dotColor = isDisabled
    ? "#5c5c5c"
    : isUnavailable
      ? "#ef4444"
      : isOnline
        ? showAi
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
    onSnapshotPreviewRef.current = onSnapshotPreview;
  }, [onSnapshotPreview]);

  useEffect(() => {
    showAiRef.current = showAi;
  }, [showAi]);

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
    pollStartedRef.current = false;
    setImageLoaded(false);
    setSnapshotUrl(null);
    setActiveAlert(null);
    if (snapshotUrlRef.current) {
      URL.revokeObjectURL(snapshotUrlRef.current);
      snapshotUrlRef.current = null;
    }
    lastCaptureRef.current = { cigarette: 0, vape: 0, litter: 0 };
    frameHistoryRef.current = [];
    motionSampleRef.current = null;
    lastMotionAtRef.current = 0;
    lastGeminiAtRef.current = 0;
    onSnapshotPreviewRef.current?.(null);
  }, [camera.id, camera.stream_url, camera.enabled]);

  useEffect(() => {
    if (!snapshotsEnabled) {
      pollStartedRef.current = false;
      return undefined;
    }

    pollStartedRef.current = true;

    return subscribeToSnapshots({
      cameraId: camera.id,
      streamUrl,
      pollIntervalMs: GRID_SNAPSHOT_POLL_MS,
      jitterMs: GRID_SNAPSHOT_JITTER_MS,
      onSnapshot: (blob) => {
        const nextUrl = URL.createObjectURL(blob);
        const previousUrl = snapshotUrlRef.current;
        snapshotUrlRef.current = nextUrl;
        setSnapshotUrl(nextUrl);
        setImageLoaded(true);
        onStreamSettledRef.current("online");
        onSnapshotPreviewRef.current?.(nextUrl);
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
  }, [camera.id, snapshotsEnabled, streamUrl]);

  useEffect(() => {
    if (
      !pollStartedRef.current ||
      !snapshotsEnabled ||
      camera.enabled === false ||
      streamState !== "loading"
    ) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setImageLoaded((loaded) => {
        if (!loaded && pollStartedRef.current) {
          onStreamSettledRef.current("stream_unavailable");
        }
        return loaded;
      });
    }, STREAM_LOAD_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [camera.id, camera.stream_url, camera.enabled, snapshotsEnabled, streamState]);

  useEffect(() => {
    return () => {
      if (snapshotUrlRef.current) {
        URL.revokeObjectURL(snapshotUrlRef.current);
        snapshotUrlRef.current = null;
      }
    };
  }, []);

  // Stage 2: ask Gemini "is anything illegal happening?" for the recent frames.
  const runGeminiVerify = useCallback(async () => {
    const liveImg = imgRef.current;
    if (verifyInFlightRef.current || !liveImg) return;

    const frames = frameHistoryRef.current.slice(-MAX_TEMPORAL_FRAMES).map((f) => f.dataUrl);
    if (frames.length === 0) return;

    verifyInFlightRef.current = true;
    lastGeminiAtRef.current = Date.now();
    setAnalyzing(true);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), GEMINI_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(detectEndpoint(camera.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: frames }),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 429 || res.status === 503) {
          backoffUntilRef.current = Date.now() + RATE_LIMIT_BACKOFF_MS;
        }
        return;
      }

      const data = (await res.json()) as { detections?: Detection[]; summary?: string };
      const raw = Array.isArray(data.detections) ? data.detections : [];
      const dets = raw.filter(
        (d) => d.label === "Person" || d.confidence >= GEMINI_VIOLATION_THRESHOLD,
      );
      const summary = (data.summary ?? "").trim();

      const captureImg = imgRef.current;
      if (!captureImg) return;

      const now = Date.now();
      const best = (detLabel: string) =>
        dets
          .filter((d) => d.label === detLabel)
          .sort((a, b) => b.confidence - a.confidence)[0];

      const violations: {
        det: Detection | undefined;
        kind: typeof CIGARETTE_KIND;
        key: "cigarette" | "vape" | "litter";
      }[] = [
        { det: best("Cigarette"), kind: CIGARETTE_KIND, key: "cigarette" },
        { det: best("Vape"), kind: VAPE_KIND, key: "vape" },
        { det: best("Litter"), kind: LITTER_KIND, key: "litter" },
      ];
      for (const { det, kind, key } of violations) {
        if (!det) continue;
        flashAlert(kind.label, det.confidence);
        if (now - lastCaptureRef.current[key] >= EVIDENCE_COOLDOWN_MS) {
          lastCaptureRef.current[key] = now;
          void captureEvidenceFromSource(
            captureImg,
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
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        console.error(`[camera-ai:${camera.id}]`, err);
      }
    } finally {
      window.clearTimeout(timeout);
      lastGeminiAtRef.current = Date.now();
      verifyInFlightRef.current = false;
      setAnalyzing(false);
    }
  }, [camera.id, flashAlert, label]);

  // Runs on every new snapshot frame. Stage 1 (motion) gates Stage 2 (Gemini).
  const handleFrameReady = useCallback(
    (img: HTMLImageElement) => {
      setImageLoaded(true);
      if (!img.naturalWidth) return;

      const now = Date.now();

      // Keep a short rolling history of downscaled frames for temporal context.
      const dataUrl = imageToGeminiDataUrl(img);
      if (dataUrl) {
        frameHistoryRef.current = [
          ...frameHistoryRef.current.filter((f) => now - f.at < FRAME_HISTORY_MS),
          { dataUrl, at: now },
        ].slice(-3);
      }

      // Stage 1: cheap local motion check.
      const motion = detectMotion(img, motionSampleRef.current);
      if (motion) {
        motionSampleRef.current = motion.sample;
        if (motion.motionDetected) lastMotionAtRef.current = now;
      }

      // Stage 2 gate: only spend a Gemini call when there was RECENT motion.
      if (!showAiRef.current || verifyInFlightRef.current) return;
      if (now < backoffUntilRef.current) return;
      if (now - lastGeminiAtRef.current < VERIFY_COOLDOWN_MS) return;
      if (now - lastMotionAtRef.current > MOTION_ACTIVE_WINDOW_MS) return;

      void runGeminiVerify();
    },
    [runGeminiVerify],
  );

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

      {showAi && analyzing ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#f0652c] to-transparent animate-[scan-line_2s_linear_infinite]"
          aria-hidden
        />
      ) : null}

      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_top,rgba(0,0,0,0.55)_0%,rgba(0,0,0,0)_34%)]" />

      {/* Top-left: LIVE badge + burned-in timestamp */}
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
      {showAi ? (
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
