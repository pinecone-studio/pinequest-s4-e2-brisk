import type { DiscoveredCamera, ScanState } from "../types";
import { discoverCameras } from "./discoverCameras";

export class ScanManager {
  private state: ScanState = { status: "idle", cameras: [] };
  private running = false;

  getState(): ScanState {
    return { ...this.state, cameras: [...this.state.cameras] };
  }

  async startScan(subnet?: string): Promise<ScanState> {
    if (this.running) {
      return this.getState();
    }

    this.running = true;
    this.state = {
      status: "running",
      cameras: [],
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      error: undefined,
    };

    try {
      const cameras = await discoverCameras(subnet, (progress) => {
        this.state = {
          ...this.state,
          cameras: progress,
        };
      });
      this.state = {
        status: "completed",
        cameras,
        startedAt: this.state.startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.state = {
        status: "failed",
        cameras: this.state.cameras,
        startedAt: this.state.startedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Discovery failed",
      };
    } finally {
      this.running = false;
    }

    return this.getState();
  }
}
