import { NextResponse } from "next/server";

const YOLO_API_URL = process.env.YOLO_API_URL ?? "http://localhost:8000/predict";

/** Global AI health check — YOLO filter mode (Gemini bypassed). */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, mode: "yolo", endpoint: YOLO_API_URL });
}
