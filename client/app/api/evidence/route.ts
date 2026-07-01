import { NextRequest, NextResponse } from "next/server";

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

/** Browser → client → server proxy for JSON evidence contract (§3). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = clientServerSecret();
  if (!secret) {
    return NextResponse.json({ error: "CLIENT_SERVER_SECRET is not configured" }, { status: 503 });
  }

  const body = await request.text();
  const target = `${serverBaseUrl()}/api/evidence`;

  const res = await fetch(target, {
    method: "POST",
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = clientServerSecret();
  if (!secret) {
    return NextResponse.json({ error: "CLIENT_SERVER_SECRET is not configured" }, { status: 503 });
  }

  const incoming = new URL(request.url);
  const target = `${serverBaseUrl()}/api/evidence${incoming.search}`;

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
