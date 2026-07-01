import { NextResponse } from "next/server";
import { getEnabledCameras, loadCameraConfig } from "./serverCameraConfig";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cameras = await loadCameraConfig();
    return NextResponse.json(getEnabledCameras(cameras));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
