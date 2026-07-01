import {
  MOTION_PIXEL_THRESHOLD,
  MOTION_SAMPLE_HEIGHT,
  MOTION_SAMPLE_WIDTH,
} from "./aiConfig";

const SAMPLE_SIZE = MOTION_SAMPLE_WIDTH * MOTION_SAMPLE_HEIGHT;

/** Grayscale downsample of a frame for cheap frame-to-frame diff. */
export type MotionSample = Uint8Array;

export interface MotionResult {
  motionDetected: boolean;
  diffPixels: number;
  sample: MotionSample;
}

function readSample(img: HTMLImageElement): MotionSample | null {
  const { naturalWidth: w, naturalHeight: h } = img;
  if (!w || !h) return null;

  const canvas = document.createElement("canvas");
  canvas.width = MOTION_SAMPLE_WIDTH;
  canvas.height = MOTION_SAMPLE_HEIGHT;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(img, 0, 0, MOTION_SAMPLE_WIDTH, MOTION_SAMPLE_HEIGHT);
  const { data } = ctx.getImageData(0, 0, MOTION_SAMPLE_WIDTH, MOTION_SAMPLE_HEIGHT);

  const gray = new Uint8Array(SAMPLE_SIZE);
  for (let i = 0; i < SAMPLE_SIZE; i += 1) {
    const o = i * 4;
    gray[i] = Math.round(data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114);
  }
  return gray;
}

/** Compare the current frame against the previous downsample. */
export function detectMotion(
  img: HTMLImageElement,
  previous: MotionSample | null,
): MotionResult | null {
  const sample = readSample(img);
  if (!sample) {
    return null;
  }

  if (!previous || previous.length !== sample.length) {
    return { motionDetected: false, diffPixels: 0, sample };
  }

  let diffPixels = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (Math.abs(sample[i] - previous[i]) > 18) {
      diffPixels += 1;
    }
  }

  return {
    motionDetected: diffPixels >= MOTION_PIXEL_THRESHOLD,
    diffPixels,
    sample,
  };
}
