import { GoogleGenAI } from "@google/genai";
import type { FrameData } from "../types";
import { sleep } from "../utils/sleep";

const MODEL = "gemini-2.5-flash";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2_000;

const SECURITY_PROMPT = `You are a security surveillance analyst reviewing a single camera frame.

Analyze the image for:
- Unauthorized persons, vehicles, or animals in restricted areas
- Suspicious behavior (loitering, forced entry, tampering)
- Safety hazards (fire, smoke, flooding, fallen objects)
- Deliveries or visitors at entry points

Respond in this exact format:
THREAT_LEVEL: none|low|medium|high
SUMMARY: <one sentence>
RECOMMENDED_ACTION: <one sentence or "none">`;

export interface GeminiAnalysisResult {
  text: string;
  model: string;
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const maybeStatus = (error as { status?: number }).status;
  if (maybeStatus === 429) return true;

  const message = String((error as { message?: string }).message ?? error);
  return /429|rate.?limit|resource.?exhausted|quota/i.test(message);
}

function getRetryDelayMs(attempt: number, error: unknown): number {
  const retryAfterHeader =
    error &&
    typeof error === "object" &&
    "headers" in error &&
    error.headers &&
    typeof error.headers === "object" &&
    "get" in error.headers &&
    typeof (error.headers as Headers).get === "function"
      ? (error.headers as Headers).get("retry-after")
      : null;

  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1_000;
    }
  }

  return BASE_BACKOFF_MS * 2 ** attempt;
}

/**
 * Shared Gemini client — one API key, many concurrent camera workers.
 * Each worker calls analyzeFrame() independently; retries are per-call.
 */
export class GeminiClient {
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async analyzeFrame(
    cameraId: string,
    frame: FrameData,
  ): Promise<GeminiAnalysisResult> {
    const base64 = frame.encoded.toString("base64");
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        const response = await this.ai.models.generateContent({
          model: MODEL,
          contents: [
            {
              inlineData: {
                mimeType: frame.mimeType,
                data: base64,
              },
            },
            {
              text: `${SECURITY_PROMPT}\n\nCamera ID: ${cameraId}`,
            },
          ],
        });

        const text = response.text?.trim();
        if (!text) {
          throw new Error("Gemini returned an empty response");
        }

        return { text, model: MODEL };
      } catch (error) {
        lastError = error;

        if (isRateLimitError(error) && attempt < MAX_RETRIES - 1) {
          const delayMs = getRetryDelayMs(attempt, error);
          console.warn(
            `[Gemini] Rate limited for camera "${cameraId}". Retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          await sleep(delayMs);
          continue;
        }

        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Gemini analysis failed for camera "${cameraId}"`);
  }
}

/** Singleton accessor so all workers share one SDK client instance. */
let sharedClient: GeminiClient | null = null;

export function getSharedGeminiClient(): GeminiClient {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.",
    );
  }

  if (!sharedClient) {
    sharedClient = new GeminiClient(apiKey);
  }

  return sharedClient;
}
