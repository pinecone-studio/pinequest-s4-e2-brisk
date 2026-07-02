import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function serverBaseUrl(): string {
  return (process.env.SERVER_URL ?? process.env.BACKEND_URL ?? "http://localhost:3001").replace(
    /\/$/,
    "",
  );
}

function clientServerSecret(): string | null {
  return process.env.CLIENT_SERVER_SECRET?.trim() || null;
}

/** Browser → client → server proxy for evidence status updates (active/handled). */
export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const secret = clientServerSecret();
  if (!secret) {
    return NextResponse.json({ error: "CLIENT_SERVER_SECRET is not configured" }, { status: 503 });
  }

  const { id } = await context.params;
  const body = await request.text();
  const target = `${serverBaseUrl()}/api/evidence/${encodeURIComponent(id)}`;

  const res = await fetch(target, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body,
  });

  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
  });
}
