import { Router, type Request, type Response } from "express";
import { ScanManager } from "./discovery/scanManager";
import { getAllLocalSubnets } from "./discovery/subnet";
import { getCamera, listCameras, upsertCameras } from "./registry";

const scanManager = new ScanManager();

export function createApiRouter(): Router {
  const router = Router();

  router.get("/cameras", (_req: Request, res: Response) => {
    res.json({ cameras: listCameras() });
  });

  router.get("/cameras/:id", (req: Request, res: Response) => {
    const camera = getCamera(String(req.params.id));
    if (!camera) {
      res.status(404).json({ error: "Camera not found" });
      return;
    }
    res.json(camera);
  });

  router.get("/discover/subnet", (_req: Request, res: Response) => {
    try {
      const subnets = getAllLocalSubnets();
      res.json({ subnet: subnets.join(", "), subnets });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Could not detect subnet",
      });
    }
  });

  router.get("/discover/results", (_req: Request, res: Response) => {
    const state = scanManager.getState();
    upsertCameras(state.cameras);
    res.json(state);
  });

  router.post("/discover/start", async (req: Request, res: Response) => {
    const subnet = typeof req.body?.subnet === "string" ? req.body.subnet : undefined;
    const subnets = typeof req.body?.subnets === "object" && Array.isArray(req.body.subnets)
      ? req.body.subnets.filter((s: unknown) => typeof s === "string")
      : undefined;
    const scanTarget = subnet ?? (subnets && subnets.length > 0 ? subnets.join(",") : undefined);
    void scanManager.startScan(scanTarget).then((state) => {
      upsertCameras(state.cameras);
    });
    const state = scanManager.getState();
    res.json(state);
  });

  return router;
}
