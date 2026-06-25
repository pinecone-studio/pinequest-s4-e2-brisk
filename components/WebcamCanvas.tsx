"use client";

import { useEffect, useRef } from "react";
import { runInference } from "@/lib/inference";
import { Detection } from "@/lib/yoloDecode";
import { ALERT_THRESHOLD } from "@/lib/modelConfig";

const SMOKING_COLOR = "#ef4444";
const LITTER_COLOR = "#f97316";

interface Props {
  onDetections: (dets: Detection[]) => void;
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
  console.log("[render]", dets.length);

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

export default function WebcamCanvas({ onDetections }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onDetectionsRef = useRef(onDetections);

  useEffect(() => {
    onDetectionsRef.current = onDetections;
  }, [onDetections]);

  useEffect(() => {
    let running = true;
    let stream: MediaStream | null = null;
    let inferenceTimer: ReturnType<typeof setInterval> | null = null;

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

      inferenceTimer = setInterval(async () => {
        const vid = videoRef.current;
        const overlay = overlayRef.current;
        const container = containerRef.current;

        if (!running || !vid || !overlay || !container || vid.readyState < 2) return;

        let dets: Detection[] = [];
        try {
          dets = await runInference(vid);
        } catch (err) {
          console.error("runInference error:", err);
          return;
        }

        onDetectionsRef.current(dets);

        const { offsetWidth: w, offsetHeight: h } = container;
        drawBoxes(overlay, dets, w, h);
      }, 100); // ~10 fps
    }

    start().catch(console.error);

    return () => {
      running = false;
      if (inferenceTimer !== null) clearInterval(inferenceTimer);
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
