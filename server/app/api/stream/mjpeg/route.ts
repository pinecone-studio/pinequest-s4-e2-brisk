import { NextResponse } from "next/server";
import { resolveRtspStreamUrl } from "@/app/api/cameras/resolveRtspStreamUrl";
import { subscribeMjpegStream } from "@/app/services/rtspSnapshotPool";
import { MJPEG_BOUNDARY } from "@/lib/ffmpegStream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

function framePart(jpeg: Uint8Array): Uint8Array {
  const header = encoder.encode(
    `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
  );
  const footer = encoder.encode("\r\n");
  const out = new Uint8Array(header.length + jpeg.length + footer.length);
  out.set(header, 0);
  out.set(jpeg, header.length);
  out.set(footer, header.length + jpeg.length);
  return out;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cameraId = searchParams.get("cameraId") ?? "unknown";
  const streamUrl = searchParams.get("streamUrl") ?? "";
  const rtspUrl = await resolveRtspStreamUrl(cameraId, streamUrl, request.url);

  if (!rtspUrl || (!rtspUrl.startsWith("rtsp://") && !rtspUrl.startsWith("rtsps://"))) {
    return NextResponse.json({ error: "Invalid RTSP URL" }, { status: 400 });
  }

  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = subscribeMjpegStream(
        cameraId,
        rtspUrl,
        {
          onFrame: (jpeg) => {
            try {
              controller.enqueue(framePart(jpeg));
            } catch {
              unsubscribe?.();
            }
          },
          onError: () => {
            try {
              controller.close();
            } catch {
              // Stream already closed.
            }
          },
        },
        request.signal,
      );

      request.signal.addEventListener(
        "abort",
        () => {
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            // Stream already closed.
          }
        },
        { once: true },
      );
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Connection: "keep-alive",
    },
  });
}
