# Pinequest / Aegis — CCTV

AI-powered surveillance platform (smoking / littering / security incidents) powered
by **TypeScript** and the **Google Gemini API**. The codebase is split into two
standalone Next.js projects:

| Project | Role | Dev port |
|---------|------|----------|
| [`aegis-cctv-front`](./aegis-cctv-front) | Next.js frontend — dashboard UI, camera grid, client-side capture. Its `app/api/**` routes are **thin proxies** that forward to the backend over HTTP. | 3000 |
| [`aegis-cctv-backend`](./aegis-cctv-backend) | API-only Next.js service — camera config, RTSP resolution, ffmpeg pool, UniFi, RTSP snapshot pool, Gemini analysis. Holds all secrets. | 3001 |

## Run both (two terminals)

```bash
# Terminal A — backend (API on :3001)
cd aegis-cctv-backend
npm install
cp .env.example .env.local   # set GEMINI_API_KEY etc.
npm run dev

# Terminal B — frontend (UI on :3000)
cd aegis-cctv-front
npm install
cp .env.local.example .env.local   # BACKEND_URL defaults to http://localhost:3001
npm run dev
```

Open **http://localhost:3000**. The frontend forwards every `/api/*` call to
`BACKEND_URL` via `lib/backendProxy.ts`.

## How the split works

- **No shared in-process imports.** The frontend never imports backend code; it
  calls the backend over HTTP through its `app/api/**/route.ts` proxy handlers.
- **Shared modules are duplicated** in both projects: `lib/detection.ts`,
  `lib/evidence.ts`, and `cameraTypes.ts`. Tradeoff: zero build/infra coupling, but
  the two copies must be kept in sync manually. (Alternative — a shared workspace
  package — was rejected to keep the two projects fully standalone.)

## Known gap (pre-existing)

The frontend "universal camera" discovery screen calls `/api/discover/*` and a
`ws://…:3001` relay that lived in the previously-removed standalone
`server/camera-service`. Those endpoints are **not** part of `aegis-cctv-backend`
yet and must be rebuilt there. The client code is left unchanged.
