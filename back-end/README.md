# aegis-cctv-backend

API-only Next.js service holding all server-side logic for the Aegis CCTV system:
camera config/discovery, RTSP stream resolution, the ffmpeg process pool, UniFi
Protect integration, RTSP snapshot pool, and Gemini frame analysis.

It exposes REST route handlers under `app/api/**`. The frontend
(`aegis-cctv-front`) never imports this code directly — it calls these endpoints
over HTTP through thin proxy routes.

## Run

```bash
npm install
cp .env.example .env.local   # then fill in GEMINI_API_KEY etc.
npm run dev                  # serves on http://localhost:3001
```

## Endpoints (unchanged from the original monorepo)

- `GET  /api/cameras`
- `GET|POST /api/cameras/settings`
- `POST /api/cameras/unifi/streams`
- `POST /api/evidence`
- `POST /api/gemini`, `GET /api/gemini/[cameraId]`
- `GET  /api/snapshot/rtsp`
- `GET  /api/stream/[cameraId]`, `GET /api/stream/mjpeg`, `GET /api/stream/rtsp`

## Notes

- Shared modules `lib/detection.ts`, `lib/evidence.ts`, `lib/cameraTypes.ts` are
  duplicated from `aegis-cctv-front` (see root README for the shared-types tradeoff).
- The network-discovery endpoints (`/api/discover/*`) and the WebSocket relay that
  the frontend's "universal camera" screen expects lived in the previously-removed
  standalone camera-service and are **not** part of this backend yet.
