import { NextResponse } from "next/server";
import { getGeminiApiKey, getGeminiModel } from "@/lib/geminiAnalyze";

export const dynamic = "force-dynamic";

/** Health check for dashboard aiReady gate. */
export async function GET(): Promise<NextResponse> {
  const key = getGeminiApiKey();
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "GEMINI_API_KEY is not set" },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, mode: "gemini", model: getGeminiModel() });
}
