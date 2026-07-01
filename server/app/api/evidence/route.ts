import { NextResponse } from "next/server";
import { getEvidenceBindings } from "@/lib/evidenceBindings";
import { verifyClientServerAuth } from "@/lib/evidenceAuth";
import { parseEvidencePostBody, persistEvidenceEvent } from "@/lib/evidencePost";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const authError = verifyClientServerAuth(request.headers.get("authorization"));
  if (authError) {
    const status = authError === "Unauthorized" ? 401 : 503;
    return NextResponse.json({ error: authError }, { status });
  }

  const bindings = getEvidenceBindings();
  if (!bindings) {
    return NextResponse.json(
      { error: "Evidence storage bindings are not configured (D1/R2 — see issue #8)" },
      { status: 503 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseEvidencePostBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = await persistEvidenceEvent(bindings, parsed);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save evidence";
    console.error("[api/evidence]", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
