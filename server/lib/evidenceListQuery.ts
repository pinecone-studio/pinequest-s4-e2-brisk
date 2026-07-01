import type { ListEvidenceEventsOptions } from "./evidenceEventsDb";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface ParsedListEvidenceQuery {
  cameraId?: string;
  limit: number;
  offset: number;
}

export function parseListEvidenceQuery(
  searchParams: URLSearchParams,
): ParsedListEvidenceQuery | { error: string } {
  const cameraId = searchParams.get("cameraId")?.trim() || undefined;

  const limitRaw = searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null && limitRaw !== "") {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return { error: "limit must be a positive integer" };
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const offsetRaw = searchParams.get("offset");
  let offset = 0;
  if (offsetRaw !== null && offsetRaw !== "") {
    const parsed = Number.parseInt(offsetRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: "offset must be a non-negative integer" };
    }
    offset = parsed;
  }

  const options: ListEvidenceEventsOptions = { limit, offset };
  if (cameraId) options.cameraId = cameraId;

  return { cameraId, limit, offset };
}
