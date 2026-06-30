# PROJECT_STATUS.md — Pinequest / Aegis

_Generated from code audit — 2026-06-29_

---

## 1. Overview

**Pinequest / Aegis** is an AI-powered surveillance platform targeting three violation categories: smoking (cigarettes and vapes), littering (abandon-object detection over time), and security incidents (violence, vandalism, disturbances). It is a dual-stack project:

| Stack | Entry point | Purpose |
|---|---|---|
| **Python / FastAPI** | `main.py`, `run.py`, `serve.py`, `app/api.py` | RTSP camera management, AI inference, violation persistence, WebSocket broadcast, video analysis API |
| **Next.js / TypeScript** | `app/page.tsx` | Browser dashboard, on-device ONNX inference, RTSP-to-MJPEG proxy, network camera discovery UI |

### Tech stack

**Frontend**
- Next.js 15 (React 19, TypeScript 5)
- Tailwind CSS 4
- `onnxruntime-web` 1.27 — runs YOLO11 models in the browser (WebGPU or WASM)

**Backend**
- FastAPI / Uvicorn
- Ultralytics 8 (YOLO11) for smoking and security detection
- ByteTrack (via Ultralytics) for object tracking
- TensorFlow + YAMNet for audio event detection
- OpenCV for frame capture and annotation
- SQLite for violation storage
- python-nmap for LAN camera discovery

---

## 2. What It Can Do Right Now

### Browser (Next.js on-device inference)
- **Webcam smoking detection** — `lib/inference.ts` loads three ONNX models simultaneously: a custom smoking model (`pretrained.onnx`), a litter model (`litter.onnx`), and a COCO model (`coco.onnx`). Detects cigarettes and vapes with per-person composite scoring and pixel-level mouth-region analysis (`lib/smokingVision.ts`, `lib/rules.ts`).
- **Webcam litter detection** — `lib/rules.ts` applies person-context filtering (removes false positives on torso/face), background filtering, and spatial context.
- **Evidence capture** — `components/WebcamCanvas.tsx` saves JPEG snapshots to `evidence/` via `app/api/evidence/route.ts` at most once per 8-second cooldown per violation type.
- **Events sidebar** — `components/EventsPanel.tsx` shows live detections with thumbnails, confidence, and save status.
- **Network camera discovery** — `app/page.tsx` drives `POST /api/cameras/discovery/start` → `GET /api/cameras/discovery/results` polling loop; progressive results appear as the nmap scan progresses.
- **RTSP camera streaming** — `app/api/stream/[cameraId]/route.ts` spawns `rtsp_mjpeg.py` to proxy RTSP to MJPEG with candidate URL testing and failure caching.
- **RTSP credential management** — global username/password set, per-camera override, automatic password rotation on stream failure. Credentials stored in localStorage via `lib/applyCameraCredentials.ts`.
- **Camera grid** — searchable, 1/2/3-column layouts, online/offline status dots.

### Python backend
- **Full littering pipeline** (`run.py --source 0` or RTSP/file) — YOLO11s COCO detection (`app/detect_frame.py`) → ByteTrack → person-object association (`app/association.py`) → abandonment state machine (`app/abandonment.py`: IDLE → CARRIED → DROPPED → STATIONARY → OWNER_DEPARTED → ALERTED) → evidence annotation → SQLite row → WebSocket broadcast.
- **Video + audio analysis via API** — `POST /api/analyze` (in `app/api.py`) accepts a file upload or URL, runs `security_detector.detect_video_clip` + `audio_detector.analyze_clip` + `fusion.fuse`, streams NDJSON progress to the analyze page.
- **Analyze web page** (`app/templates/analyze.html`) — drag-and-drop or URL video analysis with real-time NDJSON progress log and detection briefing cards.
- **Legacy HTML dashboard** (`app/templates/dashboard.html`) — served at `GET /`, shows today's violation counts via `/api/stats` and live WebSocket updates.
- **Network camera discovery API** — `app/camera_discovery_api.py` implements `POST /api/cameras/discovery/start`, `GET /api/cameras/discovery/results`, `GET /api/cameras/discovery/subnet` backed by an async scan manager (`app/services/camera_discovery_state.py`).
- **Audio detection** — `app/audio_detector.py` extracts audio via ffmpeg, runs YAMNet, filters and deduplicates events into violence/disturbance categories.
- **SQLite persistence** — `app/database.py` stores violations with camera_id, floor, zone, type, confidence, image_path.
- **RTSP stream threads** — `app/cameras.py` opens each camera in a background thread with reconnect logic.
- **Smoking detection on video files/RTSP** — `app/detector.py:VideoProcessor` samples frames from a source, applies temporal windowing and cooldown.

---

## 3. What It Cannot Do / Limitations

### Critical gaps

1. ~~ONNX model files missing from the repo.~~ **Resolved** — `public/models/pretrained.onnx`, `public/models/litter.onnx`, and `public/models/coco.onnx` are all tracked in git and included on `git clone`. No download step required for the browser models.

2. **Python model weights missing.** `app/detector.py` requires `models/smoking.pt`; `app/security_detector.py` requires `models/security.pt`. Neither is in the repo. The training scripts exist under `scripts/` but require Roboflow API keys and produce local training runs. The littering pipeline (`detect_frame.py`) requires `training/checkpoints/yolo11s.pt` which is not in the repo.

3. **`cameras.json` has hardcoded RTSP credentials** (`hk123456`) committed to git. This is a real credential leak risk for the network the cameras live on.

4. **`cameras.json` camera entries are missing `floor` and `zone` fields.** `app/reporter.py` and `app/database.py` both read `camera_info["floor"]` and `camera_info["zone"]` which will KeyError/default to 0/"unknown". The cameras.json only has `id`, `name`, `host`, `rtsp_url`, `enabled`.

5. **Littering pipeline is CLI-only; not wired into `app/api.py`.** `detect_frame.py`, `association.py`, `abandonment.py` are only exercised by `run.py`. The main FastAPI server (`app/api.py`) does not run the littering pipeline for live RTSP streams — `main.py` uses `app/detector.py` (smoking only) for its detection loop.

6. ~~No ONNX models for the browser litter/smoking pipeline.~~ **Resolved** — see item 1 above; browser ONNX models are committed to git.

### Functionality gaps

7. **`security_detector.py` silently falls back to `models/smoking.pt`** when `models/security.pt` is absent. This means the analyze pipeline runs smoking detection instead of violence/vandalism detection with no error raised.

8. **No Vercel compatibility for Python-dependent routes.** `.vercelignore` exists and a `STATIC_EXPORT` env var is documented, but the RTSP stream proxy (`app/api/stream/[cameraId]/route.ts`) spawns a Python child process (`python3 rtsp_mjpeg.py`), which will not work on Vercel serverless functions.

9. **YAMNet loads from TensorFlow Hub (network request) every cold start.** `app/audio_detector.py:_load_yamnet()` calls `hub.load("https://tfhub.dev/google/yamnet/1")` — this makes first analysis slow and fails in offline environments.

10. **WebSocket violation queue is initialised at FastAPI startup but `push_violation` in `main.py` is called before the event loop runs.** `_violation_queue = None` until the ASGI `startup` event fires. `push_violation` silently drops all events until then. In practice Uvicorn is started last in `main.py`, so the detection loop that calls `push_violation` starts before the queue is ready.

11. **No UniFi integration tested.** `app/services/camera_discovery.py:_fetch_unifi_cameras()` calls `UniFiApiService` only when `UNIFI_API_KEY` env var is set; `UNIFI_API_KEY` is not documented anywhere in README or `.env.example`.

12. **No `.env.example` file.** The `.env` file is present (not gitignored) which risks secret leakage. Only `STATIC_EXPORT` and `FASTAPI_ORIGIN` are documented; `UNIFI_API_KEY`, model paths, and Roboflow variables are under-documented.

### Code-level issues

13. **`app/detector.py:VideoProcessor._record_violation` is a static method called on an instance.** The `_record_violation` stub in `run.py` (`det_mod.VideoProcessor._record_violation = staticmethod(lambda *a, **k: None)`) works, but the method is already `@staticmethod` so the monkey-patch is fragile.

14. **`detect_and_track` in `detect_frame.py` runs two model inferences per frame** (pass 1: ByteTrack, pass 2: plain NMS). This doubles GPU/CPU cost on every frame to handle ByteTrack's two-frame warm-up. The comment explains the tradeoff but the overhead is real.

15. **`app/reporter.py:process()` has a subtle window bug** — `_windows` is a module-level defaultdict. The cooldown check uses `_is_on_cooldown` but the window uses `append(True)` even when on cooldown, meaning a camera can accumulate `True` values through a cooldown period.

16. **No test coverage for core AI logic.** Only 4 test files exist, all for the camera discovery service. None test the abandonment machine, association logic, fusion, audio detector, or inference pipeline.

---

## 4. Codebase Analysis

### Architecture

The codebase has three loosely connected layers:

```
Browser (Next.js)               Python FastAPI              SQLite
  ONNX inference (webcam) ──→  /api/evidence (save)        violations table
  Camera discovery UI    ──→  /api/cameras/discovery/*
  RTSP stream grid       ──→  /api/stream/[cameraId] ──→  python3 rtsp_mjpeg.py
  Analyze page                 /api/analyze ──────────→  security_detector
                                                          audio_detector
                                                          fusion
  (legacy)                     / (dashboard.html) ──→   /api/violations, /api/stats
                                                          /ws (WebSocket)
CLI (run.py)                Python pipeline
  --source 0 (webcam)  ──→  detect_and_track
                            association
                            abandonment  ──→  reporter ──→  SQLite
                                                            evidence/
```

The Python backend has two separate detection systems that do not share state: the live camera loop (`main.py` using `app/detector.py`) and the littering pipeline (`run.py` using `detect_frame.py`+`association.py`+`abandonment.py`). These serve different purposes but result in duplicated model-loading logic.

### Code quality

- **Structure is clear and intentional.** Each concern is isolated into its own module. The abandonment state machine (`app/abandonment.py`) and associator (`app/association.py`) are well-documented with docstrings explaining the design.
- **TypeScript frontend is well-typed.** `lib/` modules use explicit interface types throughout. `lib/modelConfig.ts` centralises all thresholds/paths.
- **Python backend uses dataclasses and enums correctly** (e.g., `AbanState`, `LitteringEvent`, `DiscoveredCamera`).
- **Inconsistent error handling in Python.** Some functions use bare `except Exception` catches with `logger.warning` (swallowed errors), while others propagate. The analyze endpoint wraps everything in one try/except which makes individual-stage failures hard to distinguish.
- **The `logging.warning` call inside `CameraDiscoveryService._scan_target`** (`logging.warning(f"Found hosts...")`) uses the root logger with a raw f-string instead of the module logger with `%s` formatting — minor but inconsistent.
- **Module-level model loading in `detect_frame.py`** (`_model = YOLO(str(_WEIGHTS))` at import time) causes a `FileNotFoundError` at import if weights are missing, not at call time. This will crash the whole process.
- **`serve.py` was not read** — it likely predates the current FastAPI structure and may be a thin wrapper.

### Technical debt

| File | Issue |
|---|---|
| `cameras.json` | Hardcoded RTSP credentials; missing `floor`/`zone` per camera |
| `app/detect_frame.py` L31-32 | `_model = YOLO(...)` at module import time — crashes on missing weights |
| `app/reporter.py` | Module-level `_windows`/`_cooldowns` make it stateful across tests |
| `app/api.py` L350 | `@app.on_event("startup")` is deprecated in FastAPI; should use lifespan context manager |
| `main.py` L108 | `push_violation` calls during detection may race the ASGI startup event |
| `next.config.ts` | No CSP, no security headers configured |
| `app/api/stream/[cameraId]/route.ts` | Spawns unbounded Python child processes per camera connection; no global process pool |

### Test coverage

4 test files, all in `tests/`, covering only `CameraDiscoveryService`. Core logic (abandonment machine, associator, fusion, audio detection, inference pipeline) has zero automated tests.

---

## 5. Key Improvements (Prioritized)

### Must fix

**1. ~~Provide ONNX model files or a download script~~ — Resolved.**
`public/models/pretrained.onnx`, `public/models/litter.onnx`, and `public/models/coco.onnx` are tracked in git and present on `git clone`.

**2. Remove RTSP credentials from cameras.json (S, impact: security)**
`cameras.json` is tracked by git with `hk123456` as password for 22 cameras. Rotate the credentials, add `cameras.json` to `.gitignore`, and document `cameras.example.json` as the template.
Files: `cameras.json`, `.gitignore`

**3. Add `floor` and `zone` to cameras.json camera entries (S, impact: correctness)**
The reporter and database insert expect these fields. Currently all violations will be logged with floor=0, zone="unknown".
Files: `cameras.json`

**4. Fix module-level model loading in detect_frame.py (S, impact: stability)**
Move `_model = YOLO(str(_WEIGHTS))` into a lazy-loading function so importing `detect_frame` doesn't crash when weights are absent. Pattern already used correctly in `app/detector.py`.
Files: `app/detect_frame.py` L28-31

**5. Wire littering pipeline into FastAPI (M, impact: core feature parity)**
`app/api.py` only broadcasts smoking violations from the static camera loop. Integrate `detect_and_track` + `Associator` + `AbandonmentMachine` into the live camera processing loop so littering events reach the WebSocket and database via the server, not just the CLI.
Files: `app/api.py`, `main.py`, `app/reporter.py`

### Should fix

**6. Add a `.env.example` and gitignore `.env` (S)**
Document all env vars, add `UNIFI_API_KEY` to the list. `.env` is currently committed (it may contain keys).
Files: `.env`, `.gitignore` (new `.env.example`)

**7. Fix the FastAPI startup event deprecation (S)**
Replace `@app.on_event("startup")` with a lifespan context manager as recommended in FastAPI docs.
Files: `app/api.py` L350-354

**8. Cache YAMNet model locally instead of fetching from Hub (M)**
First analyze call downloads the model from TFHub. Cache it to a local path or document that ffmpeg + model warm-up is expected.
Files: `app/audio_detector.py`

**9. Tests for abandonment machine and association (M)**
These are the most complex and correctness-critical modules. The existing ghost-reown logic and timer math have several edge cases. Add unit tests covering: IDLE→CARRIED→DROPPED→ALERTED happy path, re-pickup reset, flicker tolerance, ghost expiry.
Files: `tests/` (new), `app/abandonment.py`, `app/association.py`

### Nice to have

**10. Consolidate the two YOLO detection paths (L)**
`app/detector.py` (smoking, VideoProcessor) and `app/detect_frame.py` (COCO + ByteTrack) are separate model managers. Unifying them under a single inference service would reduce duplication and make model management cleaner.

**11. Python process pool for RTSP streams (M)**
`app/api/stream/[cameraId]/route.ts` spawns one Python process per camera connection with no limit beyond `MAX_CONCURRENT_STREAM_OPENS = 4`. A crashed process leaves no clean-up. Consider ffmpeg directly from Node (child_process) instead of an intermediate Python script.
Files: `app/api/stream/[cameraId]/route.ts`, `app/api/stream/[cameraId]/rtsp_mjpeg.py`

**12. Docker / docker-compose for dev setup (M)**
Setting up Python deps (TensorFlow, ultralytics, nmap binary, ffmpeg) alongside Node is non-trivial. A `docker-compose.yml` with a Python service + Node service would significantly reduce onboarding friction.

---

## 6. Future Features / Roadmap

These are features the code architecture hints at but has not yet completed:

1. **Littering via API** — The state machine is fully implemented but only runs in CLI mode. Wiring it into the FastAPI camera loop (item 5 above) would expose littering events to the dashboard, WebSocket, and evidence archive.

2. **Fine-tuned ONNX smoking model** — `modelConfig.ts` references `ACTIVE_MODEL = "pretrained" | "finetuned"` and `/models/finetuned.onnx` path. The training scripts and custom dataset (`models/custom-smoking/`) exist but the ONNX export is not automated. `training/export_onnx.py` exists but is not documented.

3. **Motion clip watcher** — `cameras.json` has `"motion_clip_watcher": false`. When enabled, `main.py` watches `input/motion/` for NVR-triggered MP4 clips and processes them through `clip_processor.py`. This is fully implemented but disabled by default with no UI to enable it.

4. **UniFi Protect integration** — `app/services/unifi_api.py` exists; `_fetch_unifi_cameras` in `camera_discovery.py` calls it when `UNIFI_API_KEY` is set. Not documented and presumably incomplete.

5. **Multi-subnet / remote camera support** — `docs/remote-camera-setup.md` exists. `cameras.json` has `connection_mode: "local"`. The architecture implies remote RTSP support via the Next.js proxy but remote authentication and NAT traversal are not implemented.

6. **Dashboard alert notifications** — The WebSocket is connected to the legacy HTML dashboard and `push_violation` is wired. A Next.js WebSocket consumer would allow the modern UI to receive server-side violation events (from RTSP cameras) in real time alongside the browser webcam events.

7. **Security detector training** — `scripts/train_security_model.py` and the Roboflow violence dataset integration are set up. The model (`models/security.pt`) just needs to be trained and exported.
