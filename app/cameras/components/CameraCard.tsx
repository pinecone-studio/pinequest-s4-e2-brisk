"use client";

import { useEffect, useRef, useState } from "react";
import { buildCameraStreamUrl } from "../lib/cameraApi";
import type { CameraView } from "../lib/cameraTypes";
import { subscribeToSnapshots } from "../lib/snapshotScheduler";
import type { StreamLoadState } from "./CameraGrid";
import type { Detection } from "@/lib/detection";
import type { EvidenceEvent } from "@/lib/evidence";
import {
  captureEvidenceFromSource,
  CIGARETTE_KIND,
  LITTER_KIND,
  VAPE_KIND,
} from "@/lib/cameraAiUtils";

const STREAM_LOAD_TIMEOUT_MS = 25000;
const CAPTURE_COOLDOWN_MS = 8000;

// --- Cloud vision detection (Gemini) --------------------------------------
const DETECT_ENDPOINT = "/api/gemini";
const VERIFY_COOLDOWN_MS = 4000; // min gap between Gemini calls per camera
const VIOLATION_THRESHOLD = 0.7; // ignore low-confidence guesses
const POLL_INTERVAL_MS = 500; // how often the loop checks the cooldown
const MAX_BACKOFF_STEPS = 4; // widen the cooldown under Gemini 503/429

// One trip grabs a short ordered burst so Gemini can judge littering as an
// ACTION (carry -> drop -> leave), at the cost of ONE cloud call per event.
const BURST_FRAMES = 5;
const BURST_INTERVAL_MS = 450;
const BURST_JPEG_QUALITY = 0.78;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cameraTitle(camera: CameraView) {
  return camera.name || camera.id;
}

export default function CameraCard({
  camera,
  label,
  streamState,
  selected,
  onSelect,
  onStreamSettled,
  onCredentialsRequest,
  aiReady = false,
  aiActive = false,
  onEvent,
}: {
  camera: CameraView;
  label: string;
  streamState: StreamLoadState;
  selected?: boolean;
  onSelect?: () => void;
  onStreamSettled: (state: "online" | "stream_unavailable") => void;
  onCredentialsRequest?: () => void;
  aiReady?: boolean;
  aiActive?: boolean;
  onEvent?: (event: EvidenceEvent) => void;
}) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const onEventRef = useRef(onEvent);
  const onStreamSettledRef = useRef(onStreamSettled);
  const snapshotUrlRef = useRef<string | null>(null);
  const lastCaptureRef = useRef({ cigarette: 0, vape: 0, litter: 0 });

  const streamUrl = buildCameraStreamUrl(camera);
  const streamActive =
    camera.enabled !== false && (streamState === "loading" || streamState === "online");
  const showStream = streamActive;
  const showAi = aiReady && aiActive && streamState === "online" && imageLoaded;

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
    setImageLoaded(false);
    setSnapshotUrl(null);
    if (snapshotUrlRef.current) {
      URL.revokeObjectURL(snapshotUrlRef.current);
      snapshotUrlRef.current = null;
    }
    lastCaptureRef.current = { cigarette: 0, vape: 0, litter: 0 };
  }, [camera.id, camera.stream_url, camera.enabled]);

  useEffect(() => {
    if (!showStream || !streamUrl) return undefined;

    return subscribeToSnapshots({
      cameraId: camera.id,
      streamUrl,
      onSnapshot: (blob) => {
        const nextUrl = URL.createObjectURL(blob);
        const previousUrl = snapshotUrlRef.current;
        snapshotUrlRef.current = nextUrl;
        setSnapshotUrl(nextUrl);
        setImageLoaded(true);
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
  }, [camera.id, showStream, streamUrl]);

  useEffect(() => {
    return () => {
      if (snapshotUrlRef.current) {
        URL.revokeObjectURL(snapshotUrlRef.current);
        snapshotUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (camera.enabled === false || streamState !== "loading") return;

    const timeout = window.setTimeout(() => {
      setImageLoaded((loaded) => {
        if (!loaded) {
          onStreamSettledRef.current("stream_unavailable");
        }
        return loaded;
      });
    }, STREAM_LOAD_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [camera.id, camera.stream_url, camera.enabled, streamState]);

  useEffect(() => {
    if (!showAi) return undefined;

    let running = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sourceLabel = label;
    let verifying = false;
    let lastVerify = 0;
    let backoff = 0; // grows on Gemini 503/429, widens the cooldown

    // Grab a short burst from the live stream <img> and ask Gemini to detect
    // smoking / littering, then raise evidence events. (No box overlay.)
    const verify = async () => {
      const img = imgRef.current;
      if (!img || img.naturalWidth === 0 || verifying) return;

      verifying = true;
      lastVerify = Date.now();
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;

        const images: string[] = [];
        for (let f = 0; f < BURST_FRAMES; f++) {
          const live = imgRef.current;
          if (!live || live.naturalWidth === 0) break;
          const snap = document.createElement("canvas");
          snap.width = w;
          snap.height = h;
          snap.getContext("2d")?.drawImage(live, 0, 0, w, h);
          images.push(snap.toDataURL("image/jpeg", BURST_JPEG_QUALITY));
          if (f < BURST_FRAMES - 1) await sleep(BURST_INTERVAL_MS);
        }
        if (!running || images.length === 0) return;

        const res = await fetch(DETECT_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images }),
        });
        if (!res.ok) {
          // Gemini overloaded/rate-limited — back off so we stop hammering it.
          if (res.status === 503 || res.status === 429) {
            backoff = Math.min(backoff + 1, MAX_BACKOFF_STEPS);
          }
          return;
        }
        backoff = 0; // recovered — return to the normal cadence

        const data = (await res.json()) as { detections?: Detection[]; summary?: string };
        const raw = Array.isArray(data.detections) ? data.detections : [];
        // Keep people (context) + only confident violations.
        const dets = raw.filter(
          (d) => d.label === "Person" || d.confidence >= VIOLATION_THRESHOLD,
        );
        const summary = (data.summary ?? "").trim();

        const liveImg = imgRef.current;
        if (!running || !liveImg) return;

        const now = Date.now();
        const best = (detLabel: string) =>
          dets
            .filter((d) => d.label === detLabel)
            .sort((a, b) => b.confidence - a.confidence)[0];

        const violations = [
          { det: best("Cigarette"), kind: CIGARETTE_KIND, key: "cigarette" as const },
          { det: best("Vape"), kind: VAPE_KIND, key: "vape" as const },
          { det: best("Litter"), kind: LITTER_KIND, key: "litter" as const },
        ];
        for (const { det, kind, key } of violations) {
          if (det && now - lastCaptureRef.current[key] >= CAPTURE_COOLDOWN_MS) {
            lastCaptureRef.current[key] = now;
            void captureEvidenceFromSource(
              liveImg,
              camera.id,
              sourceLabel,
              kind,
              det.confidence,
              onEventRef.current,
              summary || undefined,
            );
          }
        }
      } catch (err) {
        console.error(`[camera-ai:${camera.id}]`, err);
      } finally {
        // Count the cooldown from when the burst FINISHED so the ~1.8s capture
        // span doesn't eat into the gap between cloud calls.
        lastVerify = Date.now();
        verifying = false;
      }
    };

    const loop = () => {
      if (!running) return;
      const effectiveCooldown = VERIFY_COOLDOWN_MS * (1 + backoff);
      if (Date.now() - lastVerify >= effectiveCooldown) void verify();
      timer = setTimeout(loop, POLL_INTERVAL_MS);
    };

    loop();

    return () => {
      running = false;
      if (timer) clearTimeout(timer);
    };
  }, [showAi, camera.id, label]);

  const handleUnavailableClick = () => {
    if (isUnavailable && onCredentialsRequest) {
      onCredentialsRequest();
      return;
    }
    onSelect?.();
  };

  return (
    <article
      ref={containerRef}
      className={`relative aspect-video w-full overflow-hidden rounded-[10px] bg-black ${
        onSelect || onCredentialsRequest ? "cursor-pointer" : "cursor-default"
      } ${
        selected
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
              onLoad={() => {
                setImageLoaded(true);
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

      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_top,rgba(0,0,0,0.55)_0%,rgba(0,0,0,0)_34%)]" />
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
        {showAi ? (
          <span className="text-[9px] font-bold uppercase tracking-[0.06em] text-[#f0652c] bg-[rgba(240,101,44,0.2)] px-1.5 py-0.5 rounded">
            AI
          </span>
        ) : null}
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
