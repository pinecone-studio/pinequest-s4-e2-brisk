import { NextResponse } from "next/server";
import { getEvidenceBindings } from "@/lib/evidenceBindings";
import { verifyClientServerAuth } from "@/lib/evidenceAuth";
import { listEvidenceEvents } from "@/lib/evidenceEventsDb";
import { parseListEvidenceQuery } from "@/lib/evidenceListQuery";
import { parseEvidencePostBody, persistEvidenceEvent } from "@/lib/evidencePost";

export const dynamic = "force-dynamic";

function authFailureResponse(authError: string): NextResponse {
  const status = authError === "Unauthorized" ? 401 : 503;
  return NextResponse.json({ error: authError }, { status });
}

function bindingsFailureResponse(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Evidence storage bindings are not configured. Set EVIDENCE_DEV_STORAGE=memory in server/.env.local for local dev, or provision D1/R2 via Wrangler (#8).",
    },
    { status: 503 },
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  const authError = verifyClientServerAuth(request.headers.get("authorization"));
  if (authError) return authFailureResponse(authError);

  const bindings = getEvidenceBindings();
  if (!bindings) return bindingsFailureResponse();

  const url = new URL(request.url);
  const parsed = parseListEvidenceQuery(url.searchParams);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const events = await listEvidenceEvents(bindings.db, {
      cameraId: parsed.cameraId,
      limit: parsed.limit,
      offset: parsed.offset,
    });
    return NextResponse.json({
      events,
      limit: parsed.limit,
      offset: parsed.offset,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list evidence";
    console.error("[api/evidence GET]", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const authError = verifyClientServerAuth(request.headers.get("authorization"));
  if (authError) return authFailureResponse(authError);

  const bindings = getEvidenceBindings();
  if (!bindings) return bindingsFailureResponse();

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
    console.error("[api/evidence POST]", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
