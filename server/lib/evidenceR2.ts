import type { R2Bucket } from "./r2Types";

const JPEG_CONTENT_TYPE = "image/jpeg";

/** Build the object key used in D1 `r2_key` and the R2 bucket (architecture §3). */
export function buildEvidenceR2Key(
  cameraId: string,
  label: string,
  timestamp: number,
): string {
  const safeCamera = cameraId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]/g, "") || "unknown";
  return `evidence/${safeCamera}/${timestamp}-${safeLabel}.jpg`;
}

export type EvidenceImageBytes = ArrayBuffer | Uint8Array;

/** Upload a JPEG evidence frame; returns the `r2Key` stored in D1. */
export async function saveEvidenceImage(
  bucket: R2Bucket,
  cameraId: string,
  label: string,
  timestamp: number,
  bytes: EvidenceImageBytes,
): Promise<string> {
  const r2Key = buildEvidenceR2Key(cameraId, label, timestamp);
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  const result = await bucket.put(r2Key, body, {
    httpMetadata: { contentType: JPEG_CONTENT_TYPE },
  });

  if (!result) {
    throw new Error(`Failed to upload evidence image to R2: ${r2Key}`);
  }

  return r2Key;
}
