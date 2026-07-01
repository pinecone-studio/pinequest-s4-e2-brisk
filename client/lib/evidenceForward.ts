import { EVIDENCE_COOLDOWN_MS } from "./aiConfig";
import type { AnalyzeRunResult } from "./analyzePipeline";

function getServerUrl(): string {
  return (process.env.SERVER_URL ?? process.env.BACKEND_URL ?? "http://localhost:3001").replace(
    /\/$/,
    "",
  );
}

function getClientServerSecret(): string {
  const secret = process.env.CLIENT_SERVER_SECRET?.trim();
  if (!secret) {
    throw new Error("CLIENT_SERVER_SECRET is not configured");
  }
  return secret;
}

const lastEvidenceSaveAt = new Map<string, number>();

function dedupeKey(cameraId: string, label: string): string {
  return `${cameraId}:${label}`;
}

export function shouldSkipEvidenceSave(
  cameraId: string,
  label: string,
  now = Date.now(),
): boolean {
  const last = lastEvidenceSaveAt.get(dedupeKey(cameraId, label)) ?? 0;
  return now - last < EVIDENCE_COOLDOWN_MS;
}

export function markEvidenceSaved(cameraId: string, label: string, now = Date.now()): void {
  lastEvidenceSaveAt.set(dedupeKey(cameraId, label), now);
}

export interface ForwardViolationInput {
  cameraId: string;
  label: string;
  confidence: number;
  occurredAt: number;
  summary: string | null;
  image: string;
}

export async function forwardViolationToServer(input: ForwardViolationInput): Promise<void> {
  const res = await fetch(`${getServerUrl()}/api/evidence`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getClientServerSecret()}`,
    },
    body: JSON.stringify({
      cameraId: input.cameraId,
      label: input.label,
      confidence: input.confidence,
      occurredAt: input.occurredAt,
      summary: input.summary,
      image: input.image,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Server evidence POST failed (HTTP ${res.status}): ${detail}`);
  }
}

export async function forwardAnalyzeViolations(
  result: AnalyzeRunResult,
): Promise<{ forwarded: number; skipped: number }> {
  let forwarded = 0;
  let skipped = 0;
  const now = Date.now();

  for (const violation of result.violations) {
    if (shouldSkipEvidenceSave(result.cameraId, violation.label, now)) {
      skipped += 1;
      continue;
    }

    await forwardViolationToServer({
      cameraId: result.cameraId,
      label: violation.label,
      confidence: violation.confidence,
      occurredAt: result.timestamp,
      summary: result.summary || null,
      image: result.evidenceImage,
    });
    markEvidenceSaved(result.cameraId, violation.label, now);
    forwarded += 1;
  }

  return { forwarded, skipped };
}
