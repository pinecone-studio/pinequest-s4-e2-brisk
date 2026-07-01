// Detection now runs server-side via Gemini (see app/api/gemini/route.ts), so
// the old ONNX model paths and per-class decode thresholds are gone. Only the
// display/UI thresholds below are still used.

/** Minimum confidence for a violation to count as an "alert" (box emphasis). */
export const ALERT_THRESHOLD = 0.55;

/** Confidence floor used by the Events panel to mark a smoking event as live. */
export const SMOKING_THRESHOLD = 0.28;
