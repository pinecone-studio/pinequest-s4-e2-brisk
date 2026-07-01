/** Per-camera configuration passed to CameraWorker. */
export interface CameraConfig {
  /** Human-readable camera identifier used in logs, e.g. "Front-Door". */
  id: string;
  /**
   * Stream source descriptor.
   * - `mock:<seed>` — synthetic frames for local development
   * - `mjpeg:<url>` — MJPEG snapshot URL (wire up in createFrameSource)
   * - `rtsp:<url>` — RTSP stream URL (wire up via ffmpeg in createFrameSource)
   */
  source: string;
  /**
   * Minimum number of differing pixels (after downscaling) required to count as motion.
   * Lower = more sensitive. Typical range: 200–5000 depending on scene size.
   */
  motionThreshold: number;
  /** How often to sample a frame for motion checks, in milliseconds. */
  sampleIntervalMs: number;
  /**
   * Minimum time between Gemini API calls for this camera, in milliseconds.
   * Prevents flooding the API when motion is continuous.
   */
  analyzeCooldownMs?: number;
}

/** Raw + encoded representation of a single captured frame. */
export interface FrameData {
  width: number;
  height: number;
  /** RGBA pixel buffer (width * height * 4 bytes) used for motion detection. */
  rgba: Buffer;
  /** JPEG/PNG bytes sent to Gemini on motion events. */
  encoded: Buffer;
  mimeType: "image/jpeg" | "image/png";
}

export interface MotionResult {
  diffPixels: number;
  motionDetected: boolean;
}
