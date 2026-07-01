import { NextResponse } from "next/server";
import { getDiscoveryState } from "@/app/services/cameraDiscovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const state = getDiscoveryState();
  return NextResponse.json(state);
}
