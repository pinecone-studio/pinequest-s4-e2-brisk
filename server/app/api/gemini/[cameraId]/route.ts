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
    const yoloResponse = await fetch(yoloUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64Image }),
    });

    if (!yoloResponse.ok) {
      console.error(`❌ [yolo:${cameraId}] Filter server failed or offline.`);
      return NextResponse.json(
        { success: false, error: "YOLO filter server error" },
        { status: 502 },
      );
    }

    const { has_person } = await yoloResponse.json();
    console.log(`[yolo:${cameraId}] Inference completed. Has Person: ${has_person}`);

    // 3. ХҮН БАЙВАЛ: true утга болон Base64 зургийг хамт буцаана
    if (has_person) {
      return NextResponse.json({
        cameraId,
        has_person: true,
        image: base64Image, // Дараагийн хүн энийг аваад Gemini руу шиднэ
      });
    }

    // 4. ХҮН БАЙХГҮЙ БОЛ: false гээд зургийг null болгож буцаана
    return NextResponse.json({
      cameraId,
      has_person: false,
      image: null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ API Error:", error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// Хөнгөхөн Health Check
export async function GET(_request: NextRequest, context: RouteContext) {
  const { cameraId } = await context.params;
  return NextResponse.json({ ok: true, cameraId, mode: "YOLO-Base64-Pass" });
}
