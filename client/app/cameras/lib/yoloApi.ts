import type { Detection } from "@/lib/detection";

export function geminiAnalyzeEndpoint(cameraId: string): string {
  return `/api/gemini/${encodeURIComponent(cameraId)}`;
}

/** @deprecated Use geminiAnalyzeEndpoint — route now runs Gemini, not YOLO. */
export const yoloDetectEndpoint = geminiAnalyzeEndpoint;

export type GeminiAnalyzeApiResult = {
  cameraId?: string;
  detections?: Detection[];
  summary?: string;
  model?: string;
  error?: string;
};

export async function postGeminiAnalyze(
  cameraId: string,
  image: string,
  signal?: AbortSignal,
): Promise<GeminiAnalyzeApiResult | null> {
  try {
    const res = await fetch(geminiAnalyzeEndpoint(cameraId), {
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

/** @deprecated Renamed to postGeminiAnalyze when /api/gemini moved to client-side Gemini. */
export const postYoloFilter = postGeminiAnalyze;
