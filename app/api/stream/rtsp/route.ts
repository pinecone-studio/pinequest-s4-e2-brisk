import { NextResponse } from "next/server";
import path from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { resolvePythonBin } from "@/lib/pythonBin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BOUNDARY = "frame";
const OPEN_TIMEOUT_MS = 12000;

interface StreamCandidate {
  label: string;
  pathName: string;
  url: string;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rtspUrl = searchParams.get("url");

  if (!rtspUrl || !rtspUrl.startsWith("rtsp://")) {
    return NextResponse.json({ error: "Invalid RTSP URL" }, { status: 400 });
  }

  let host = "unknown";
  try {
    host = new URL(rtspUrl).hostname;
  } catch {
    return NextResponse.json({ error: "Invalid RTSP URL" }, { status: 400 });
  }

  const candidate: StreamCandidate = {
    label: "dynamic rtsp",
    pathName: "dynamic",
    url: rtspUrl,
  };

  const openedStream = await openStreamDecoder({
    host,
    candidate,
    signal: request.signal,
  });

  if (!openedStream) {
    return new NextResponse("Stream unavailable", { status: 503 });
  }

  let cleanupStream = () => {
    stopDecoder(openedStream.decoder);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanupStream = attachDecoderToStream(openedStream, controller);
    },
    cancel() {
      cleanupStream();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Connection: "keep-alive",
    },
  });
}

interface OpenedStreamDecoder {
  decoder: ChildProcessWithoutNullStreams;
  firstChunk: Uint8Array;
}

async function openStreamDecoder({
  host,
  candidate,
  signal,
}: {
  host: string;
  candidate: StreamCandidate;
  signal: AbortSignal;
}): Promise<OpenedStreamDecoder | undefined> {
  if (signal.aborted) return undefined;

  return new Promise((resolve) => {
    const decoder = startDecoder([candidate]);
    let opened = false;
    let settled = false;

    const finishFailed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      stopDecoder(decoder);
      resolve(undefined);
    };

    const finishOpened = (chunk: Buffer) => {
      if (settled) return;
      opened = true;
      settled = true;
      cleanup();
      resolve({ decoder, firstChunk: new Uint8Array(chunk) });
    };

    const onAbort = () => finishFailed();
    const openTimer = setTimeout(finishFailed, OPEN_TIMEOUT_MS);
    openTimer.unref();

    const onStdoutData = (chunk: Buffer) => finishOpened(chunk);
    const onError = () => {
      if (!opened) finishFailed();
    };
    const onCloseBeforeOpen = () => {
      if (!opened) finishFailed();
    };

    const cleanup = () => {
      clearTimeout(openTimer);
      signal.removeEventListener("abort", onAbort);
      decoder.stdout.off("data", onStdoutData);
      decoder.off("error", onError);
      decoder.off("close", onCloseBeforeOpen);
    };

    decoder.stdout.on("data", onStdoutData);
    decoder.on("error", onError);
    decoder.on("close", onCloseBeforeOpen);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function attachDecoderToStream(
  openedStream: OpenedStreamDecoder,
  controller: ReadableStreamDefaultController<Uint8Array>,
): () => void {
  const { decoder, firstChunk } = openedStream;
  let closed = false;

  const safeClose = () => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      // Client may have disconnected.
    }
  };

  const safeEnqueue = (chunk: Uint8Array) => {
    if (closed) return;
    try {
      controller.enqueue(chunk);
    } catch {
      closed = true;
      stopDecoder(decoder);
    }
  };

  const onStdoutData = (chunk: Buffer) => safeEnqueue(new Uint8Array(chunk));
  const onClose = () => safeClose();

  safeEnqueue(firstChunk);
  decoder.stdout.on("data", onStdoutData);
  decoder.on("close", onClose);

  return () => {
    closed = true;
    decoder.stdout.off("data", onStdoutData);
    decoder.off("close", onClose);
    stopDecoder(decoder);
  };
}

function startDecoder(candidates: StreamCandidate[]): ChildProcessWithoutNullStreams {
  const scriptPath = path.join(process.cwd(), "app/api/stream/[cameraId]/rtsp_mjpeg.py");
  const decoder = spawn(resolvePythonBin(), ["-u", scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  decoder.stdin.end(JSON.stringify({ stream_candidates: candidates }));
  return decoder;
}

function stopDecoder(decoder: ChildProcessWithoutNullStreams) {
  if (decoder.exitCode !== null || decoder.killed) return;
  decoder.kill("SIGTERM");
  setTimeout(() => {
    if (decoder.exitCode === null) decoder.kill("SIGKILL");
  }, 1000).unref();
}
