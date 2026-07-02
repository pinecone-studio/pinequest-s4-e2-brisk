import { NextResponse } from "next/server";
import { getEvidenceBindings } from "@/lib/evidenceBindings";
import { verifyClientServerAuth } from "@/lib/evidenceAuth";
import { updateEvidenceStatus, type EvidenceStatus } from "@/lib/evidenceEventsDb";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function authFailureResponse(authError: string): NextResponse {
  const status = authError === "Unauthorized" ? 401 : 503;
  return NextResponse.json({ error: authError }, { status });
}

const VALID_STATUS = new Set<EvidenceStatus>(["active", "handled"]);

/** Update an event's lifecycle status (active -> handled when trash is removed). */
export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  const authError = verifyClientServerAuth(request.headers.get("authorization"));
  if (authError) return authFailureResponse(authError);

  const bindings = getEvidenceBindings();
  if (!bindings) {
    return NextResponse.json(
      { error: "Evidence storage bindings are not configured." },
      { status: 503 },
    );
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const status = (raw as { status?: unknown }).status;
  if (typeof status !== "string" || !VALID_STATUS.has(status as EvidenceStatus)) {
    return NextResponse.json(
      { error: "status must be one of: active, handled" },
      { status: 400 },
    );
  }

  try {
    const updated = await updateEvidenceStatus(bindings.db, id, status as EvidenceStatus);
    if (!updated) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    return NextResponse.json({ id, status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update evidence";
    console.error("[api/evidence PATCH]", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
