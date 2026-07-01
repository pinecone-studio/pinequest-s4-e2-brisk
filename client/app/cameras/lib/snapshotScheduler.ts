import { extractRtspUrlFromStreamReference } from "./rtspUtils";

export const GRID_SNAPSHOT_POLL_MS = 4000;
export const GRID_SNAPSHOT_JITTER_MS = 1000;
export const BACKGROUND_SNAPSHOT_POLL_MS = GRID_SNAPSHOT_POLL_MS;
export const BACKGROUND_SNAPSHOT_JITTER_MS = GRID_SNAPSHOT_JITTER_MS;

const MAX_CONCURRENT_SNAPSHOT_FETCHES = 2;
const SNAPSHOT_TIMEOUT_MS = 10000;
const QUIET_SNAPSHOT_STATUSES = new Set([401, 503]);
const QUIET_LOG_COOLDOWN_MS = 30_000;

const lastQuietLogAt = new Map<string, number>();

interface SnapshotSubscription {
  active: boolean;
  cameraId: string;
  streamUrl: string;
  pollIntervalMs: number;
  jitterMs: number;
  timeout: ReturnType<typeof setTimeout> | null;
  abortController: AbortController | null;
  onSnapshot: (blob: Blob) => void;
  onError: () => void;
}

interface SnapshotTask {
  subscription: SnapshotSubscription;
}

const queue: SnapshotTask[] = [];
let activeFetches = 0;
let drainScheduled = false;

function handleSnapshotHttpFailure(cameraId: string, status: number): void {
  if (!QUIET_SNAPSHOT_STATUSES.has(status)) return;

  const key = `${cameraId}:${status}`;
  const now = Date.now();
  const lastLoggedAt = lastQuietLogAt.get(key) ?? 0;
  if (now - lastLoggedAt < QUIET_LOG_COOLDOWN_MS) return;

  lastQuietLogAt.set(key, now);
  const reason = status === 401 ? "unauthorized" : "offline";
  console.warn(`[Snapshot]: Camera ${cameraId} is ${reason} (${status}). Skipping...`);
}

function buildSnapshotUrl(cameraId: string, streamUrl: string): string {
  const rtspDirect = extractRtspUrlFromStreamReference(streamUrl);
  const params = new URLSearchParams({
    cameraId,
    v: String(Date.now()),
  });
  params.set("streamUrl", rtspDirect ?? streamUrl);
  return `/api/snapshot/rtsp?${params.toString()}`;
}

function snapshotEndpoint(subscription: SnapshotSubscription): string {
  return buildSnapshotUrl(subscription.cameraId, subscription.streamUrl);
}

async function fetchSnapshotBlob(
  subscription: SnapshotSubscription,
  signal: AbortSignal,
): Promise<Blob | null> {
  const response = await fetch(snapshotEndpoint(subscription), {
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    handleSnapshotHttpFailure(subscription.cameraId, response.status);
    return null;
  }

  const blob = await response.blob();
  return blob.size > 0 ? blob : null;
}

export function subscribeToSnapshots({
  cameraId,
  streamUrl,
  onSnapshot,
  onError,
  pollIntervalMs = BACKGROUND_SNAPSHOT_POLL_MS,
  jitterMs = BACKGROUND_SNAPSHOT_JITTER_MS,
}: {
  cameraId: string;
  streamUrl: string;
  onSnapshot: (blob: Blob) => void;
  onError: () => void;
  pollIntervalMs?: number;
  jitterMs?: number;
}): () => void {
  const subscription: SnapshotSubscription = {
    active: true,
    cameraId,
    streamUrl,
    pollIntervalMs,
    jitterMs,
    timeout: null,
    abortController: null,
    onSnapshot,
    onError,
  };

  scheduleNext(subscription, initialDelay(cameraId, jitterMs));

  return () => {
    subscription.active = false;
    if (subscription.timeout) {
      clearTimeout(subscription.timeout);
      subscription.timeout = null;
    }
    subscription.abortController?.abort();
  };
}

function scheduleNext(subscription: SnapshotSubscription, delayMs: number) {
  if (!subscription.active) return;
  subscription.timeout = setTimeout(() => {
    subscription.timeout = null;
    enqueue({ subscription });
  }, delayMs);
}

function enqueue(task: SnapshotTask) {
  if (!task.subscription.active) return;
  queue.push(task);
  scheduleDrain();
}

function scheduleDrain() {
  if (drainScheduled) return;
  drainScheduled = true;
  setTimeout(drainQueue, 0);
}

function drainQueue() {
  drainScheduled = false;
  let started = 0;

  while (
    activeFetches < MAX_CONCURRENT_SNAPSHOT_FETCHES &&
    queue.length > 0 &&
    started < MAX_CONCURRENT_SNAPSHOT_FETCHES
  ) {
    const task = queue.shift();
    if (!task || !task.subscription.active) continue;

    activeFetches += 1;
    started += 1;
    void runTask(task).finally(() => {
      activeFetches -= 1;
      scheduleDrain();
    });
  }

  if (queue.length > 0 && activeFetches < MAX_CONCURRENT_SNAPSHOT_FETCHES) {
    scheduleDrain();
  }
}

async function runTask({ subscription }: SnapshotTask) {
  if (!subscription.active) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
  subscription.abortController = controller;

  try {
    const blob = await fetchSnapshotBlob(subscription, controller.signal);
    if (!blob || !subscription.active) return;
    subscription.onSnapshot(blob);
  } catch {
    if (subscription.active && !controller.signal.aborted) {
      subscription.onError();
    }
  } finally {
    clearTimeout(timeout);
    if (subscription.abortController === controller) {
      subscription.abortController = null;
    }
    scheduleNext(subscription, nextDelay(subscription));
  }
}

/** Convert a JPEG snapshot blob into a data-URL base64 string for YOLO/LitServe. */
export async function blobToBase64DataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to encode snapshot as base64"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read snapshot blob"));
    reader.readAsDataURL(blob);
  });
}

/** Fetch one RTSP snapshot and return it as `data:image/jpeg;base64,...`. */
export async function fetchSnapshotAsBase64(
  cameraId: string,
  streamUrl: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetch(buildSnapshotUrl(cameraId, streamUrl), {
      cache: "no-store",
      signal,
    });

    if (!response.ok) {
      handleSnapshotHttpFailure(cameraId, response.status);
      return null;
    }

    const blob = await response.blob();
    if (!blob.size) return null;
    return blobToBase64DataUrl(blob);
  } catch {
    return null;
  }
}

function initialDelay(cameraId: string, jitterMs: number): number {
  return hashCameraId(cameraId) % jitterMs;
}

function nextDelay(subscription: SnapshotSubscription): number {
  return (
    subscription.pollIntervalMs +
    (hashCameraId(`${subscription.cameraId}:${Date.now()}`) % subscription.jitterMs)
  );
}

function hashCameraId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
