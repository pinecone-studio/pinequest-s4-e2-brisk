import { insertEvidenceEvent } from "./evidenceEventsDb";
import { saveEvidenceImage } from "./evidenceR2";
import type { EvidenceBindings } from "./evidenceBindings";
import type { D1Database } from "./d1Types";
import type { R2Bucket } from "./r2Types";

const VALID_LABELS = new Set(["Cigarette", "Vape", "Litter"]);

export interface EvidencePostBody {
  cameraId: string;
  label: string;
  confidence: number;
  occurredAt: number;
  summary: string | null;
  image: string;
}

export interface EvidencePostResult {
  id: string;
  r2Key: string;
  savedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEvidencePostBody(raw: unknown): EvidencePostBody | { error: string } {
  if (!isRecord(raw)) {
    return { error: "Request body must be a JSON object" };
  }

  const cameraId = raw.cameraId;
  const label = raw.label;
  const confidence = raw.confidence;
  const occurredAt = raw.occurredAt;
  const image = raw.image;

  if (typeof cameraId !== "string" || !cameraId.trim()) {
    return { error: "cameraId is required" };
  }
  if (typeof label !== "string" || !VALID_LABELS.has(label)) {
    return { error: 'label must be one of: Cigarette, Vape, Litter' };
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return { error: "confidence must be a number" };
  }
  if (confidence < 0 || confidence > 1) {
    return { error: "confidence must be between 0 and 1" };
  }
  if (typeof occurredAt !== "number" || !Number.isFinite(occurredAt)) {
    return { error: "occurredAt must be a number" };
  }
  if (typeof image !== "string" || !image.trim()) {
    return { error: "image is required" };
  }

  const summary =
    raw.summary === undefined || raw.summary === null
      ? null
      : typeof raw.summary === "string"
        ? raw.summary.slice(0, 500)
        : null;

  return {
    cameraId: cameraId.trim(),
    label,
    confidence,
    occurredAt: Math.trunc(occurredAt),
    summary,
    image: image.trim(),
  };
}

/** Strip optional `data:image/jpeg;base64,` prefix and decode to bytes. */
export function decodeEvidenceImage(image: string): Uint8Array {
  const base64 = image.includes(",") ? (image.split(",")[1] ?? "") : image;
  if (!base64) {
    throw new Error("image is empty");
  }

  const binary = Buffer.from(base64, "base64");
  if (binary.byteLength === 0) {
    throw new Error("image could not be decoded");
  }
  return new Uint8Array(binary);
}

export async function persistEvidenceEvent(
  bindings: EvidenceBindings,
  body: EvidencePostBody,
): Promise<EvidencePostResult> {
  const bytes = decodeEvidenceImage(body.image);
  const r2Key = await saveEvidenceImage(
    bindings.bucket,
    body.cameraId,
    body.label,
    body.occurredAt,
    bytes,
  );

  const savedAt = Date.now();
  const id = `evt_${crypto.randomUUID()}`;

  await insertEvidenceEvent(bindings.db, {
    id,
    cameraId: body.cameraId,
    label: body.label,
    confidence: body.confidence,
    occurredAt: body.occurredAt,
    r2Key,
    summary: body.summary,
    createdAt: savedAt,
  });

  return { id, r2Key, savedAt };
}

/** Test hook: persist with explicit db/bucket (verify scripts). */
export async function persistEvidenceEventWith(
  db: D1Database,
  bucket: R2Bucket,
  body: EvidencePostBody,
): Promise<EvidencePostResult> {
  return persistEvidenceEvent({ db, bucket }, body);
}
