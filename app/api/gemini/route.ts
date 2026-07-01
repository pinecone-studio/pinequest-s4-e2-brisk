import { NextResponse } from "next/server";
import { getGeminiApiKey, getGeminiModel } from "@/lib/geminiAnalyze";

/** Global Gemini health check (any camera can use the same API key). */
export async function GET(): Promise<NextResponse> {
  if (!getGeminiApiKey()) {
    return NextResponse.json({ error: "GEMINI_API_KEY is not set on the server" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, model: getGeminiModel() });
}
