import { Detection } from "./yoloDecode";
import { SMOKING_MOUTH_BOX_MIN } from "./modelConfig";

type Box = [number, number, number, number];

export interface MouthRegionStats {
  solidRedRatio: number;
  uniformLightRatio: number;
  palePaperRatio: number;
  centerPaleRatio: number;
  skinCoverRatio: number;
  smokeLikeRatio: number;
  emberRatio: number;
  redClusterMaxRatio: number;
}

function isPaperLikePixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  // Bright rolled paper — whiter than typical skin/lips.
  return max > 158 && r > 148 && g > 138 && b > 125 && sat < 0.2;
}

function isPalePixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (isPaperLikePixel(r, g, b)) return true;
  if (r > 185 && g > 175 && b > 160 && sat < 0.2) return true;
  return false;
}

function isSkinPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  return (
    r > 90 &&
    g > 55 &&
    b > 35 &&
    r >= g &&
    g >= b - 15 &&
    sat > 0.06 &&
    sat < 0.55 &&
    max > 75 &&
    max < 235
  );
}

function isEmberPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  return r > 185 && g > 70 && g < 175 && b < 95 && sat > 0.35 && max > 120;
}

/** Sample mouth-area pixels from the live video frame (normalized person box). */
export function analyzeMouthRegion(
  video: HTMLVideoElement,
  personBox: Box,
): MouthRegionStats | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;

  const [px1, py1, px2, py2] = personBox;
  const pw = px2 - px1;
  const ph = py2 - py1;

  const x1 = Math.max(0, Math.floor((px1 + pw * 0.15) * w));
  const y1 = Math.max(0, Math.floor((py1 + ph * 0.05) * h));
  const x2 = Math.min(w, Math.ceil((px2 - pw * 0.15) * w));
  const y2 = Math.min(h, Math.ceil((py1 + ph * 0.38) * h));
  const rw = x2 - x1;
  const rh = y2 - y1;
  if (rw < 8 || rh < 8) return null;

  const canvas = document.createElement("canvas");
  canvas.width = rw;
  canvas.height = rh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, x1, y1, rw, rh, 0, 0, rw, rh);
  const { data } = ctx.getImageData(0, 0, rw, rh);

  let solidRed = 0;
  let uniformLight = 0;
  let palePaper = 0;
  let centerPaper = 0;
  let centerSkin = 0;
  let centerTotal = 0;
  let smokeLike = 0;
  let ember = 0;
  const total = rw * rh;

  const cx1 = Math.floor(rw * 0.2);
  const cx2 = Math.ceil(rw * 0.8);
  const cy1 = Math.floor(rh * 0.25);
  const cy2 = Math.ceil(rh * 0.9);

  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = (y * rw + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;

      const inCenter = x >= cx1 && x < cx2 && y >= cy1 && y < cy2;
      if (inCenter) {
        centerTotal++;
        if (isPaperLikePixel(r, g, b)) centerPaper++;
        if (isSkinPixel(r, g, b)) centerSkin++;
      }

      if (r > 170 && r > g * 1.6 && r > b * 1.6 && sat > 0.45) {
        solidRed++;
      }

      if (r > 185 && g > 175 && b > 160 && sat < 0.2) {
        const graySmoke =
          sat < 0.35 &&
          max > 60 &&
          max < 220 &&
          Math.abs(r - g) < 35 &&
          Math.abs(g - b) < 35 &&
          !isPaperLikePixel(r, g, b);
        if (!graySmoke) uniformLight++;
      }

      if (isPalePixel(r, g, b)) {
        palePaper++;
      }

      if (
        !isPalePixel(r, g, b) &&
        sat < 0.35 &&
        max > 60 &&
        max < 220 &&
        Math.abs(r - g) < 35 &&
        Math.abs(g - b) < 35
      ) {
        smokeLike++;
      }

      if (isEmberPixel(r, g, b)) {
        ember++;
      }
    }
  }

  const cols = 8;
  const rows = 6;
  let redClusterMax = 0;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      let cellRed = 0;
      let cellTotal = 0;
      const sx = Math.floor((gx / cols) * rw);
      const ex = Math.floor(((gx + 1) / cols) * rw);
      const sy = Math.floor((gy / rows) * rh);
      const ey = Math.floor(((gy + 1) / rows) * rh);
      for (let y = sy; y < ey; y++) {
        for (let x = sx; x < ex; x++) {
          const idx = (y * rw + x) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          cellTotal++;
          if (r > 170 && r > g * 1.6 && r > b * 1.6) cellRed++;
        }
      }
      if (cellTotal > 0) {
        redClusterMax = Math.max(redClusterMax, cellRed / cellTotal);
      }
    }
  }

  return {
    solidRedRatio: solidRed / total,
    uniformLightRatio: uniformLight / total,
    palePaperRatio: palePaper / total,
    centerPaleRatio: centerTotal > 0 ? centerPaper / centerTotal : 0,
    skinCoverRatio: centerTotal > 0 ? centerSkin / centerTotal : 0,
    smokeLikeRatio: smokeLike / total,
    emberRatio: ember / total,
    redClusterMaxRatio: redClusterMax,
  };
}

export function paleMouthScore(stats: MouthRegionStats): number {
  return Math.max(stats.uniformLightRatio, stats.centerPaleRatio);
}

/** Reject obvious non-smoking mouth visuals (toy, paper, red lamp). */
export function isVisualFalsePositive(stats: MouthRegionStats): boolean {
  if (stats.solidRedRatio > 0.22 && stats.redClusterMaxRatio > 0.65 && stats.emberRatio < 0.04) {
    return true;
  }

  const noEmber = stats.emberRatio < 0.018;
  const heavySmoke = stats.smokeLikeRatio > 0.14;

  // Hands covering face — mostly skin in mouth area, no ember/smoke.
  if (noEmber && stats.skinCoverRatio > 0.42 && stats.smokeLikeRatio < 0.16) return true;

  // Bare face / lips — model often fires "cigarette" on mouth with no smoke or ember.
  if (noEmber && stats.skinCoverRatio > 0.28 && stats.smokeLikeRatio < 0.14) return true;

  // White paper / toy — not a gray smoke plume.
  if (noEmber && !heavySmoke && stats.centerPaleRatio > 0.045) return true;
  if (noEmber && !heavySmoke && stats.uniformLightRatio > 0.1) return true;

  return false;
}

/**
 * Pixel + model smoking proof. Model mouth boxes alone are not enough (paper FP),
 * but a trained smoke box plus gray smoke pixels is valid.
 */
export function hasRealSmokingEvidence(
  stats: MouthRegionStats | null,
  modelScore = 0,
): boolean {
  if (!stats) return false;

  if (stats.centerPaleRatio > 0.05 && stats.emberRatio < 0.015 && stats.smokeLikeRatio < 0.12) {
    return false;
  }
  if (stats.uniformLightRatio > 0.12 && stats.emberRatio < 0.015 && stats.smokeLikeRatio < 0.12) {
    return false;
  }
  if (stats.skinCoverRatio > 0.45 && stats.emberRatio < 0.015 && stats.smokeLikeRatio < 0.14) {
    return false;
  }

  // Normal face: mouth shadows are not smoke. Require ember, visible smoke, or very high model score.
  if (stats.emberRatio < 0.015 && stats.smokeLikeRatio < 0.14) {
    if (stats.skinCoverRatio > 0.28) return false;
    if (modelScore < 0.72) return false;
  }

  if (stats.emberRatio > 0.015) return true;

  if (stats.smokeLikeRatio > 0.14) return true;

  return false;
}

/** Small smoking-model box overlapping mouth — used for scoring only, not as sole proof. */
export function hasMouthSmokingBox(
  personBox: Box,
  smokingDets: Detection[],
  minConfidence = SMOKING_MOUTH_BOX_MIN,
): boolean {
  const [px1, py1, px2, py2] = personBox;
  const pw = px2 - px1;
  const ph = py2 - py1;
  const mouth: Box = [px1 + pw * 0.15, py1 + ph * 0.05, px2 - pw * 0.15, py1 + ph * 0.35];

  return smokingDets.some((det) => {
    if (
      (det.label !== "Cigarette" && det.label !== "Vape") ||
      det.confidence < minConfidence
    ) {
      return false;
    }
    const boxArea = (det.box[2] - det.box[0]) * (det.box[3] - det.box[1]);
    if (boxArea > 0.1) return false;
    return coverageRatio(mouth, det.box) > 0.1;
  });
}

function coverageRatio(region: Box, obj: Box): number {
  const x1 = Math.max(region[0], obj[0]);
  const y1 = Math.max(region[1], obj[1]);
  const x2 = Math.min(region[2], obj[2]);
  const y2 = Math.min(region[3], obj[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const objArea = Math.max(0, obj[2] - obj[0]) * Math.max(0, obj[3] - obj[1]);
  return objArea > 0 ? inter / objArea : 0;
}
