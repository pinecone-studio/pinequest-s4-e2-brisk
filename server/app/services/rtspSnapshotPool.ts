import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import {
  applyPasswordToRtspUrl,
  buildPasswordCandidates,
  canonicalRtspSourceKey,
} from "@/lib/rtspPasswordFallback";

const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const IDLE_EVICT_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const INITIAL_CONNECT_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const SNAPSHOT_FPS = 1;
const MJPEG_FPS = 12;
const MJPEG_FPS_UPGRADE_DELAY_MS = 2_500;
const AUTH_RETRY_COOLDOWN_MS = 8_000;

export type SnapshotErrorKind = "auth" | "connection" | "timeout" | "unavailable";

interface MjpegSubscriber {
  id: number;
  onFrame: (jpeg: Uint8Array) => void;
  onError?: (error: SnapshotErrorKind) => void;
}

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
  canonicalKey: string;
  sourceRtspUrl: string;
  rtspUrl: string;
  passwordCandidates: string[];
  passwordCandidateIndex: number;
  currentFps: number;
  process: ChildProcessWithoutNullStreams | null;
  processGeneration: number;
  latestJpeg: Uint8Array | null;
  errorKind: SnapshotErrorKind | null;
  authExhaustedAt: number | null;
  consecutiveFailures: number;
  lastRequestAt: number;
  backoffMs: number;
  stdoutBuffer: Buffer;
  frameWaiters: FrameWaiter[];
  mjpegSubscribers: Map<number, MjpegSubscriber>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  fpsUpgradeTimer: ReturnType<typeof setTimeout> | null;
  starting: boolean;
  nextWaiterId: number;
  nextMjpegSubscriberId: number;
}

const pool = new Map<string, PoolEntry>();

export async function getBufferedSnapshot(
  cameraId: string,
  rtspUrl: string,
  signal?: AbortSignal,
): Promise<{ jpeg?: Uint8Array; error?: SnapshotErrorKind }> {
  const entry = ensureEntry(cameraId, rtspUrl);
  touchEntry(entry);

  if (
    entry.errorKind === "auth" &&
    entry.authExhaustedAt &&
    Date.now() - entry.authExhaustedAt < AUTH_RETRY_COOLDOWN_MS
  ) {
    return { error: "auth" };
  }

  if (entry.errorKind === "auth" && entry.authExhaustedAt) {
    entry.passwordCandidateIndex = 0;
    entry.rtspUrl = applyPasswordToRtspUrl(
      entry.sourceRtspUrl,
      entry.passwordCandidates[0] ?? "",
    );
    clearAuthFailure(entry);
    if (!entry.process && !entry.starting) {
      startFfmpeg(entry);
    }
  } else if (entry.errorKind === "auth") {
    if (entry.passwordCandidateIndex + 1 < entry.passwordCandidates.length) {
      clearAuthFailure(entry);
      if (!entry.process && !entry.starting) {
        startFfmpeg(entry);
      }
    }
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

export function subscribeMjpegStream(
  cameraId: string,
  rtspUrl: string,
  callbacks: {
    onFrame: (jpeg: Uint8Array) => void;
    onError?: (error: SnapshotErrorKind) => void;
  },
  signal?: AbortSignal,
): () => void {
  const entry = ensureEntry(cameraId, rtspUrl);
  touchEntry(entry);

  const subscriberId = entry.nextMjpegSubscriberId;
  entry.nextMjpegSubscriberId += 1;

  entry.mjpegSubscribers.set(subscriberId, {
    id: subscriberId,
    onFrame: callbacks.onFrame,
    onError: callbacks.onError,
  });

  adjustFpsIfNeeded(entry);

  if (!entry.process && !entry.starting) {
    startFfmpeg(entry);
  }

  if (entry.latestJpeg) {
    callbacks.onFrame(entry.latestJpeg);
  }

  const unsubscribe = () => {
    entry.mjpegSubscribers.delete(subscriberId);
    adjustFpsIfNeeded(entry);
    if (entry.mjpegSubscribers.size === 0) {
      touchEntry(entry);
    }
  };

  signal?.addEventListener("abort", unsubscribe, { once: true });
  return unsubscribe;
}

export function evictSnapshotCamera(cameraId: string) {
  const entry = pool.get(cameraId);
  if (!entry) return;
  notifyMjpegError(entry, entry.errorKind ?? "unavailable");
  entry.mjpegSubscribers.clear();
  stopEntry(entry);
  pool.delete(cameraId);
}

function ensureEntry(cameraId: string, rtspUrl: string): PoolEntry {
  const canonicalKey = canonicalRtspSourceKey(rtspUrl);
  let entry = pool.get(cameraId);

  if (!entry) {
    entry = createEntry(cameraId, rtspUrl, canonicalKey);
    pool.set(cameraId, entry);
    return entry;
  }

  if (entry.canonicalKey !== canonicalKey) {
    stopEntry(entry);
    configureEntryUrls(entry, rtspUrl, canonicalKey);
    entry.passwordCandidateIndex = 0;
    entry.latestJpeg = null;
    clearAuthFailure(entry);
    entry.consecutiveFailures = 0;
    entry.backoffMs = 1000;
    return entry;
  }

  if (entry.sourceRtspUrl !== rtspUrl) {
    entry.sourceRtspUrl = rtspUrl;
    mergePasswordCandidates(entry, rtspUrl);
  }

  return entry;
}

function configureEntryUrls(entry: PoolEntry, rtspUrl: string, canonicalKey: string) {
  entry.sourceRtspUrl = rtspUrl;
  entry.canonicalKey = canonicalKey;
  entry.passwordCandidates = buildPasswordCandidates(rtspUrl);
  entry.passwordCandidateIndex = 0;
  entry.rtspUrl = applyPasswordToRtspUrl(
    rtspUrl,
    entry.passwordCandidates[0] ?? "",
  );
}

function mergePasswordCandidates(entry: PoolEntry, rtspUrl: string) {
  const incoming = buildPasswordCandidates(rtspUrl);
  for (const password of incoming) {
    if (!entry.passwordCandidates.includes(password)) {
      entry.passwordCandidates.push(password);
    }
  }
}

function createEntry(cameraId: string, rtspUrl: string, canonicalKey: string): PoolEntry {
  const entry: PoolEntry = {
    cameraId,
    canonicalKey,
    sourceRtspUrl: rtspUrl,
    rtspUrl,
    passwordCandidates: [],
    passwordCandidateIndex: 0,
    currentFps: SNAPSHOT_FPS,
    process: null,
    processGeneration: 0,
    latestJpeg: null,
    errorKind: null,
    authExhaustedAt: null,
    consecutiveFailures: 0,
    lastRequestAt: Date.now(),
    backoffMs: 1000,
    stdoutBuffer: Buffer.alloc(0),
    frameWaiters: [],
    mjpegSubscribers: new Map(),
    idleTimer: null,
    reconnectTimer: null,
    fpsUpgradeTimer: null,
    starting: false,
    nextWaiterId: 1,
    nextMjpegSubscriberId: 1,
  };
  configureEntryUrls(entry, rtspUrl, canonicalKey);
  entry.currentFps = desiredFps(entry);
  return entry;
}

function desiredFps(entry: PoolEntry): number {
  return entry.mjpegSubscribers.size > 0 ? MJPEG_FPS : SNAPSHOT_FPS;
}

function cancelFpsUpgrade(entry: PoolEntry) {
  if (!entry.fpsUpgradeTimer) return;
  clearTimeout(entry.fpsUpgradeTimer);
  entry.fpsUpgradeTimer = null;
}

function restartFfmpegAtCurrentFps(entry: PoolEntry) {
  if (!entry.process && !entry.starting) return;
  const generation = entry.processGeneration;
  killFfmpegProcess(entry, generation);
  entry.stdoutBuffer = Buffer.alloc(0);
  startFfmpeg(entry);
}

function adjustFpsIfNeeded(entry: PoolEntry) {
  const nextFps = desiredFps(entry);
  if (entry.currentFps === nextFps) {
    cancelFpsUpgrade(entry);
    return;
  }

  if (nextFps < entry.currentFps) {
    cancelFpsUpgrade(entry);
    entry.currentFps = nextFps;
    restartFfmpegAtCurrentFps(entry);
    return;
  }

  if (entry.fpsUpgradeTimer) {
    return;
  }

  // Reuse the warm decoder briefly instead of killing it on dialog open.
  if (entry.process && entry.latestJpeg) {
    cancelFpsUpgrade(entry);
    entry.fpsUpgradeTimer = setTimeout(() => {
      entry.fpsUpgradeTimer = null;
      if (entry.mjpegSubscribers.size === 0) return;
      if (entry.currentFps >= MJPEG_FPS) return;
      entry.currentFps = MJPEG_FPS;
      restartFfmpegAtCurrentFps(entry);
    }, MJPEG_FPS_UPGRADE_DELAY_MS);
    entry.fpsUpgradeTimer.unref?.();
    return;
  }

  entry.currentFps = nextFps;
  restartFfmpegAtCurrentFps(entry);
}

function clearAuthFailure(entry: PoolEntry) {
  entry.errorKind = null;
  entry.authExhaustedAt = null;
  entry.consecutiveFailures = 0;
}

function touchEntry(entry: PoolEntry) {
  entry.lastRequestAt = Date.now();
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  entry.idleTimer = setTimeout(() => {
    if (entry.mjpegSubscribers.size > 0) {
      touchEntry(entry);
      return;
    }
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
  entry.processGeneration += 1;
  const generation = entry.processGeneration;

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
      `fps=${entry.currentFps}`,
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
    if (generation !== entry.processGeneration) return;
    entry.stdoutBuffer = Buffer.concat([entry.stdoutBuffer, chunk]);
    extractJpegFrames(entry);
  });

  process.stderr.on("data", (chunk: Buffer) => {
    if (generation !== entry.processGeneration) return;
    const text = chunk.toString("utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.info(`[snapshot-pool:${entry.cameraId}] ${trimmed}`);
      classifyStderr(entry, trimmed, generation);
    }
  });

  process.on("close", (code) => {
    if (generation !== entry.processGeneration) return;
    entry.process = null;
    entry.starting = false;
    if (code !== 0 && code !== null) {
      entry.consecutiveFailures += 1;
      if (!entry.errorKind) {
        entry.errorKind = "connection";
      }
      failWaiters(entry);
      notifyMjpegError(entry, entry.errorKind ?? "connection");
      scheduleReconnect(entry);
    }
  });

  process.on("error", (error) => {
    if (generation !== entry.processGeneration) return;
    console.info(`[snapshot-pool:${entry.cameraId}] process error ${error.message}`);
    entry.errorKind = "connection";
    entry.consecutiveFailures += 1;
    failWaiters(entry);
    notifyMjpegError(entry, "connection");
  });
}

function isAuthError(line: string): boolean {
  return /401|403|Unauthorized|authorization failed|authentication error|method DESCRIBE failed/i.test(
    line,
  );
}

function classifyStderr(entry: PoolEntry, line: string, generation: number) {
  if (!isAuthError(line)) {
    if (/timed out|Timeout|Connection refused|No route to host|Could not find codec/i.test(line)) {
      entry.errorKind = entry.errorKind ?? "connection";
    }
    return;
  }

  if (generation !== entry.processGeneration) return;

  if (tryNextPasswordCandidate(entry, generation)) {
    return;
  }

  entry.errorKind = "auth";
  entry.authExhaustedAt = Date.now();
  entry.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
  stopEntry(entry);
  failWaiters(entry);
  notifyMjpegError(entry, "auth");
}

function tryNextPasswordCandidate(entry: PoolEntry, generation: number): boolean {
  if (entry.passwordCandidateIndex + 1 >= entry.passwordCandidates.length) {
    return false;
  }

  killFfmpegProcess(entry, generation);
  entry.passwordCandidateIndex += 1;
  entry.rtspUrl = applyPasswordToRtspUrl(
    entry.sourceRtspUrl,
    entry.passwordCandidates[entry.passwordCandidateIndex] ?? "",
  );
  clearAuthFailure(entry);
  entry.latestJpeg = null;
  entry.backoffMs = 1000;
  extendWaiterTimeouts(entry);
  startFfmpeg(entry);
  return true;
}

function extendWaiterTimeouts(entry: PoolEntry) {
  for (const waiter of entry.frameWaiters) {
    clearTimeout(waiter.timeout);
    waiter.timeout = setTimeout(() => {
      entry.errorKind = entry.errorKind ?? "timeout";
      waiter.reject(new Error("snapshot timeout"));
    }, INITIAL_CONNECT_TIMEOUT_MS);
    waiter.timeout.unref?.();
  }
}

function killFfmpegProcess(entry: PoolEntry, expectedGeneration: number) {
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  const process = entry.process;
  entry.process = null;
  entry.starting = false;
  entry.processGeneration += 1;

  if (!process || process.killed || process.exitCode !== null) return;
  if (expectedGeneration !== entry.processGeneration - 1) return;

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
    clearAuthFailure(entry);
    entry.backoffMs = 1000;
    resolveWaiters(entry, entry.latestJpeg);
    broadcastMjpegFrame(entry, entry.latestJpeg);
  }
}

function broadcastMjpegFrame(entry: PoolEntry, jpeg: Uint8Array) {
  for (const subscriber of entry.mjpegSubscribers.values()) {
    try {
      subscriber.onFrame(jpeg);
    } catch {
      // Client disconnected.
    }
  }
}

function notifyMjpegError(entry: PoolEntry, error: SnapshotErrorKind) {
  for (const subscriber of entry.mjpegSubscribers.values()) {
    try {
      subscriber.onError?.(error);
    } catch {
      // Client disconnected.
    }
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
    if (entry.mjpegSubscribers.size > 0) {
      touchEntry(entry);
    } else if (Date.now() - entry.lastRequestAt >= IDLE_EVICT_MS) {
      evictSnapshotCamera(entry.cameraId);
      return;
    }
    startFfmpeg(entry);
  }, delay);
  entry.reconnectTimer.unref?.();
}

function stopEntry(entry: PoolEntry) {
  cancelFpsUpgrade(entry);
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  const generation = entry.processGeneration;
  killFfmpegProcess(entry, generation);
  failWaiters(entry);
}
