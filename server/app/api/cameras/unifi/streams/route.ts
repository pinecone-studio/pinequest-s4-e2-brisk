import { NextResponse } from "next/server";
import { getEffectiveUniFiCredentials } from "@/app/services/cameraSettingsStore";
import {
  resolveCameraStreams,
  UniFiRtspAuthError,
  UniFiRtspPermissionError,
} from "@/app/services/unifiRtsp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const { apiKey, protectHost } = getEffectiveUniFiCredentials();

  if (!apiKey || !protectHost) {
    return NextResponse.json(
      { detail: "UniFi API key and Protect host are required." },
      { status: 400 },
    );
  }

  try {
    const cameras = await resolveCameraStreams(apiKey, protectHost);
    return NextResponse.json(cameras);
  } catch (error) {
    if (error instanceof UniFiRtspAuthError) {
      return NextResponse.json({ detail: error.message }, { status: 401 });
    }
    if (error instanceof UniFiRtspPermissionError) {
      return NextResponse.json({ detail: error.message }, { status: 403 });
    }

    const message = error instanceof Error ? error.message : "UniFi stream resolution failed";
    return NextResponse.json({ detail: message }, { status: 502 });
  }
}
