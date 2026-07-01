import { NextResponse } from "next/server";
import { resolveRtspStreamUrl } from "@/app/api/cameras/resolveRtspStreamUrl";
import { getBufferedSnapshot } from "@/app/services/rtspSnapshotPool";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cameraId = searchParams.get("cameraId") ?? "unknown";
  const streamUrl = searchParams.get("streamUrl") ?? "";
  const rtspUrl = await resolveRtspStreamUrl(cameraId, streamUrl, request.url);

  if (!rtspUrl || (!rtspUrl.startsWith("rtsp://") && !rtspUrl.startsWith("rtsps://"))) {
    return NextResponse.json({ error: "Invalid RTSP URL" }, { status: 400 });
  }

  const { jpeg, error } = await getBufferedSnapshot(cameraId, rtspUrl, request.signal);
  if (!jpeg) {
    console.info(
      `[snapshot] cameraId=${cameraId} unavailable${error ? ` (${error})` : ""}`,
    );
    return new Response("Snapshot unavailable", { status: 503 });
  }

  const body = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) as ArrayBuffer;
  return new Response(body, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
    },
  });
}
