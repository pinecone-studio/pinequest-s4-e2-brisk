import { Detection } from "./yoloDecode";
import {
  SMOKING_MODEL_MIN,
  SMOKING_COMPOSITE_THRESHOLD,
  SMOKING_HIGH_CONFIDENCE,
  SMOKING_MOUTH_BOX_MIN,
  CIGARETTE_BOX_MAX_AREA,
  CIGARETTE_BOX_MIN_AREA,
  VAPE_BOX_MAX_AREA,
  SMOKE_PLUME_MAX_AREA,
  SMOKING_THRESHOLD,
} from "./modelConfig";
import { hasRealSmokingEvidence } from "./smokingVision";

export interface SmokingSignals {
  hasHandheldObject: boolean;
  isNearMouth: boolean;
  smokingModelScore: number;
  hasMouthSmokingBox: boolean;
  smokeLikeRatio: number;
}

export interface PersonResult {
  personBox: Box;
  cigaretteBox: Box;
  productLabel: SmokingProductLabel;
  compositeScore: number;
  signals: SmokingSignals;
}

export type SmokingProductLabel = "Cigarette" | "Vape";

export function isSmokingProductLabel(label: string): label is SmokingProductLabel {
  return label === "Cigarette" || label === "Vape";
}

export interface CompositeDetections {
  smokingResults: PersonResult[];
}

export interface MouthAnalysis {
  smokeLikeRatio: number;
  emberRatio: number;
  uniformLightRatio: number;
  palePaperRatio: number;
  centerPaleRatio: number;
  skinCoverRatio: number;
  isFalsePositive: boolean;
}

const MAX_LITTER_BOX_AREA = 0.5;
const FACE_FRACTION = 0.25;
const SMOKING_PRODUCTS = new Set<SmokingProductLabel>(["Cigarette", "Vape"]);

type Box = [number, number, number, number];

export function getFaceBoxes(personBoxes: Box[]): Box[] {
  return personBoxes.map(([px1, py1, px2, py2]) => {
    const faceBottom = py1 + (py2 - py1) * FACE_FRACTION;
    return [px1, py1, px2, faceBottom];
  });
}

export function filterLitterByFaces(
  litterDets: Detection[],
  faceBoxes: Box[],
): Detection[] {
  return litterDets.filter((lit) => {
    if (boxArea(lit.box) > MAX_LITTER_BOX_AREA) return false;

    const cx = (lit.box[0] + lit.box[2]) / 2;
    const cy = (lit.box[1] + lit.box[3]) / 2;

    return !faceBoxes.some(([fx1, fy1, fx2, fy2]) =>
      cx >= fx1 && cx <= fx2 && cy >= fy1 && cy <= fy2,
    );
  });
}

/** Head / face — litter here is almost always a false positive. */
function isOnHead(cx: number, cy: number, person: Box): boolean {
  const [px1, py1, px2, py2] = person;
  const pw = Math.max(px2 - px1, 1e-6);
  const ph = Math.max(py2 - py1, 1e-6);
  const relX = (cx - px1) / pw;
  const relY = (cy - py1) / ph;
  return relX >= 0.12 && relX <= 0.88 && relY >= 0 && relY <= 0.34;
}

function isOnTorso(cx: number, cy: number, person: Box): boolean {
  const [px1, py1, px2, py2] = person;
  const pw = Math.max(px2 - px1, 1e-6);
  const ph = Math.max(py2 - py1, 1e-6);
  const relX = (cx - px1) / pw;
  const relY = (cy - py1) / ph;
  return relX >= 0.26 && relX <= 0.74 && relY >= 0.18 && relY <= 0.58;
}

/** Arms / hands / waist — litter here is often a real held object. */
function isLikelyHandHeldLitter(cx: number, cy: number, person: Box): boolean {
  const [px1, py1, px2, py2] = person;
  const pw = Math.max(px2 - px1, 1e-6);
  const ph = Math.max(py2 - py1, 1e-6);
  const relX = (cx - px1) / pw;
  const relY = (cy - py1) / ph;

  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return false;

  const onLeftArm = relX <= 0.3;
  const onRightArm = relX >= 0.7;
  const belowShoulder = relY >= 0.36;
  const lowerBody = relY >= 0.52;
  const frontHold = relX >= 0.22 && relX <= 0.78 && relY >= 0.5;

  return (belowShoulder && (onLeftArm || onRightArm)) || lowerBody || frontHold;
}

function litterInsidePersonBody(cx: number, cy: number, person: Box): boolean {
  const [px1, py1, px2, py2] = person;
  return cx >= px1 && cx <= px2 && cy >= py1 && cy <= py2;
}

/**
 * Drop litter on head/torso (false positives on face, shirt, hair).
 * Keep litter in hands or outside the person.
 */
export function filterLitterByPersons(
  litterDets: Detection[],
  personBoxes: Box[],
): Detection[] {
  return litterDets.filter((lit) => {
    if (boxArea(lit.box) > MAX_LITTER_BOX_AREA) return false;

    const cx = (lit.box[0] + lit.box[2]) / 2;
    const cy = (lit.box[1] + lit.box[3]) / 2;

    for (const person of personBoxes) {
      if (!litterInsidePersonBody(cx, cy, person)) continue;

      if (isLikelyHandHeldLitter(cx, cy, person)) continue;

      if (isOnHead(cx, cy, person) || isOnTorso(cx, cy, person)) {
        return false;
      }
    }

    return true;
  });
}

function boxArea(b: Box): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function intersectionArea(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function coverageRatio(region: Box, obj: Box): number {
  const area = boxArea(obj);
  return area > 0 ? intersectionArea(region, obj) / area : 0;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function expandBox(box: Box, factor: number): Box {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const w = (box[2] - box[0]) * factor;
  const h = (box[3] - box[1]) * factor;
  return [
    clamp01(cx - w / 2),
    clamp01(cy - h / 2),
    clamp01(cx + w / 2),
    clamp01(cy + h / 2),
  ];
}

function isCigaretteSizedBox(box: Box): boolean {
  const area = boxArea(box);
  return area >= CIGARETTE_BOX_MIN_AREA && area <= CIGARETTE_BOX_MAX_AREA;
}

function isVapeSizedBox(box: Box): boolean {
  const area = boxArea(box);
  return area >= CIGARETTE_BOX_MIN_AREA && area <= VAPE_BOX_MAX_AREA;
}

function isProductSizedBox(box: Box, label: SmokingProductLabel): boolean {
  return label === "Vape" ? isVapeSizedBox(box) : isCigaretteSizedBox(box);
}

/** Best small cigarette-model box on/near mouth or hand. */
function pickCigaretteBox(personBox: Box, smokingDets: Detection[]): Box | null {
  const [px1, py1, px2, py2] = personBox;
  const pw = px2 - px1;
  const ph = py2 - py1;
  const mouth: Box = [px1 + pw * 0.1, py1 + ph * 0.02, px2 - pw * 0.1, py1 + ph * 0.42];
  const holdZone: Box = [px1, py1 + ph * 0.2, px2, py2];

  let best: { box: Box; score: number } | null = null;

  for (const det of smokingDets) {
    if (det.label !== "Cigarette") continue;
    if (det.confidence < SMOKING_MOUTH_BOX_MIN) continue;
    if (!isCigaretteSizedBox(det.box)) continue;
    if (coverageRatio(personBox, det.box) < 0.12) continue;

    const nearMouth = coverageRatio(mouth, det.box) > 0.15;
    const inHand = coverageRatio(holdZone, det.box) > 0.12;
    if (!nearMouth && !inHand) continue;

    const score = det.confidence + (nearMouth ? 0.05 : 0);
    if (!best || score > best.score) best = { box: det.box, score };
  }

  return best?.box ?? null;
}

/** Vape device box on/near mouth or hand. */
function pickVapeBox(personBox: Box, smokingDets: Detection[]): Box | null {
  const [px1, py1, px2, py2] = personBox;
  const pw = px2 - px1;
  const ph = py2 - py1;
  const mouth: Box = [px1 + pw * 0.08, py1 + ph * 0.02, px2 - pw * 0.08, py1 + ph * 0.48];
  const holdZone: Box = [px1, py1 + ph * 0.15, px2, py2];

  let best: { box: Box; score: number } | null = null;

  for (const det of smokingDets) {
    if (det.label !== "Vape") continue;
    if (det.confidence < SMOKING_MOUTH_BOX_MIN) continue;
    if (!isVapeSizedBox(det.box)) continue;
    if (coverageRatio(personBox, det.box) < 0.1) continue;

    const nearMouth = coverageRatio(mouth, det.box) > 0.12;
    const inHand = coverageRatio(holdZone, det.box) > 0.1;
    if (!nearMouth && !inHand) continue;

    const score = det.confidence + (nearMouth ? 0.05 : 0);
    if (!best || score > best.score) best = { box: det.box, score };
  }

  return best?.box ?? null;
}

/** Cigarette/vape box, or smoke-plume box when gray smoke pixels are visible. */
function pickSmokingDisplayBox(
  personBox: Box,
  smokingDets: Detection[],
  mouthStats: MouthAnalysis | null,
): { box: Box; label: SmokingProductLabel } | null {
  const cigarette = pickCigaretteBox(personBox, smokingDets);
  if (cigarette) return { box: cigarette, label: "Cigarette" };

  const vape = pickVapeBox(personBox, smokingDets);
  if (vape) return { box: vape, label: "Vape" };

  const smokeLike = mouthStats?.smokeLikeRatio ?? 0;
  if (smokeLike < 0.12) return null;

  const [px1, py1, px2, py2] = personBox;
  const pw = px2 - px1;
  const ph = py2 - py1;
  const plumeRegion: Box = [px1 + pw * 0.08, py1 + ph * 0.02, px2 - pw * 0.08, py1 + ph * 0.48];

  let best: { box: Box; label: SmokingProductLabel; score: number } | null = null;
  for (const det of smokingDets) {
    if (!SMOKING_PRODUCTS.has(det.label as SmokingProductLabel)) continue;
    if (det.confidence < SMOKING_THRESHOLD) continue;
    const area = boxArea(det.box);
    if (area > SMOKE_PLUME_MAX_AREA || area < CIGARETTE_BOX_MIN_AREA) continue;
    if (coverageRatio(plumeRegion, det.box) < 0.08) continue;
    if (!best || det.confidence > best.score) {
      best = { box: det.box, label: det.label as SmokingProductLabel, score: det.confidence };
    }
  }
  if (best) return { box: best.box, label: best.label };

  if (smokeLike > 0.16) {
    const vapeHint = smokingDets.some(
      (d) => d.label === "Vape" && d.confidence >= SMOKING_THRESHOLD * 0.85,
    );
    return { box: plumeRegion, label: vapeHint ? "Vape" : "Cigarette" };
  }
  return null;
}

function mouthSmokingBox(
  personBox: Box,
  smokingDets: Detection[],
): { found: boolean; score: number; maxBoxArea: number } {
  const [px1, py1, px2, py2] = personBox;
  const pw = px2 - px1;
  const ph = py2 - py1;
  const mouth: Box = [px1 + pw * 0.12, py1 + ph * 0.04, px2 - pw * 0.12, py1 + ph * 0.35];

  let best = 0;
  let maxBoxArea = 0;
  for (const det of smokingDets) {
    if (!SMOKING_PRODUCTS.has(det.label as SmokingProductLabel)) continue;
    if (det.confidence < SMOKING_MOUTH_BOX_MIN) continue;
    const area = boxArea(det.box);
    if (area > 0.15) continue;
    if (coverageRatio(mouth, det.box) > 0.08) {
      best = Math.max(best, det.confidence);
      maxBoxArea = Math.max(maxBoxArea, area);
    }
  }
  return { found: best >= SMOKING_MOUTH_BOX_MIN, score: best, maxBoxArea };
}

function scorePersonSmoking(
  personBox: Box,
  smokingDets: Detection[],
  mouthStats: MouthAnalysis | null,
): PersonResult | null {
  const mouthStatsEarly = mouthStats;
  const display = pickSmokingDisplayBox(personBox, smokingDets, mouthStatsEarly);
  if (!display) return null;

  const { box: displayBox, label: productLabel } = display;
  const isVape = productLabel === "Vape";

  let smokingModelScore = 0;
  for (const det of smokingDets) {
    if (det.label !== productLabel) continue;
    if (det.confidence < SMOKING_THRESHOLD) continue;
    if (iouBox(det.box, displayBox) > 0.12 || coverageRatio(displayBox, det.box) > 0.15) {
      smokingModelScore = Math.max(smokingModelScore, det.confidence);
    }
  }

  const smokeLikeRatio = mouthStats?.smokeLikeRatio ?? 0;
  if (smokingModelScore < SMOKING_MODEL_MIN && smokeLikeRatio < 0.16) return null;
  if (smokingModelScore < SMOKING_THRESHOLD && smokeLikeRatio > 0.16) {
    smokingModelScore = Math.min(0.55, 0.35 + smokeLikeRatio * 0.5);
  }

  if (mouthStats?.isFalsePositive) return null;

  const mouthBox = mouthSmokingBox(personBox, smokingDets);
  const emberRatio = mouthStats?.emberRatio ?? 0;
  if (
    !isVape &&
    mouthBox.maxBoxArea > 0.07 &&
    emberRatio < 0.015 &&
    smokeLikeRatio < 0.14
  ) {
    return null;
  }

  const mouthPixels = mouthStats
    ? {
        solidRedRatio: 0,
        uniformLightRatio: mouthStats.uniformLightRatio,
        palePaperRatio: mouthStats.palePaperRatio,
        centerPaleRatio: mouthStats.centerPaleRatio,
        skinCoverRatio: mouthStats.skinCoverRatio,
        smokeLikeRatio: mouthStats.smokeLikeRatio,
        emberRatio: mouthStats.emberRatio,
        redClusterMaxRatio: 0,
      }
    : null;

  if (!hasRealSmokingEvidence(mouthPixels, smokingModelScore)) return null;

  let score = smokingModelScore;

  if (mouthBox.found && emberRatio > 0.012) {
    score = Math.min(1, score + mouthBox.score * 0.15);
  }

  if (smokeLikeRatio > 0.12) {
    score = Math.min(1, score + Math.min(0.28, smokeLikeRatio * 0.45));
  }
  if (emberRatio > 0.015) {
    score = Math.min(1, score + Math.min(0.12, emberRatio * 3));
  }

  if (score < SMOKING_COMPOSITE_THRESHOLD && smokingModelScore < SMOKING_HIGH_CONFIDENCE) {
    if (smokeLikeRatio < 0.16) return null;
    score = Math.max(score, SMOKING_COMPOSITE_THRESHOLD);
  }

  return {
    personBox,
    cigaretteBox: displayBox,
    productLabel,
    compositeScore: Math.min(1, score),
    signals: {
      hasHandheldObject: false,
      isNearMouth: false,
      smokingModelScore,
      hasMouthSmokingBox: mouthBox.found,
      smokeLikeRatio,
    },
  };
}

function smokingMatchedPerson(smokingBox: Box, personBoxes: Box[]): boolean {
  return personBoxes.some((person) => coverageRatio(person, smokingBox) > 0.08);
}

function dedupePersonBoxes(boxes: Box[]): Box[] {
  const sorted = [...boxes].sort((a, b) => boxArea(b) - boxArea(a));
  const kept: Box[] = [];

  for (const box of sorted) {
    const overlaps = kept.some((k) => iouBox(k, box) > 0.45);
    if (!overlaps) kept.push(box);
  }
  return kept;
}

function iouBox(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Smoking from YOLO class-1 boxes + optional COCO person boxes.
 * Also emits direct smoking hits when COCO misses the person.
 */
export function computeCompositeDetections(
  smokingDets: Detection[],
  personBoxes: Box[],
  analyzeMouth?: (personBox: Box) => MouthAnalysis | null,
): CompositeDetections {
  const uniquePersons = dedupePersonBoxes(personBoxes);
  const smokingResults: PersonResult[] = [];

  for (const personBox of uniquePersons) {
    const mouthStats = analyzeMouth?.(personBox) ?? null;
    const result = scorePersonSmoking(personBox, smokingDets, mouthStats);
    if (result) smokingResults.push(result);
  }

  for (const det of smokingDets) {
    if (!isSmokingProductLabel(det.label) || det.confidence < SMOKING_MODEL_MIN) continue;
    if (smokingMatchedPerson(det.box, uniquePersons)) continue;
    if (det.confidence < SMOKING_HIGH_CONFIDENCE) continue;
    if (!isProductSizedBox(det.box, det.label)) continue;

    const analysisBox = expandBox(det.box, 6);
    const mouthStats = analyzeMouth?.(analysisBox) ?? null;
    if (mouthStats?.isFalsePositive) continue;

    const mouthPixels = mouthStats
      ? {
          solidRedRatio: 0,
          uniformLightRatio: mouthStats.uniformLightRatio,
          palePaperRatio: mouthStats.palePaperRatio,
          centerPaleRatio: mouthStats.centerPaleRatio,
          skinCoverRatio: mouthStats.skinCoverRatio,
          smokeLikeRatio: mouthStats.smokeLikeRatio,
          emberRatio: mouthStats.emberRatio,
          redClusterMaxRatio: 0,
        }
      : null;

    if (!hasRealSmokingEvidence(mouthPixels, det.confidence)) continue;

    smokingResults.push({
      personBox: det.box,
      cigaretteBox: det.box,
      productLabel: det.label,
      compositeScore: det.confidence,
      signals: {
        hasHandheldObject: false,
        isNearMouth: false,
        smokingModelScore: det.confidence,
        hasMouthSmokingBox: true,
        smokeLikeRatio: mouthStats?.smokeLikeRatio ?? 0,
      },
    });
  }

  if (smokingResults.length <= 1) return { smokingResults };

  const best = smokingResults.reduce((a, b) =>
    a.compositeScore >= b.compositeScore ? a : b,
  );
  return { smokingResults: [best] };
}
