import "dotenv/config";

import { CameraWorker } from "./camera/CameraWorker";
import { createFrameSource } from "./frame/createFrameSource";
import { getSharedGeminiClient } from "./gemini/client";
import type { CameraConfig } from "./types";

/**
 * Sample camera fleet — each worker runs concurrently with its own threshold
 * and sampling interval. Adjust or load from JSON / env as you scale out.
 */
const SAMPLE_CAMERAS: CameraConfig[] = [
  {
    id: "Front-Door",
    source: "mock:1",
    motionThreshold: 400,
    sampleIntervalMs: 1_000,
    analyzeCooldownMs: 8_000,
  },
  {
    id: "Parking-Lot",
    source: "mock:7",
    motionThreshold: 2_000,
    sampleIntervalMs: 1_000,
    analyzeCooldownMs: 12_000,
  },
  {
    id: "Back-Yard",
    source: "mock:13",
    motionThreshold: 1_000,
    sampleIntervalMs: 1_500,
    analyzeCooldownMs: 10_000,
  },
];

async function main(): Promise<void> {
  console.log("🎥 Camera Motion + Gemini service starting...\n");

  const gemini = getSharedGeminiClient();
  const workers = SAMPLE_CAMERAS.map(
    (config) =>
      new CameraWorker(
        config,
        createFrameSource(config.source),
        gemini,
      ),
  );

  for (const worker of workers) {
    worker.start();
  }

  console.log(
    `\n✅ ${workers.length} camera workers running. Press Ctrl+C to stop.\n`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}, shutting down workers...`);
    await Promise.all(workers.map((worker) => worker.stop()));
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
