"use client";

import { useEffect, useRef, useState } from "react";
import type { Detection } from "@/lib/yoloDecode";
import type { EvidenceEvent } from "@/lib/evidence";
import {
  captureEvidenceFromSource,
  CIGARETTE_KIND,
  LITTER_KIND,
  VAPE_KIND,
} from "@/lib/cameraAiUtils";

// --- Local motion gate (free, runs every frame, no model) -------------------
const PROC_W = 192; // downscaled processing resolution
const PROC_H = 108;
const DETECT_INTERVAL_MS = 100;
const DIFF_THRESHOLD = 26; // per-pixel grayscale delta that counts as "moved"
const MIN_BLOB_AREA = 45; // ignore blobs smaller than this (proc pixels) = noise
const MERGE_PAD = 6; // grow each blob box before drawing (proc pixels)
const MERGE_GAP = 14; // boxes closer than this get merged into one (proc pixels)
const MIN_BOX_AREA = 120; // drop final boxes smaller than this (proc pixels)

// --- Cloud vision "brain" (only called when motion trips) -------------------
// Swap this to "/api/gemini" once the Gemini route + billing are ready.
const DETECT_ENDPOINT = "/api/detect";
const VERIFY_COOLDOWN_MS = 4000; // min gap between cloud calls, even on constant motion
const VLM_BOX_TTL_MS = 3500; // how long a VLM box stays drawn after a verdict
const CAPTURE_COOLDOWN_MS = 8000; // per-type evidence/event cooldown
const VIOLATION_THRESHOLD = 0.7; // ignore low-confidence guesses (kills false positives)
const WEBCAM_ID = "webcam-local";

const VLM_COLORS: Record<string, string> = {
  Cigarette: "#ef4444",
  Vape: "#a855f7",
  Litter: "#f97316",
  Person: "#3b82f6",
};

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 4-connectivity connected-component bounding boxes over a binary motion mask. */
function findMotionBoxes(mask: Uint8Array): Box[] {
  const visited = new Uint8Array(mask.length);
  const boxes: Box[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || visited[start]) continue;

    stack.length = 0;
    stack.push(start);
    visited[start] = 1;

    let area = 0;
    let minX = PROC_W;
    let minY = PROC_H;
    let maxX = 0;
    let maxY = 0;

    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % PROC_W;
      const y = (idx / PROC_W) | 0;
      area++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      if (x > 0 && mask[idx - 1] && !visited[idx - 1]) {
        visited[idx - 1] = 1;
        stack.push(idx - 1);
      }
      if (x < PROC_W - 1 && mask[idx + 1] && !visited[idx + 1]) {
        visited[idx + 1] = 1;
        stack.push(idx + 1);
      }
      if (y > 0 && mask[idx - PROC_W] && !visited[idx - PROC_W]) {
        visited[idx - PROC_W] = 1;
        stack.push(idx - PROC_W);
      }
      if (y < PROC_H - 1 && mask[idx + PROC_W] && !visited[idx + PROC_W]) {
        visited[idx + PROC_W] = 1;
        stack.push(idx + PROC_W);
      }
    }

    if (area >= MIN_BLOB_AREA) {
      boxes.push({
        x1: Math.max(0, minX - MERGE_PAD),
        y1: Math.max(0, minY - MERGE_PAD),
        x2: Math.min(PROC_W, maxX + MERGE_PAD),
        y2: Math.min(PROC_H, maxY + MERGE_PAD),
      });
    }
  }

  return boxes;
}

/** Repeatedly union boxes that overlap or sit within MERGE_GAP of each other. */
function mergeBoxes(boxes: Box[]): Box[] {
  const result = boxes.slice();

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i];
        const b = result[j];
        const near =
          a.x1 - MERGE_GAP <= b.x2 &&
          b.x1 - MERGE_GAP <= a.x2 &&
          a.y1 - MERGE_GAP <= b.y2 &&
          b.y1 - MERGE_GAP <= a.y2;
        if (near) {
          result[i] = {
            x1: Math.min(a.x1, b.x1),
            y1: Math.min(a.y1, b.y1),
            x2: Math.max(a.x2, b.x2),
            y2: Math.max(a.y2, b.y2),
          };
          result.splice(j, 1);
          merged = true;
          j--;
        }
      }
    }
  }

  return result.filter((b) => (b.x2 - b.x1) * (b.y2 - b.y1) >= MIN_BOX_AREA);
}

export default function WebcamCard({
  label = "Webcam",
  onEvent,
  onClose,
}: {
  label?: string;
  onEvent?: (event: EvidenceEvent) => void;
  onClose?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [checking, setChecking] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLElement>(null);

  const onEventRef = useRef(onEvent);
  const lastVerifyRef = useRef(0);
  const verifyingRef = useRef(false);
  const vlmDetsRef = useRef<{ dets: Detection[]; expiry: number }>({ dets: [], expiry: 0 });
  const lastCaptureRef = useRef({ Cigarette: 0, Vape: 0, Litter: 0 });

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  // --- webcam acquisition ---------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
          setStreaming(true);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not access webcam");
        }
      }
    })();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // --- send the current frame to the cloud VLM ------------------------------
  const verifyFrame = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || verifyingRef.current) return;

    verifyingRef.current = true;
    lastVerifyRef.current = Date.now();
    setChecking(true);

    try {
      const snap = document.createElement("canvas");
      snap.width = video.videoWidth;
      snap.height = video.videoHeight;
      snap.getContext("2d")?.drawImage(video, 0, 0, snap.width, snap.height);
      const image = snap.toDataURL("image/jpeg", 0.85);

      const res = await fetch(DETECT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      if (!res.ok) return;

      const data = (await res.json()) as { detections?: Detection[]; summary?: string };
      const raw = Array.isArray(data.detections) ? data.detections : [];
      // Keep people (context) + only confident violations; drop low-conf guesses.
      const dets = raw.filter(
        (d) => d.label === "Person" || d.confidence >= VIOLATION_THRESHOLD,
      );
      const summary = (data.summary ?? "").trim();
      vlmDetsRef.current = { dets, expiry: Date.now() + VLM_BOX_TTL_MS };

      // Raise events / save evidence for actual violations (Person is context only).
      const now = Date.now();
      const kindFor = (l: string) =>
        l === "Cigarette" ? CIGARETTE_KIND : l === "Vape" ? VAPE_KIND : l === "Litter" ? LITTER_KIND : null;

      let savedViolation = false;
      for (const label of ["Cigarette", "Vape", "Litter"] as const) {
        const best = dets
          .filter((d) => d.label === label)
          .sort((a, b) => b.confidence - a.confidence)[0];
        const kind = kindFor(label);
        if (best && kind && now - lastCaptureRef.current[label] >= CAPTURE_COOLDOWN_MS) {
          lastCaptureRef.current[label] = now;
          savedViolation = true;
          void captureEvidenceFromSource(
            video,
            WEBCAM_ID,
            "Webcam",
            kind,
            best.confidence,
            onEventRef.current,
            summary || undefined,
          );
        }
      }

      // Always log what the AI thought for this motion — as a lightweight, unsaved
      // "info" event — unless we just saved a violation event for the same frame.
      if (!savedViolation && summary && onEventRef.current) {
        const thumbCanvas = document.createElement("canvas");
        thumbCanvas.width = 200;
        thumbCanvas.height = Math.round((snap.height / snap.width) * 200);
        thumbCanvas.getContext("2d")?.drawImage(snap, 0, 0, thumbCanvas.width, thumbCanvas.height);
        onEventRef.current({
          id: `${now}-${WEBCAM_ID}-info`,
          source: "Webcam",
          label: "AI Note",
          confidence: 0,
          time: now,
          thumb: thumbCanvas.toDataURL("image/jpeg", 0.6),
          savedPath: null,
          note: summary,
          info: true,
        });
      }
    } catch {
      /* network/quota errors shouldn't break the motion loop */
    } finally {
      verifyingRef.current = false;
      setChecking(false);
    }
  };

  // --- motion loop (drives both the tripwire and the verify gate) -----------
  useEffect(() => {
    if (!streaming) return undefined;

    let running = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const proc = document.createElement("canvas");
    proc.width = PROC_W;
    proc.height = PROC_H;
    const procCtx = proc.getContext("2d", { willReadFrequently: true });

    let prevGray: Float32Array | null = null;
    const mask = new Uint8Array(PROC_W * PROC_H);

    const loop = () => {
      if (!running) return;

      const video = videoRef.current;
      const overlay = overlayRef.current;
      const container = containerRef.current;

      if (video && overlay && container && procCtx && video.videoWidth > 0) {
        procCtx.drawImage(video, 0, 0, PROC_W, PROC_H);
        const { data } = procCtx.getImageData(0, 0, PROC_W, PROC_H);
        const gray = new Float32Array(PROC_W * PROC_H);

        for (let i = 0; i < gray.length; i++) {
          const o = i * 4;
          gray[i] = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
        }

        let boxes: Box[] = [];
        if (prevGray) {
          for (let i = 0; i < gray.length; i++) {
            mask[i] = Math.abs(gray[i] - prevGray[i]) > DIFF_THRESHOLD ? 1 : 0;
          }
          boxes = mergeBoxes(findMotionBoxes(mask));
        }
        prevGray = gray;

        // Motion trips the cloud check, rate-limited by the cooldown.
        const now = Date.now();
        if (boxes.length > 0 && now - lastVerifyRef.current >= VERIFY_COOLDOWN_MS) {
          void verifyFrame();
        }

        const w = container.offsetWidth;
        const h = container.offsetHeight;
        overlay.width = w;
        overlay.height = h;
        const ctx = overlay.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, w, h);

          // tripwire: dashed orange motion boxes
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = "rgba(240,101,44,0.7)";
          ctx.lineWidth = 1.5;
          for (const b of boxes) {
            ctx.strokeRect(
              (b.x1 / PROC_W) * w,
              (b.y1 / PROC_H) * h,
              ((b.x2 - b.x1) / PROC_W) * w,
              ((b.y2 - b.y1) / PROC_H) * h,
            );
          }
          ctx.setLineDash([]);

          // VLM verdict: solid labeled boxes (normalized 0..1 coords)
          if (now < vlmDetsRef.current.expiry) {
            ctx.font = "bold 13px system-ui, sans-serif";
            for (const d of vlmDetsRef.current.dets) {
              const color = VLM_COLORS[d.label] ?? "#f97316";
              const px = d.box[0] * w;
              const py = d.box[1] * h;
              const pw = (d.box[2] - d.box[0]) * w;
              const ph = (d.box[3] - d.box[1]) * h;
              ctx.strokeStyle = color;
              ctx.lineWidth = d.label === "Person" ? 2 : 3;
              ctx.strokeRect(px, py, pw, ph);

              const text = `${d.label} ${Math.round(d.confidence * 100)}%`;
              const tw = ctx.measureText(text).width;
              ctx.fillStyle = color;
              ctx.fillRect(px, py - 20, tw + 10, 20);
              ctx.fillStyle = "#fff";
              ctx.fillText(text, px + 5, py - 5);
            }
          }
        }
      }

      if (running) {
        timer = setTimeout(loop, DETECT_INTERVAL_MS);
      }
    };

    loop();

    return () => {
      running = false;
      if (timer) clearTimeout(timer);
    };
  }, [streaming]);

  return (
    <article
      ref={containerRef}
      className="relative aspect-video w-full overflow-hidden rounded-[10px] bg-black border-2 border-[#f0652c] shadow-[0_0_0_3px_rgba(240,101,44,0.14)]"
    >
      {error ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-[#ef4444] text-[12px] tracking-[0.08em] bg-[#0d0d0d] px-4 text-center">
          <span>WEBCAM UNAVAILABLE</span>
          <span className="text-[10px] tracking-[0.04em] text-[#5c5c5c]">{error}</span>
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            muted
            playsInline
            className="block h-full w-full object-cover"
          />
          <canvas
            ref={overlayRef}
            className="absolute inset-0 h-full w-full pointer-events-none"
          />
          {!streaming ? (
            <div className="absolute inset-0 flex items-center justify-center text-[#8a8a8a] text-[12px] tracking-[0.08em] bg-[#0d0d0d]">
              STARTING WEBCAM
            </div>
          ) : null}
        </>
      )}

      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_top,rgba(0,0,0,0.55)_0%,rgba(0,0,0,0)_34%)]" />
      <div className="absolute left-3 bottom-2.5 flex items-center gap-[7px]">
        <span
          className="w-[7px] h-[7px] rounded-full shrink-0"
          style={{
            background: error ? "#ef4444" : "#f0652c",
            boxShadow: streaming ? "0 0 6px #f0652c" : "none",
          }}
        />
        <span className="text-[12px] font-semibold text-white tracking-[0.02em] [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
          {label}
        </span>
        {streaming ? (
          <span className="text-[9px] font-bold uppercase tracking-[0.06em] text-[#f0652c] bg-[rgba(240,101,44,0.2)] px-1.5 py-0.5 rounded">
            {checking ? "Checking…" : "Motion"}
          </span>
        ) : null}
      </div>

      {onClose ? (
        <button
          type="button"
          title="Turn off webcam"
          onClick={onClose}
          className="absolute right-2.5 top-2.5 w-6 h-6 flex items-center justify-center rounded-full border-none bg-[rgba(0,0,0,0.5)] text-[rgba(255,255,255,0.85)] cursor-pointer hover:text-white"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      ) : null}
    </article>
  );
}
