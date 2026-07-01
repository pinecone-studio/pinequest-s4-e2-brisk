import { GEMINI_VIOLATION_THRESHOLD } from "./aiConfig";
import type { Detection } from "./detection";
import { analyzeCameraFrames } from "./geminiAnalyze";

const VIOLATION_LABELS = new Set(["Cigarette", "Vape", "Litter"]);

export interface AnalyzePostBody {
  cameraId: string;
  timestamp: number;
  frames: string[];
}

export interface AnalyzeViolation {
  label: string;
  confidence: number;
}

export interface AnalyzeRunResult {
  cameraId: string;
  timestamp: number;
  summary: string;
  detections: Detection[];
  violations: AnalyzeViolation[];
  /** Last frame JPEG (base64 or data URL) for evidence upload. */
  evidenceImage: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAnalyzePostBody(raw: unknown): AnalyzePostBody | { error: string } {
  if (!isRecord(raw)) {
    return { error: "Request body must be a JSON object" };
  }

  const cameraId = raw.cameraId;
  const timestamp = raw.timestamp;
  const frames = raw.frames;

  if (typeof cameraId !== "string" || !cameraId.trim()) {
    return { error: "cameraId is required" };
  }
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return { error: "timestamp must be a number" };
  }
  if (!Array.isArray(frames) || frames.length === 0) {
    return { error: "frames must be a non-empty array of base64 JPEG strings" };
  }
  if (!frames.every((f) => typeof f === "string" && f.trim().length > 0)) {
    return { error: "each frame must be a non-empty string" };
  }

  return {
    cameraId: cameraId.trim(),
    timestamp: Math.trunc(timestamp),
    frames: frames.map((f) => f.trim()),
  };
}

export function filterViolations(detections: Detection[]): AnalyzeViolation[] {
  return detections.filter(
    (d) =>
      VIOLATION_LABELS.has(d.label) && d.confidence >= GEMINI_VIOLATION_THRESHOLD,
  );
}

export async function runAnalyzePipeline(body: AnalyzePostBody): Promise<AnalyzeRunResult> {
  const gemini = await analyzeCameraFrames(body.cameraId, body.frames);
  const violations = filterViolations(gemini.detections);
  const evidenceImage = body.frames[body.frames.length - 1];

  return {
    cameraId: body.cameraId,
    timestamp: body.timestamp,
    summary: gemini.summary,
    detections: gemini.detections,
    violations,
    evidenceImage,
  };
}
