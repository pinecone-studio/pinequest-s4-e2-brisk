/** Fleet-wide Gemini concurrency + backoff when the API is overloaded. */

/**
 * Defaults are tuned for a PAID key (high RPM), so cameras are analyzed in
 * parallel instead of one-at-a-time. Override via env if you swap keys:
 *   GEMINI_MAX_CONCURRENT — how many cameras may call Gemini at once (default 8)
 *   GEMINI_MIN_GAP_MS     — min spacing between calls in ms (default 0)
 * For a free key, set e.g. GEMINI_MAX_CONCURRENT=1 and GEMINI_MIN_GAP_MS=2000.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const MAX_CONCURRENT = Math.max(1, envInt("GEMINI_MAX_CONCURRENT", 8));
const MIN_GAP_MS = envInt("GEMINI_MIN_GAP_MS", 0);
const RATE_LIMIT_BACKOFF_MS = 25_000;

let activeCalls = 0;
let lastCallFinishedAt = 0;
let backoffUntil = 0;
const waiters: Array<() => void> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function releaseSlot() {
  activeCalls = Math.max(0, activeCalls - 1);
  lastCallFinishedAt = Date.now();
  const next = waiters.shift();
  if (next) next();
}

function acquireSlot(): Promise<void> {
  if (activeCalls < MAX_CONCURRENT) {
    activeCalls += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      activeCalls += 1;
      resolve();
    });
  });
}

/** Call when Gemini returns 429/503 so we pause the whole fleet briefly. */
export function markGeminiRateLimited() {
  backoffUntil = Math.max(backoffUntil, Date.now() + RATE_LIMIT_BACKOFF_MS);
}

export function getGeminiBackoffRemainingMs(): number {
  return Math.max(0, backoffUntil - Date.now());
}

/** Run one Gemini request with global spacing and concurrency limits. */
export async function withGeminiSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    const gapWait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCallFinishedAt));
    const backoffWait = getGeminiBackoffRemainingMs();
    const wait = Math.max(gapWait, backoffWait);
    if (wait > 0) {
      await sleep(wait);
    }
    return await fn();
  } finally {
    releaseSlot();
  }
}
