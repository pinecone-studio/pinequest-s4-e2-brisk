import { NextRequest, NextResponse } from "next/server";
import { analyzeCameraFrames, getGeminiApiKey, getGeminiModel } from "@/lib/geminiAnalyze";

export const maxDuration = 60;

/** Global Gemini health check (any camera can use the same API key). */
export async function GET(): Promise<NextResponse> {
  if (!getGeminiApiKey()) {
    return NextResponse.json({ error: "GEMINI_API_KEY is not set on the server" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, model: getGeminiModel() });
}

/**
 * Frame analysis. Mirrors /api/gemini/[cameraId] but takes an optional cameraId
 * in the body, so callers that POST to the bare /api/gemini still work instead
 * of getting a 405. Detection callers should pass { images, cameraId }.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!getGeminiApiKey()) {
    return NextResponse.json({ error: "GEMINI_API_KEY is not set" }, { status: 500 });
  }

  let images: string[];
  let cameraId = "camera";
  try {
    const body = await req.json();
    if (typeof body.cameraId === "string" && body.cameraId.trim()) {
      cameraId = body.cameraId.trim();
    }
    if (Array.isArray(body.images) && body.images.length > 0) {
      images = body.images.map((i: unknown) => String(i ?? "")).filter(Boolean);
    } else if (body.image) {
      images = [String(body.image)];
    } else {
      throw new Error("missing image");
    }
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  try {
    const result = await analyzeCameraFrames(cameraId, images);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "detection failed";
    const status =
      err instanceof Error && "status" in err && typeof err.status === "number"
        ? err.status
        : message.toLowerCase().includes("high demand") ||
            message.toLowerCase().includes("rate")
          ? 503
          : 500;
    console.error(`[gemini:${cameraId}]`, message);
    return NextResponse.json({ error: message, cameraId }, { status });
  }
}
