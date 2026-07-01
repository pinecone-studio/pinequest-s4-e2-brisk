/** Central AI tuning — motion-gated Gemini on every online camera. */

/** Downscaled motion sample size (small = fast on all tiles). */
export const MOTION_SAMPLE_WIDTH = 64;
export const MOTION_SAMPLE_HEIGHT = 48;

/** Differing sample pixels required to treat a frame as "motion". */
export const MOTION_PIXEL_THRESHOLD = 28;

/** Per-camera minimum gap between Gemini calls (ms). */
export const GEMINI_COOLDOWN_MS = 6_000;

/** Frames sent per Gemini call (2 = fast temporal litter check). */
export const GEMINI_BURST_FRAMES = 2;

/** Ms between burst captures when grabbing live from <img>. */
export const GEMINI_BURST_INTERVAL_MS = 250;

export const GEMINI_FETCH_TIMEOUT_MS = 30_000;

/** Ignore Gemini detections below this confidence. */
export const GEMINI_VIOLATION_THRESHOLD = 0.7;

/** Min gap between evidence snapshots per violation type (ms). */
export const EVIDENCE_COOLDOWN_MS = 8_000;

/** Keep recent frames for temporal pairing (ms). */
export const FRAME_HISTORY_MS = 8_000;
