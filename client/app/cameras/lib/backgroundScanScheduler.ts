"use client";

import { buildCameraStreamUrl } from "./cameraApi";
import type { CameraView } from "./cameraTypes";
import { patchCameraScanState } from "./cameraScanStore";
import {
  BACKGROUND_SNAPSHOT_JITTER_MS,
  BACKGROUND_SNAPSHOT_POLL_MS,
  fetchSnapshotAsBase64,
} from "./snapshotScheduler";
import { postYoloFilter } from "./yoloApi";

const MAX_CONCURRENT_SCANS = 2;
const SCAN_TIMEOUT_MS = 12_000;
const UNAVAILABLE_AFTER_FAILURES = 6;

interface ScanSubscription {
  active: boolean;
  cameraId: string;
  streamUrl: string;
  aiReady: boolean;
  pollIntervalMs: number;
  jitterMs: number;
  consecutiveFailures: number;
  timeout: ReturnType<typeof setTimeout> | null;
  abortController: AbortController | null;
}

interface ScanTask {
  subscription: ScanSubscription;
}

const queue: ScanTask[] = [];
let activeScans = 0;
let drainScheduled = false;

export function subscribeToBackgroundScan({
  camera,
  aiReady,
  pollIntervalMs = BACKGROUND_SNAPSHOT_POLL_MS,
  jitterMs = BACKGROUND_SNAPSHOT_JITTER_MS,
}: {
  camera: CameraView;
  aiReady: boolean;
  pollIntervalMs?: number;
  jitterMs?: number;
}): () => void {
  const streamUrl = buildCameraStreamUrl(camera);
  const subscription: ScanSubscription = {
    active: true,
    cameraId: camera.id,
    streamUrl,
    aiReady,
    pollIntervalMs,
    jitterMs,
    consecutiveFailures: 0,
    timeout: null,
    abortController: null,
  };

  patchCameraScanState(camera.id, { status: "loading" });
  scheduleNext(subscription, initialDelay(camera.id, jitterMs));

  return () => {
    subscription.active = false;
    if (subscription.timeout) {
      clearTimeout(subscription.timeout);
      subscription.timeout = null;
    }
    subscription.abortController?.abort();
  };
}

function scheduleNext(subscription: ScanSubscription, delayMs: number) {
  if (!subscription.active) return;
  subscription.timeout = setTimeout(() => {
    subscription.timeout = null;
    enqueue({ subscription });
  }, delayMs);
}

function enqueue(task: ScanTask) {
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

  while (activeScans < MAX_CONCURRENT_SCANS && queue.length > 0 && started < MAX_CONCURRENT_SCANS) {
    const task = queue.shift();
    if (!task || !task.subscription.active) continue;
    activeScans += 1;
    started += 1;
    void runTask(task).finally(() => {
      activeScans -= 1;
      scheduleDrain();
    });
  }

  if (queue.length > 0 && activeScans < MAX_CONCURRENT_SCANS) {
    scheduleDrain();
  }
}

async function runTask({ subscription }: ScanTask) {
  if (!subscription.active) return;

  const { cameraId } = subscription;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  subscription.abortController = controller;

  patchCameraScanState(cameraId, { analyzing: true });

  try {
    const base64Image = await fetchSnapshotAsBase64(
      cameraId,
      subscription.streamUrl,
      controller.signal,
    );

    if (!subscription.active) return;

    if (!base64Image) {
      subscription.consecutiveFailures += 1;
      if (subscription.consecutiveFailures >= UNAVAILABLE_AFTER_FAILURES) {
        patchCameraScanState(cameraId, { status: "unavailable" });
      }
      return;
    }

    subscription.consecutiveFailures = 0;
    patchCameraScanState(cameraId, {
      status: "online",
      snapshotUrl: base64Image,
      lastScanAt: Date.now(),
    });

    if (subscription.aiReady) {
      const result = await postYoloFilter(cameraId, base64Image, controller.signal);
      if (!subscription.active || !result) return;

      if (result.has_person) {
        console.log(`[yolo:${cameraId}] person detected`);
      }

      patchCameraScanState(cameraId, {
        hasPerson: result.has_person === true,
        yoloImage: result.has_person ? (result.image ?? base64Image) : null,
      });
    }
  } finally {
    clearTimeout(timeout);
    if (subscription.abortController === controller) {
      subscription.abortController = null;
    }
    if (subscription.active) {
      patchCameraScanState(cameraId, { analyzing: false });
      scheduleNext(subscription, nextDelay(subscription));
    }
  }
}

function initialDelay(cameraId: string, jitterMs: number): number {
  return hashCameraId(cameraId) % jitterMs;
}

function nextDelay(subscription: ScanSubscription): number {
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
