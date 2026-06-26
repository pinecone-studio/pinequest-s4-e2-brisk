import type * as OrtType from "onnxruntime-web";
import {
  SMOKING_MODEL_PATH,
  LITTER_MODEL_PATH,
  COCO_MODEL_PATH,
  SMOKING_THRESHOLD,
  LITTER_THRESHOLD,
  COCO_THRESHOLD,
  COCO_CLASS_NAMES,
  INPUT_SIZE,
} from "./modelConfig";
import { decodeYolo, Detection } from "./yoloDecode";
import { computeCompositeDetections, filterLitterByPersons } from "./rules";

// Smoking model output is [cx, cy, w, h, background, smoking].
const SMOKING_CLASS_NAMES = ["-", "Smoking"];
// Trash model trained on plastic-bottle class (maps to "Litter" via normalizeLabel).
const LITTER_CLASS_NAMES = ["plastic-bottles"];

let ort: typeof OrtType | null = null;
let smokingSession: OrtType.InferenceSession | null = null;
let litterSession: OrtType.InferenceSession | null = null;
let cocoSession: OrtType.InferenceSession | null = null;
let isRunning = false;

export let activeBackend: "webgpu" | "wasm" = "wasm";

export async function loadModels(): Promise<void> {
  ort = await import("onnxruntime-web");

  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
  ort.env.wasm.numThreads = 1;

  // WebGPU (Chrome/Edge) is several times faster than the single-thread WASM
  // backend. Try it first, fall back to WASM if the device lacks it.
  const hasWebGPU =
    typeof navigator !== "undefined" &&
    (navigator as Navigator & { gpu?: unknown }).gpu != null;
  const providers: ("webgpu" | "wasm")[] = hasWebGPU ? ["webgpu", "wasm"] : ["wasm"];

  const create = (path: string) =>
    ort!.InferenceSession.create(path, { executionProviders: providers });

  try {
    [smokingSession, litterSession, cocoSession] = await Promise.all([
      create(SMOKING_MODEL_PATH),
      create(LITTER_MODEL_PATH),
      create(COCO_MODEL_PATH),
    ]);
    activeBackend = hasWebGPU ? "webgpu" : "wasm";
  } catch (err) {
    // WebGPU init can fail on some GPUs/drivers — retry on WASM only.
    console.warn("[inference] WebGPU init failed, falling back to WASM:", err);
    const createWasm = (path: string) =>
      ort!.InferenceSession.create(path, { executionProviders: ["wasm"] });
    [smokingSession, litterSession, cocoSession] = await Promise.all([
      createWasm(SMOKING_MODEL_PATH),
      createWasm(LITTER_MODEL_PATH),
      createWasm(COCO_MODEL_PATH),
    ]);
    activeBackend = "wasm";
  }
}

// Reused across frames to avoid allocating a canvas every inference.
let preprocessCanvas: HTMLCanvasElement | null = null;
let preprocessCtx: CanvasRenderingContext2D | null = null;

// Recently-seen person boxes, so litter suppression survives brief COCO misses.
type Box = [number, number, number, number];
const PERSON_MEMORY_MS = 1500;
let recentPersons: { box: Box; t: number }[] = [];

function rememberPersons(cocoDets: Detection[]): Box[] {
  const now = Date.now();
  recentPersons = recentPersons.filter((p) => now - p.t < PERSON_MEMORY_MS);
  for (const det of cocoDets) {
    if (det.label === "person") recentPersons.push({ box: det.box, t: now });
  }
  return recentPersons.map((p) => p.box);
}

function preprocessFrame(source: HTMLVideoElement | HTMLCanvasElement): Float32Array {
  if (!ort) throw new Error("ORT not loaded");
  if (!preprocessCanvas) {
    preprocessCanvas = document.createElement("canvas");
    preprocessCanvas.width = INPUT_SIZE;
    preprocessCanvas.height = INPUT_SIZE;
    preprocessCtx = preprocessCanvas.getContext("2d", { willReadFrequently: true });
  }
  const ctx = preprocessCtx!;
  ctx.drawImage(source as CanvasImageSource, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);

  const pixels = INPUT_SIZE * INPUT_SIZE;
  const float32 = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    float32[i] = data[i * 4] / 255;
    float32[pixels + i] = data[i * 4 + 1] / 255;
    float32[2 * pixels + i] = data[i * 4 + 2] / 255;
  }
  return float32;
}

export async function runInference(video: HTMLVideoElement): Promise<Detection[]> {
  if (!ort || !smokingSession || !litterSession || !cocoSession) return [];
  if (isRunning) return [];
  isRunning = true;

  try {
    const inputData = preprocessFrame(video);
    const tensor = new ort.Tensor("float32", inputData, [1, 3, INPUT_SIZE, INPUT_SIZE]);

    // Sequential — WASM backend throws "Session already started" on concurrent runs
    const smokingResult = await smokingSession.run({ [smokingSession.inputNames[0]]: tensor });
    const litterResult = await litterSession.run({ [litterSession.inputNames[0]]: tensor });
    const cocoResult = await cocoSession.run({ [cocoSession.inputNames[0]]: tensor });

    const smokingOut = smokingResult[smokingSession.outputNames[0]];
    const litterOut = litterResult[litterSession.outputNames[0]];
    const cocoOut = cocoResult[cocoSession.outputNames[0]];

    const smokingDets = decodeYolo(
      smokingOut.data as Float32Array,
      SMOKING_CLASS_NAMES,
      SMOKING_THRESHOLD,
      smokingOut.dims[2] as number,
    ).filter((det) => det.label === "Smoking");

    const litterDets = decodeYolo(
      litterOut.data as Float32Array,
      LITTER_CLASS_NAMES,
      LITTER_THRESHOLD,
      litterOut.dims[2] as number,
    );

    const cocoDets = decodeYolo(
      cocoOut.data as Float32Array,
      COCO_CLASS_NAMES,
      COCO_THRESHOLD,
      cocoOut.dims[2] as number,
    );

    const { smokingResults } = computeCompositeDetections(smokingDets, cocoDets);
    // Drop litter boxes that coincide with a person (model misfires on people).
    // Person boxes are kept "sticky" for a moment so a one-frame COCO dropout
    // doesn't let a face slip through and get saved as litter.
    const personBoxes = rememberPersons(cocoDets);
    const filteredLitter = filterLitterByPersons(litterDets, personBoxes);

    return [
      ...smokingResults.map((r) => ({
        label: "Smoking",
        confidence: r.compositeScore,
        box: r.personBox,
      })),
      ...filteredLitter.map((r) => ({
        label: "Litter",
        confidence: r.confidence,
        box: r.box,
      })),
    ];
  } finally {
    isRunning = false;
  }
}
