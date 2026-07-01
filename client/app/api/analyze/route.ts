import { NextResponse } from "next/server";
import { parseAnalyzePostBody, runAnalyzePipeline } from "@/lib/analyzePipeline";
import { forwardAnalyzeViolations } from "@/lib/evidenceForward";
import { verifyModelsClientAuth } from "@/lib/modelsAuth";

export const dynamic = "force-dynamic";

/**
 * Models → Client entry point (architecture §3).
 * Returns ack only; violations ≥ threshold are forwarded to the server.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const authError = verifyModelsClientAuth(request.headers.get("authorization"));
  if (authError) {
    const status = authError === "Unauthorized" ? 401 : 503;
    return NextResponse.json({ error: authError }, { status });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseAnalyzePostBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = await runAnalyzePipeline(parsed);
    const { forwarded, skipped } = await forwardAnalyzeViolations(result);
    if (forwarded > 0 || skipped > 0) {
      console.info(
        `[api/analyze:${parsed.cameraId}] violations forwarded=${forwarded} skipped(cooldown)=${skipped}`,
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analysis failed";
    const status =
      err instanceof Error && "status" in err && typeof err.status === "number"
        ? err.status
        : 500;
    console.error("[api/analyze]", err);
    return NextResponse.json({ error: message }, { status });
  }
}
