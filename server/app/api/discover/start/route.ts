import { NextResponse } from "next/server";
import { startDiscoveryScan } from "@/app/services/cameraDiscovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let subnet: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body === "object" && typeof (body as { subnet?: unknown }).subnet === "string") {
      subnet = (body as { subnet: string }).subnet;
    }
  } catch {
    // Empty body is fine — we auto-detect the subnet.
  }

  const state = await startDiscoveryScan(subnet);
  return NextResponse.json(state);
}
