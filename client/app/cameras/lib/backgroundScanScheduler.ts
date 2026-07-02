"use client";

import {
  EVIDENCE_COOLDOWN_MS,
  GEMINI_VIOLATION_THRESHOLD,
  PERSON_STICKY_MS,
} from "@/lib/aiConfig";
import {
  detectMotionFromDataUrl,
  type MotionSample,
} from "@/lib/motionGate";
import {
  captureEvidenceFromDataUrl,
  CIGARETTE_KIND,
  LITTER_KIND,
  VAPE_KIND,
} from "@/lib/cameraAiUtils";
import type { EvidenceEvent } from "@/lib/evidence";
import {
  buildGeminiFrameSet,
  hasTemporalContext,
  recordSceneFrame,
} from "@/lib/sceneBaseline";
import { buildCameraStreamUrl } from "./cameraApi";
import type { CameraView } from "./cameraTypes";
import { getCameraScanState, patchCameraScanState } from "./cameraScanStore";
import {
  BACKGROUND_SNAPSHOT_JITTER_MS,
  BACKGROUND_SNAPSHOT_POLL_MS,
  fetchSnapshotAsBase64,
} from "./snapshotScheduler";
import { postGeminiAnalyzeFrames, postYoloPersonGate } from "./yoloApi";

const MAX_CONCURRENT_SCANS = 2;
const SCAN_TIMEOUT_MS = 12_000;
const UNAVAILABLE_AFTER_FAILURES = 6;

type ViolationKey = "cigarette" | "vape" | "litter";

const VIOLATION_SPECS: {
  label: "Cigarette" | "Vape" | "Litter";
  key: ViolationKey;
  kind: typeof CIGARETTE_KIND;
  requiresTemporal: boolean;
}[] = [
  { label: "Cigarette", key: "cigarette", kind: CIGARETTE_KIND, requiresTemporal: false },
  { label: "Vape", key: "vape", kind: VAPE_KIND, requiresTemporal: false },
  { label: "Litter", key: "litter", kind: LITTER_KIND, requiresTemporal: true },
];

const lastEvidenceAt = new Map<string, number>();

/** When YOLO is offline, pause person-gate attempts (not Gemini) for all cameras. */
let yoloGatePausedUntil = 0;
const YOLO_OFFLINE_BACKOFF_MS = 60_000;

const lastNoPersonLogAt = new Map<string, number>();
const NO_PERSON_LOG_COOLDOWN_MS = 30_000;

const motionSamples = new Map<string, MotionSample>();
const lastPersonSeenAt = new Map<string, number>();

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
      const now = Date.now();
      if (now < yoloGatePausedUntil) {
        return;
      }

      const motion = await detectMotionFromDataUrl(
        base64Image,
        motionSamples.get(cameraId) ?? null,
      );
      if (motion) {
        motionSamples.set(cameraId, motion.sample);
      }

      const scanState = getCameraScanState(cameraId);
      const personRecentlySeen =
        scanState.hasPerson ||
        now - (lastPersonSeenAt.get(cameraId) ?? 0) < PERSON_STICKY_MS;

      if (!motion?.motionDetected && !personRecentlySeen) {
        if (scanState.hasPerson) {
          patchCameraScanState(cameraId, { hasPerson: false, yoloImage: null });
        }
        return;
      }

      patchCameraScanState(cameraId, { analyzing: true });

      const yolo = await postYoloPersonGate(cameraId, base64Image, controller.signal);
      if (!subscription.active) return;

      if (!yolo) {
        yoloGatePausedUntil = now + YOLO_OFFLINE_BACKOFF_MS;
        console.warn(
          `[yolo:${cameraId}] person gate offline — pausing YOLO checks for ${YOLO_OFFLINE_BACKOFF_MS / 1000}s (Gemini not called). Start models: cd models && python server.py`,
        );
        return;
      }

      yoloGatePausedUntil = 0;

      const hasPerson = yolo.has_person === true;
      // Fallback to has_person if an older models build doesn't send should_analyze.
      const shouldAnalyze =
        typeof yolo.should_analyze === "boolean" ? yolo.should_analyze : hasPerson;
      if (hasPerson) {
        lastPersonSeenAt.set(cameraId, now);
      } else {
        lastPersonSeenAt.delete(cameraId);
      }

      patchCameraScanState(cameraId, {
        hasPerson,
        yoloImage: hasPerson ? (yolo.image ?? base64Image) : null,
        lastViolation: null,
      });

      if (!hasPerson) {
        recordSceneFrame(cameraId, base64Image, false);
        const lastLog = lastNoPersonLogAt.get(cameraId) ?? 0;
        if (now - lastLog >= NO_PERSON_LOG_COOLDOWN_MS) {
          lastNoPersonLogAt.set(cameraId, now);
          console.log(`[yolo:${cameraId}] no person — skipping Gemini`);
        }
        return;
      }

      recordSceneFrame(cameraId, base64Image, true);

      // Person present but no smoke/litter candidate from the models — skip Gemini.
      // This is where the extra Gemini savings come from.
      if (!shouldAnalyze) {
        const lastLog = lastNoPersonLogAt.get(cameraId) ?? 0;
        if (now - lastLog >= NO_PERSON_LOG_COOLDOWN_MS) {
          lastNoPersonLogAt.set(cameraId, now);
          console.log(`[yolo:${cameraId}] person but no smoke/litter — skipping Gemini`);
        }
        patchCameraScanState(cameraId, { lastViolation: null });
        return;
      }

      const geminiFrames = buildGeminiFrameSet(cameraId, base64Image);
      const temporalOk = hasTemporalContext(cameraId, base64Image);

      console.log(
        `[yolo:${cameraId}] person detected — calling Gemini (${geminiFrames.length} frame${geminiFrames.length === 1 ? "" : "s"})`,
      );
      const result = await postGeminiAnalyzeFrames(cameraId, geminiFrames, controller.signal);
      if (!subscription.active || !result) return;

      const detections = Array.isArray(result.detections) ? result.detections : [];
      const summary = (result.summary ?? "").trim();

      let topViolation: { label: string; confidence: number } | null = null;

      for (const spec of VIOLATION_SPECS) {
        if (spec.requiresTemporal && !temporalOk) continue;

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
