# Pinequest / Aegis

AI-powered surveillance platform for detecting **smoking**, **littering**, and **security incidents** from live camera feeds — powered entirely by **TypeScript** and the **Google Gemini API**.

No YOLO weights, no ONNX models, no Python backend.

---

## Architecture

```
RTSP cameras
    │
    ├─► Next.js stream routes (FFmpeg → MJPEG)
    │       └─► CameraCard.tsx — burst-frame capture
    │               └─► POST /api/gemini (gemini-2.5-flash)
    │                       └─► Evidence saved via /api/evidence
    │
    └─► server/camera-service — ONVIF / nmap discovery + RTSP relay
```

Optional background workers in `server/camera-motion-gemini/` add motion-gated Gemini analysis (pixelmatch + `@google/genai`).

---

## Prerequisites

| Tool | Purpose |
|------|---------|
| **Node.js 20+** | Next.js app + camera services |
| **ffmpeg** | RTSP → MJPEG decoding |
| **nmap** | Network camera discovery (via camera-service) |
| **GEMINI_API_KEY** | Google AI Studio API key |

---

## Quick start

### 1. Environment

```bash
cp .env.example .env.local
# Set GEMINI_API_KEY in .env.local
```

### 2. Install & run (two terminals)

**Terminal A — Next.js dashboard:**
```bash
npm install
npm run dev
```
Open **http://localhost:3000**

**Terminal B — camera discovery service:**
```bash
npm run dev:camera-service
```

### 3. Optional — motion-gated Gemini workers

```bash
cd server/camera-motion-gemini
cp .env.example .env   # GEMINI_API_KEY
npm install
npm run dev
```

---

## How detection works

1. Each online camera tile loads an MJPEG stream via `/api/stream/*`.
2. `CameraCard` captures a short burst of JPEG frames (~5 frames, 450 ms apart).
3. Frames are sent to `POST /api/gemini`, which calls **gemini-2.5-flash** with a temporal prompt (littering is judged as an action across frames, not a single still).
4. Confident detections (≥ 0.7) trigger evidence capture to `evidence/` via `POST /api/evidence`.

The Gemini API key stays server-side — the browser never sees it.

---

## Project structure

```
app/
  page.tsx                    — Main camera dashboard
  api/gemini/route.ts         — Gemini vision proxy (smoking + littering)
  api/evidence/route.ts       — Save violation snapshots
  api/stream/                 — FFmpeg RTSP → MJPEG proxies
  cameras/                    — Camera grid UI + discovery helpers

lib/
  aiThresholds.ts             — UI confidence thresholds
  cameraAiUtils.ts            — Evidence capture from stream frames
  detection.ts                — Detection type contract

server/
  camera-service/             — ONVIF discovery + stream relay (Express)
  camera-motion-gemini/       — Per-camera motion detection + Gemini workers

components/
  EventsPanel.tsx             — Live events sidebar
```

---

## Deploy

**Full dashboard (recommended):** deploy Next.js as a Node server so `/api/gemini` and stream routes work.

- **Vercel / Railway / Render:** `npm run build && npm start`
- Set `GEMINI_API_KEY` in the host environment
- Run `camera-service` on a host with LAN access to cameras

**Static-only export** (`npm run build:static`) ships UI without API routes — no Gemini detection. Use only for a camera-viewing shell without AI.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| AI badge never appears on cameras | Set `GEMINI_API_KEY` in `.env.local` and restart `npm run dev` |
| `GET /api/gemini` returns 500 | Key missing or invalid |
| Streams show UNAVAILABLE | Enter RTSP credentials via the lock icon on each tile |
| Discovery returns nothing | Ensure `npm run dev:camera-service` is running and nmap is installed |
| Gemini 429 / 503 | Rate limit — workers back off automatically; reduce active AI cameras (max 3) |

---

## License

Internal Pinequest / Aegis project — see repository maintainers for usage terms.
