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
  downscaleFrameForGate,
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
import { patchEvidenceStatus, postGeminiAnalyzeFrames, postYoloPersonGate } from "./yoloApi";

// Tuned for ~30 cameras: allow more scans in flight so cameras don't fall
// behind the ~500ms poll cadence. Raise cautiously — higher = more browser load.
const MAX_CONCURRENT_SCANS = 8;
/** Global cap on how many scans start per second, across ALL cameras, so the
 *  browser stays smooth no matter how many cameras are hot. */
const MAX_SCANS_PER_SEC = 10;
const MIN_SCAN_GAP_MS = 1000 / MAX_SCANS_PER_SEC;
const SCAN_TIMEOUT_MS = 12_000;
const UNAVAILABLE_AFTER_FAILURES = 6;
/** Max width of the frame sent to the Lightning gate (YOLO needs no detail). */
const GATE_FRAME_WIDTH = 384;

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

// ---- Litter lifecycle state machine --------------------------------------
// Littering = a person leaves trash behind and moves off it. We track each
// litter box (normalized [x1,y1,x2,y2]) per camera across frames:
//   pending  — trash seen; if a person was ON it and then steps away, it's a
//              candidate. If it vanishes while pending, they carried/binned it
//              (no event). If it persists unattended -> escalate to Gemini once.
//   active   — Gemini confirmed littering; an evidence event exists.
// When an active box later disappears (trash removed), the event is HANDLED.
type BBox = [number, number, number, number];
const LITTER_IOU = 0.4; // same-trash match across frames
const PERSON_ON_MARGIN = 0.05; // expand person box slightly when testing "on the trash"
const LITTER_LEFT_BEHIND_MS = 3000; // unattended this long -> left behind
const LITTER_GONE_MISSES = 2; // scans without the box -> removed from scene
const MAX_REGISTERED_LITTER = 32;

interface LitterTrack {
  box: BBox;
  firstSeenAt: number;
  lastSeenAt: number;
  missStreak: number;
  personWasOn: boolean; // a person overlapped this box -> it was dropped, not pre-existing debris
  leftBehindSince: number | null; // when it became unattended after a person was on it
  state: "pending" | "active";
  escalated: boolean; // already sent to Gemini (don't ask again for the same box)
  event: EvidenceEvent | null; // the active event, so removal can mark it handled
}

const litterTracks = new Map<string, LitterTrack[]>();

function iou(a: BBox, b: BBox): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function boxesOverlap(a: BBox, b: BBox, margin = 0): boolean {
  const ax1 = a[0] - margin, ay1 = a[1] - margin, ax2 = a[2] + margin, ay2 = a[3] + margin;
  return (
    Math.min(ax2, b[2]) > Math.max(ax1, b[0]) && Math.min(ay2, b[3]) > Math.max(ay1, b[1])
  );
}

/**
 * Advance the per-camera litter tracks with this frame's detections.
 * Returns litter that just became "left behind" (escalate to Gemini) and the
 * events whose trash was removed (mark handled).
 */
function updateLitterTracks(
  cameraId: string,
  litterBoxes: BBox[],
  personBoxes: BBox[],
  now: number,
): { leftBehindBoxes: BBox[]; handledEvents: EvidenceEvent[] } {
  const tracks = litterTracks.get(cameraId) ?? [];
  const matched = new Set<number>();

  for (const box of litterBoxes) {
    const personOn = personBoxes.some((p) => boxesOverlap(p, box, PERSON_ON_MARGIN));
    let idx = -1;
    for (let i = 0; i < tracks.length; i += 1) {
      if (!matched.has(i) && iou(tracks[i].box, box) >= LITTER_IOU) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      matched.add(idx);
      const t = tracks[idx];
      t.box = box;
      t.lastSeenAt = now;
      t.missStreak = 0;
      if (personOn) {
        t.personWasOn = true;
        t.leftBehindSince = null; // still attended
      } else if (t.personWasOn && t.leftBehindSince === null && !t.escalated) {
        t.leftBehindSince = now; // person just stepped off
      }
    } else if (tracks.length < MAX_REGISTERED_LITTER) {
      tracks.push({
        box,
        firstSeenAt: now,
        lastSeenAt: now,
        missStreak: 0,
        personWasOn: personOn,
        leftBehindSince: null,
        state: "pending",
        escalated: false,
        event: null,
      });
    }
  }

  const leftBehindBoxes: BBox[] = [];
  const handledEvents: EvidenceEvent[] = [];
  const survivors: LitterTrack[] = [];

  for (let i = 0; i < tracks.length; i += 1) {
    const t = tracks[i];
    if (!matched.has(i) && t.lastSeenAt !== now) {
      t.missStreak += 1;
    }
    if (t.missStreak >= LITTER_GONE_MISSES) {
      // Trash removed from the scene.
      if (t.state === "active" && t.event) handledEvents.push(t.event);
      continue; // drop the track
    }
    if (
      t.state === "pending" &&
      !t.escalated &&
      t.personWasOn &&
      t.leftBehindSince !== null &&
      now - t.leftBehindSince >= LITTER_LEFT_BEHIND_MS
    ) {
      t.escalated = true; // ask Gemini once
      leftBehindBoxes.push(t.box);
    }
    survivors.push(t);
  }

  litterTracks.set(cameraId, survivors);
  return { leftBehindBoxes, handledEvents };
}

/** Attach a confirmed evidence event to the left-behind track(s) it belongs to. */
function linkLitterEvent(cameraId: string, boxes: BBox[], event: EvidenceEvent): void {
  const tracks = litterTracks.get(cameraId);
  if (!tracks) return;
  for (const t of tracks) {
    if (t.state === "pending" && boxes.some((b) => iou(b, t.box) >= LITTER_IOU)) {
      t.state = "active";
      t.event = event;
    }
  }
}

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
let lastScanStartAt = 0;

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
  scheduleDrainIn(0);
}

function scheduleDrainIn(ms: number) {
  if (drainScheduled) return;
  drainScheduled = true;
  setTimeout(drainQueue, ms);
}

function drainQueue() {
  drainScheduled = false;
  if (queue.length === 0 || activeScans >= MAX_CONCURRENT_SCANS) return;

  // Global rate cap: at most MAX_SCANS_PER_SEC scan starts per second, across
  // every camera, so total per-frame work stays bounded and the UI stays smooth.
  const now = Date.now();
  const wait = MIN_SCAN_GAP_MS - (now - lastScanStartAt);
  if (wait > 0) {
    scheduleDrainIn(wait);
    return;
  }

  const task = queue.shift();
  if (task && task.subscription.active) {
    lastScanStartAt = now;
    activeScans += 1;
    void runTask(task).finally(() => {
      activeScans -= 1;
      scheduleDrain();
    });
  }

  // Try to start the next one — it'll hit the rate gate and reschedule if needed.
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

      // Send a downscaled frame to the gate — YOLO needs no detail and returns
      // normalized boxes, so this cuts payload/inference without shifting coords.
      // Full-res base64Image is still used for Gemini + evidence below.
      const gateImage = await downscaleFrameForGate(base64Image, GATE_FRAME_WIDTH);
      const yolo = await postYoloPersonGate(cameraId, gateImage, controller.signal);
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
      const hasSmoke = yolo.has_smoke === true;
      const personBoxes: BBox[] = Array.isArray(yolo.person_boxes)
        ? (yolo.person_boxes as BBox[])
        : [];
      const litterBoxes: BBox[] = Array.isArray(yolo.litter_boxes)
        ? (yolo.litter_boxes as BBox[])
        : [];

      if (hasPerson) {
        lastPersonSeenAt.set(cameraId, now);
      } else {
        lastPersonSeenAt.delete(cameraId);
      }

      patchCameraScanState(cameraId, {
        hasPerson,
        yoloImage: hasPerson ? (yolo.image ?? base64Image) : null,
      });

      recordSceneFrame(cameraId, base64Image, hasPerson);

      // Advance the litter lifecycle every scan, person or not — trash left
      // behind must be tracked after the person leaves, and its later removal
      // (which involves motion, so we're still scanning) marks the event handled.
      const { leftBehindBoxes, handledEvents } = updateLitterTracks(
        cameraId,
        litterBoxes,
        personBoxes,
        now,
      );
      for (const ev of handledEvents) {
        void patchEvidenceStatus(ev.id, "handled");
        subscription.onEvent?.({ ...ev, status: "handled", handledAt: now });
        console.log(`[litter:${cameraId}] trash removed — event ${ev.id} marked handled`);
      }
      const litterLeftBehind = leftBehindBoxes.length > 0;

      // Gate: smoking needs a person; littering fires only when trash was just
      // left behind. Legacy fallback for an older models build without fields.
      const legacyGate =
        yolo.has_smoke === undefined && yolo.litter_boxes === undefined;
      const needGemini = legacyGate
        ? typeof yolo.should_analyze === "boolean"
          ? yolo.should_analyze
          : hasPerson
        : (hasPerson && hasSmoke) || litterLeftBehind;

      if (!needGemini) {
        const lastLog = lastNoPersonLogAt.get(cameraId) ?? 0;
        if (now - lastLog >= NO_PERSON_LOG_COOLDOWN_MS) {
          lastNoPersonLogAt.set(cameraId, now);
          console.log(
            `[yolo:${cameraId}] nothing to analyze (person=${hasPerson} smoke=${hasSmoke} litterLeftBehind=${litterLeftBehind})`,
          );
        }
        patchCameraScanState(cameraId, { lastViolation: null });
        return;
      }

      const geminiFrames = buildGeminiFrameSet(cameraId, base64Image);
      const temporalOk = hasTemporalContext(cameraId, base64Image);

      console.log(
        `[yolo:${cameraId}] escalating to Gemini (${geminiFrames.length} frame${geminiFrames.length === 1 ? "" : "s"}; smoke=${hasSmoke} litterLeftBehind=${litterLeftBehind})`,
      );
      const result = await postGeminiAnalyzeFrames(cameraId, geminiFrames, controller.signal);
      if (!subscription.active || !result) return;

      const detections = Array.isArray(result.detections) ? result.detections : [];
      const summary = (result.summary ?? "").trim();

      let topViolation: { label: string; confidence: number } | null = null;

      for (const spec of VIOLATION_SPECS) {
        // Litter only counts when a box just became "left behind" this scan.
        if (spec.label === "Litter" && !litterLeftBehind) continue;
        // Smoking/vaping are person-actions — require a person in frame.
        if (spec.label !== "Litter" && !hasPerson) continue;
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
        const created = await captureEvidenceFromDataUrl(
          base64Image,
          cameraId,
          subscription.sourceLabel,
          spec.kind,
          det.confidence,
          subscription.onEvent,
          summary || undefined,
        );
        // Link the confirmed litter event to its track so removal marks it handled.
        if (spec.label === "Litter" && created) {
          linkLitterEvent(cameraId, leftBehindBoxes, created);
        }
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
