import { NextRequest, NextResponse } from "next/server";
import { forwardToBackend } from "@/lib/backendProxy";
import { analyzeCameraFrames } from "@/lib/geminiAnalyze";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ cameraId: string }> };

/** Dashboard live analysis — Gemini on client (server /api/gemini stays YOLO-only). */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { cameraId } = await context.params;
    const body = await request.json();
    const images: string[] = Array.isArray(body.images)
      ? body.images.filter((v: unknown) => typeof v === "string")
      : typeof body.image === "string"
        ? [body.image]
        : [];

    if (images.length === 0) {
      return NextResponse.json({ error: "images or image is required" }, { status: 400 });
    }

    const result = await analyzeCameraFrames(cameraId, images);
    return NextResponse.json({
      detections: result.detections,
      summary: result.summary,
      model: result.model,
      cameraId: result.cameraId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gemini analysis failed";
    const status =
      err instanceof Error && "status" in err && typeof err.status === "number"
        ? err.status
        : 500;
    console.error("[client/api/gemini]", err);
    return NextResponse.json({ error: message }, { status });
  }
}

/** YOLO person-gate health still served by backend. */
export async function GET(request: NextRequest, context: RouteContext) {
  return forwardToBackend(request);
}
