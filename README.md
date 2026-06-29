# Pinequest / Aegis

AI-powered surveillance platform for detecting **smoking** (cigarettes, vapes), **littering** (person carries object, drops it, walks away), and **security incidents** (violence, vandalism, disturbances).

The project is a dual stack:
- **Next.js frontend** — browser dashboard with on-device ONNX inference from the webcam, live RTSP camera grid, network camera discovery, and a video-analysis page.
- **FastAPI backend** — RTSP camera management, server-side YOLO11 inference, YAMNet audio detection, SQLite violation log, WebSocket broadcast, and a `/api/analyze` endpoint for video-file analysis.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| **Python** | 3.10+ | FastAPI, YOLO inference, RTSP decoding, audio analysis |
| **Node.js** | 20+ | Next.js frontend |
| **npm** | 9+ | Frontend dependencies |
| **nmap** | 7.x+ | Network camera discovery (`python-nmap` wraps the system binary) |
| **ffmpeg** | 4.x+ | Audio extraction for YAMNet; RTSP-to-MJPEG proxy |

### Install system dependencies

**macOS:**
```bash
brew install nmap ffmpeg
```

**Ubuntu / Debian:**
```bash
sudo apt update && sudo apt install nmap ffmpeg
```

---

## Quick start

You need **two terminals** — one for the Python backend, one for Next.js.

### 1. Backend (FastAPI)

```bash
# From the project root
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Start FastAPI on port 8000
python3 -m uvicorn app.api:app --reload --port 8000
```

Backend endpoints:
- API root / legacy dashboard: http://localhost:8000
- Video analysis page: http://localhost:8000/analyze
- Camera discovery: http://localhost:8000/api/cameras/discovery/results
- OpenAPI docs: http://localhost:8000/docs

### 2. Frontend (Next.js)

```bash
# In a second terminal, from the project root
npm install
npm run dev
```

Open **http://localhost:3000**

> **Note:** The webcam AI panel requires ONNX model files in `public/models/`. See **Model files** below.

---

## Model files

The frontend runs three ONNX models entirely in the browser:

| File | Purpose |
|------|---------|
| `public/models/pretrained.onnx` | Smoking detection (cigarette + vape) |
| `public/models/litter.onnx` | Litter / plastic bottle detection |
| `public/models/coco.onnx` | COCO person detector (context for false-positive filtering) |

These files are **not tracked in git** (they are large binary weights). You must obtain them separately — either by exporting from a trained Ultralytics checkpoint via `training/export_onnx.py`, or by downloading from the project's model store.

The Python backend also needs:

| File | Purpose |
|------|---------|
| `models/smoking.pt` | YOLO11 smoking weights (used by `app/detector.py`) |
| `models/security.pt` | YOLO11 security/violence weights (used by `app/security_detector.py`) |
| `training/checkpoints/yolo11s.pt` | COCO YOLO11s weights (used by `app/detect_frame.py`) |

Run `python3 scripts/download_pretrained.py` to fetch the COCO pretrained weights.

---

## Environment variables

### Frontend (`.env.local`)

| Variable | Default | Description |
|----------|---------|-------------|
| `FASTAPI_ORIGIN` | `http://localhost:8000` | Base URL of the FastAPI server. Used by `next.config.ts` to proxy `/api/cameras/*` routes. |
| `STATIC_EXPORT` | *(unset)* | Set to `1` to enable static export mode (disables API rewrites). |
| `NEXT_PUBLIC_ACTIVE_MODEL` | `pretrained` | Webcam model: `pretrained` or `finetuned`. |

Example `.env.local`:
```env
FASTAPI_ORIGIN=http://localhost:8000
NEXT_PUBLIC_ACTIVE_MODEL=pretrained
```

### Backend (`.env` or shell)

| Variable | Default | Description |
|----------|---------|-------------|
| `CAMERA_DISCOVERY_TARGETS` | Auto-detect | Comma-separated scan targets (CIDR, IP, hostname). E.g. `192.168.1.0/24`. |
| `ROBOFLOW_API_KEY` | — | Required by training scripts (`scripts/train_model.py`, etc.). |
| `ROBOFLOW_TRASH_WORKSPACE` | `ros` | Roboflow workspace for trash dataset. |
| `ROBOFLOW_TRASH_PROJECT` | `trash-plastic-bottle-detection` | Trash dataset project name. |
| `ROBOFLOW_TRASH_VERSION` | `2` | Trash dataset version. |
| `ROBOFLOW_SECURITY_WORKSPACE` | `gowtham-p4vua` | Security/violence model workspace. |
| `ROBOFLOW_SECURITY_PROJECT` | `violence-2apnk-1wrkr` | Security dataset project name. |
| `ROBOFLOW_SECURITY_VERSION` | `1` | Security dataset version. |
| `UNIFI_API_KEY` | — | Optional. Enables UniFi Protect camera discovery alongside nmap. |

---

## Features

### Browser webcam AI
- Runs **three ONNX models in parallel** in the browser (no server round-trip) via `onnxruntime-web`.
- Detects **cigarettes**, **vapes**, and **litter** from the webcam feed in real time.
- Composite scoring: model confidence + pixel-level mouth-region analysis (gray smoke pixels, ember pixels) to suppress false positives.
- Saves JPEG evidence to `evidence/` via `POST /api/evidence` with an 8-second per-type cooldown.
- Detections appear in the **Events panel** sidebar with thumbnail, confidence, and save status.
- Press **Space** to pause/resume inference.

### Network camera discovery (Live Monitoring)
1. Click **Scan Network** to detect the local `/24` subnet and start an nmap scan.
2. Results poll progressively via `GET /api/cameras/discovery/results`.
3. Discovered RTSP cameras appear in the sidebar camera list.
4. Enter credentials via the global **Credentials** panel or per-camera modal.
5. Streams are proxied as MJPEG through `GET /api/stream/[cameraId]` (Next.js Node route → Python subprocess).

Credentials are stored in the browser (localStorage) and never hardcoded in the backend.

### Video analysis (`/analyze`)
- Upload a video file (MP4/MOV/WebM) or paste a direct video URL or RTSP link.
- The backend runs **YOLO11 video analysis** + **YAMNet audio analysis** + **signal fusion** and streams NDJSON progress back.
- Results appear as detection cards with confidence, evidence thumbnail, and audio/video source tags.
- Fusion modes: `any` (fire on either), `both` (require video AND audio), `weighted` (combined score threshold).

### Littering pipeline (CLI / `run.py`)
```bash
python3 run.py --source 0          # webcam
python3 run.py --source input/clip.mp4
python3 run.py --source rtsp://...
```
Per-frame pipeline: YOLO11s COCO detector → ByteTrack → person-object association → abandonment state machine (IDLE → CARRIED → DROPPED → STATIONARY → OWNER_DEPARTED → ALERTED) → evidence snapshot → SQLite row → optional WebSocket broadcast.

### Legacy RTSP camera mode (`main.py`)
```bash
python3 main.py
```
Reads `cameras.json`, opens RTSP streams in background threads, runs smoking detection on sampled frames, and serves the legacy HTML dashboard on port 8080.

---

## Camera configuration (`cameras.json`)

Static cameras used by the CLI tools and legacy API. The Next.js UI uses the discovery API instead.

**`cameras.json` is not tracked in git** — it contains real RTSP credentials and must never be committed. Set it up locally:

```bash
cp cameras.example.json cameras.json
# Edit cameras.json and replace REPLACE_ME_USER / REPLACE_ME_PASSWORD with your real credentials
```

The file structure (see `cameras.example.json` for the full template):

```json
{
  "cameras": [
    {
      "id": "cam_010",
      "name": "LAN Camera 10",
      "host": "192.168.1.10",
      "rtsp_url": "rtsp://REPLACE_ME_USER:REPLACE_ME_PASSWORD@192.168.1.10:554/cam/realmonitor?channel=1&subtype=0",
      "enabled": true
    }
  ],
  "sample_rate": 15,
  "confidence_threshold": 0.50,
  "audio_enabled": true,
  "audio_threshold": 0.35,
  "fusion_mode": "any"
}
```

---

## Camera discovery API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/cameras/discovery/subnet` | Detect local network subnet |
| `POST` | `/api/cameras/discovery/start` | Start async nmap scan (`{"targets": ["192.168.1.0/24"]}`) |
| `GET` | `/api/cameras/discovery/results` | Scan status + `discovered_cameras` list |

Scan status values: `running`, `completed`, `failed`, `timeout`.

---

## Project structure

```
app/
  api.py                      — FastAPI app (violations, WebSocket, analyze, mounts discovery router)
  camera_discovery_api.py     — /api/cameras/discovery/* REST endpoints
  detect_frame.py             — YOLO11s COCO + ByteTrack for littering pipeline
  association.py              — Person-object ownership tracking
  abandonment.py              — Abandonment state machine (littering detection)
  detector.py                 — Smoking detector VideoProcessor (RTSP/file mode)
  security_detector.py        — YOLO11 security/violence detector
  audio_detector.py           — YAMNet audio event detection
  fusion.py                   — Video + audio signal fusion
  clip_processor.py           — Motion clip processor (file → violations)
  reporter.py                 — Violation annotation + SQLite persistence
  database.py                 — SQLite schema and queries
  cameras.py                  — RTSP stream thread management
  services/
    camera_discovery.py       — nmap-based LAN scanner
    camera_discovery_state.py — Async scan state + progressive results
    unifi_api.py              — Optional UniFi Protect integration
  api/
    evidence/route.ts         — Next.js: save webcam evidence to disk
    stream/[cameraId]/route.ts — Next.js: RTSP → MJPEG proxy
  cameras/                    — Next.js camera UI components + API helpers
  templates/
    dashboard.html            — Legacy HTML dashboard (served at GET /)
    analyze.html              — Video analysis page (served at GET /analyze)

lib/                          — Browser-side YOLO / inference
  inference.ts                — ONNX session management + runInference()
  modelConfig.ts              — All model paths, thresholds, class names
  rules.ts                    — Composite smoking + litter filtering logic
  smokingVision.ts            — Pixel-level mouth region analysis
  yoloDecode.ts               — YOLO output tensor decoder + NMS
  evidence.ts                 — EvidenceEvent type

components/
  WebcamCanvas.tsx            — Webcam capture + inference loop + evidence capture
  EventsPanel.tsx             — Events sidebar
  ModelStatusBadge.tsx        — Loading / ready / error badge

training/
  export_onnx.py              — Export YOLO checkpoint to ONNX
  verify_onnx.py              — Verify exported ONNX model
  checkpoints/
    bytetrack_littering.yaml  — ByteTrack config for littering pipeline

scripts/
  train_model.py              — Train smoking model
  train_security_model.py     — Train security/violence model
  train_trash_model.py        — Train litter model
  download_pretrained.py      — Download pretrained COCO weights

cameras.example.json          — Camera config template (copy to cameras.json and add real credentials — not tracked in git)
requirements.txt              — Python dependencies
package.json                  — Next.js (React 19, onnxruntime-web 1.27)
next.config.ts                — Proxies /api/cameras/* → FastAPI
```

---

## Training

Training scripts live in `scripts/`. All require Ultralytics and (optionally) a Roboflow API key for dataset download.

```bash
# Smoking detection
python3 scripts/train_model.py --epochs 20 --imgsz 640

# Security / violence detection (downloads from Roboflow)
python3 scripts/train_security_model.py --download-only
python3 scripts/train_security_model.py --epochs 10

# Litter / plastic bottle detection
python3 scripts/train_trash_model.py --epochs 20

# Export a trained checkpoint to ONNX for the browser
python3 training/export_onnx.py --weights models/smoking.pt --output public/models/pretrained.onnx
```

Custom smoking training data (positive and negative examples) is in `models/custom-smoking/`.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Browser shows "Loading models…" indefinitely | ONNX files are missing from `public/models/`. Export or obtain them — see Model files above. |
| `ModuleNotFoundError` on backend start | Activate the venv (`source venv/bin/activate`) and run `pip install -r requirements.txt`. |
| Detection fails with "Model weights not found" | Run `python3 scripts/download_pretrained.py` or train the model first. |
| Discovery returns 404 | Ensure FastAPI is running on port 8000 and `FASTAPI_ORIGIN` in `.env.local` matches. |
| `nmap not found` | Install nmap system-wide; on macOS use `/opt/homebrew/bin/nmap`. |
| Scan takes a long time | By default RTSP credential probing is disabled (`probe_rtsp=False`). Large subnets still take 30-60s for ping sweep + port scan. |
| Streams show "UNAVAILABLE" | Open the camera credentials modal or set global credentials in the Credentials panel. Credentials are not stored server-side. |
| MJPEG proxy fails | Confirm `python3` is on PATH and `opencv-python` is installed in the active venv. |
| Audio analysis fails or is skipped | Install `ffmpeg` system-wide. The audio pipeline extracts a WAV with ffmpeg then runs YAMNet. |
| `FileNotFoundError` for yolo11s.pt | Run `python3 scripts/download_pretrained.py`. |

---

## License

Internal Pinequest / Aegis project — see repository maintainers for usage terms.
