"use client";

import { GEMINI_VIOLATION_THRESHOLD, EVIDENCE_COOLDOWN_MS } from "@/lib/aiConfig";
import {
  captureEvidenceFromDataUrl,
  CIGARETTE_KIND,
  LITTER_KIND,
  VAPE_KIND,
} from "@/lib/cameraAiUtils";
import type { EvidenceEvent } from "@/lib/evidence";
import { buildCameraStreamUrl } from "./cameraApi";
import type { CameraView } from "./cameraTypes";
import { patchCameraScanState } from "./cameraScanStore";
import {
  BACKGROUND_SNAPSHOT_JITTER_MS,
  BACKGROUND_SNAPSHOT_POLL_MS,
  fetchSnapshotAsBase64,
} from "./snapshotScheduler";
import { postGeminiAnalyze } from "./yoloApi";

const MAX_CONCURRENT_SCANS = 2;
const SCAN_TIMEOUT_MS = 12_000;
const UNAVAILABLE_AFTER_FAILURES = 6;

type ViolationKey = "cigarette" | "vape" | "litter";

const VIOLATION_SPECS: {
  label: "Cigarette" | "Vape" | "Litter";
  key: ViolationKey;
  kind: typeof CIGARETTE_KIND;
}[] = [
  { label: "Cigarette", key: "cigarette", kind: CIGARETTE_KIND },
  { label: "Vape", key: "vape", kind: VAPE_KIND },
  { label: "Litter", key: "litter", kind: LITTER_KIND },
];

const lastEvidenceAt = new Map<string, number>();

interface ScanSubscription {
  active: boolean;
  camera: CameraView;
  sourceLabel: string;
  streamUrl: string;
  aiReady: boolean;
  pollIntervalMs: number;
  jitterMs: number;
  consecutiveFailures: number;
  timeout: ReturnType<typeof setTimeout> | null;
  abortController: AbortController | null;
  onEvent?: (event: EvidenceEvent) => void;
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
  onEvent,
  sourceLabel,
}: {
  camera: CameraView;
  aiReady: boolean;
  pollIntervalMs?: number;
  jitterMs?: number;
  onEvent?: (event: EvidenceEvent) => void;
  sourceLabel?: string;
}): () => void {
  const streamUrl = buildCameraStreamUrl(camera);
  const subscription: ScanSubscription = {
    active: true,
    camera,
    sourceLabel: sourceLabel ?? camera.name ?? camera.id,
    streamUrl,
    aiReady,
    pollIntervalMs,
    jitterMs,
    consecutiveFailures: 0,
    timeout: null,
    abortController: null,
    onEvent,
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

  const cameraId = subscription.camera.id;
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
      const result = await postGeminiAnalyze(cameraId, base64Image, controller.signal);
      if (!subscription.active || !result) return;

      const detections = Array.isArray(result.detections) ? result.detections : [];
      const hasPerson = detections.some((d) => d.label === "Person");
      const summary = (result.summary ?? "").trim();

      patchCameraScanState(cameraId, {
        hasPerson,
        yoloImage: hasPerson ? base64Image : null,
      });

      const now = Date.now();
      let topViolation: { label: string; confidence: number } | null = null;

      for (const spec of VIOLATION_SPECS) {
        const det = detections
          .filter((d) => d.label === spec.label && d.confidence >= GEMINI_VIOLATION_THRESHOLD)
          .sort((a, b) => b.confidence - a.confidence)[0];
        if (!det) continue;

        if (!topViolation || det.confidence > topViolation.confidence) {
          topViolation = { label: spec.label, confidence: det.confidence };
        }

        console.log(
          `[gemini:${cameraId}] ${spec.label} ${Math.round(det.confidence * 100)}% — ${summary || "violation detected"}`,
        );

        const cooldownKey = `${cameraId}:${spec.key}`;
        const lastAt = lastEvidenceAt.get(cooldownKey) ?? 0;
        if (now - lastAt < EVIDENCE_COOLDOWN_MS) continue;

        lastEvidenceAt.set(cooldownKey, now);
        void captureEvidenceFromDataUrl(
          base64Image,
          cameraId,
          subscription.sourceLabel,
          spec.kind,
          det.confidence,
          subscription.onEvent,
          summary || undefined,
        );
      }

      patchCameraScanState(cameraId, { lastViolation: topViolation });
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
    (hashCameraId(`${subscription.camera.id}:${Date.now()}`) % subscription.jitterMs)
  );
}

function hashCameraId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
