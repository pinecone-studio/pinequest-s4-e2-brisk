import type * as OrtType from "onnxruntime-web";
import {
  SMOKING_MODEL_PATH,
  COCO_MODEL_PATH,
  SMOKING_THRESHOLD,
  COCO_THRESHOLD,
  COCO_CLASS_NAMES,
  INPUT_SIZE,
} from "./modelConfig";
import { decodeYolo, Detection } from "./yoloDecode";
import { computeCompositeDetections } from "./rules";

// Smoking model output is [cx, cy, w, h, background, smoking].
const SMOKING_CLASS_NAMES = ["-", "Smoking"];

let ort: typeof OrtType | null = null;
let smokingSession: OrtType.InferenceSession | null = null;
let cocoSession: OrtType.InferenceSession | null = null;
let isRunning = false;

export async function loadModels(): Promise<void> {
  // Dynamic import keeps onnxruntime-web out of the SSR bundle
  ort = await import("onnxruntime-web");

  // Use CDN so we don't have to serve WASM + .mjs worker files locally
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
  // Single-threaded avoids needing SharedArrayBuffer COOP/COEP headers
  ort.env.wasm.numThreads = 1;

  [smokingSession, cocoSession] = await Promise.all([
    ort.InferenceSession.create(SMOKING_MODEL_PATH, {
      executionProviders: ["wasm"],
    }),
    ort.InferenceSession.create(COCO_MODEL_PATH, {
      executionProviders: ["wasm"],
    }),
  ]);
}

function preprocessFrame(source: HTMLVideoElement | HTMLCanvasElement): Float32Array {
  if (!ort) throw new Error("ORT not loaded");
  const offscreen = document.createElement("canvas");
  offscreen.width = INPUT_SIZE;
  offscreen.height = INPUT_SIZE;
  const ctx = offscreen.getContext("2d")!;
  ctx.drawImage(source as CanvasImageSource, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);

  const pixels = INPUT_SIZE * INPUT_SIZE;
  const float32 = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    float32[i] = data[i * 4] / 255;                   // R
    float32[pixels + i] = data[i * 4 + 1] / 255;      // G
    float32[2 * pixels + i] = data[i * 4 + 2] / 255;  // B
  }
  return float32;
}

export async function runInference(video: HTMLVideoElement): Promise<Detection[]> {
  if (!ort || !smokingSession || !cocoSession) return [];
  if (isRunning) return [];
  isRunning = true;

  try {
    const inputData = preprocessFrame(video);
    const tensor = new ort.Tensor("float32", inputData, [1, 3, INPUT_SIZE, INPUT_SIZE]);

    // Run sequentially — WASM backend throws "Session already started" on concurrent runs
    const smokingResult = await smokingSession.run({ [smokingSession.inputNames[0]]: tensor });
    const cocoResult = await cocoSession.run({ [cocoSession.inputNames[0]]: tensor });

    const smokingOut = smokingResult[smokingSession.outputNames[0]];
    const cocoOut = cocoResult[cocoSession.outputNames[0]];

    const smokingDets = decodeYolo(
      smokingOut.data as Float32Array,
      SMOKING_CLASS_NAMES,
      SMOKING_THRESHOLD,
      smokingOut.dims[2] as number,
    ).filter((det) => det.label === "Smoking");
    const cocoDets = decodeYolo(
      cocoOut.data as Float32Array,
      COCO_CLASS_NAMES,
      COCO_THRESHOLD,
      cocoOut.dims[2] as number,
    );

    const { smokingResults, litterResults } = computeCompositeDetections(
      smokingDets,
      cocoDets,
    );

    console.log(
      "[composite]",
      smokingResults.map((r) => ({ score: r.compositeScore, signals: r.signals })),
    );

    const compositeDets: Detection[] = [
      ...smokingResults.map((r) => ({
        label: "Smoking",
        confidence: r.compositeScore,
        box: r.personBox,
      })),
      ...litterResults.map((r) => ({
        label: "Litter",
        confidence: r.confidence,
        box: r.box,
      })),
    ];

    return compositeDets;
  } finally {
    isRunning = false;
  }
}
