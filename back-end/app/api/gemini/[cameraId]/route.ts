import { NextRequest, NextResponse } from "next/server";
import { analyzeCameraFrames, getGeminiApiKey, getGeminiModel } from "@/lib/geminiAnalyze";

export const maxDuration = 60;

type RouteContext = { params: Promise<{ cameraId: string }> };

/** Per-camera Gemini analysis — one endpoint per camera, no shared queue. */
export async function GET(_req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { cameraId } = await context.params;
  if (!getGeminiApiKey()) {
    return NextResponse.json({ error: "GEMINI_API_KEY is not set on the server" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, cameraId, model: getGeminiModel() });
}

export async function POST(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { cameraId } = await context.params;

  if (!getGeminiApiKey()) {
    return NextResponse.json({ error: "GEMINI_API_KEY is not set" }, { status: 500 });
  }

  let images: string[];
  try {
    const body = await req.json();
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
