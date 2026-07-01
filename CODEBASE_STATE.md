# Codebase state — verified audit (2026-07-02)

> **Read this first** if you're a new session. Authoritative design for the pipeline being built lives in [`AEGIS_AI_PIPELINE_ARCHITECTURE.md`](./AEGIS_AI_PIPELINE_ARCHITECTURE.md). Work backlog is [`AEGIS_ISSUES.md`](./AEGIS_ISSUES.md). Active Claude skills: `.claude/skills/aegis-pipeline-conventions/` and `.claude/skills/aegis-issue-workflow/`. Stale skills from prior generations are under `.claude/skills-archive/`.

## Naming map (docs vs disk)

| Concept in architecture docs | Actual directory | npm package name |
|---|---|---|
| Client / front-end | `client/` | `aegis-cctv-front` |
| Server / back-end | `server/` | `aegis-cctv-backend` |
| Models / ml | `models/` | (Python, no package name) |

Root `README.md` and `.github/workflows/deploy-cloudflare.yml` still reference `aegis-cctv-front` as a **directory path** — that folder does not exist; the code is in `client/`.

---

## Architecture generations

### Generation 1 — Python FastAPI + YOLO + ByteTrack (removed)

**Absent from repo (confirmed):** `app/api.py`, `cameras.json` (only gitignored placeholder expected), `app/reporter.py`, `run.py`, `Dockerfile`, `public/models/*.onnx`, `onnxruntime-web` in any `package.json`, `camera-service/`, `server/camera-motion-gemini/`.

**Still present as stale docs:** `PROJECT_STATUS.md` (camera-service rows), `SETUP.md` (8-issue ONNX demo plan), `models/README.md` (fire/smoke + litter/cig contract that code no longer implements).

### Generation 2 — Browser ONNX + Vercel webcam demo (removed)

**Absent:** `onnxruntime-web`, `public/models/`, `lib/modelConfig.ts`, `lib/inference.ts`, Vercel deploy config.

**Still present as stale automation:** `.github/workflows/deploy-cloudflare.yml` builds a **static export** and deploys to Cloudflare Pages project `pinequest` — but points at non-existent `aegis-cctv-front/` path and strips `app/api/**` during build anyway.

### Generation 3 — Current (TypeScript + Gemini, split Next.js apps)

**Present:** `client/` (dashboard UI + thin API proxies), `server/` (RTSP/ffmpeg, camera config, Gemini library code), `models/` (LitServe person-detector stub).

This is what `AEGIS_AI_PIPELINE_ARCHITECTURE.md` describes building toward, but several pieces are only partially wired today (see gaps below).

---

## What each piece does today

### Client (`client/`)

**Working (local dev, Node Next.js server):**
- Camera dashboard at `/` — grid, discovery UI, credentials, events sidebar.
- Thin `app/api/**` proxies via `lib/backendProxy.ts` → `BACKEND_URL` (default `http://localhost:3001`).
- RTSP snapshot polling + background scan (`backgroundScanScheduler.ts`) → YOLO person gate via `postYoloFilter` → `/api/gemini/[cameraId]`.
- Focus-camera live view (`FocusCameraHero.tsx`) attempts Gemini-style violation detection by POSTing `{ images }` to `/api/gemini/[cameraId]` and expecting `{ detections, summary }` back.
- Threshold constants in `lib/aiConfig.ts`: `GEMINI_VIOLATION_THRESHOLD = 0.7`, `EVIDENCE_COOLDOWN_MS = 8000`. UI-only thresholds in `lib/aiThresholds.ts`: `ALERT_THRESHOLD`, `SMOKING_THRESHOLD`.
- Evidence capture helper (`lib/cameraAiUtils.ts`) POSTs **multipart FormData** to `/api/evidence` (not JSON).

**Not working / missing:**
- No `app/api/analyze` route (planned Models→Client entry point).
- No `app/api/evidence` route (client proxies would forward to server, but server route also missing).
- `server/lib/geminiAnalyze.ts` is **not called from any route** — focus-camera Gemini path is broken at HTTP layer (see Server).
- Static export (`npm run build:static`) **removes** `app/api/**` before build (`scripts/build-static.mjs`) — no API routes in Cloudflare Pages deploy.
- `nmap` npm package is in `package.json` but **never imported** in source; discovery uses server-side TCP port probing, not the nmap binary.

### Server (`server/`)

**Working (local dev, Node Next.js on :3001):**
- Camera config from `cameras.json` (gitignored; operator must create).
- RTSP → MJPEG streaming via ffmpeg child processes (`lib/ffmpegStream.ts`, `app/api/stream/*`).
- RTSP snapshot pool (`app/services/rtspSnapshotPool.ts`).
- Camera discovery via TCP connect to port 554 (`app/services/cameraDiscovery.ts`) — not nmap binary.
- UniFi Protect integration (optional env vars).
- `lib/geminiAnalyze.ts` — complete Gemini prompt + JSON parse + 429/503 retry logic.
- `lib/geminiQueue.ts` — in-memory concurrency limiter (`GEMINI_MAX_CONCURRENT`, `GEMINI_MIN_GAP_MS`).
- `POST /api/gemini/[cameraId]` — **YOLO person filter only** (`has_person` boolean); does **not** call `analyzeCameraFrames`.
- `GET /api/gemini` — health check reporting `mode: "yolo"`.

**Not working / missing:**
- No `app/api/evidence` route (listed in `server/README.md` but file does not exist).
- No `GET /api/evidence` route.
- No D1, R2, or Wrangler bindings.
- `analyzeCameraFrames` is dead code (defined, zero call sites).
- ffmpeg/nmap child-process patterns incompatible with Cloudflare Workers as-is.

### Models (`models/`)

**On disk:**
- `server.py` — LitServe + **YOLOv8n person detector** (`yolov8n.pt`), returns `{ has_person: bool }` on `POST /predict` with JSON `{ image: base64 }`.
- `README.md` — describes a **different** API (fire_smoke.pt + litter_cig.pt, categorized detections). **README is stale; code does not match.**
- `test_client.py`, `verify_gpu.py`, `requirements.txt`.

**Not present:** `weights/fire_smoke.pt`, `weights/litter_cig.pt`, person-crop POST to Client `/api/analyze`.

---

## Env vars: code vs `.env.example`

### Client (`client/.env.example`, `client/.env.local.example`)

| Variable | In code | In .env.example |
|---|---|---|
| `BACKEND_URL` | yes | yes |
| `CAMERA_SERVICE_ORIGIN` | yes (`cameraApi.ts`) | yes |
| `NEXT_PUBLIC_CAMERA_SERVICE_HTTP` | yes | yes |
| `NEXT_PUBLIC_CAMERA_SERVICE_WS` | yes | yes |
| `NEXT_PUBLIC_DEMO_REALTIME` | yes (`demoConfig.ts`) | commented |
| `STATIC_EXPORT` | yes (`next.config.ts`) | commented in `.env.local.example` only |

**Not in client code yet (planned in architecture doc):** `GEMINI_API_KEY`, `GEMINI_MODEL`, `MODELS_CLIENT_SECRET`, `CLIENT_SERVER_SECRET`, `SERVER_URL`.

`.env.example` still says "this project holds NO secrets" — false under target architecture (Gemini key moves to Client Pages Functions).

### Server (`server/.env.example`)

| Variable | In code | In .env.example |
|---|---|---|
| `GEMINI_API_KEY` | yes | yes |
| `GOOGLE_API_KEY` | yes (fallback) | commented |
| `GEMINI_MODEL` | yes | commented |
| `GEMINI_MAX_CONCURRENT` | yes (`geminiQueue.ts`) | **no** |
| `GEMINI_MIN_GAP_MS` | yes (`geminiQueue.ts`) | **no** |
| `YOLO_API_URL` | yes | commented |
| `FFMPEG_PATH` | yes | commented |
| `CAMERA_DISCOVERY_TARGETS` | yes | commented |
| `RTSP_PASSWORDS` | yes | commented |
| `RTSP_PATHS` | yes | commented |
| `UNIFI_API_KEY` | yes | commented |
| `UNIFI_PROTECT_HOST` | yes | commented |
| `UNIFI_PROTECT_VERIFY_TLS` | yes | commented |
| `UNIFI_RTSP_CACHE_TTL_SECONDS` | yes | commented |

**Not in server code yet (planned):** `CLIENT_SERVER_SECRET`, D1/R2 bindings.

---

## Routes audit

| Route | Client proxy | Server handler | Status |
|---|---|---|---|
| `POST /api/evidence` | would proxy | **missing** | Called from `cameraAiUtils.ts`; 404 in dev |
| `GET /api/evidence` | — | **missing** | Planned for dashboard |
| `POST /api/analyze` | **missing** | — | Planned Models→Client contract |
| `POST /api/gemini/[cameraId]` | proxies | YOLO filter only | Mismatch: UI expects Gemini `detections` |
| `GET /api/gemini` | proxies | YOLO health | `aiReady` gate works |
| `GET /api/cameras`, stream, snapshot, discover | proxies | implemented | RTSP/ffmpeg dependent |

---

## Deploy / infra

| Item | State |
|---|---|
| `wrangler.toml` / `wrangler.jsonc` | **None anywhere** |
| `.github/workflows/deploy-cloudflare.yml` | Broken path (`aegis-cctv-front/`), static export without API routes |
| `.github/workflows/deploy.yaml` | Minimal wrangler-action stub (no project wiring) |
| Cloudflare Pages target name in workflow | `pinequest` (architecture doc says `aegis-cctv-front`) |
| D1 / R2 | Not provisioned in repo |

---

## Gaps between docs and code

| Doc claim | Reality |
|---|---|
| Directories `front-end/`, `back-end/`, `ml/` | Actually `client/`, `server/`, `models/` |
| `geminiAnalyze.ts` is working end-to-end | Library exists; **no route calls it**; `/api/gemini/[cameraId]` is YOLO-only |
| `ml/server.py` uses fire_smoke + litter_cig | Code uses `yolov8n.pt` person gate; `models/README.md` is stale |
| Server shells out to `nmap` | Discovery uses Node `net` TCP probes; `nmap` npm dep unused |
| `POST /api/evidence` missing | **Confirmed** missing on both client and server |
| No wrangler config | **Confirmed** |
| `EvidenceEvent` matches future D1 row | UI type (`thumb`, `savedPath`, `source`) differs from architecture §3 JSON (`image`, `occurredAt`, `r2Key`) — migration will need mapping |
| Current evidence POST is JSON per architecture | Client sends **multipart FormData** today |
| `GEMINI_VIOLATION_THRESHOLD` in `aiThresholds.ts` | Actually in `aiConfig.ts` (`aiThresholds.ts` has UI thresholds only) |
| `PROJECT_STATUS.md` camera-service / motion-gemini | Services removed; doc stale (pointer added at top) |
| `SETUP.md` | Entirely Generation-2 demo-build issue list; unrelated to current pipeline |
| `server/README.md` lists `POST /api/evidence` | Route does not exist |

---

## Ambiguous files — which generation?

| File | Generation |
|---|---|
| `AEGIS_AI_PIPELINE_ARCHITECTURE.md`, `AEGIS_ISSUES.md` | **Gen 3 target** (authoritative forward) |
| `CODEBASE_STATE.md` (this file) | **Gen 3 audit** |
| `client/`, `server/`, `models/server.py` | **Gen 3 current code** |
| `PROJECT_STATUS.md` | Gen 3 intent, Gen 1 references mixed in |
| `README.md` | Gen 3 split, wrong directory names |
| `SETUP.md` | Gen 2 |
| `models/README.md` | Gen 3 intent (old YOLO contract), code diverged |
| `docs/remote-camera-setup.md` | Gen 3 (RTSP config still relevant) |
| `.claude/skills-archive/*` | Gen 1–2 (archived) |
| `.github/workflows/deploy-cloudflare.yml` | Gen 2 static ONNX demo |

---

## Active skills (post-archive)

| Skill | Purpose |
|---|---|
| `aegis-pipeline-conventions` | Current pipeline conventions |
| `aegis-issue-workflow` | Issue → branch → PR loop for `AEGIS_ISSUES.md` |
