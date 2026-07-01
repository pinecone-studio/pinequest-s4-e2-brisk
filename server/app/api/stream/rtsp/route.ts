import { NextResponse } from "next/server";
import { type ChildProcessWithoutNullStreams } from "child_process";
import { isBenignDecoderNoise, MJPEG_BOUNDARY, startFfmpegDecoder } from "@/lib/ffmpegStream";
import { FALLBACK_PASSWORDS } from "@/lib/rtspPasswordFallback";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BOUNDARY = MJPEG_BOUNDARY;
const OPEN_TIMEOUT_MS = 12000;

// How long to remember that a given RTSP URL failed to open, so we don't
// respawn a Python/FFmpeg decoder on every retry for a camera that is (for
// now) unreachable or rejecting our credentials.
const FAILURE_CACHE_TTL_MS = 30000;

interface StreamCandidate {
  label: string;
  pathName: string;
  url: string;
}

interface CachedFailure {
  reason: string;
  expiresAt: number;
}

const failureCache = new Map<string, CachedFailure>();

// RTSP paths to try (in addition to the one in the URL) when a camera returns
// 404 for the path. Covers common Hikvision/Dahua/generic conventions.
// Configurable via RTSP_PATHS (comma-separated).
const FALLBACK_PATHS = (
  process.env.RTSP_PATHS ??
  "/Streaming/Channels/101,/Streaming/Channels/102,/live,/h264,/cam/realmonitor?channel=1&subtype=0,/stream2,/video1"
)
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

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

  const cached = failureCache.get(rtspUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return unavailableResponse(cached.reason);
  }

  // Try the URL's own path+password first, then fall through: alternate
  // passwords when the camera rejects auth (401), and alternate paths when it
  // returns 404. A 401 means the path exists (stop trying paths); a 404 means
  // the path is wrong (move on); anything else (timeout/unreachable) → give up.
  const pathCandidates = buildPathList(rtspUrl);
  const passwordCandidates = buildPasswordList(rtspUrl);
  let result: OpenResult = { opened: false, reason: "could not open RTSP stream", aborted: false };

  outer: for (const path of pathCandidates) {
    for (const password of passwordCandidates) {
      result = await openStreamDecoder({
        host,
        candidate: {
          label: "dynamic rtsp",
          pathName: "dynamic",
          url: buildRtspVariant(rtspUrl, path, password),
        },
        signal: request.signal,
      });
      if (result.opened || result.aborted) break outer;
      if (isAuthFailure(result.reason)) continue; // wrong password, try the next one
      break; // non-auth failure — no point trying more passwords on this path
    }
    // Only keep trying other paths when the failure was specifically "path not
    // found"; a 401/timeout/etc. won't be fixed by a different path.
    if (!isPathFailure(result.reason)) break;
  }

  if (!result.opened) {
    // Don't cache client-initiated aborts — those aren't the camera's fault.
    if (!result.aborted) {
      failureCache.set(rtspUrl, {
        reason: result.reason,
        expiresAt: Date.now() + FAILURE_CACHE_TTL_MS,
      });
    }
    return unavailableResponse(result.reason);
  }

  // Recovered: clear any stale failure entry so future retries aren't blocked.
  failureCache.delete(rtspUrl);

  const openedStream = result.stream;
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

type OpenResult =
  | { opened: true; stream: OpenedStreamDecoder }
  | { opened: false; reason: string; aborted: boolean };

function unavailableResponse(reason: string): NextResponse {
  // HTTP header values must be Latin-1 (bytes 0-255); strip anything outside
  // that range so a non-ASCII reason can't turn a 503 into a 500.
  const headerSafeReason = reason.replace(/[^\x20-\x7e]/g, "");
  return new NextResponse(`Stream unavailable: ${reason}`, {
    status: 503,
    headers: { "X-Stream-Error": headerSafeReason },
  });
}

function isAuthFailure(reason: string): boolean {
  return /401|authentication/i.test(reason);
}

function isPathFailure(reason: string): boolean {
  return /404|not found/i.test(reason);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

// The URL's own password first, then the fallbacks (de-duplicated).
function buildPasswordList(rtspUrl: string): string[] {
  let originalPassword = "";
  try {
    originalPassword = new URL(rtspUrl).password;
  } catch {
    return [""];
  }
  return dedupe([originalPassword, ...FALLBACK_PASSWORDS]);
}

// The URL's own path (with query) first, then the fallbacks (de-duplicated).
function buildPathList(rtspUrl: string): string[] {
  let originalPath = "/";
  try {
    const u = new URL(rtspUrl);
    originalPath = u.pathname + u.search;
  } catch {
    return FALLBACK_PATHS.length > 0 ? FALLBACK_PATHS : ["/"];
  }
  return dedupe([originalPath, ...FALLBACK_PATHS]);
}

// Rebuild the RTSP URL with a specific path (optionally including a ?query) and
// password, keeping the original scheme/user/host/port.
function buildRtspVariant(rtspUrl: string, path: string, password: string): string {
  const u = new URL(rtspUrl);
  u.password = password;
  const queryIndex = path.indexOf("?");
  if (queryIndex >= 0) {
    u.pathname = path.slice(0, queryIndex);
    u.search = path.slice(queryIndex);
  } else {
    u.pathname = path;
    u.search = "";
  }
  return u.toString();
}

// Turn the decoder's FFmpeg/OpenCV stderr chatter into a short, actionable
// reason the client can display and we can cache. Keep it ASCII — this value
// is also sent as an HTTP header (see unavailableResponse).
function classifyFailure(stderr: string): string {
  if (/401\s*Unauthorized/i.test(stderr)) {
    return "authentication failed (401) - check the RTSP username/password";
  }
  if (/404\s*Not Found/i.test(stderr)) {
    return "stream path not found (404) - check the RTSP path";
  }
  if (/timed?\s*out|timeout/i.test(stderr)) {
    return "connection timed out - camera unreachable";
  }
  return "could not open RTSP stream";
}

async function openStreamDecoder({
  host,
  candidate,
  signal,
}: {
  host: string;
  candidate: StreamCandidate;
  signal: AbortSignal;
}): Promise<OpenResult> {
  if (signal.aborted) {
    return { opened: false, reason: "request aborted", aborted: true };
  }

  return new Promise<OpenResult>((resolve) => {
    let stderrBuffer = "";
    const decoder = startDecoder([candidate], (line) => {
      stderrBuffer += line;
    });
    let opened = false;
    let settled = false;
    let aborted = false;

    const finishFailed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      stopDecoder(decoder);
      resolve({
        opened: false,
        reason: aborted ? "request aborted" : classifyFailure(stderrBuffer),
        aborted,
      });
    };

    const finishOpened = (chunk: Buffer) => {
      if (settled) return;
      opened = true;
      settled = true;
      cleanup();
      resolve({ opened: true, stream: { decoder, firstChunk: new Uint8Array(chunk) } });
    };

    const onAbort = () => {
      aborted = true;
      finishFailed();
    };
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

function startDecoder(
  candidates: StreamCandidate[],
  onStderr?: (line: string) => void,
): ChildProcessWithoutNullStreams {
  const decoder = startFfmpegDecoder(candidates[0].url);

  // Surface FFmpeg's diagnostics. It logs RTSP open failures (401/404,
  // unreachable host, etc.) to stderr; without this the route returns a bare
  // 503 with no clue why. onStderr also feeds the failure classifier.
  decoder.stderr.setEncoding("utf8");
  decoder.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trimEnd();
      if (!trimmed || isBenignDecoderNoise(trimmed)) continue;
      console.error(`[rtsp decoder] ${trimmed}`);
    }
    onStderr?.(chunk);
  });
  decoder.on("error", (err) => {
    console.error(`[rtsp decoder] failed to spawn ffmpeg:`, err);
  });

  return decoder;
}

function stopDecoder(decoder: ChildProcessWithoutNullStreams) {
  if (decoder.exitCode !== null || decoder.killed) return;
  decoder.kill("SIGTERM");
  setTimeout(() => {
    if (decoder.exitCode === null) decoder.kill("SIGKILL");
  }, 1000).unref();
}
