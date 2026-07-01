import { GEMINI_FETCH_TIMEOUT_MS } from "./aiConfig";

const RETRY_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Per-request timeout + simple retry — safe on Workers (no shared concurrency state). */
export async function fetchGeminiWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs = GEMINI_FETCH_TIMEOUT_MS,
): Promise<Response> {
  let lastRes: Response | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      lastRes = res;
      if (res.ok || !RETRY_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) {
        return res;
      }
      console.warn(`[gemini] HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying`);
      await sleep(1500 * attempt);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  if (!lastRes) {
    throw new Error("no response from Gemini");
  }
  return lastRes;
}
