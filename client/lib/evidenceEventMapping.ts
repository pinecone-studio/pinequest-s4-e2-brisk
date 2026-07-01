import type { EvidenceEvent } from "./evidence";

/** Server POST /api/evidence success body (architecture §3). */
export interface EvidencePostResponse {
  id: string;
  r2Key: string;
  savedAt: number;
}

/** Build UI EvidenceEvent from browser capture + server persistence response. */
export function mapToEvidenceEvent(input: {
  cameraId: string;
  sourceLabel: string;
  label: string;
  confidence: number;
  occurredAt: number;
  thumb: string;
  note?: string;
  response?: EvidencePostResponse | null;
  saveError?: string;
}): EvidenceEvent {
  return {
    id: input.response?.id ?? `${input.occurredAt}-${input.cameraId}-${input.label}`,
    source: input.sourceLabel,
    label: input.label,
    confidence: input.confidence,
    time: input.occurredAt,
    thumb: input.thumb,
    savedPath: input.response?.r2Key ?? null,
    saveError: input.saveError,
    note: input.note,
  };
}
