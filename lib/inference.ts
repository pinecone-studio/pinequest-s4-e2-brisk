import type * as OrtType from "onnxruntime-web";
import {
  SMOKING_MODEL_PATH,
  LITTER_MODEL_PATH,
  COCO_MODEL_PATH,
  SMOKING_THRESHOLD,
  CIGARETTE_CLASS_IDX,
  SMOKING_DECODE_CLASSES,
  LITTER_TRACK_THRESHOLD,
  COCO_THRESHOLD,
  PERSON_THRESHOLD,
  SHOW_PERSON_DETECTIONS,
  COCO_CLASS_NAMES,
  INPUT_SIZE,
} from "./modelConfig";
import { decodeYolo, decodeYoloClasses, Detection } from "./yoloDecode";
import { computeCompositeDetections } from "./rules";
import { buildLitteringInputs } from "./littering/pipeline";
import type { RawDetection } from "./littering/simpleTracker";
import { analyzeMouthRegion, isVisualFalsePositive } from "./smokingVision";
import type { MouthAnalysis } from "./rules";
import type { FrameSource } from "./frameSource";
import { getSourceSize, isSourceReady } from "./frameSource";

const LITTER_CLASS_NAMES = ["plastic-bottles"];

let ort: typeof OrtType | null = null;
let smokingSession: OrtType.InferenceSession | null = null;
let litterSession: OrtType.InferenceSession | null = null;
let cocoSession: OrtType.InferenceSession | null = null;

export let activeBackend: "webgpu" | "wasm" = "wasm";

export async function loadModels(): Promise<void> {
  ort = await import("onnxruntime-web");

  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
  ort.env.wasm.numThreads = 1;

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

let preprocessCanvas: HTMLCanvasElement | null = null;
let preprocessCtx: CanvasRenderingContext2D | null = null;

type Box = [number, number, number, number];

interface LetterboxMeta {
  scale: number;
  padX: number;
  padY: number;
  srcW: number;
  srcH: number;
}

const PERSON_MEMORY_MS = 2000;
let recentPersons: { box: Box; t: number }[] = [];

function mouthAnalysisFromSource(
  source: FrameSource,
  personBox: Box,
): MouthAnalysis | null {
  const stats = analyzeMouthRegion(source, personBox);
  if (!stats) return null;
  return {
    smokeLikeRatio: stats.smokeLikeRatio,
    emberRatio: stats.emberRatio,
    uniformLightRatio: stats.uniformLightRatio,
    palePaperRatio: stats.palePaperRatio,
    centerPaleRatio: stats.centerPaleRatio,
    skinCoverRatio: stats.skinCoverRatio,
    isFalsePositive: isVisualFalsePositive(stats),
  };
}

function getCachedPersonBoxes(): Box[] {
  const now = Date.now();
  return recentPersons
    .filter((p) => now - p.t < PERSON_MEMORY_MS)
    .map((p) => p.box);
}

function rememberPersons(cocoDets: Detection[]): Box[] {
  const now = Date.now();
  recentPersons = recentPersons.filter((p) => now - p.t < PERSON_MEMORY_MS);
  for (const det of cocoDets) {
    if (det.label === "person") recentPersons.push({ box: det.box, t: now });
  }
  return recentPersons.map((p) => p.box);
}

function mergePersonBoxes(...groups: Box[][]): Box[] {
  const merged: Box[] = [];
  for (const boxes of groups) {
    for (const box of boxes) merged.push(box);
  }
  return merged;
}

function preprocessFrame(source: FrameSource): {
  inputData: Float32Array;
  meta: LetterboxMeta;
} {
  if (!ort) throw new Error("ORT not loaded");

  const { width: srcW, height: srcH } = getSourceSize(source);
  if (!srcW || !srcH) throw new Error("Frame source not ready");

  if (!preprocessCanvas) {
    preprocessCanvas = document.createElement("canvas");
    preprocessCanvas.width = INPUT_SIZE;
    preprocessCanvas.height = INPUT_SIZE;
    preprocessCtx = preprocessCanvas.getContext("2d", { willReadFrequently: true });
  }

  const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
  const drawW = Math.round(srcW * scale);
  const drawH = Math.round(srcH * scale);
  const padX = Math.floor((INPUT_SIZE - drawW) / 2);
  const padY = Math.floor((INPUT_SIZE - drawH) / 2);

  const ctx = preprocessCtx!;
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(source, padX, padY, drawW, drawH);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const pixels = INPUT_SIZE * INPUT_SIZE;
  const float32 = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    float32[i] = data[i * 4] / 255;
    float32[pixels + i] = data[i * 4 + 1] / 255;
    float32[2 * pixels + i] = data[i * 4 + 2] / 255;
  }

  return {
    inputData: float32,
    meta: { scale, padX, padY, srcW, srcH },
  };
}

function unmapBox(box: Box, meta: LetterboxMeta): Box {
  const toSource = (norm: number, isX: boolean) => {
    const px = norm * INPUT_SIZE;
    const unpadded = px - (isX ? meta.padX : meta.padY);
    const srcPx = unpadded / meta.scale;
    const dim = isX ? meta.srcW : meta.srcH;
    return Math.max(0, Math.min(1, srcPx / dim));
  };

  return [
    toSource(box[0], true),
    toSource(box[1], false),
    toSource(box[2], true),
    toSource(box[3], false),
  ];
}

function remapDetections(dets: Detection[], meta: LetterboxMeta): Detection[] {
  return dets.map((d) => ({ ...d, box: unmapBox(d.box, meta) }));
}

export interface InferenceResult {
  detections: Detection[];
  litteringInputs: RawDetection[];
}

export async function runInference(source: FrameSource): Promise<InferenceResult> {
  const empty: InferenceResult = { detections: [], litteringInputs: [] };
  if (!ort || !smokingSession || !litterSession || !cocoSession) return empty;
  if (!isSourceReady(source)) return empty;

  const { inputData, meta } = preprocessFrame(source);
  const tensor = new ort.Tensor("float32", inputData, [1, 3, INPUT_SIZE, INPUT_SIZE]);

  const smokingResult = await smokingSession.run({ [smokingSession.inputNames[0]]: tensor });
  const litterResult = await litterSession.run({ [litterSession.inputNames[0]]: tensor });
  const cocoResult = await cocoSession.run({ [cocoSession.inputNames[0]]: tensor });

    const smokingOut = smokingResult[smokingSession.outputNames[0]];
    const litterOut = litterResult[litterSession.outputNames[0]];
    const cocoOut = cocoResult[cocoSession.outputNames[0]];
    const numAnchors = smokingOut.dims[2] as number;
    const numClasses = (smokingOut.dims[1] as number) - 4;
    const smokingClasses =
      numClasses >= 3
        ? SMOKING_DECODE_CLASSES
        : [{ idx: CIGARETTE_CLASS_IDX, label: "Cigarette" as const }];

    const smokingDets = remapDetections(
      decodeYoloClasses(
        smokingOut.data as Float32Array,
        smokingClasses,
        SMOKING_THRESHOLD,
        numAnchors,
        INPUT_SIZE,
      ),
      meta,
    );

    const litterDets = remapDetections(
      decodeYolo(
        litterOut.data as Float32Array,
        LITTER_CLASS_NAMES,
        LITTER_TRACK_THRESHOLD,
        litterOut.dims[2] as number,
      ),
      meta,
    );

    const cocoDets = remapDetections(
      decodeYolo(
        cocoOut.data as Float32Array,
        COCO_CLASS_NAMES,
        COCO_THRESHOLD,
        cocoOut.dims[2] as number,
      ),
      meta,
    );

    const personDetections: Detection[] = SHOW_PERSON_DETECTIONS
      ? cocoDets
          .filter((d) => d.label === "person" && d.confidence >= PERSON_THRESHOLD)
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 1)
          .map((d) => ({
            label: "Person",
            confidence: d.confidence,
            box: d.box,
          }))
      : [];

    const cachedPersons = getCachedPersonBoxes();
    const cocoPersons = cocoDets
      .filter((d) => d.label === "person")
      .map((d) => d.box);
    const smokingPersons = mergePersonBoxes(cocoPersons, cachedPersons);

    const { smokingResults } = computeCompositeDetections(
      smokingDets,
      smokingPersons,
      (box) => mouthAnalysisFromSource(source, box),
    );

    rememberPersons(cocoDets);

    const litteringInputs = buildLitteringInputs(cocoDets, litterDets);

  return {
    detections: [
      ...personDetections,
      ...smokingResults.map((r) => ({
        label: r.productLabel,
        confidence: r.compositeScore,
        box: r.cigaretteBox,
      })),
    ],
    litteringInputs,
  };
}
