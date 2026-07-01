import { NextResponse } from "next/server";
import { type ChildProcessWithoutNullStreams } from "child_process";
import { loadCameraStreamSource } from "../../cameras/serverCameraConfig";
import { markCameraOffline, markCameraOnline } from "../../cameras/cameraHealth";
import { isBenignDecoderNoise, MJPEG_BOUNDARY, startFfmpegDecoder } from "@/lib/ffmpegStream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BOUNDARY = MJPEG_BOUNDARY;
const CANDIDATE_OPEN_TIMEOUT_MS = 8000;
const TOTAL_OPEN_TIMEOUT_MS = 12000;
const FAILED_CAMERA_TTL_MS = 15000;
const MAX_CONCURRENT_STREAM_OPENS = 4;
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxActive: number) {}

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const run = () => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.queue.shift()?.();
        });
      };

      if (this.active < this.maxActive) {
        run();
      } else {
        this.queue.push(run);
      }
    });
  }
}

const successfulStreamUrls = new Map<string, StreamCandidate>();
const failedStreamUntil = new Map<string, number>();
const streamOpenLimiter = new Semaphore(MAX_CONCURRENT_STREAM_OPENS);

interface StreamCandidate {
  label: string;
  pathName: string;
  url: string;
}

interface StreamRouteContext {
  params: Promise<{
    cameraId: string;
  }>;
}

export async function GET(request: Request, { params }: StreamRouteContext) {
  const { cameraId } = await params;
  const camera = await loadCameraStreamSource(cameraId);

  if (!camera || camera.enabled === false || !camera.host) {
    return NextResponse.json({ error: "Camera not found" }, { status: 404 });
  }

  const host = camera.host;
  console.info(`[stream] cameraId=${camera.id} host=${host} Camera mode: ${camera.connection_mode}`);

  if (camera.config_error) {
    console.warn(`[stream] cameraId=${camera.id} host=${host} ${camera.config_error}`);
    markCameraOffline(camera.id);
    return NextResponse.json({ error: camera.config_error }, { status: 503 });
  }

  if (!camera.rtsp_url) {
    markCameraOffline(camera.id);
    return NextResponse.json({ error: "Camera stream URL is not configured" }, { status: 503 });
  }

  if (isFailureCached(camera.id)) {
    markCameraOffline(camera.id);
    return unavailableResponse();
  }

  const streamCandidates = buildStreamCandidates(camera.id, camera.rtsp_url);
  const cachedCandidate = successfulStreamUrls.get(camera.id);
  const orderedCandidates = cachedCandidate
    ? [
        { ...cachedCandidate, label: `cached ${cachedCandidate.pathName}` },
        ...streamCandidates.filter((candidate) => candidate.url !== cachedCandidate.url),
      ]
    : streamCandidates;

  console.info(
    `[stream] cameraId=${camera.id} host=${host} candidates=${orderedCandidates.length} queued`,
  );

  const openedStream = await openStreamDecoder({
    cameraId: camera.id,
    host,
    candidates: orderedCandidates,
    signal: request.signal,
  });

  if (!openedStream) {
    markCameraOffline(camera.id);
    return unavailableResponse();
  }

  markCameraOnline(camera.id);

  let cleanupStream = () => {
    stopDecoder(openedStream.decoder);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanupStream = attachDecoderToStream({
        cameraId: camera.id,
        host,
        openedStream,
        controller,
      });
    },
    cancel() {
      cleanupStream();
    },
  });

  // Kill the decoder when the HTTP request is aborted (browser tab closed,
  // navigation away) — ReadableStream.cancel() is not always reliable for
  // detecting server-side disconnects in Next.js route handlers.
  request.signal.addEventListener("abort", () => cleanupStream(), { once: true });

  return new Response(stream, {
    headers: {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

interface OpenStreamDecoderOptions {
  cameraId: string;
  host: string;
  candidates: StreamCandidate[];
  signal: AbortSignal;
}

interface OpenedStreamDecoder {
  decoder: ChildProcessWithoutNullStreams;
  firstChunk: Uint8Array;
}

async function openStreamDecoder({
  cameraId,
  host,
  candidates,
  signal,
}: OpenStreamDecoderOptions): Promise<OpenedStreamDecoder | undefined> {
  const release = await streamOpenLimiter.acquire();
  const deadline = Date.now() + TOTAL_OPEN_TIMEOUT_MS;

  try {
    if (signal.aborted) return undefined;
    if (isFailureCached(cameraId)) return undefined;

    console.info(
      `[stream] cameraId=${cameraId} host=${host} candidates=${candidates.length} opening`,
    );

    for (const candidate of candidates) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || signal.aborted) break;

      const opened = await tryOpenCandidate({
        cameraId,
        host,
        candidate,
        signal,
        timeoutMs: Math.min(CANDIDATE_OPEN_TIMEOUT_MS, remainingMs),
      });

      if (opened) return opened;
    }

    cacheStreamFailure(cameraId);
    console.info(`[stream] cameraId=${cameraId} host=${host} configured RTSP URL failed`);
    return undefined;
  } finally {
    release();
  }
}

interface TryOpenCandidateOptions {
  cameraId: string;
  host: string;
  candidate: StreamCandidate;
  signal: AbortSignal;
  timeoutMs: number;
}

function tryOpenCandidate({
  cameraId,
  host,
  candidate,
  signal,
  timeoutMs,
}: TryOpenCandidateOptions): Promise<OpenedStreamDecoder | undefined> {
  return new Promise((resolve) => {
    const decoder = startDecoder([candidate]);
    let opened = false;
    let settled = false;

    const finishFailed = (reason: string) => {
      if (settled) return;
      settled = true;
      cleanupOpenListeners();
      stopDecoder(decoder);
      console.info(
        `[stream] cameraId=${cameraId} host=${host} ${reason} candidate=${candidate.label}`,
      );
      resolve(undefined);
    };

    const finishOpened = (chunk: Buffer) => {
      if (settled) return;
      opened = true;
      settled = true;
      cleanupOpenListeners();
      // Remember the working URL so future opens skip straight to it. FFmpeg
      // (unlike the old Python decoder) doesn't emit a cache marker, so record
      // it here on first successful frame.
      successfulStreamUrls.set(cameraId, {
        label: `cached ${candidate.pathName}`,
        pathName: candidate.pathName,
        url: candidate.url,
      });
      failedStreamUntil.delete(cameraId);
      resolve({ decoder, firstChunk: new Uint8Array(chunk) });
    };

    const cleanupOpenListeners = () => {
      clearTimeout(openTimer);
      signal.removeEventListener("abort", onAbort);
      decoder.stdout.off("data", onStdoutData);
      decoder.stderr.off("data", onStderrData);
      decoder.off("error", onError);
      decoder.off("close", onCloseBeforeOpen);
    };

    const onAbort = () => finishFailed("stream open aborted");
    const openTimer = setTimeout(
      () => finishFailed(`stream open timeout after ${timeoutMs}ms`),
      timeoutMs,
    );
    openTimer.unref();

    const onStdoutData = (chunk: Buffer) => finishOpened(chunk);

    const onStderrData = (chunk: Buffer) => handleDecoderStderr(cameraId, host, chunk);

    const onError = (error: Error) => {
      if (!opened) {
        finishFailed(`decoder error ${error.message}`);
        return;
      }
      console.error(`[stream] cameraId=${cameraId} decoder error`, error);
    };

    const onCloseBeforeOpen = (code: number | null) => {
      if (!opened) {
        finishFailed(`stream open failure code=${code}`);
      }
    };

    decoder.stdout.on("data", onStdoutData);
    decoder.stderr.on("data", onStderrData);
    decoder.on("error", onError);
    decoder.on("close", onCloseBeforeOpen);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface AttachDecoderToStreamOptions {
  cameraId: string;
  host: string;
  openedStream: OpenedStreamDecoder;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

function attachDecoderToStream({
  cameraId,
  host,
  openedStream,
  controller,
}: AttachDecoderToStreamOptions): () => void {
  const { decoder, firstChunk } = openedStream;
  let closed = false;

  const safeClose = () => {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      // The browser may already have closed the response during navigation/reload.
    }
  };

  const safeError = (error: Error) => {
    if (closed) return;
    closed = true;
    try {
      controller.error(error);
    } catch {
      // The controller can already be closed if the client disconnected.
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

  const onStdoutData = (chunk: Buffer) => {
    safeEnqueue(new Uint8Array(chunk));
  };
  const onStderrData = (chunk: Buffer) => {
    handleDecoderStderr(cameraId, host, chunk);
  };
  const onError = (error: Error) => {
    console.error(`[stream] cameraId=${cameraId} decoder error`, error);
    safeError(error);
  };
  const onClose = (code: number | null) => {
    if (closed) return;
    if (code && code !== 0) {
      successfulStreamUrls.delete(cameraId);
    }
    console.info(`[stream] cameraId=${cameraId} decoder closed code=${code}`);
    safeClose();
  };

  safeEnqueue(firstChunk);
  decoder.stdout.on("data", onStdoutData);
  decoder.stderr.on("data", onStderrData);
  decoder.on("error", onError);
  decoder.on("close", onClose);

  return () => {
    closed = true;
    decoder.stdout.off("data", onStdoutData);
    decoder.stderr.off("data", onStderrData);
    decoder.off("error", onError);
    decoder.off("close", onClose);
    stopDecoder(decoder);
  };
}

function handleDecoderStderr(cameraId: string, host: string, chunk: Buffer) {
  for (const line of chunk.toString().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || isBenignDecoderNoise(trimmed)) continue;
    console.info(`[stream] cameraId=${cameraId} host=${host} ${trimmed}`);
  }
}

function startDecoder(candidates: StreamCandidate[]): ChildProcessWithoutNullStreams {
  // Each open attempt drives a single candidate URL; FFmpeg handles the RTSP
  // handshake and JPEG encoding directly (no Python decoder).
  return startFfmpegDecoder(candidates[0].url);
}

function stopDecoder(decoder: ChildProcessWithoutNullStreams) {
  if (decoder.exitCode !== null || decoder.killed) return;
  decoder.kill("SIGTERM");
  setTimeout(() => {
    if (decoder.exitCode === null) decoder.kill("SIGKILL");
  }, 1000).unref();
}

function cacheStreamFailure(cameraId: string) {
  failedStreamUntil.set(cameraId, Date.now() + FAILED_CAMERA_TTL_MS);
  successfulStreamUrls.delete(cameraId);
}

function isFailureCached(cameraId: string): boolean {
  const expiresAt = failedStreamUntil.get(cameraId);
  if (!expiresAt) return false;
  if (expiresAt > Date.now()) return true;
  failedStreamUntil.delete(cameraId);
  return false;
}

function unavailableResponse(): Response {
  return new Response("STREAM UNAVAILABLE", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
    },
  });
}

function buildStreamCandidates(cameraId: string, rtspUrl: string): StreamCandidate[] {
  return [
    {
      label: `${cameraId} configured rtsp_url`,
      pathName: "configured rtsp_url",
      url: rtspUrl,
    },
  ];
}
