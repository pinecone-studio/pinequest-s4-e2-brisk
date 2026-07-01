"use client";

export const GRID_SNAPSHOT_POLL_MS = 4000;
export const GRID_SNAPSHOT_JITTER_MS = 1000;
export const BACKGROUND_SNAPSHOT_POLL_MS = GRID_SNAPSHOT_POLL_MS;
export const BACKGROUND_SNAPSHOT_JITTER_MS = GRID_SNAPSHOT_JITTER_MS;
const MAX_CONCURRENT_SNAPSHOT_FETCHES = 2;
const SNAPSHOT_TIMEOUT_MS = 10000;

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
    const response = await fetch(snapshotEndpoint(subscription), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Snapshot failed with status ${response.status}`);

    const blob = await response.blob();
    if (!subscription.active) return;
    subscription.onSnapshot(blob);
  } catch {
    if (subscription.active) {
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

function snapshotEndpoint(subscription: SnapshotSubscription): string {
  const params = new URLSearchParams({
    cameraId: subscription.cameraId,
    streamUrl: subscription.streamUrl,
    v: String(Date.now()),
  });
  return `/api/snapshot/rtsp?${params.toString()}`;
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
