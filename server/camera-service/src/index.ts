import cors from "cors";
import express from "express";
import { SERVICE_PORT } from "./config";
import { createApiRouter } from "./routes";
import { createStreamRelay } from "./stream/relay";

const app = express();

app.use(cors());
app.use(express.json());

createStreamRelay(app);
app.use("/api", createApiRouter());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(SERVICE_PORT, () => {
  process.stdout.write(`camera-service listening on ${SERVICE_PORT}\n`);
});
