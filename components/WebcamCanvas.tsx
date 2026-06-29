"use client";

import { useEffect, useRef } from "react";
import { runInference } from "@/lib/inference";
import { Detection } from "@/lib/yoloDecode";
import { ALERT_THRESHOLD, SMOKING_THRESHOLD, LITTER_THRESHOLD } from "@/lib/modelConfig";
import type { EvidenceEvent } from "@/lib/evidence";

type ViolationKind = {
  label: "Cigarette" | "Vape" | "Litter";
  type: "smoking" | "vape" | "litter";
};
const CIGARETTE_KIND: ViolationKind = { label: "Cigarette", type: "smoking" };
const VAPE_KIND: ViolationKind = { label: "Vape", type: "vape" };
const LITTER_KIND: ViolationKind = { label: "Litter", type: "litter" };

const CIGARETTE_COLOR = "#ef4444";
const VAPE_COLOR = "#a855f7";
const LITTER_COLOR = "#f97316";
const PERSON_COLOR = "#3b82f6";

const CAPTURE_COOLDOWN_MS = 8000;
const THUMB_WIDTH = 200;
const WEBCAM_CAMERA_ID = "webcam";
const WEBCAM_SOURCE_LABEL = "Webcam AI";

interface Props {
  onDetections?: (dets: Detection[]) => void;
  onEvent?: (event: EvidenceEvent) => void;
  paused?: boolean;
}

/**
 * Grab the raw video frame, POST it to /api/evidence for local saving, and
 * emit an EvidenceEvent (with a thumbnail preview) for the sidebar feed.
 */
async function captureEvidence(
  video: HTMLVideoElement,
  kind: ViolationKind,
  confidence: number,
  onEvent?: (event: EvidenceEvent) => void,
): Promise<void> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, w, h);

  // Small preview for the sidebar (evidence/ isn't served statically).
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = THUMB_WIDTH;
  thumbCanvas.height = Math.round((h / w) * THUMB_WIDTH);
  thumbCanvas
    .getContext("2d")
    ?.drawImage(video, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const thumb = thumbCanvas.toDataURL("image/jpeg", 0.6);

  const time = Date.now();
  let savedPath: string | null = null;
  let saveError: string | undefined;

  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.9),
  );

  if (blob) {
    const form = new FormData();
    form.append("file", blob, "snapshot.jpg");
    form.append("cameraId", WEBCAM_CAMERA_ID);
    form.append("type", kind.type);
    form.append("confidence", String(confidence));
    try {
      const res = await fetch("/api/evidence", { method: "POST", body: form });
      const contentType = res.headers.get("content-type") ?? "";
      const data = contentType.includes("application/json")
        ? await res.json()
        : { error: `HTTP ${res.status}` };
      if (res.ok) {
        savedPath = data.saved as string;
        console.log("[evidence] saved", savedPath);
      } else {
        saveError = data.error ?? `HTTP ${res.status}`;
        console.error("[evidence] save failed:", saveError);
      }
    } catch (err) {
      saveError = err instanceof Error ? err.message : "network error";
      console.error("[evidence] save error:", err);
    }
  } else {
    saveError = "could not encode frame";
  }

  onEvent?.({
    id: `${time}-${kind.type}`,
    source: WEBCAM_SOURCE_LABEL,
    label: kind.label,
    confidence,
    time,
    thumb,
    savedPath,
    saveError,
  });
}

function getColor(label: string): string {
  if (label === "Cigarette") return CIGARETTE_COLOR;
  if (label === "Vape") return VAPE_COLOR;
  if (label === "Person") return PERSON_COLOR;
  return LITTER_COLOR;
}

function drawBoxes(
  overlay: HTMLCanvasElement,
  dets: Detection[],
  displayW: number,
  displayH: number,
): void {
  overlay.width = displayW;
  overlay.height = displayH;
  const ctx = overlay.getContext("2d")!;
  ctx.clearRect(0, 0, displayW, displayH);

  for (const det of dets) {
    const [x1, y1, x2, y2] = det.box;
    const color = getColor(det.label);
    const isAlert =
      det.label !== "Person" && det.confidence >= ALERT_THRESHOLD;
    const lineWidth = det.label === "Person" ? 2 : isAlert ? 3 : 2;

    const px = x1 * displayW;
    const py = y1 * displayH;
    const pw = (x2 - x1) * displayW;
    const ph = (y2 - y1) * displayH;

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(px, py, pw, ph);

    const label = `${det.label} ${Math.round(det.confidence * 100)}%`;
    ctx.font = "bold 13px system-ui, sans-serif";
    const tw = ctx.measureText(label).width;

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(px, py - 22, tw + 10, 22);
    ctx.globalAlpha = 1;

    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, px + 5, py - 6);
  }
}

export default function WebcamCanvas({ onDetections, onEvent, paused }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onDetectionsRef = useRef(onDetections);
  const onEventRef = useRef(onEvent);
  const pausedRef = useRef(paused);
  const lastCaptureRef = useRef<{ cigarette: number; vape: number; litter: number }>({
    cigarette: 0,
    vape: 0,
    litter: 0,
  });

  useEffect(() => { onDetectionsRef.current = onDetections; }, [onDetections]);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => {
    pausedRef.current = paused;
    // Clear boxes immediately when pausing
    if (paused) {
      const overlay = overlayRef.current;
      if (overlay) overlay.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
      onDetectionsRef.current?.([]);
    }
  }, [paused]);

  useEffect(() => {
    let running = true;
    let stream: MediaStream | null = null;
    let frameTimer: ReturnType<typeof setTimeout> | null = null;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch {
        // fallback: any camera
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      const video = videoRef.current;
      if (!video || !running) return;
      video.srcObject = stream;
      await video.play();

      // Self-scheduling loop: run the next inference only after the previous
      // one finishes. Avoids the backlog/flicker of a fixed-interval timer
      // when a frame takes longer than the interval.
      const loop = async () => {
        if (!running) return;
        const vid = videoRef.current;
        const overlay = overlayRef.current;
        const container = containerRef.current;

        if (vid && overlay && container && vid.readyState >= 2 && !pausedRef.current) {
          try {
            const dets = await runInference(vid);

            onDetectionsRef.current?.(dets);

            // Capture evidence when a smoking/litter detection clears 50%,
            // throttled per-type so each fires at most once per cooldown.
            const now = Date.now();
            const best = (label: string) =>
              dets
                .filter((d) => d.label === label)
                .sort((a, b) => b.confidence - a.confidence)[0];

            const cigarette = best("Cigarette");
            if (
              cigarette &&
              cigarette.confidence >= SMOKING_THRESHOLD &&
              now - lastCaptureRef.current.cigarette >= CAPTURE_COOLDOWN_MS
            ) {
              lastCaptureRef.current.cigarette = now;
              void captureEvidence(vid, CIGARETTE_KIND, cigarette.confidence, onEventRef.current);
            }

            const vape = best("Vape");
            if (
              vape &&
              vape.confidence >= SMOKING_THRESHOLD &&
              now - lastCaptureRef.current.vape >= CAPTURE_COOLDOWN_MS
            ) {
              lastCaptureRef.current.vape = now;
              void captureEvidence(vid, VAPE_KIND, vape.confidence, onEventRef.current);
            }

            const litter = best("Litter");
            if (
              litter &&
              litter.confidence >= LITTER_THRESHOLD &&
              now - lastCaptureRef.current.litter >= CAPTURE_COOLDOWN_MS
            ) {
              lastCaptureRef.current.litter = now;
              void captureEvidence(vid, LITTER_KIND, litter.confidence, onEventRef.current);
            }

            const { offsetWidth: w, offsetHeight: h } = container;
            drawBoxes(overlay, dets, w, h);
          } catch (err) {
            console.error("runInference error:", err);
          }
        }

        if (running) frameTimer = setTimeout(loop, 0);
      };

      loop();
    }

    start().catch(console.error);

    return () => {
      running = false;
      if (frameTimer !== null) clearTimeout(frameTimer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black">
      <video
        ref={videoRef}
        muted
        playsInline
        className="w-full h-full block object-contain"
      />
      <canvas
        ref={overlayRef}
        className="absolute top-0 left-0 w-full h-full pointer-events-none"
      />
    </div>
  );
}
