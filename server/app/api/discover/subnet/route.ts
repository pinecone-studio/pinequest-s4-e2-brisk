import { NextResponse } from "next/server";
import { detectLocalSubnets, getPrimarySubnet } from "@/app/services/cameraDiscovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const subnets = detectLocalSubnets();
  const subnet = getPrimarySubnet();
  return NextResponse.json({ subnet, subnets });
}
