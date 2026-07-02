import { NextResponse } from "next/server";
import { getAccountsDb } from "@/lib/accountsBindings";
import { verifyClientServerAuth } from "@/lib/evidenceAuth";
import { getMostRecentAccountWithCameraConfigs, touchAccountLastActive } from "@/lib/accountsDb";

export const dynamic = "force-dynamic";

function authFailureResponse(authError: string): NextResponse {
  const status = authError === "Unauthorized" ? 401 : 503;
  return NextResponse.json({ error: authError }, { status });
}

/** Returns the most-recently-active account + its camera setup, and marks it active now (Skip Login). */
export async function GET(request: Request): Promise<NextResponse> {
  const authError = verifyClientServerAuth(request.headers.get("authorization"));
  if (authError) return authFailureResponse(authError);

  const db = getAccountsDb();
  if (!db) {
    return NextResponse.json(
      {
        error:
          "Accounts storage bindings are not configured. Set EVIDENCE_DEV_STORAGE=memory in server/.env.local for local dev, or provision D1 via Wrangler (#8).",
      },
      { status: 503 },
    );
  }

  try {
    const account = await getMostRecentAccountWithCameraConfigs(db);
    if (!account) {
      return NextResponse.json(
        { error: "No accounts found. Run scripts/seed-accounts.ts." },
        { status: 404 },
      );
    }

    const now = Date.now();
    await touchAccountLastActive(db, account.id, now);

    return NextResponse.json({
      account: { id: account.id, name: account.name },
      cameraConfigs: account.cameraConfigs,
      lastActiveAt: now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load last-used account";
    console.error("[api/session/last-used GET]", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
