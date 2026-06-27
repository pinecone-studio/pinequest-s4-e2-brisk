export interface Detection {
  label: string;
  confidence: number;
  box: [number, number, number, number]; // x1, y1, x2, y2 normalized [0,1]
}

export function normalizeLabel(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("smoking")) return "Smoking";
  if (lower.includes("litter") || lower.includes("plastic") || lower.includes("trash"))
    return "Litter";
  return raw;
}

function iou(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-6);
}

function nms(dets: Detection[], iouThreshold = 0.45): Detection[] {
  const sorted = [...dets].sort((a, b) => b.confidence - a.confidence);
  const keep: Detection[] = [];
  const suppressed = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue;
    keep.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (!suppressed.has(j) && iou(sorted[i].box, sorted[j].box) > iouThreshold) {
        suppressed.add(j);
      }
    }
  }
  return keep;
}

/**
 * Decode YOLO output tensor (shape [1, 4+numClasses, numAnchors]) into detections.
 * Box coords are in absolute pixels relative to INPUT_SIZE (640x640).
 */
export function decodeYolo(
  output: Float32Array,
  classNames: string[],
  threshold: number,
  numAnchors: number,
): Detection[] {
  const numClasses = classNames.length;
  const raw: Detection[] = [];

  for (let a = 0; a < numAnchors; a++) {
    const cx = output[0 * numAnchors + a];
    const cy = output[1 * numAnchors + a];
    const w = output[2 * numAnchors + a];
    const h = output[3 * numAnchors + a];

    let maxScore = -Infinity;
    let maxIdx = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = output[(4 + c) * numAnchors + a];
      if (score > maxScore) {
        maxScore = score;
        maxIdx = c;
      }
    }

    if (maxScore < threshold) continue;

    // Normalize to [0, 1] from absolute 640px coords
    const x1 = Math.max(0, (cx - w / 2) / 640);
    const y1 = Math.max(0, (cy - h / 2) / 640);
    const x2 = Math.min(1, (cx + w / 2) / 640);
    const y2 = Math.min(1, (cy + h / 2) / 640);

    raw.push({
      label: normalizeLabel(classNames[maxIdx]),
      confidence: maxScore,
      box: [x1, y1, x2, y2],
    });
  }

  return nms(raw);
}
