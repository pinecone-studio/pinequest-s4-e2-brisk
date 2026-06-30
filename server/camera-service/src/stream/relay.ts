import type { Express, Request, Response } from "express";
import rtspRelay from "rtsp-relay";
import { getCamera } from "../registry";

export function createStreamRelay(app: Express) {
  const { proxy, scriptUrl } = rtspRelay(app);

  app.get("/api/stream/script.js", (_req: Request, res: Response) => {
    res.redirect(scriptUrl);
  });

  app.ws("/api/stream/:cameraId", (ws: unknown, req: Request) => {
    const camera = getCamera(String(req.params.cameraId));
    if (!camera) {
      (ws as { close: () => void }).close();
      return;
    }

    const handleStream = proxy({
      url: camera.rtspUrl,
      transport: "tcp",
      verbose: false,
    });
    handleStream(ws as Parameters<typeof handleStream>[0]);
  });

  return { scriptUrl };
}

declare module "express-serve-static-core" {
  interface Application {
    ws: (route: string, handler: (ws: unknown, req: Request) => void) => void;
  }
}
