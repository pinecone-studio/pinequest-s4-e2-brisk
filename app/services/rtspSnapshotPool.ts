import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import {
  applyPasswordToRtspUrl,
  buildPasswordCandidates,
} from "@/lib/rtspPasswordFallback";

const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const IDLE_EVICT_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const INITIAL_CONNECT_TIMEOUT_MS = 12_000;
const MAX_BACKOFF_MS = 30_000;

export type SnapshotErrorKind = "auth" | "connection" | "timeout" | "unavailable";

interface FrameWaiter {
  id: number;
  resolve: (jpeg: Uint8Array | null) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
}

interface PoolEntry {
  cameraId: string;
  sourceRtspUrl: string;
  rtspUrl: string;
  passwordCandidates: string[];
  passwordCandidateIndex: number;
  process: ChildProcessWithoutNullStreams | null;
  latestJpeg: Uint8Array | null;
  errorKind: SnapshotErrorKind | null;
  consecutiveFailures: number;
  lastRequestAt: number;
  backoffMs: number;
  stdoutBuffer: Buffer;
  frameWaiters: FrameWaiter[];
  idleTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  starting: boolean;
  nextWaiterId: number;
}

const pool = new Map<string, PoolEntry>();

export async function getBufferedSnapshot(
  cameraId: string,
  rtspUrl: string,
  signal?: AbortSignal,
): Promise<{ jpeg?: Uint8Array; error?: SnapshotErrorKind }> {
  const entry = ensureEntry(cameraId, rtspUrl);
  touchEntry(entry);

  if (entry.errorKind === "auth" && entry.passwordCandidateIndex + 1 >= entry.passwordCandidates.length) {
    return { error: "auth" };
  }

  if (entry.latestJpeg) {
    return { jpeg: entry.latestJpeg };
  }

  if (entry.errorKind && entry.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return { error: entry.errorKind };
  }

  if (!entry.process && !entry.starting) {
    startFfmpeg(entry);
  }

  if (signal?.aborted) {
    return { error: "unavailable" };
  }

  try {
    const jpeg = await waitForFrame(entry, signal);
    if (jpeg) {
      return { jpeg };
    }
    return { error: entry.errorKind ?? "unavailable" };
  } catch {
    return { error: entry.errorKind ?? "timeout" };
  }
}

export function evictSnapshotCamera(cameraId: string) {
  const entry = pool.get(cameraId);
  if (!entry) return;
  stopEntry(entry);
  pool.delete(cameraId);
}

function ensureEntry(cameraId: string, rtspUrl: string): PoolEntry {
  let entry = pool.get(cameraId);
  if (!entry) {
    entry = createEntry(cameraId, rtspUrl);
    pool.set(cameraId, entry);
    return entry;
  }

  if (entry.rtspUrl !== rtspUrl && entry.sourceRtspUrl !== rtspUrl) {
    stopEntry(entry);
    configureEntryUrls(entry, rtspUrl);
    entry.latestJpeg = null;
    entry.errorKind = null;
    entry.consecutiveFailures = 0;
    entry.backoffMs = 1000;
  }

  return entry;
}

function configureEntryUrls(entry: PoolEntry, rtspUrl: string) {
  entry.sourceRtspUrl = rtspUrl;
  entry.passwordCandidates = buildPasswordCandidates(rtspUrl);
  entry.passwordCandidateIndex = 0;
  entry.rtspUrl = applyPasswordToRtspUrl(
    rtspUrl,
    entry.passwordCandidates[0] ?? "",
  );
}

function createEntry(cameraId: string, rtspUrl: string): PoolEntry {
  const entry: PoolEntry = {
    cameraId,
    sourceRtspUrl: rtspUrl,
    rtspUrl,
    passwordCandidates: [],
    passwordCandidateIndex: 0,
    process: null,
    latestJpeg: null,
    errorKind: null,
    consecutiveFailures: 0,
    lastRequestAt: Date.now(),
    backoffMs: 1000,
    stdoutBuffer: Buffer.alloc(0),
    frameWaiters: [],
    idleTimer: null,
    reconnectTimer: null,
    starting: false,
    nextWaiterId: 1,
  };
  configureEntryUrls(entry, rtspUrl);
  return entry;
}

function touchEntry(entry: PoolEntry) {
  entry.lastRequestAt = Date.now();
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  entry.idleTimer = setTimeout(() => {
    if (Date.now() - entry.lastRequestAt >= IDLE_EVICT_MS) {
      evictSnapshotCamera(entry.cameraId);
    }
  }, IDLE_EVICT_MS);
  entry.idleTimer.unref?.();
}

function startFfmpeg(entry: PoolEntry) {
  if (entry.starting || entry.process) return;

  entry.starting = true;
  entry.errorKind = null;
  entry.stdoutBuffer = Buffer.alloc(0);

  const process = spawn(
    FFMPEG_BIN,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      "tcp",
      "-timeout",
      "8000000",
      "-i",
      entry.rtspUrl,
      "-an",
      "-vf",
      "fps=1",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-q:v",
      "5",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  process.stdin.end();

  entry.process = process;
  entry.starting = false;

  process.stdout.on("data", (chunk: Buffer) => {
    entry.stdoutBuffer = Buffer.concat([entry.stdoutBuffer, chunk]);
    extractJpegFrames(entry);
  });

  process.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.info(`[snapshot-pool:${entry.cameraId}] ${trimmed}`);
      classifyStderr(entry, trimmed);
    }
  });

  process.on("close", (code) => {
    entry.process = null;
    entry.starting = false;
    if (code !== 0 && code !== null) {
      entry.consecutiveFailures += 1;
      if (!entry.errorKind) {
        entry.errorKind = "connection";
      }
      failWaiters(entry);
      scheduleReconnect(entry);
    }
  });

  process.on("error", (error) => {
    console.info(`[snapshot-pool:${entry.cameraId}] process error ${error.message}`);
    entry.errorKind = "connection";
    entry.consecutiveFailures += 1;
    failWaiters(entry);
  });
}

function classifyStderr(entry: PoolEntry, line: string) {
  if (/401|403|Unauthorized|authorization failed/i.test(line)) {
    if (tryNextPasswordCandidate(entry)) {
      return;
    }
    entry.errorKind = "auth";
    entry.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
    stopEntry(entry);
    failWaiters(entry);
    return;
  }

  if (/timed out|Timeout|Connection refused|No route to host|Could not find codec/i.test(line)) {
    entry.errorKind = entry.errorKind ?? "connection";
  }
}

function tryNextPasswordCandidate(entry: PoolEntry): boolean {
  if (entry.passwordCandidateIndex + 1 >= entry.passwordCandidates.length) {
    return false;
  }

  killFfmpegProcess(entry);
  entry.passwordCandidateIndex += 1;
  entry.rtspUrl = applyPasswordToRtspUrl(
    entry.sourceRtspUrl,
    entry.passwordCandidates[entry.passwordCandidateIndex] ?? "",
  );
  entry.errorKind = null;
  entry.consecutiveFailures = 0;
  entry.latestJpeg = null;
  entry.backoffMs = 1000;
  startFfmpeg(entry);
  return true;
}

function killFfmpegProcess(entry: PoolEntry) {
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  const process = entry.process;
  entry.process = null;
  entry.starting = false;
  if (!process || process.killed || process.exitCode !== null) return;

  process.kill("SIGTERM");
  setTimeout(() => {
    if (process.exitCode === null && !process.killed) {
      process.kill("SIGKILL");
    }
  }, 1000).unref?.();
}

function extractJpegFrames(entry: PoolEntry) {
  while (true) {
    const start = entry.stdoutBuffer.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) {
      if (entry.stdoutBuffer.length > 2_000_000) {
        entry.stdoutBuffer = entry.stdoutBuffer.subarray(-512_000);
      }
      return;
    }

    const end = entry.stdoutBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) return;

    const frame = entry.stdoutBuffer.subarray(start, end + 2);
    entry.stdoutBuffer = entry.stdoutBuffer.subarray(end + 2);
    entry.latestJpeg = new Uint8Array(frame);
    entry.errorKind = null;
    entry.consecutiveFailures = 0;
    entry.backoffMs = 1000;
    resolveWaiters(entry, entry.latestJpeg);
  }
}

function waitForFrame(entry: PoolEntry, signal?: AbortSignal): Promise<Uint8Array | null> {
  if (entry.latestJpeg) {
    return Promise.resolve(entry.latestJpeg);
  }

  return new Promise((resolve, reject) => {
    const waiterId = entry.nextWaiterId;
    entry.nextWaiterId += 1;

    const finish = (jpeg: Uint8Array | null) => {
      cleanup();
      resolve(jpeg);
    };

    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onAbort = () => fail(new Error("aborted"));

    const timeout = setTimeout(() => {
      entry.errorKind = entry.errorKind ?? "timeout";
      fail(new Error("snapshot timeout"));
    }, INITIAL_CONNECT_TIMEOUT_MS);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      entry.frameWaiters = entry.frameWaiters.filter((waiter) => waiter.id !== waiterId);
    };

    entry.frameWaiters.push({
      id: waiterId,
      resolve: finish,
      reject: fail,
      timeout,
      signal: signal ?? new AbortController().signal,
      onAbort,
    });

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function resolveWaiters(entry: PoolEntry, jpeg: Uint8Array) {
  for (const waiter of entry.frameWaiters) {
    clearTimeout(waiter.timeout);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(jpeg);
  }
  entry.frameWaiters = [];
}

function failWaiters(entry: PoolEntry) {
  for (const waiter of entry.frameWaiters) {
    clearTimeout(waiter.timeout);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(null);
  }
  entry.frameWaiters = [];
}

function scheduleReconnect(entry: PoolEntry) {
  if (entry.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
  if (entry.reconnectTimer) return;

  const delay = entry.backoffMs;
  entry.backoffMs = Math.min(entry.backoffMs * 2, MAX_BACKOFF_MS);

  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    if (Date.now() - entry.lastRequestAt >= IDLE_EVICT_MS) {
      evictSnapshotCamera(entry.cameraId);
      return;
    }
    startFfmpeg(entry);
  }, delay);
  entry.reconnectTimer.unref?.();
}

function stopEntry(entry: PoolEntry) {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  killFfmpegProcess(entry);
  failWaiters(entry);
}
