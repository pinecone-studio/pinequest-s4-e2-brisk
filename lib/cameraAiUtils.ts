import type { Detection } from "./yoloDecode";
import type { EvidenceEvent } from "./evidence";
import { ALERT_THRESHOLD } from "./modelConfig";
import type { FrameSource } from "./frameSource";
import { getSourceSize } from "./frameSource";

const CIGARETTE_COLOR = "#ef4444";
const VAPE_COLOR = "#a855f7";
const LITTER_COLOR = "#f97316";
const PERSON_COLOR = "#3b82f6";
const THUMB_WIDTH = 200;

type ViolationKind = {
  label: "Cigarette" | "Vape" | "Litter";
  type: "smoking" | "vape" | "litter";
};

function getColor(label: string): string {
  if (label === "Cigarette") return CIGARETTE_COLOR;
  if (label === "Vape") return VAPE_COLOR;
  if (label === "Person") return PERSON_COLOR;
  if (label === "Littering") return LITTER_COLOR;
  if (label === "Dropped") return "#eab308";
  return LITTER_COLOR;
}

export function drawDetectionBoxes(
  overlay: HTMLCanvasElement,
  dets: Detection[],
  displayW: number,
  displayH: number,
): void {
  overlay.width = displayW;
  overlay.height = displayH;
  const ctx = overlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, displayW, displayH);

  for (const det of dets) {
    const [x1, y1, x2, y2] = det.box;
    const color = getColor(det.label);
    const isAlert = det.label !== "Person" && det.confidence >= ALERT_THRESHOLD;
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

export async function captureEvidenceFromSource(
  source: FrameSource,
  cameraId: string,
  sourceLabel: string,
  kind: ViolationKind,
  confidence: number,
  onEvent?: (event: EvidenceEvent) => void,
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

  const time = Date.now();
  let savedPath: string | null = null;
  let saveError: string | undefined;

  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.9),
  );

  if (blob) {
    const form = new FormData();
    form.append("file", blob, "snapshot.jpg");
    form.append("cameraId", cameraId);
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
      } else {
        saveError = data.error ?? `HTTP ${res.status}`;
      }
    } catch (err) {
      saveError = err instanceof Error ? err.message : "network error";
    }
  } else {
    saveError = "could not encode frame";
  }

  onEvent?.({
    id: `${time}-${cameraId}-${kind.type}`,
    source: sourceLabel,
    label: kind.label,
    confidence,
    time,
    thumb,
    savedPath,
    saveError,
  });
}

export const CIGARETTE_KIND: ViolationKind = { label: "Cigarette", type: "smoking" };
export const VAPE_KIND: ViolationKind = { label: "Vape", type: "vape" };
export const LITTER_KIND: ViolationKind = { label: "Litter", type: "litter" };
