"use client";

import { useEffect, useRef, useState } from "react";
import { buildCameraStreamUrl } from "../lib/cameraApi";
import type { CameraView } from "../lib/cameraTypes";
import type { StreamLoadState } from "./CameraGrid";
import { runInference } from "@/lib/inference";
import { SMOKING_THRESHOLD } from "@/lib/modelConfig";
import { CameraLitteringSession } from "@/lib/littering/pipeline";
import type { EvidenceEvent } from "@/lib/evidence";
import {
  captureEvidenceFromSource,
  CIGARETTE_KIND,
  drawDetectionBoxes,
  LITTER_KIND,
  VAPE_KIND,
} from "@/lib/cameraAiUtils";

const STREAM_LOAD_TIMEOUT_MS = 25000;
const INFERENCE_INTERVAL_MS = 400;
const CAPTURE_COOLDOWN_MS = 8000;

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
  modelsReady = false,
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
  modelsReady?: boolean;
  aiActive?: boolean;
  onEvent?: (event: EvidenceEvent) => void;
}) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const onEventRef = useRef(onEvent);
  const lastCaptureRef = useRef({ cigarette: 0, vape: 0, litter: 0 });
  const litteringSessionRef = useRef<CameraLitteringSession | null>(null);

  const streamUrl = buildCameraStreamUrl(camera);
  const streamActive =
    camera.enabled !== false && (streamState === "loading" || streamState === "online");
  const showStream = streamActive;
  const showAi = modelsReady && aiActive && streamState === "online" && imageLoaded;

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
    setImageLoaded(false);
    lastCaptureRef.current = { cigarette: 0, vape: 0, litter: 0 };
    litteringSessionRef.current = new CameraLitteringSession();
  }, [camera.id, camera.stream_url, camera.enabled]);

  useEffect(() => {
    if (camera.enabled === false || streamState !== "loading") return;

    const timeout = window.setTimeout(() => {
      setImageLoaded((loaded) => {
        if (!loaded) {
          onStreamSettled("stream_unavailable");
        }
        return loaded;
      });
    }, STREAM_LOAD_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [camera.id, camera.stream_url, camera.enabled, streamState, onStreamSettled]);

  useEffect(() => {
    if (!showAi) {
      const overlay = overlayRef.current;
      overlay?.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
      return undefined;
    }

    let running = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sourceLabel = label;

    const loop = async () => {
      if (!running) return;

      const img = imgRef.current;
      const overlay = overlayRef.current;
      const container = containerRef.current;

      if (img && overlay && container && img.naturalWidth > 0) {
        try {
          const { detections, litteringInputs } = await runInference(img);
          const littering = litteringSessionRef.current?.process(litteringInputs) ?? {
            events: [],
            overlayDets: [],
          };
          const dets = [...detections, ...littering.overlayDets];
          const { offsetWidth: w, offsetHeight: h } = container;
          drawDetectionBoxes(overlay, dets, w, h);

          const now = Date.now();
          const best = (detLabel: string) =>
            dets
              .filter((d) => d.label === detLabel)
              .sort((a, b) => b.confidence - a.confidence)[0];

          const cigarette = best("Cigarette");
          if (
            cigarette &&
            cigarette.confidence >= SMOKING_THRESHOLD &&
            now - lastCaptureRef.current.cigarette >= CAPTURE_COOLDOWN_MS
          ) {
            lastCaptureRef.current.cigarette = now;
            void captureEvidenceFromSource(
              img,
              camera.id,
              sourceLabel,
              CIGARETTE_KIND,
              cigarette.confidence,
              onEventRef.current,
            );
          }

          const vape = best("Vape");
          if (
            vape &&
            vape.confidence >= SMOKING_THRESHOLD &&
            now - lastCaptureRef.current.vape >= CAPTURE_COOLDOWN_MS
          ) {
            lastCaptureRef.current.vape = now;
            void captureEvidenceFromSource(
              img,
              camera.id,
              sourceLabel,
              VAPE_KIND,
              vape.confidence,
              onEventRef.current,
            );
          }

          const litter = littering.events[0];
          if (
            litter &&
            now - lastCaptureRef.current.litter >= CAPTURE_COOLDOWN_MS
          ) {
            lastCaptureRef.current.litter = now;
            void captureEvidenceFromSource(
              img,
              camera.id,
              sourceLabel,
              LITTER_KIND,
              0.95,
              onEventRef.current,
            );
          }
        } catch (err) {
          console.error(`[camera-ai:${camera.id}]`, err);
        }
      }

      if (running) {
        timer = setTimeout(() => {
          void loop();
        }, INFERENCE_INTERVAL_MS);
      }
    };

    void loop();

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
          <img
            ref={imgRef}
            src={camera.stream_url ?? streamUrl}
            alt={cameraTitle(camera)}
            className="block h-full w-full object-cover"
            onLoad={() => {
              setImageLoaded(true);
              onStreamSettled("online");
            }}
            onError={() => {
              setImageLoaded(false);
              onStreamSettled("stream_unavailable");
            }}
          />
          <canvas
            ref={overlayRef}
            className="absolute inset-0 h-full w-full pointer-events-none"
          />
          {streamState === "loading" && !imageLoaded ? (
            <div className="absolute inset-0 flex items-center justify-center text-[#8a8a8a] text-[12px] tracking-[0.08em] bg-[#0d0d0d]">
              LOADING
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
