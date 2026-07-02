import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function serverBaseUrl(): string {
  return (process.env.SERVER_URL ?? process.env.BACKEND_URL ?? "http://localhost:3001").replace(
    /\/$/,
    "",
  );
}

function clientServerSecret(): string | null {
  return process.env.CLIENT_SERVER_SECRET?.trim() || null;
}

/** Browser → client → server proxy for the Skip Login demo bypass. */
export async function GET(): Promise<NextResponse> {
  const secret = clientServerSecret();
  if (!secret) {
    return NextResponse.json({ error: "CLIENT_SERVER_SECRET is not configured" }, { status: 503 });
  }

  const target = `${serverBaseUrl()}/api/session/last-used`;

  const res = await fetch(target, {
    headers: { Authorization: `Bearer ${secret}` },
    cache: "no-store",
  });

  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
  });
}
