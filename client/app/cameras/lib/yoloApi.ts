export function yoloDetectEndpoint(cameraId: string): string {
  return `/api/gemini/${encodeURIComponent(cameraId)}`;
}

export type YoloFilterResult = {
  cameraId?: string;
  has_person?: boolean;
  image?: string | null;
  error?: string;
};

export async function postYoloFilter(
  cameraId: string,
  image: string,
  signal?: AbortSignal,
): Promise<YoloFilterResult | null> {
  try {
    const res = await fetch(yoloDetectEndpoint(cameraId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as YoloFilterResult;
  } catch {
    return null;
  }
}
