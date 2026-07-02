import { NextRequest, NextResponse } from "next/server";

type RouteContext = { params: Promise<{ cameraId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { cameraId } = await context.params;
    const body = await request.json();

    // 1. Камераас ирж буй Base64 зургийг салгаж авах
    const base64Image = body.image || (body.images && body.images[0]);

    if (!base64Image) {
      return NextResponse.json(
        { success: false, error: "No image provided from camera client" },
        { status: 400 },
      );
    }

    // 2. Локал Python LitServe рүү илгээж хүн байгааг шалгуулах
    const yoloUrl = process.env.YOLO_API_URL || "http://localhost:8000/predict";
    let yoloResponse: Response;
    try {
      yoloResponse = await fetch(yoloUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64Image }),
      });
    } catch (error: unknown) {
      const refused =
        error instanceof TypeError &&
        error.cause instanceof AggregateError &&
        error.cause.errors.some(
          (e: unknown) => e instanceof Error && "code" in e && e.code === "ECONNREFUSED",
        );
      console.error(
        `❌ [yolo:${cameraId}] Models service unreachable at ${yoloUrl} — start: cd models && python server.py`,
      );
      return NextResponse.json(
        {
          success: false,
          error: refused
            ? "YOLO models service offline (ECONNREFUSED)"
            : "YOLO models service unreachable",
        },
        { status: 503 },
      );
    }

    if (!yoloResponse.ok) {
      console.error(`❌ [yolo:${cameraId}] Filter server failed or offline.`);
      return NextResponse.json(
        { success: false, error: "YOLO filter server error" },
        { status: 502 },
      );
    }

    const yolo = await yoloResponse.json();
    const hasPerson = yolo.has_person === true;
    const hasSmoke = yolo.has_smoke === true;
    const hasLitter = yolo.has_litter === true;
    // Fallback: if an older models build without smoke/litter is deployed, gate
    // Gemini on has_person alone (previous behaviour) so the pipeline still runs.
    const shouldAnalyze =
      typeof yolo.should_analyze === "boolean" ? yolo.should_analyze : hasPerson;

    console.log(
      `[yolo:${cameraId}] person=${hasPerson} smoke=${hasSmoke} litter=${hasLitter} -> analyze=${shouldAnalyze}`,
    );

    // Return the person image only when a person is present (for the UI crop);
    // should_analyze is what gates the Gemini call downstream.
    return NextResponse.json({
      cameraId,
      has_person: hasPerson,
      has_smoke: hasSmoke,
      has_litter: hasLitter,
      should_analyze: shouldAnalyze,
      image: hasPerson ? base64Image : null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`❌ [yolo:${(await context.params).cameraId}]`, error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// Хөнгөхөн Health Check
export async function GET(_request: NextRequest, context: RouteContext) {
  const { cameraId } = await context.params;
  return NextResponse.json({ ok: true, cameraId, mode: "YOLO-Base64-Pass" });
}
