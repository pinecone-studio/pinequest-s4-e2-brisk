import type { EvidenceEvent } from "./evidence";
import {
  mapToEvidenceEvent,
  type EvidencePostResponse,
} from "./evidenceEventMapping";
import type { FrameSource } from "./frameSource";
import { getSourceSize } from "./frameSource";

const THUMB_WIDTH = 200;

/** Max width sent to /api/gemini — keeps POST bodies small so the dev server stays responsive. */
export const GEMINI_MAX_FRAME_WIDTH = 640;
export const GEMINI_JPEG_QUALITY = 0.72;

type ViolationKind = {
  label: "Cigarette" | "Vape" | "Litter";
  type: "smoking" | "vape" | "litter";
};

function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load frame"));
    img.src = dataUrl;
  });
}

/** Evidence capture from a snapshot data URL (background grid scans). */
export async function captureEvidenceFromDataUrl(
  dataUrl: string,
  cameraId: string,
  sourceLabel: string,
  kind: ViolationKind,
  confidence: number,
  onEvent?: (event: EvidenceEvent) => void,
  note?: string,
): Promise<void> {
  try {
    const img = await loadImageFromDataUrl(dataUrl);
    await captureEvidenceFromSource(
      img,
      cameraId,
      sourceLabel,
      kind,
      confidence,
      onEvent,
      note,
    );
  } catch {
    /* ignore decode errors */
  }
}

export async function captureEvidenceFromSource(
  source: FrameSource,
  cameraId: string,
  sourceLabel: string,
  kind: ViolationKind,
  confidence: number,
  onEvent?: (event: EvidenceEvent) => void,
  note?: string,
): Promise<void> {
  const { width: w, height: h } = getSourceSize(source);
  if (!w || !h) return;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(source, 0, 0, w, h);

  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = THUMB_WIDTH;
  thumbCanvas.height = Math.round((h / w) * THUMB_WIDTH);
  thumbCanvas.getContext("2d")?.drawImage(source, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const thumb = thumbCanvas.toDataURL("image/jpeg", 0.6);

  const occurredAt = Date.now();
  let response: EvidencePostResponse | null = null;
  let saveError: string | undefined;

  const image: string | null = await new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      0.9,
    );
  });

  if (image) {
    try {
      const res = await fetch("/api/evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cameraId,
          label: kind.label,
          confidence,
          occurredAt,
          summary: note ?? null,
          image,
        }),
      });
      const contentType = res.headers.get("content-type") ?? "";
      const data = contentType.includes("application/json")
        ? await res.json()
        : { error: `HTTP ${res.status}` };
      if (res.ok) {
        response = data as EvidencePostResponse;
      } else {
        saveError = (data as { error?: string }).error ?? `HTTP ${res.status}`;
      }
    } catch (err) {
      saveError = err instanceof Error ? err.message : "network error";
    }
  } else {
    saveError = "could not encode frame";
  }

  onEvent?.(
    mapToEvidenceEvent({
      cameraId,
      sourceLabel,
      label: kind.label,
      confidence,
      occurredAt,
      thumb,
      note,
      response,
      saveError,
    }),
  );
}

export const CIGARETTE_KIND: ViolationKind = { label: "Cigarette", type: "smoking" };
export const VAPE_KIND: ViolationKind = { label: "Vape", type: "vape" };
export const LITTER_KIND: ViolationKind = { label: "Litter", type: "litter" };

/** Downscale a loaded <img> to a JPEG data URL suitable for Gemini. */
export function imageToGeminiDataUrl(
  img: HTMLImageElement,
  maxWidth = GEMINI_MAX_FRAME_WIDTH,
  quality = GEMINI_JPEG_QUALITY,
): string | null {
  const { naturalWidth: w, naturalHeight: h } = img;
  if (!w || !h) return null;

  const scale = w > maxWidth ? maxWidth / w : 1;
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, outW, outH);
  return canvas.toDataURL("image/jpeg", quality);
}

/** Capture an ordered burst of downscaled JPEGs for temporal Gemini analysis. */
export async function captureBurstForGemini(
  img: HTMLImageElement,
  frameCount: number,
  intervalMs: number,
  getLiveImage: () => HTMLImageElement | null,
): Promise<string[]> {
  const images: string[] = [];
  for (let f = 0; f < frameCount; f += 1) {
    const live = getLiveImage();
    if (!live || live.naturalWidth === 0) break;
    const dataUrl = imageToGeminiDataUrl(live);
    if (dataUrl) images.push(dataUrl);
    if (f < frameCount - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return images;
}
