import { NextResponse } from "next/server";
import {
  type CameraSettings,
  getMaskedRuntimeSettings,
  updateRuntimeSettings,
} from "@/app/services/cameraSettingsStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseSettingsBody(body: unknown): Partial<CameraSettings> {
  if (!body || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const partial: Partial<CameraSettings> = {};

  if ("unifi_api_key" in record) {
    partial.unifi_api_key =
      record.unifi_api_key === null
        ? null
        : typeof record.unifi_api_key === "string"
          ? record.unifi_api_key
          : null;
  }
  if ("unifi_protect_host" in record) {
    partial.unifi_protect_host =
      record.unifi_protect_host === null
        ? null
        : typeof record.unifi_protect_host === "string"
          ? record.unifi_protect_host
          : null;
  }
  if ("unifi_protect_username" in record) {
    partial.unifi_protect_username =
      record.unifi_protect_username === null
        ? null
        : typeof record.unifi_protect_username === "string"
          ? record.unifi_protect_username
          : null;
  }
  if ("unifi_protect_password" in record) {
    partial.unifi_protect_password =
      record.unifi_protect_password === null
        ? null
        : typeof record.unifi_protect_password === "string"
          ? record.unifi_protect_password
          : null;
  }

  return partial;
}

export async function GET() {
  return NextResponse.json(getMaskedRuntimeSettings());
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const updated = updateRuntimeSettings(parseSettingsBody(body));
    return NextResponse.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request body";
    return NextResponse.json({ detail: message }, { status: 400 });
  }
}
