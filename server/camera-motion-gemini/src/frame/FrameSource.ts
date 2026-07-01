import type { FrameData } from "../types";

/**
 * Abstraction for frame capture. Each CameraWorker owns one FrameSource instance
 * so cameras never share mutable capture state.
 */
export interface FrameSource {
  /** Capture a single frame. Returns null if the stream is temporarily unavailable. */
  capture(): Promise<FrameData | null>;
  /** Release underlying connections (ffmpeg child, HTTP agent, etc.). */
  dispose(): Promise<void>;
}
