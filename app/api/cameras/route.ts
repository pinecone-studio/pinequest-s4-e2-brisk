import { NextResponse } from "next/server";
import { getEnabledCameras, loadCameraConfig } from "./serverCameraConfig";

export const dynamic = "force-dynamic";

export async function GET() {
  const cameras = await loadCameraConfig();
  return NextResponse.json(getEnabledCameras(cameras));
}
