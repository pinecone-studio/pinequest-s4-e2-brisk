# Pinequest / Aegis

AI-powered smoking and litter detection with a **Next.js** web UI and a **FastAPI** backend. The Live Monitoring view discovers IP cameras on your local network (via **nmap**), lets you enter RTSP credentials in the browser, and streams MJPEG previews into the dashboard.

---

## Prerequisites

Install these before running the project locally:

| Tool | Version | Purpose |
|------|---------|---------|
| **Python** | 3.9+ | FastAPI backend, YOLO inference, RTSP decoding |
| **Node.js** | 20+ | Next.js frontend |
| **npm** | 9+ | Frontend dependencies |
| **nmap** | 7.x+ | Network camera discovery (`python-nmap` wraps the system binary) |
| **OpenCV / FFmpeg** | (via `opencv-python`) | RTSP → MJPEG stream proxy |

### Install nmap

**macOS (Homebrew):**
```bash
brew install nmap
```

**Ubuntu / Debian:**
```bash
sudo apt update && sudo apt install nmap
```

**Verify:**
```bash
nmap --version
python3 -c "import nmap; print('python-nmap OK')"
```

---

## Quick start (local development)

You need **two terminals** — one for the backend, one for the frontend.

### 1. Backend (FastAPI + nmap)

```bash
# From the project root
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Start FastAPI on port 8000
python3 -m uvicorn app.api:app --reload --port 8000
```

Backend URLs:

- API root: http://localhost:8000
- Camera discovery: http://localhost:8000/api/cameras/discovery/results
- OpenAPI docs: http://localhost:8000/docs

### 2. Frontend (Next.js)

```bash
# In a second terminal, from the project root
npm install

# Optional: point Next.js at a non-default FastAPI host
# echo "FASTAPI_ORIGIN=http://localhost:8000" >> .env.local

npm run dev
```

Open **http://localhost:3000**

- **Face Cam** — browser webcam + on-device YOLO detection
- **Camera Room (Live Monitoring)** — click **Scan Network** to discover RTSP cameras, enter credentials, and view streams

> Next.js rewrites `/api/cameras/*` to FastAPI (`FASTAPI_ORIGIN`, default `http://localhost:8000`). The RTSP MJPEG proxy (`/api/stream/rtsp`) runs inside the Next.js Node process and requires `python3` on your PATH.

---

## Environment variables

### Frontend (`.env.local`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FASTAPI_ORIGIN` | No | `http://localhost:8000` | Base URL of the FastAPI server. Used by `next.config.ts` to proxy `/api/cameras` routes. |
| `STATIC_EXPORT` | No | *(unset)* | Set to `1` to enable static export mode (disables API rewrites). |
| `NEXT_PUBLIC_ACTIVE_MODEL` | No | `pretrained` | Webcam demo model: `pretrained` or `finetuned`. |

**Example `.env.local`:**
```env
FASTAPI_ORIGIN=http://localhost:8000
NEXT_PUBLIC_ACTIVE_MODEL=pretrained
```

### Backend (`.env` or shell)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CAMERA_DISCOVERY_TARGETS` | No | Auto-detect | Comma-separated scan targets (CIDR, IP, or hostname). Example: `192.168.1.0/24,10.0.0.0/24`. If unset, the API derives targets from the local subnet or `cameras.json`. |
| `ROBOFLOW_API_KEY` | No* | — | Roboflow API key for training scripts (`scripts/train_model.py`, etc.). |
| `ROBOFLOW_TRASH_WORKSPACE` | No | `ros` | Roboflow workspace for trash dataset scripts. |
| `ROBOFLOW_TRASH_PROJECT` | No | `trash-plastic-bottle-detection` | Trash project name. |
| `ROBOFLOW_TRASH_VERSION` | No | `2` | Trash dataset version. |
| `ROBOFLOW_SECURITY_WORKSPACE` | No | `gowtham-p4vua` | Security/violence model workspace. |
| `ROBOFLOW_SECURITY_PROJECT` | No | `violence-2apnk-1wrkr` | Security project name. |
| `ROBOFLOW_SECURITY_VERSION` | No | `1` | Security dataset version. |

\* Required only when running Roboflow training/download scripts.

**Example `.env`:**
```env
CAMERA_DISCOVERY_TARGETS=192.168.1.0/24
ROBOFLOW_API_KEY=your_key_here
```

---

## Live Monitoring workflow

1. Open **Camera Room** in the sidebar.
2. Click **Scan Network** — the app detects your local `/24` subnet and starts an nmap scan via `POST /api/cameras/discovery/start`.
3. While status is `running`, the UI polls `GET /api/cameras/discovery/results` and shows discovered cameras as they appear.
4. Enter credentials via the **Credentials** panel (global username + comma-separated passwords) or per-camera modal when a stream is unavailable.
5. Streams are proxied as MJPEG through `/api/stream/rtsp?url=...` so they work in the browser.

RTSP credentials are managed in the **frontend** (not hardcoded in the backend) so the same build works on any network.

---

## Camera discovery API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/cameras/discovery/subnet` | Detect local network subnet |
| `POST` | `/api/cameras/discovery/start` | Start async nmap scan (`{"targets": ["192.168.1.0/24"]}`) |
| `GET` | `/api/cameras/discovery/results` | Scan status + `discovered_cameras` list |

Scan status values: `running`, `completed`, `failed`, `timeout`.

---

## Legacy CLI & dashboard (Python-only)

These entry points predate the Next.js UI and still work for batch/offline use:

```bash
# Train smoking detection model
python3 scripts/train_model.py --epochs 5 --imgsz 416

# Run detection on a video file
python3 run.py --video input/your_video.mp4 --camera cam_01

# Standalone violation dashboard (no Next.js)
python3 serve.py
# → http://localhost:8080

# Live RTSP detection from cameras.json
python3 main.py
```

Configure static cameras in `cameras.json` (used by CLI tools and `/api/cameras`, not by Live Monitoring discovery).

---

## Project structure

```
app/
  api.py                      — FastAPI app (violations, WebSocket, mounts discovery router)
  camera_discovery_api.py     — /api/cameras/discovery/* REST endpoints
  services/
    camera_discovery.py       — nmap-based network scanner
    camera_discovery_state.py — Async scan state + progressive results
  api/stream/                 — Next.js RTSP → MJPEG proxy routes
app/cameras/                  — Next.js camera UI components + API helpers
lib/                          — Browser-side YOLO / inference
next.config.ts                — Proxies /api/cameras/* → FastAPI
cameras.json                  — Static camera config (CLI / legacy API)
requirements.txt              — Python dependencies (includes python-nmap)
package.json                  — Next.js frontend
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Discovery returns 404 | Ensure FastAPI is running on port 8000 and `FASTAPI_ORIGIN` matches. |
| `nmap not found` | Install nmap system-wide; on macOS use `/opt/homebrew/bin/nmap`. |
| Scan takes very long | Default config skips RTSP credential probing (`probe_rtsp=False`). Large subnets still take time. |
| Streams show "UNAVAILABLE" | Open the camera credentials modal or set global passwords; RTSP auth is user-supplied. |
| MJPEG proxy fails | Confirm `python3` is on PATH and `opencv-python` is installed in the venv used by Next.js child processes. |

---

## License

Internal Pinequest / Aegis project — see repository maintainers for usage terms.
