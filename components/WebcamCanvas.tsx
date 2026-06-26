"use client";

import { useEffect, useRef } from "react";
import { runInference } from "@/lib/inference";
import { Detection } from "@/lib/yoloDecode";
import { ALERT_THRESHOLD, SMOKING_THRESHOLD, LITTER_THRESHOLD } from "@/lib/modelConfig";
import type { EvidenceEvent } from "@/lib/evidence";

type ViolationKind = { label: "Smoking" | "Litter"; type: "smoking" | "litter" };
const SMOKING_KIND: ViolationKind = { label: "Smoking", type: "smoking" };
const LITTER_KIND: ViolationKind = { label: "Litter", type: "litter" };

const SMOKING_COLOR = "#ef4444";
const LITTER_COLOR = "#f97316";

// Minimum gap between saved evidence snapshots, to avoid spamming the
// evidence/ folder while the model fires every frame (~10 fps).
const CAPTURE_COOLDOWN_MS = 8000;
const THUMB_WIDTH = 200;

interface Props {
  onDetections?: (dets: Detection[]) => void;
  onEvent?: (event: EvidenceEvent) => void;
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
    form.append("cameraId", "webcam");
    form.append("type", kind.type);
    form.append("confidence", String(confidence));
    try {
      const res = await fetch("/api/evidence", { method: "POST", body: form });
      const data = await res.json();
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
    label: kind.label,
    confidence,
    time,
    thumb,
    savedPath,
    saveError,
  });
}

function getColor(label: string): string {
  return label === "Smoking" ? SMOKING_COLOR : LITTER_COLOR;
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
    const isAlert = det.confidence >= ALERT_THRESHOLD;

    const px = x1 * displayW;
    const py = y1 * displayH;
    const pw = (x2 - x1) * displayW;
    const ph = (y2 - y1) * displayH;

    ctx.strokeStyle = color;
    ctx.lineWidth = isAlert ? 3 : 2;
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

export default function WebcamCanvas({ onDetections, onEvent }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onDetectionsRef = useRef(onDetections);
  const onEventRef = useRef(onEvent);
  const lastCaptureRef = useRef<{ smoking: number; litter: number }>({ smoking: 0, litter: 0 });

  useEffect(() => {
    onDetectionsRef.current = onDetections;
  }, [onDetections]);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

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

        if (vid && overlay && container && vid.readyState >= 2) {
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

            const smoking = best("Smoking");
            if (
              smoking &&
              smoking.confidence >= SMOKING_THRESHOLD &&
              now - lastCaptureRef.current.smoking >= CAPTURE_COOLDOWN_MS
            ) {
              lastCaptureRef.current.smoking = now;
              void captureEvidence(vid, SMOKING_KIND, smoking.confidence, onEventRef.current);
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
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        style={{ width: "100%", height: "100%", display: "block", objectFit: "contain" }}
      />
      <canvas
        ref={overlayRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
