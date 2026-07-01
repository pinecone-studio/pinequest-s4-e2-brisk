import pixelmatch from "pixelmatch";
import type { FrameData, MotionResult } from "../types";

/**
 * Lightweight frame-to-frame motion detector using pixelmatch.
 *
 * Frames are compared at their native resolution (MockFrameSource already
 * downscales to 320×240). For full-resolution RTSP captures, resize with
 * sharp before storing `rgba` to keep CPU usage predictable.
 */
export class MotionDetector {
  private previousRgba: Buffer | null = null;
  private previousWidth = 0;
  private previousHeight = 0;

  /**
   * Compare the current frame against the previous one.
   * @param frame Current frame RGBA buffer
   * @param threshold Minimum differing pixel count to flag motion
   */
  detect(frame: FrameData, threshold: number): MotionResult {
    if (
      this.previousRgba === null ||
      frame.width !== this.previousWidth ||
      frame.height !== this.previousHeight
    ) {
      this.storeBaseline(frame);
      return { diffPixels: 0, motionDetected: false };
    }

    const diffPixels = pixelmatch(
      this.previousRgba,
      frame.rgba,
      undefined,
      frame.width,
      frame.height,
      { threshold: 0.1 },
    );

    this.storeBaseline(frame);

    return {
      diffPixels,
      motionDetected: diffPixels >= threshold,
    };
  }

  reset(): void {
    this.previousRgba = null;
    this.previousWidth = 0;
    this.previousHeight = 0;
  }

  private storeBaseline(frame: FrameData): void {
    this.previousRgba = Buffer.from(frame.rgba);
    this.previousWidth = frame.width;
    this.previousHeight = frame.height;
  }
}
