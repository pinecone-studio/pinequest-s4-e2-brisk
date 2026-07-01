import type { FrameSource } from "../frame/FrameSource";
import type { GeminiClient } from "../gemini/client";
import { MotionDetector } from "../motion/MotionDetector";
import type { CameraConfig } from "../types";
import { createCameraLogger, type CameraLogger } from "../utils/logger";
import { sleep } from "../utils/sleep";

const DEFAULT_ANALYZE_COOLDOWN_MS = 10_000;

/**
 * Manages one camera's lifecycle: periodic frame sampling, local motion
 * detection, and independent Gemini analysis when motion exceeds threshold.
 *
 * Each instance runs its own async loop so multiple cameras operate
 * concurrently without blocking one another.
 */
export class CameraWorker {
  private readonly config: CameraConfig;
  private readonly frameSource: FrameSource;
  private readonly gemini: GeminiClient;
  private readonly motionDetector = new MotionDetector();
  private readonly log: CameraLogger;
  private readonly analyzeCooldownMs: number;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private analysisInFlight = false;
  private lastAnalysisAt = 0;

  constructor(
    config: CameraConfig,
    frameSource: FrameSource,
    gemini: GeminiClient,
  ) {
    this.config = config;
    this.frameSource = frameSource;
    this.gemini = gemini;
    this.log = createCameraLogger(config.id);
    this.analyzeCooldownMs =
      config.analyzeCooldownMs ?? DEFAULT_ANALYZE_COOLDOWN_MS;
  }

  /** Start the independent sampling loop (non-blocking). */
  start(): void {
    if (this.running) {
      this.log.warn("Worker already running");
      return;
    }

    this.running = true;
    this.log.info(
      `▶️  Starting worker (source=${this.config.source}, threshold=${this.config.motionThreshold}, interval=${this.config.sampleIntervalMs}ms)`,
    );
    this.loopPromise = this.runLoop();
  }

  /** Signal the worker to stop and wait for the loop to exit. */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    this.log.info("⏹️  Stopping worker...");
    await this.loopPromise;
    await this.frameSource.dispose();
    this.log.info("Worker stopped");
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        this.log.error("Unhandled tick error:", error);
      }

      await sleep(this.config.sampleIntervalMs);
    }
  }

  private async tick(): Promise<void> {
    const frame = await this.frameSource.capture();
    if (!frame) {
      this.log.warn("⚠️  Frame capture returned empty — skipping sample");
      return;
    }

    const motion = this.motionDetector.detect(
      frame,
      this.config.motionThreshold,
    );

    if (!motion.motionDetected) {
      return;
    }

    this.log.info(
      `🚨 Motion detected (delta=${motion.diffPixels}px, threshold=${this.config.motionThreshold}px)`,
    );

    if (this.analysisInFlight) {
      this.log.info("⏳ Analysis already in flight — skipping duplicate trigger");
      return;
    }

    const now = Date.now();
    if (now - this.lastAnalysisAt < this.analyzeCooldownMs) {
      this.log.info(
        `⏳ Cooldown active (${this.analyzeCooldownMs}ms) — skipping Gemini call`,
      );
      return;
    }

    this.analysisInFlight = true;
    this.lastAnalysisAt = now;

    void this.analyzeWithGemini(frame).finally(() => {
      this.analysisInFlight = false;
    });
  }

  private async analyzeWithGemini(
    frame: Parameters<GeminiClient["analyzeFrame"]>[1],
  ): Promise<void> {
    this.log.info("📡 Sending frame to Gemini for analysis...");

    try {
      const result = await this.gemini.analyzeFrame(this.config.id, frame);
      this.log.info(`✅ Gemini (${result.model}):\n${result.text}`);
    } catch (error) {
      this.log.error("❌ Gemini analysis failed:", error);
    }
  }
}
