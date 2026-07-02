import type { Detection } from "@/lib/detection";

export function yoloPersonGateEndpoint(cameraId: string): string {
  return `/api/yolo/${encodeURIComponent(cameraId)}`;
}

export function geminiVisionEndpoint(cameraId: string): string {
  return `/api/vision/${encodeURIComponent(cameraId)}`;
}

export type YoloPersonGateResult = {
  cameraId?: string;
  has_person?: boolean;
  /** Normalized [x1,y1,x2,y2] person boxes — used to tell if a person is on the trash. */
  person_boxes?: number[][];
  has_smoke?: boolean;
  has_litter?: boolean;
  /** Normalized [x1,y1,x2,y2] litter boxes — tracked across frames. */
  litter_boxes?: number[][];
  /** person AND (smoke OR litter) — the gate for calling Gemini. */
  should_analyze?: boolean;
  image?: string | null;
  error?: string;
};

export type GeminiAnalyzeApiResult = {
  cameraId?: string;
  detections?: Detection[];
  summary?: string;
  model?: string;
  error?: string;
};

/** Mark an evidence event handled/active (browser → client proxy → server). */
export async function patchEvidenceStatus(
  id: string,
  status: "active" | "handled",
): Promise<boolean> {
  try {
    const res = await fetch(`/api/evidence/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** YOLO person gate via server → models LitServe. No Gemini call. */
export async function postYoloPersonGate(
  cameraId: string,
  image: string,
  signal?: AbortSignal,
): Promise<YoloPersonGateResult | null> {
  try {
    const res = await fetch(yoloPersonGateEndpoint(cameraId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as YoloPersonGateResult;
  } catch {
    return null;
  }
}

/** Gemini behavior analysis — call only after postYoloPersonGate returns has_person. */
export async function postGeminiAnalyze(
  cameraId: string,
  image: string,
  signal?: AbortSignal,
): Promise<GeminiAnalyzeApiResult | null> {
  try {
    const res = await fetch(geminiVisionEndpoint(cameraId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as GeminiAnalyzeApiResult;
  } catch {
    return null;
  }
}

/** Multi-frame Gemini (temporal litter check). */
export async function postGeminiAnalyzeFrames(
  cameraId: string,
  images: string[],
  signal?: AbortSignal,
): Promise<GeminiAnalyzeApiResult | null> {
  try {
    const res = await fetch(geminiVisionEndpoint(cameraId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images }),
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as GeminiAnalyzeApiResult;
  } catch {
    return null;
  }
}
