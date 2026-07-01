# PROJECT_STATUS.md — Pinequest / Aegis

_Last updated: 2026-07-01_

## Overview

**Pinequest / Aegis** is a TypeScript surveillance platform that detects smoking, littering, and security incidents using the **Google Gemini API** — no YOLO, no ONNX, no Python runtime.

| Stack | Entry point | Purpose |
|---|---|---|
| **Next.js 15** | `app/page.tsx` | Camera dashboard, Gemini vision proxy, RTSP streaming, evidence capture |
| **camera-service** | `server/camera-service/src/index.ts` | ONVIF / nmap discovery, RTSP relay |
| **camera-motion-gemini** | `server/camera-motion-gemini/src/index.ts` | Optional motion-gated per-camera Gemini workers |

## Detection pipeline

```
RTSP stream → FFmpeg MJPEG → CameraCard burst capture
    → POST /api/gemini (gemini-2.5-flash, temporal prompt)
    → Evidence event + JPEG snapshot (/api/evidence)
```

Littering is detected as an **action over time** (carry → drop → leave) via multi-frame Gemini prompts, not single-frame classification.

## What works today

- Live RTSP camera grid with credential management
- Network camera discovery (nmap + ONVIF via camera-service)
- Gemini-powered smoking / vape / litter detection on up to 3 concurrent cameras
- Evidence snapshots saved to `evidence/`
- Events sidebar with live violation feed
- Motion-gated Gemini workers (standalone service)

## Requirements

- Node.js 20+
- `ffmpeg` on PATH (stream decoding)
- `nmap` (camera discovery)
- `GEMINI_API_KEY` in `.env.local`

## Deploy notes

- Full AI requires a **Node server** (`npm run build && npm start`) — API routes need a runtime.
- `camera-service` and cameras must share network access (same LAN or VPN).
- Static export (`npm run build:static`) does **not** include Gemini detection.

## Removed (legacy)

The following were removed in the TS + Gemini migration:

- Python FastAPI backend, Ultralytics YOLO, ByteTrack littering pipeline
- Browser ONNX inference (`onnxruntime-web`, `public/models/*.onnx`)
- Training datasets (`models/custom-smoking`, `models/trash-dataset`)
- YAMNet audio analysis, Roboflow training scripts
