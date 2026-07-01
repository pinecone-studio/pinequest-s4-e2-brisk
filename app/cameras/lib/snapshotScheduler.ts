"use client";

import {
  MAX_CONCURRENT_SNAPSHOT_FETCHES,
  SNAPSHOT_JITTER_MS,
  SNAPSHOT_POLL_INTERVAL_FAST_MS,
  SNAPSHOT_POLL_INTERVAL_MS,
  SNAPSHOT_TIMEOUT_MS,
} from "@/lib/snapshotConfig";

export type SnapshotPriority = "high" | "normal" | "paused";

interface SnapshotSubscription {
  active: boolean;
  cameraId: string;
  streamUrl: string;
  priority: SnapshotPriority;
  visible: boolean;
  etag: string | null;
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
  priority = "normal",
  onSnapshot,
  onError,
}: {
  cameraId: string;
  streamUrl: string;
  priority?: SnapshotPriority;
  onSnapshot: (blob: Blob) => void;
  onError: () => void;
}): {
  unsubscribe: () => void;
  setPriority: (priority: SnapshotPriority) => void;
  setVisible: (visible: boolean) => void;
} {
  const subscription: SnapshotSubscription = {
    active: true,
    cameraId,
    streamUrl,
    priority,
    visible: true,
    etag: null,
    timeout: null,
    abortController: null,
    onSnapshot,
    onError,
  };

  scheduleNext(subscription, initialDelay(cameraId));

  return {
    unsubscribe: () => {
      subscription.active = false;
      if (subscription.timeout) {
        clearTimeout(subscription.timeout);
        subscription.timeout = null;
      }
      subscription.abortController?.abort();
    },
    setPriority: (next) => {
      subscription.priority = next;
    },
    setVisible: (visible) => {
      subscription.visible = visible;
      if (!visible) {
        subscription.abortController?.abort();
      }
    },
  };
}

function scheduleNext(subscription: SnapshotSubscription, delayMs: number) {
  if (!subscription.active) return;
  subscription.timeout = setTimeout(() => {
    subscription.timeout = null;
    if (!subscription.visible || subscription.priority === "paused") {
      scheduleNext(subscription, pollInterval(subscription));
      return;
    }
    enqueue({ subscription });
  }, delayMs);
}

function pollInterval(subscription: SnapshotSubscription): number {
  if (!subscription.visible || subscription.priority === "paused") {
    return SNAPSHOT_POLL_INTERVAL_MS * 2;
  }
  if (subscription.priority === "high") {
    return SNAPSHOT_POLL_INTERVAL_FAST_MS + (hashCameraId(subscription.cameraId) % SNAPSHOT_JITTER_MS);
  }
  return SNAPSHOT_POLL_INTERVAL_MS + (hashCameraId(subscription.cameraId) % SNAPSHOT_JITTER_MS);
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
  if (!subscription.active || !subscription.visible) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
  subscription.abortController = controller;

  try {
    const headers: HeadersInit = {};
    if (subscription.etag) {
      headers["If-None-Match"] = subscription.etag;
    }

    const response = await fetch(snapshotEndpoint(subscription), {
      cache: "no-store",
      signal: controller.signal,
      headers,
    });

    if (response.status === 304) {
      return;
    }

    if (!response.ok) throw new Error(`Snapshot failed with status ${response.status}`);

    const nextEtag = response.headers.get("etag");
    if (nextEtag) {
      subscription.etag = nextEtag;
    }

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
    scheduleNext(subscription, pollInterval(subscription));
  }
}

function snapshotEndpoint(subscription: SnapshotSubscription): string {
  const params = new URLSearchParams({
    cameraId: subscription.cameraId,
    streamUrl: subscription.streamUrl,
  });
  return `/api/snapshot/rtsp?${params.toString()}`;
}

function initialDelay(cameraId: string): number {
  return hashCameraId(cameraId) % SNAPSHOT_JITTER_MS;
}

function hashCameraId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
