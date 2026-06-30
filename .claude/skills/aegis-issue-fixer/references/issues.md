# Aegis Audit Findings — Issue Reference

_Last updated: 2026-06-29. Two items from the original twelve-issue audit have already shipped:_
- _RTSP credential leak in `cameras.json` — fixed in PR #110 (branch `security/remove-camera-credentials`, GitHub issue #109)_
- _Module-level model load in `detect_frame.py` — fixed in PR #115 (branch `fix/lazy-model-loading`, GitHub issue #113)_

_This file tracks the remaining ten issues in recommended execution order (security/correctness first, then feature work, then infrastructure)._

---

## Issue #1 — Add `.env.example` and `.env.local.example` templates

**Labels:** `security`, `documentation`
**Branch:** `chore/add-env-example`
**Commit message:** `chore: add .env.example and .env.local.example environment templates`
**Security-sensitive:** Mildly — the `.env` file was never committed to git (gitignored), so no history cleanup is required. However, the `ROBOFLOW_API_KEY` present in the local `.env` is a real key; flag in the PR that it should be rotated as a precaution now that it is being documented.

### Problem

There is no `.env.example` or `.env.local.example` file. Developers cloning the repo have no template to copy — they must read through `README.md`, `next.config.ts`, and `app/services/camera_discovery.py` to discover which variables are required. The README documents the variables in prose, but a template file is the convention and is needed for scripts that use `cp .env.example .env`.

The frontend uses `.env.local` (Next.js convention). The backend uses `.env` (gitignored). Both need example files.

### Impact

New contributors cannot run the project without guessing required variables. CI/CD pipelines have no reference. `UNIFI_API_KEY` is undiscoverable without reading Python source.

### Acceptance criteria

- [ ] `.env.example` exists at repo root, covering all backend variables with placeholder values and one-line comments
- [ ] `.env.local.example` exists at repo root, covering all frontend variables with placeholder values and one-line comments
- [ ] Variables in `.env.example`: `ROBOFLOW_API_KEY`, `ROBOFLOW_WORKSPACE`, `ROBOFLOW_PROJECT`, `ROBOFLOW_VERSION`, `ROBOFLOW_TRASH_WORKSPACE`, `ROBOFLOW_TRASH_PROJECT`, `ROBOFLOW_TRASH_VERSION`, `ROBOFLOW_SECURITY_WORKSPACE`, `ROBOFLOW_SECURITY_PROJECT`, `ROBOFLOW_SECURITY_VERSION`, `UNIFI_API_KEY`, `CAMERA_DISCOVERY_TARGETS`, `TFHUB_CACHE_DIR`
- [ ] Variables in `.env.local.example`: `FASTAPI_ORIGIN`, `STATIC_EXPORT`, `NEXT_PUBLIC_ACTIVE_MODEL`
- [ ] `.gitignore` confirms `.env` is listed (already is — verify and leave as-is)
- [ ] README setup section references `cp .env.example .env` (edit only the setup section, not the full README)

### Implementation notes

1. Read the current `.gitignore` to verify `.env` is listed — it is, at current line matching `.env`
2. Read `README.md` lines 95-125 for the full list of backend and frontend env vars already documented
3. Read `next.config.ts` to confirm `FASTAPI_ORIGIN` and `STATIC_EXPORT` var names
4. Read `app/services/camera_discovery.py` to confirm `UNIFI_API_KEY` and `CAMERA_DISCOVERY_TARGETS`
5. Create `.env.example` with all backend vars as placeholder strings (never real values)
6. Create `.env.local.example` with all frontend vars
7. Edit README: add `cp .env.example .env` step in the existing setup section (around line 40-60); do not regenerate or rewrite any other section

### Verification

- `git ls-files .env` returns nothing (not tracked — confirm)
- `ls .env.example .env.local.example` lists both files
- All placeholder values are obviously fake (e.g., `your-api-key-here`, `REPLACE_ME`)

---

## Issue #2 — Add `floor` and `zone` fields to `cameras.example.json`

**Labels:** `bug`, `correctness`
**Branch:** `fix/cameras-floor-zone-fields`
**Commit message:** `fix: add floor and zone fields to every camera entry in cameras.example.json`

### Problem

`app/reporter.py` and `app/database.py` read `camera_info["floor"]` and `camera_info["zone"]` for every violation record. The current `cameras.example.json` has no `floor` or `zone` fields on any camera entry. Any operator copying `cameras.example.json → cameras.json` will silently record all violations with `floor=0` and `zone="unknown"`, losing location metadata permanently.

`app/cameras.py:get_camera_statuses()` uses `cam.get("floor", 0)` and `cam.get("zone", "unknown")` (lines 132–138) — the defaults mask the missing fields with no warning.

### Impact

All violations in the SQLite database will have floor=0 and zone="unknown" until the operator manually adds the fields. There is no error; the data is silently wrong.

### Acceptance criteria

- [ ] Every camera entry in `cameras.example.json` has a `"floor"` integer field (example value: `1`)
- [ ] Every camera entry in `cameras.example.json` has a `"zone"` string field (example value: `"REPLACE_ME_ZONE"`)
- [ ] `cameras.example.json` validates as well-formed JSON after the change
- [ ] README or a JSON `"_note"` key explains that `floor` is an integer level and `zone` is a free-form string (e.g. `"entrance"`, `"parking"`, `"lobby"`)

### Implementation notes

1. Read `cameras.example.json` in full (22 camera entries)
2. Add `"floor": 1, "zone": "REPLACE_ME_ZONE"` to each camera entry
3. Add a `"_note"` key at the top level explaining the fields (JSON does not support comments)

### Verification

```
python3 -c "
import json
d = json.load(open('cameras.example.json'))
missing = [c['id'] for c in d['cameras'] if 'floor' not in c or 'zone' not in c]
assert not missing, f'Missing fields in: {missing}'
print('OK')
"
```

---

## Issue #3 — Migrate FastAPI startup event to lifespan context manager

**Labels:** `bug`, `deprecation`
**Branch:** `fix/fastapi-lifespan-migration`
**Commit message:** `fix: replace deprecated on_event startup with lifespan context manager`

### Problem

`app/api.py` at line 350–354 uses the deprecated `@app.on_event("startup")` decorator:

```python
@app.on_event("startup")
async def startup():
    global _violation_queue
    _violation_queue = asyncio.Queue()
    asyncio.create_task(violation_broadcaster())
```

FastAPI has deprecated `@app.on_event` in favour of the `lifespan` context manager. Additionally, `push_violation()` in `main.py` is called from the detection thread before Uvicorn's ASGI startup event fires (`main.py` starts the detection thread at line 75, then starts Uvicorn at line 108). During that window, `_violation_queue` is `None` and `push_violation` silently drops all violations (guarded by the `if _violation_queue is None: return` check at line 342).

### Impact

- Deprecation warning on every server start
- All violations detected in the first seconds (before Uvicorn startup event fires) are silently dropped

### Acceptance criteria

- [ ] `app/api.py` uses `asynccontextmanager`-based `lifespan` function instead of `@app.on_event("startup")`
- [ ] `FastAPI(title="Aegis", lifespan=lifespan)` is the app constructor call
- [ ] `@app.on_event("startup")` function is removed
- [ ] No deprecation warning is emitted on `python3 -W error -c "from app.api import app"`
- [ ] `push_violation` null-guard is preserved

### Implementation notes

```python
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _violation_queue
    _violation_queue = asyncio.Queue()
    asyncio.create_task(violation_broadcaster())
    yield

app = FastAPI(title="Aegis", lifespan=lifespan)
```

Move `app = FastAPI(...)` below the `lifespan` function definition. Keep all `app.include_router`, `app.mount`, and route decorator calls exactly as they are — they just reference the already-created `app` object.

Note: `app.mount(...)` and `app.include_router(...)` must come AFTER `app = FastAPI(...)`. Read the full `app/api.py` to confirm current ordering before editing.

### Verification

- `python3 -W error -c "from app.api import app; print('OK')"` exits 0 without DeprecationWarning
- `grep -n 'on_event' app/api.py` returns nothing

---

## Issue #4 — Wire littering/abandonment pipeline into FastAPI RTSP camera loop

**Labels:** `enhancement`, `back-end`
**Branch:** `feat/wire-littering-into-fastapi`
**Commit message:** `feat: wire abandonment machine into FastAPI camera detection loop`

### Problem

The littering pipeline (`app/detect_frame.py` + `app/association.py` + `app/abandonment.py`) is fully implemented but only runs via `run.py` (CLI mode). `main.py`'s detection loop calls `app/detector.py:detect()` (smoking-only), not `detect_and_track()`. Littering events never reach the WebSocket, the database, or the dashboard when the system runs as a server.

`app/reporter.py:report_littering_event()` (line 116) is already implemented and ready to be called but is never invoked from `main.py` or `app/api.py`.

### Impact

Littering is invisible at runtime. Operators using the dashboard see zero littering events regardless of real-world abandonment activity.

### Acceptance criteria

- [ ] `main.py`'s `detection_loop` integrates `detect_and_track` + `Associator` + `AbandonmentMachine` per camera, alongside the existing smoking detector
- [ ] Per-camera `Associator` and `AbandonmentMachine` instances are created once and maintained across frames (not re-created each iteration)
- [ ] `LitteringEvent`s are passed to `report_littering_event()` → violation dict written to SQLite
- [ ] Littering violations are broadcast via `push_violation()`
- [ ] If `detect_frame.py` weights (`training/checkpoints/yolo11s.pt`) are absent, littering detection is skipped with a log warning — not a crash
- [ ] Existing smoking detection loop is unchanged

### Implementation notes

1. Read `main.py` in full before editing — the detection loop is in `detection_loop(config, streams)`
2. Read `app/reporter.py` in full — specifically `report_littering_event()` signature: `(frame, evt, source_id: str) -> Optional[Dict]`
3. In `detection_loop`, before the loop starts, attempt to import `detect_and_track`, `Associator`, `AbandonmentMachine`; if import fails (FileNotFoundError on weights), log a warning and set a `littering_enabled = False` flag
4. Inside the per-camera loop, if `littering_enabled`:
   - Call `detect_and_track(frame)` to get tracked detections
   - Maintain `associators: Dict[str, Associator]` and `machines: Dict[str, AbandonmentMachine]` keyed by `cam_id`
   - Call `associators[cam_id].update(frame_idx, detections)`
   - Call `events = machines[cam_id].update(time.time(), detections, associators[cam_id].object_states, associators[cam_id].reown_map)`
   - For each event: `v = report_littering_event(frame, evt, cam_id)`; if `v`: `push_violation(v)`
5. Keep a `frame_idx` counter per camera

### Verification

- `python3 -c "from app.detect_frame import detect_and_track; from app.association import Associator; from app.abandonment import AbandonmentMachine; print('imports OK')"` (may raise FileNotFoundError on missing weights — that is expected; the import path itself must resolve)
- `grep -n 'report_littering_event' main.py` returns a match after the change

---

## Issue #5 — Cache YAMNet model locally instead of fetching from TensorFlow Hub on every cold start

**Labels:** `performance`, `reliability`
**Branch:** `perf/yamnet-local-cache`
**Commit message:** `perf: cache YAMNet model locally to avoid TFHub network fetch on cold start`

### Problem

`app/audio_detector.py:_load_yamnet()` at lines 117–123 always calls `hub.load("https://tfhub.dev/google/yamnet/1")`. TensorFlow Hub downloads and unpacks the model on the first call to a temp directory. This cache is not guaranteed to persist across container restarts. The initial download adds 30–60 seconds to the first analysis request and fails entirely in offline environments.

### Impact

- First `/api/analyze` request in any cold environment is very slow (download + unpack)
- Fails completely if the deployment host has no internet access (e.g., air-gapped server)

### Acceptance criteria

- [ ] `_load_yamnet()` reads `TFHUB_CACHE_DIR` env var and passes it to TensorFlow Hub (TF Hub natively respects this variable when set via `os.environ`)
- [ ] A `YAMNET_LOCAL_PATH` env var is checked first; if it points to a valid SavedModel directory, the model is loaded with `tf.saved_model.load()` instead of `hub.load()` — no network call
- [ ] `.gitignore` excludes `models/yamnet_cache/` and `models/yamnet/`
- [ ] `.env.example` (from Issue #1) documents both `TFHUB_CACHE_DIR` and `YAMNET_LOCAL_PATH`
- [ ] Log message on load indicates the source (Hub URL vs. local path) for operator visibility

### Implementation notes

TF Hub respects `TFHUB_CACHE_DIR` natively when set in `os.environ` before the `hub.load()` call. The simplest implementation:

```python
import os, tensorflow as tf

def _load_yamnet():
    global _model, _class_names
    if _model is not None:
        return _model, _class_names

    import tensorflow_hub as hub

    local_path = os.environ.get("YAMNET_LOCAL_PATH")
    if local_path and Path(local_path).is_dir():
        logger.info("Loading YAMNet from local path: %s", local_path)
        _model = tf.saved_model.load(local_path)
    else:
        cache_dir = os.environ.get("TFHUB_CACHE_DIR")
        if cache_dir:
            os.environ["TFHUB_CACHE_DIR"] = cache_dir  # ensure it's set before hub.load
        logger.info("Loading YAMNet from TensorFlow Hub…")
        _model = hub.load("https://tfhub.dev/google/yamnet/1")

    class_map_path = _model.class_map_path().numpy().decode("utf-8")
    _class_names = [line.strip() for line in Path(class_map_path).read_text().splitlines()[1:]]
    logger.info("YAMNet ready (%d classes)", len(_class_names))
    return _model, _class_names
```

Read `app/audio_detector.py` lines 112–124 in full before editing to match the existing style exactly.

### Verification

- `python3 -c "import os; os.environ['TFHUB_CACHE_DIR']='/tmp/yamnet_test'; from app.audio_detector import _load_yamnet"` — check that TF uses the specified cache dir (visible in TF log output)
- If `YAMNET_LOCAL_PATH` is set to a valid dir, `_load_yamnet` must NOT make a network call

---

## Issue #6 — Document that ONNX models are already tracked in git

**Labels:** `documentation`
**Branch:** `docs/onnx-models-setup`
**Commit message:** `docs: clarify that browser ONNX models are committed and require no download step`

### Problem

`PROJECT_STATUS.md` and the original audit listed "ONNX model files missing from the repo" as a critical gap. In reality, `public/models/pretrained.onnx`, `public/models/litter.onnx`, and `public/models/coco.onnx` are all tracked by git (`git ls-files public/models/` confirms this). The README setup section does not explicitly say `git clone` already provides them — it only documents the Python weights download (`scripts/download_pretrained.py`).

### Impact

Developers may assume the browser UI will not work and attempt to find and download model files manually, wasting time on a non-problem.

### Acceptance criteria

- [ ] README setup section explicitly states that the three ONNX models are included in the repo and no separate download is needed
- [ ] `PROJECT_STATUS.md` critical gap #1 (ONNX models missing) is corrected to "resolved — files are tracked in git"
- [ ] (Optional) `scripts/download_pretrained.py` description in README is clarified to be Python-backend-only, not browser models

### Implementation notes

1. Read README lines 80–95 (the setup section near Python weights)
2. Add one sentence after the `download_pretrained.py` line: "Browser ONNX models (`public/models/*.onnx`) are committed to the repository and do not require a separate download."
3. Edit `PROJECT_STATUS.md` section 3 item #1 to reflect the resolved status — change the "critical gap" description

### Verification

- `grep -n "ONNX" README.md` shows the clarifying sentence is present

---

## Issue #7 — Add unit tests for abandonment machine and association logic

**Labels:** `testing`, `quality`
**Branch:** `test/abandonment-association-unit-tests`
**Commit message:** `test: add unit tests for AbandonmentMachine and Associator`

### Problem

`app/abandonment.py` and `app/association.py` are the most complex and correctness-critical modules in the codebase. The ghost-reown logic, hysteresis frames, disappear tolerance, and six-state machine transitions all have edge cases. The existing four test files cover only `CameraDiscoveryService`. None of the core detection pipeline logic has automated tests.

### Impact

Regressions in the abandonment state machine or association logic go undetected. The ghost-reown path (track-ID-change survival) is particularly subtle and is entirely untested.

### Acceptance criteria

- [ ] `tests/test_abandonment.py` covers: IDLE→CARRIED→DROPPED→STATIONARY→OWNER_DEPARTED→ALERTED happy path; re-pickup resets state; brief disappearance does not reset timers; sustained absence resets to IDLE; ghost track reown (reown_map migration)
- [ ] `tests/test_association.py` covers: carry trial (CARRY_FRAMES consecutive overlaps), hysteresis grace period, ghost creation on track disappearance, ghost reown of a new track, debounce of duplicate ghosts
- [ ] All new tests pass with `pytest tests/test_abandonment.py tests/test_association.py -v`
- [ ] No real model weights or video hardware required — all tests use synthetic detection dicts

### Implementation notes

Both modules are pure Python state machines. Tests pass synthetic detection lists:

```python
# Minimal detection dict for abandonment machine
det = {"class": "bottle", "track_id": 1, "bbox": (100, 100, 150, 150), "conf": 0.8}
person = {"class": "person", "track_id": 2, "bbox": (80, 80, 200, 200), "conf": 0.9}
```

Use `time.time()` mocking or pass explicit `now` values to control timer advancement.

Mirror the existing test file style in `tests/test_camera_discovery.py` (read it first).

### Verification

- `pytest tests/test_abandonment.py tests/test_association.py -v` exits 0 with all tests passing

---

## Issue #8 — Add process-level cleanup to RTSP stream proxy

**Labels:** `reliability`, `back-end`
**Branch:** `fix/rtsp-process-pool`
**Commit message:** `fix: add abort-signal cleanup to RTSP stream proxy child processes`

### Problem

`app/api/stream/[cameraId]/route.ts` spawns a Python child process (`python3 rtsp_mjpeg.py`) for each camera stream request. When the client disconnects (browser tab closed, navigation away), the route handler is aborted but the child process is not killed. The process continues consuming CPU and memory until it exits on its own (which may never happen for a live RTSP stream).

There is a `MAX_CONCURRENT_STREAM_OPENS = 4` semaphore for simultaneous connection attempts, but no per-process lifetime management after opening.

### Impact

Under repeated page refreshes or multiple simultaneous clients, orphaned `rtsp_mjpeg.py` processes accumulate. Eventually the system runs out of file descriptors or process slots. The streaming buffer never cleans up.

### Acceptance criteria

- [ ] When the HTTP request is aborted (`req.signal` fires `"abort"`), the child process is sent `SIGTERM`
- [ ] The response `ReadableStream` closes cleanly on child process exit or client disconnect
- [ ] A global `Set<ChildProcess>` registry tracks all active processes so a server shutdown hook can kill them all
- [ ] On process crash (non-zero exit), the response stream closes with an error (not a hanging connection)
- [ ] `MAX_CONCURRENT_STREAM_OPENS` semaphore is preserved

### Implementation notes

1. Read `app/api/stream/[cameraId]/route.ts` in full before editing
2. After `const child = spawn(...)`, add:
   ```typescript
   req.signal.addEventListener("abort", () => {
     child.kill("SIGTERM");
   });
   child.on("exit", () => {
     activeProcesses.delete(child);
   });
   activeProcesses.add(child);
   ```
3. Add `const activeProcesses = new Set<import("child_process").ChildProcess>()` at module scope
4. The `req.signal` approach requires Next.js 13.2+ route handlers — confirm `next` version in `package.json`

### Verification

- Manual: open a camera stream URL in the browser, close the tab, run `ps aux | grep rtsp_mjpeg` after 5 seconds — process should be gone
- Or document in PR that verification requires RTSP hardware and was not tested locally

---

## Issue #9 — Add docker-compose for development setup

**Labels:** `developer-experience`, `infrastructure`
**Branch:** `chore/add-docker-compose`
**Commit message:** `chore: add docker-compose.yml for local development`

### Problem

Setting up the project requires: Python 3.11+, Node.js 20+, `nmap` binary, `ffmpeg`, PyTorch (MPS or CPU), TensorFlow, Ultralytics, and OpenCV. Installing these alongside each other manually is error-prone across platforms. A `Dockerfile` for the Python backend exists but has no companion `docker-compose.yml` to wire the backend and frontend together.

### Impact

New contributors spend significant time on environment setup before writing a single line of code. The existing `Dockerfile` is unused without a compose file.

### Acceptance criteria

- [ ] `docker-compose.yml` at repo root defines: `backend` (Python/FastAPI) and `frontend` (Next.js) services
- [ ] `backend` service uses the existing `Dockerfile`, mounts `cameras.json` and `models/` as volumes, exposes port 8080
- [ ] `frontend` service runs `npm run dev`, mounts the project root, exposes port 3000, sets `FASTAPI_ORIGIN=http://backend:8080`
- [ ] `docker-compose up` starts both services with live-reload
- [ ] `docker-compose.yml` references `.env` for backend secrets (`env_file: .env`)
- [ ] README setup section documents `docker-compose up` as the recommended dev path

### Implementation notes

1. Read the existing `Dockerfile` in full before writing compose
2. Read `render.yaml` for any env var patterns to mirror in compose
3. The backend needs `cameras.json` at runtime — document that it must be created from `cameras.example.json` before running compose

### Verification

- `docker compose config` validates without errors (requires Docker to be installed)
- Or document in PR that validation was performed with `docker compose config --quiet`

---

## Issue #10 — Fix `reporter.py` window accumulation during cooldown

**Labels:** `bug`, `correctness`
**Branch:** `fix/reporter-window-bug`
**Commit message:** `fix: stop accumulating True detections in reporter window during cooldown period`

### Problem

`app/reporter.py:process()` has a subtle state bug. `_windows` is a module-level `defaultdict(lambda: deque(maxlen=5))`. When a violation is on cooldown, the code still calls `window.append(True)` (line 66) before the cooldown check (line 71). This means a camera can accumulate 5 consecutive `True` values through a cooldown period, causing an immediate re-fire the moment the cooldown expires — even if there are no current detections.

### Impact

After a cooldown period, the first frame with any detection immediately fires a violation because the window is already full of stale `True` values. The temporal windowing (designed to require N *consecutive* detections) is bypassed.

### Acceptance criteria

- [ ] `process()` skips `window.append(True)` when on cooldown (or appends `False` to drain stale state)
- [ ] The window is cleared when a violation fires (already done at line 92 with `window.clear()` — preserve this)
- [ ] Existing behaviour (N consecutive detections required outside cooldown) is unchanged

### Implementation notes

Read `app/reporter.py:process()` in full (lines 55–113). The fix is to move the cooldown check before the window append, or append `False` when on cooldown:

```python
if _is_on_cooldown(camera_id, vtype, cooldown_minutes):
    _windows[key].append(False)  # drain stale state through cooldown
    continue
window.append(True)
```

### Verification

- Unit test: confirm that if a camera fires a violation and immediately the next frame also has a detection (but is on cooldown), the window gets `False` not `True`
- `grep -n 'append(True)' app/reporter.py` — the line should be after the cooldown check
