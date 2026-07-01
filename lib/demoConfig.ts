/** Demo tuning — selected camera gets live MJPEG + faster Gemini loop. */

/** Disable with NEXT_PUBLIC_DEMO_REALTIME=0 */
export const DEMO_REALTIME_SELECTED =
  process.env.NEXT_PUBLIC_DEMO_REALTIME !== "0";

/** Sample the selected live feed for AI this often (ms). */
export const SELECTED_AI_INTERVAL_MS = 1_200;

/** Min gap between Gemini calls on the selected camera (ms). */
export const SELECTED_GEMINI_COOLDOWN_MS = 2_000;

/** Extra client pause after a 503 from Gemini (ms). */
export const SELECTED_GEMINI_BACKOFF_MS = 20_000;

export function isLiveStreamUrl(url: string): boolean {
  return url.includes("/api/stream/rtsp") || /\/api\/stream\/[^/?]+/.test(url);
}
