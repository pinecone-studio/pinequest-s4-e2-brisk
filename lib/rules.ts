import { Detection } from "./yoloDecode";

export interface SmokingSignals {
  hasHandheldObject: boolean;
  isNearMouth: boolean;
  smokingModelScore: number;
}

export interface PersonResult {
  personBox: [number, number, number, number];
  compositeScore: number;
  signals: SmokingSignals;
}

export interface LitterResult {
  box: [number, number, number, number];
  label: string;
  confidence: number;
}

export interface CompositeDetections {
  smokingResults: PersonResult[];
  litterResults: LitterResult[];
}

const HANDHELD_LABELS = new Set([
  "cell phone", "bottle", "cup", "remote", "book", "scissors",
]);

const LITTER_LABELS = new Set([
  "bottle", "cup", "book", "cell phone",
]);

// COCO objects that can indicate mouth proximity (no smoking model — avoids circular logic)
const MOUTH_OBJECT_LABELS = new Set([
  "cell phone", "bottle", "cup", "remote", "scissors", "book", "banana", "toothbrush",
]);

const SMOKING_COMPOSITE_THRESHOLD = 0.45;
const LITTER_CONFIDENCE_THRESHOLD = 0.6;

function intersectionArea(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function boxArea(b: [number, number, number, number]): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function iou(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const inter = intersectionArea(a, b);
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

// Fraction of obj's area that falls inside region
function coverageRatio(
  region: [number, number, number, number],
  obj: [number, number, number, number],
): number {
  const area = boxArea(obj);
  return area > 0 ? intersectionArea(region, obj) / area : 0;
}

export function computeCompositeDetections(
  smokingDets: Detection[],
  cocoDets: Detection[],
): CompositeDetections {
  const persons = cocoDets.filter((d) => d.label === "person");
  const personBoxes = persons.map((p) => p.box);

  // ── smoking results ────────────────────────────────────────────────────────
  const smokingResults: PersonResult[] = [];

  for (const person of persons) {
    const [px1, py1, px2, py2] = person.box;
    const pw = px2 - px1;
    const ph = py2 - py1;

    // Upper-left and upper-right thirds (horizontally), upper half (vertically)
    const leftHandRegion: [number, number, number, number] = [
      px1, py1, px1 + pw / 3, py1 + ph / 2,
    ];
    const rightHandRegion: [number, number, number, number] = [
      px2 - pw / 3, py1, px2, py1 + ph / 2,
    ];

    // Mouth region: top 10–25% vertically, inner 60% horizontally
    const mouthRegion: [number, number, number, number] = [
      px1 + pw * 0.20,
      py1 + ph * 0.10,
      px2 - pw * 0.20,
      py1 + ph * 0.25,
    ];

    let score = 0;
    let hasHandheldObject = false;
    let isNearMouth = false;
    let smokingModelScore = 0;

    // Signal 1: handheld COCO object in left or right hand region
    for (const det of cocoDets) {
      if (!HANDHELD_LABELS.has(det.label)) continue;
      if (
        coverageRatio(leftHandRegion, det.box) > 0.3 ||
        coverageRatio(rightHandRegion, det.box) > 0.3
      ) {
        hasHandheldObject = true;
        break;
      }
    }
    if (hasHandheldObject) score += 0.2;

    // Signal 2: COCO small object overlapping mouth region (smoking model excluded —
    // using it here would let its own false positives confirm themselves)
    for (const det of cocoDets) {
      if (!MOUTH_OBJECT_LABELS.has(det.label)) continue;
      if (coverageRatio(mouthRegion, det.box) > 0.2) {
        isNearMouth = true;
        break;
      }
    }
    if (isNearMouth) score += 0.4;

    // Signal 3: smoking model detection inside person box. This is the primary
    // signal; COCO mouth/hand cues are only supporting context.
    for (const det of smokingDets) {
      if (det.label !== "Smoking") continue;
      if (det.confidence <= 0.5) continue;
      if (coverageRatio(person.box, det.box) > 0.3) {
        smokingModelScore = Math.max(smokingModelScore, det.confidence);
      }
    }
    if (smokingModelScore > 0) score += smokingModelScore;

    score = Math.min(1, Math.max(0, score));

    if (score > SMOKING_COMPOSITE_THRESHOLD) {
      smokingResults.push({
        personBox: person.box,
        compositeScore: score,
        signals: { hasHandheldObject, isNearMouth, smokingModelScore },
      });
    }
  }

  // ── litter results ─────────────────────────────────────────────────────────
  const litterResults: LitterResult[] = [];

  for (const det of cocoDets) {
    if (!LITTER_LABELS.has(det.label)) continue;

    // Must meet confidence threshold
    if (det.confidence < LITTER_CONFIDENCE_THRESHOLD) continue;

    // Must be a small object — no full-room boxes
    const w = det.box[2] - det.box[0];
    const h = det.box[3] - det.box[1];
    if (w >= 0.4 || h >= 0.4) continue;

    // Center must be in the bottom half of the frame
    const cy = (det.box[1] + det.box[3]) / 2;
    if (cy < 0.5) continue;

    // Must not overlap any person (IoU < 0.1)
    const overlapsPersons = personBoxes.some((pb) => iou(pb, det.box) >= 0.1);
    if (overlapsPersons) continue;

    litterResults.push({ box: det.box, label: det.label, confidence: det.confidence });
  }

  return { smokingResults, litterResults };
}
