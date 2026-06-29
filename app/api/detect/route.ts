import { NextRequest, NextResponse } from "next/server";

// Groq vision detection proxy. Keeps GROQ_API_KEY server-side; the browser
// never sees it. POST a JPEG (base64) and get back normalized detections that
// match the app's Detection contract ({ label, confidence, box:[x1,y1,x2,y2] }).
//
// NOTE: Llama vision is a general LLM, not a detector — bounding boxes are
// approximate. We keep the box contract so the existing overlay/panel work.

// Use || (not ??) so an empty GROQ_MODEL="" in .env still falls back to the default.
const MODEL = process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT =
  "You are a surveillance vision system that detects smoking and littering. Respond with JSON only, no prose.";

const USER_PROMPT = `You monitor for SMOKING and LITTERING. Your priority is finding these targets:
- "Cigarette": a cigarette held in a hand or at the mouth, lit or unlit. Look closely at hands and faces — cigarettes are small and thin. If a small white/tan stick is near a person's mouth or fingers, report it.
- "Vape": an e-cigarette / vape pen / pod / box mod held near the mouth or hand.
- "Litter": a bottle, can, cup, wrapper, bag, or plastic item being held about to be dropped, mid-drop, or already lying discarded.
- "Person": each visible person (secondary — context only).

Examine hands and the mouth region carefully before deciding. Smoking and litter objects are small; do not ignore them just because they are small. It is fine to report a Cigarette/Vape/Litter with lower confidence (e.g. 0.4) if you are unsure — express your uncertainty in the confidence value rather than omitting it.

Respond with a JSON object of this exact shape:
{"detections":[{"label":"Cigarette|Vape|Litter|Person","confidence":0.0-1.0,"box":[x_min,y_min,x_max,y_max]}]}

Coordinates are normalized 0.0-1.0, origin at top-left. If nothing is present, return {"detections":[]}.`;

interface RawBox {
  label?: string;
  confidence?: number;
  box?: number[];
}

interface Detection {
  label: string;
  confidence: number;
  box: [number, number, number, number]; // x1,y1,x2,y2 normalized [0,1]
}

const VALID_LABELS = new Set(["Cigarette", "Vape", "Litter", "Person"]);
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** LLMs are inconsistent about coordinate scale — accept 0-1, 0-100, or 0-1000. */
function normalizeScale(box: number[]): number[] {
  const max = Math.max(...box.map(Math.abs));
  if (max <= 1) return box;
  if (max <= 100) return box.map((v) => v / 100);
  return box.map((v) => v / 1000);
}

function toDetection(raw: RawBox): Detection | null {
  if (!raw || typeof raw.label !== "string" || !VALID_LABELS.has(raw.label)) return null;
  if (!Array.isArray(raw.box) || raw.box.length !== 4 || raw.box.some((v) => typeof v !== "number"))
    return null;

  const [x1, y1, x2, y2] = normalizeScale(raw.box);
  const box: [number, number, number, number] = [
    clamp01(Math.min(x1, x2)),
    clamp01(Math.min(y1, y2)),
    clamp01(Math.max(x1, x2)),
    clamp01(Math.max(y1, y2)),
  ];
  return {
    label: raw.label,
    confidence: typeof raw.confidence === "number" ? clamp01(raw.confidence) : 0.5,
    box,
  };
}

/** Pull a JSON object/array out of the model's text, tolerating code fences/prose. */
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

/** Health check — confirms the key is configured before the UI flips to "ready". */
export async function GET(): Promise<NextResponse> {
  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json({ error: "GROQ_API_KEY is not set on the server" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, model: MODEL });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GROQ_API_KEY is not set" }, { status: 500 });
  }

  let image: string;
  try {
    const body = await req.json();
    image = String(body.image ?? "");
    if (!image) throw new Error("missing image");
    if (!image.startsWith("data:")) image = `data:image/jpeg;base64,${image}`;
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: USER_PROMPT },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[detect] Groq error", res.status, detail.slice(0, 500));
      let message = `Groq request failed (HTTP ${res.status})`;
      try {
        const parsed = JSON.parse(detail);
        if (parsed?.error?.message) message = parsed.error.message;
      } catch {
        /* keep generic message */
      }
      return NextResponse.json({ error: message, providerStatus: res.status }, { status: res.status });
    }

    const data = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "{}";

    const parsed = extractJson(text);
    const list: RawBox[] = Array.isArray(parsed)
      ? (parsed as RawBox[])
      : Array.isArray((parsed as { detections?: RawBox[] })?.detections)
        ? (parsed as { detections: RawBox[] }).detections
        : [];

    const detections = list
      .map(toDetection)
      .filter((d): d is Detection => d !== null);

    return NextResponse.json({ detections });
  } catch (err) {
    const message = err instanceof Error ? err.message : "detection failed";
    console.error("[detect] error", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
