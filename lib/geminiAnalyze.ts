import type { Detection } from "./detection";
import { markGeminiRateLimited, withGeminiSlot } from "./geminiQueue";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ENDPOINT = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const PROMPT = `You are a surveillance vision system that monitors for SMOKING and LITTERING. Look at this single frame and report:
- "Cigarette": a cigarette held in a hand or at the mouth, lit or unlit.
- "Vape": an e-cigarette / vape pen / pod held near the mouth or hand.
- "Litter": a bottle, can, cup, wrapper, bag, or plastic item being held about to be dropped, mid-drop, or already lying discarded.
- "Person": each visible person (secondary — context only).

Be conservative: only report a Cigarette/Vape/Litter when you can CLEARLY see it. When in doubt, do NOT report it. Only assign confidence above 0.7 when you are genuinely confident.

Respond with STRICT JSON of this exact shape, no markdown:
{"summary":"one short sentence describing what you see and whether anything is illegal","detections":[{"label":"Cigarette|Vape|Litter|Person","confidence":0.0-1.0}]}

If nothing notable is present, return {"summary":"...","detections":[]}.`;

const PROMPT_TEMPORAL = `You are a surveillance vision system monitoring for SMOKING and LITTERING. You are given SEVERAL frames from the SAME fixed camera, in time order (oldest first). Use the SEQUENCE to judge actions over time.

Report:
- "Cigarette": a cigarette held in a hand or at the mouth, lit or unlit.
- "Vape": an e-cigarette / vape pen / pod held near the mouth or hand.
- "Litter": LITTERING AS AN ACTION — a person carries an object and then DROPS or DISCARDS it. Someone simply carrying a bottle with no drop is NOT littering.
- "Person": each visible person (secondary — context only).

Be conservative. When in doubt, do NOT report it.

Respond with STRICT JSON of this exact shape, no markdown:
{"summary":"one short sentence describing what happened and whether anything is illegal","detections":[{"label":"Cigarette|Vape|Litter|Person","confidence":0.0-1.0}]}

If nothing notable is present, return {"summary":"...","detections":[]}.`;

interface RawDetection {
  label?: string;
  confidence?: number;
}

const VALID_LABELS = new Set(["Cigarette", "Vape", "Litter", "Person"]);
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function toDetection(raw: RawDetection): Detection | null {
  if (!raw || typeof raw.label !== "string" || !VALID_LABELS.has(raw.label)) return null;
  return {
    label: raw.label,
    confidence: typeof raw.confidence === "number" ? clamp01(raw.confidence) : 0.5,
  };
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

function parseImage(image: string): { data: string; mimeType: string } {
  const match = /^data:(image\/[a-zA-Z+]+);base64,([\s\S]*)$/.exec(image);
  if (match) return { mimeType: match[1], data: match[2] };
  return { mimeType: "image/jpeg", data: image };
}

export function getGeminiApiKey(): string {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
}

export function getGeminiModel(): string {
  return MODEL;
}

export interface GeminiAnalyzeResult {
  cameraId: string;
  detections: Detection[];
  summary: string;
  model: string;
}

export async function analyzeCameraFrames(
  cameraId: string,
  images: string[],
): Promise<GeminiAnalyzeResult> {
  const key = getGeminiApiKey();
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const MAX_FRAMES = 8;
  const frames = images.filter(Boolean).slice(0, MAX_FRAMES);
  if (frames.length === 0) {
    throw new Error("missing image");
  }

  const isTemporal = frames.length > 1;
  const parts: Array<Record<string, unknown>> = [
    { text: `${isTemporal ? PROMPT_TEMPORAL : PROMPT}\n\nCamera ID: ${cameraId}` },
  ];
  for (const img of frames) {
    const { data, mimeType } = parseImage(img);
    parts.push({ inline_data: { mime_type: mimeType, data } });
  }

  const requestBody = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  });

  const RETRY_STATUSES = new Set([429, 503]);
  const MAX_ATTEMPTS = 2;

  let res: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await withGeminiSlot(() =>
      fetch(ENDPOINT(MODEL, key), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      }),
    );
    if (res.ok || !RETRY_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) break;
    markGeminiRateLimited();
    console.warn(`[gemini:${cameraId}] ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying`);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }

  if (!res) {
    throw new Error("no response from Gemini");
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let message = `Gemini request failed (HTTP ${res.status})`;
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      /* keep generic message */
    }
    if (RETRY_STATUSES.has(res.status)) {
      markGeminiRateLimited();
    }
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  const rawBody = await res.text();
  let payload: {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new Error("empty or invalid response from Gemini");
  }

  const text: string =
    payload?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "{}";

  const parsed = extractJson(text);
  const list: RawDetection[] = Array.isArray(parsed)
    ? (parsed as RawDetection[])
    : Array.isArray((parsed as { detections?: RawDetection[] })?.detections)
      ? (parsed as { detections: RawDetection[] }).detections
      : [];

  const detections = list.map(toDetection).filter((d): d is Detection => d !== null);
  const summary =
    typeof (parsed as { summary?: unknown })?.summary === "string"
      ? ((parsed as { summary: string }).summary).slice(0, 240)
      : "";

  return { cameraId, detections, summary, model: MODEL };
}
