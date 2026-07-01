import sharp from "sharp";
import type { FrameData } from "../types";
import type { FrameSource } from "./FrameSource";

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;

interface MockFrameSourceOptions {
  /** Numeric seed that controls motion simulation timing per camera. */
  seed: number;
}

/**
 * Synthetic frame generator for local development and unit-style testing.
 *
 * Simulates a static background with a moving bright rectangle so motion
 * detection and Gemini triggers can be exercised without real hardware.
 *
 * SWAP FOR PRODUCTION:
 * Replace this class with `MjpegFrameSource` or `RtspFrameSource` (see
 * streamFrameSource.ts) inside `createFrameSource()`.
 */
export class MockFrameSource implements FrameSource {
  private tick = 0;
  private readonly seed: number;

  constructor(options: MockFrameSourceOptions) {
    this.seed = options.seed;
  }

  async capture(): Promise<FrameData | null> {
    this.tick += 1;

    const rgba = Buffer.alloc(FRAME_WIDTH * FRAME_HEIGHT * 4);
    const motionPhase = (this.tick + this.seed) % 20;

    // Motion burst every ~20 samples: blob moves horizontally across the frame.
    const isMotionBurst = motionPhase >= 15;
    const blobX = isMotionBurst
      ? Math.floor(((motionPhase - 15) / 4) * (FRAME_WIDTH - 40))
      : 10;
    const blobY = 80 + (this.seed % 30);

    for (let y = 0; y < FRAME_HEIGHT; y += 1) {
      for (let x = 0; x < FRAME_WIDTH; x += 1) {
        const idx = (y * FRAME_WIDTH + x) * 4;
        const inBlob =
          isMotionBurst &&
          x >= blobX &&
          x < blobX + 40 &&
          y >= blobY &&
          y < blobY + 40;

        rgba[idx] = inBlob ? 255 : 30; // R
        rgba[idx + 1] = inBlob ? 80 : 30; // G
        rgba[idx + 2] = inBlob ? 80 : 30; // B
        rgba[idx + 3] = 255; // A
      }
    }

    const encoded = await sharp(rgba, {
      raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 4 },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    return {
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      rgba,
      encoded,
      mimeType: "image/jpeg",
    };
  }

  async dispose(): Promise<void> {
    // No external resources to release for the mock source.
  }
}
