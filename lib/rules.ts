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

export interface CompositeDetections {
  smokingResults: PersonResult[];
}

const HANDHELD_LABELS = new Set([
  "cell phone", "bottle", "cup", "remote", "book", "scissors",
]);

const MOUTH_OBJECT_LABELS = new Set([
  "cell phone", "bottle", "cup", "remote", "scissors", "book", "banana", "toothbrush",
]);

const SMOKING_COMPOSITE_THRESHOLD = 0.45;

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

function coverageRatio(
  region: [number, number, number, number],
  obj: [number, number, number, number],
): number {
  const area = boxArea(obj);
  return area > 0 ? intersectionArea(region, obj) / area : 0;
}

const MAX_LITTER_BOX_AREA = 0.5;
// Face is roughly the top 25% of a person bounding box.
const FACE_FRACTION = 0.25;

type Box = [number, number, number, number];

/** Derive face bounding boxes from COCO person detections. */
export function getFaceBoxes(personBoxes: Box[]): Box[] {
  return personBoxes.map(([px1, py1, px2, py2]) => {
    const faceBottom = py1 + (py2 - py1) * FACE_FRACTION;
    return [px1, py1, px2, faceBottom];
  });
}

/** Drop litter detections whose center falls inside a detected face box. */
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

/** @deprecated use filterLitterByFaces + getFaceBoxes */
export function filterLitterByPersons(
  litterDets: Detection[],
  personBoxes: Box[],
): Detection[] {
  return filterLitterByFaces(litterDets, getFaceBoxes(personBoxes));
}

export function computeCompositeDetections(
  smokingDets: Detection[],
  cocoDets: Detection[],
): CompositeDetections {
  const persons = cocoDets.filter((d) => d.label === "person");

  const smokingResults: PersonResult[] = [];

  for (const person of persons) {
    const [px1, py1, px2, py2] = person.box;
    const pw = px2 - px1;
    const ph = py2 - py1;

    const leftHandRegion: [number, number, number, number] = [
      px1, py1, px1 + pw / 3, py1 + ph / 2,
    ];
    const rightHandRegion: [number, number, number, number] = [
      px2 - pw / 3, py1, px2, py1 + ph / 2,
    ];

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

    for (const det of cocoDets) {
      if (!MOUTH_OBJECT_LABELS.has(det.label)) continue;
      if (coverageRatio(mouthRegion, det.box) > 0.2) {
        isNearMouth = true;
        break;
      }
    }
    if (isNearMouth) score += 0.4;

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

  return { smokingResults };
}
