# Aegis — Models → Client → Server AI Pipeline (v1)

_Scope: only the pipeline that takes a person-crop from the Models service, runs it
through Gemini on the Client, and saves high-confidence evidence on the Server.
Person detection already exists in `models/server.py` (see §1); the remaining Models
work is emitting the crop and POSTing it to the Client — not building detection from
scratch._

Repo: `pinecone-studio/pinequest-s4-e2-aegis` (monorepo)
- `client/` = **Client**, deploys to Cloudflare Pages (npm package `aegis-cctv-front`)
- `server/` = **Server**, deploys to Cloudflare (npm package `aegis-cctv-backend`)
- `models/` = **Models**, deploys to Lightning AI (LitServe)

## 1. What's already there (found by reading the repo, not assumed)

- `server/lib/geminiAnalyze.ts` — complete Gemini call: single-frame prompt +
  a temporal multi-frame prompt for "carry → drop → leave" littering, strict JSON
  output (`{summary, detections:[{label, confidence}]}`), retry on 429/503. **Library
  only** — no route calls `analyzeCameraFrames` today; `/api/gemini/[cameraId]` was
  repurposed as a YOLO person gate (see below).
- `server/lib/geminiQueue.ts` — in-memory concurrency limiter + backoff
  (`GEMINI_MAX_CONCURRENT`, `GEMINI_MIN_GAP_MS`). Works fine on a persistent Node
  server; **will not** behave correctly on Workers (no shared in-memory state
  across isolates/PoPs) — don't lift this file as-is, see §5.
- `client/lib/aiConfig.ts` / `aiThresholds.ts` — existing tuning constants,
  reused below instead of inventing new ones:
  - `GEMINI_VIOLATION_THRESHOLD = 0.7` (in `aiConfig.ts`) — counts as a real violation
  - `EVIDENCE_COOLDOWN_MS = 8000` — min gap between evidence saves per violation type
  - `ALERT_THRESHOLD = 0.55`, `SMOKING_THRESHOLD = 0.28` (in `aiThresholds.ts`) — UI-only
    "live" indicators, not persistence thresholds
- `client/lib/evidence.ts` / `server/lib/evidence.ts` — identical
  `EvidenceEvent` interface (kept duplicated on purpose, per the repo's
  no-shared-imports rule). This is the **UI/event-feed** shape (`thumb`, `savedPath`,
  `source`, `time`) — not field-for-field the same as the §3 persistence payload
  (`image`, `r2Key`, `occurredAt`). Migrations must map between them (see issue #7b).
- `POST /api/evidence` is called from `client/lib/cameraAiUtils.ts` but
  **the route doesn't exist anywhere in the repo.** The caller currently sends
  **multipart FormData**; the target contract in §3 is **JSON + base64** — the sender
  gets migrated in issue #7b, not the contract.
- `models/server.py` — LitServe + `yolov8n.pt` person detection. Returns
  `{has_person: bool}` on `POST /predict` with JSON `{image: base64}`. Wired today
  to the Server's `POST /api/gemini/[cameraId]` as a YOLO gate — **not** the target
  Models→Client flow. Person detection exists; what's missing is cropping the person
  and POSTing JPEG(s) to Client's `/api/analyze` (§3). (`models/README.md` still
  describes an older fire_smoke/litter_cig contract — stale; leave that for the
  Models track.)
- Reusable Client patterns already in code (port/adapt for issues #5–#7, don't rewrite
  from scratch):
  - `client/app/cameras/components/FocusCameraHero.tsx` — working Gemini-call +
    evidence-capture flow (orphaned at the route layer, but the logic is there).
  - `client/app/cameras/lib/backgroundScanScheduler.ts` + `postYoloFilter` — YOLO
    person-gate then call a Gemini-shaped route; same shape `/api/analyze` needs,
    pointed at the wrong endpoint today.
- No `wrangler.toml`/`wrangler.jsonc` or any Cloudflare config anywhere yet.

## 2. Flagged, not solved here

`server` shells out to `ffmpeg` via `child_process` for RTSP ingestion and MJPEG
streaming. Cloudflare Workers/Pages Functions run on `workerd`, which cannot spawn
native binaries or long-lived child processes. Whatever ends up doing raw RTSP→frame
capture will very likely need to stay on a real host (a small VM/container, or
possibly folded into the Lightning AI instance) even after the evidence/analysis logic
below moves to Workers. Camera discovery uses Node `net` TCP port-554 probing — not
the `nmap` binary (the `nmap` npm package in `client/package.json` is unused dead
weight and not a Workers blocker). This doesn't block the pipeline in this doc — the
pipeline only cares about receiving already-cropped JPEGs — but it does mean
"Server: Cloudflare" can't mean "100% of `server`, unchanged" without a separate
decision on where ffmpeg lives.

## 3. Contract

### Models — current vs target

**Today:** `models/server.py` detects persons (`yolov8n.pt`) and returns
`{has_person: bool}` to `server/app/api/gemini/[cameraId]/route.ts` (YOLO gate).
No crop is emitted; nothing POSTs to the Client.

**Target (Models → Client):**

```
POST https://<client-domain>/api/analyze
Authorization: Bearer <MODELS_CLIENT_SECRET>
Content-Type: application/json

{
  "cameraId": "cam_010",
  "timestamp": 1751470000000,
  "frames": ["<base64 jpeg>"]        // 1 frame = single-frame check
                                       // 2+ frames, oldest-first = temporal/litter-action check
}
```

`frames` are person-crops (or short bursts of them), not full-frame camera shots.
Closing the gap is "emit the crop and POST it" — person detection is already there.

Response (ack only — the dashboard reads results from the Server, not from this
response):

```json
{ "ok": true }
```

Auth, retries, and rate limits are the Models service's responsibility. No
Cloudflare Queue in v1 — Models calls this endpoint directly and treats a
non-2xx as "drop this frame, try the next one." Revisit if/when a real camera
fleet proves this endpoint can't keep up (Cloudflare Queues does support direct
HTTP publish from a non-Worker service like a Lightning AI Python process, so
that's the natural next step, not a rewrite).

> **Do not repurpose `/api/gemini/[cameraId]`** for the new Gemini call. That route
> stays YOLO-only unless separately asked to change it. New Gemini analysis belongs
> on `POST /api/analyze`.

### Client → Server

Client calls this internally after a Gemini analysis clears the violation
threshold — never called by Models directly.

**Target contract (JSON + base64)** — not multipart FormData:

```
POST https://<server-domain>/api/evidence
Authorization: Bearer <CLIENT_SERVER_SECRET>
Content-Type: application/json

{
  "cameraId": "cam_010",
  "label": "Litter",                 // "Cigarette" | "Vape" | "Litter"
  "confidence": 0.83,
  "occurredAt": 1751470000000,
  "summary": "Person drops a bottle near the entrance.",
  "image": "<base64 jpeg>"
}
```

Response:

```json
{ "id": "evt_...", "r2Key": "evidence/cam_010/1751470000000-litter.jpg", "savedAt": 1751470001200 }
```

The UI `EvidenceEvent` type (`thumb`, `savedPath`, `source`, `time`) does not map
field-for-field to this payload (`image`, `r2Key`, `occurredAt`). Issue #7b covers
migrating `cameraAiUtils.ts` from today's FormData sender and adding the mapping layer
— not just swapping the fetch call.

### D1 schema — `evidence_events`

```sql
CREATE TABLE evidence_events (
  id          TEXT PRIMARY KEY,
  camera_id   TEXT NOT NULL,
  label       TEXT NOT NULL,
  confidence  REAL NOT NULL,
  occurred_at INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  summary     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_evidence_camera_time ON evidence_events (camera_id, occurred_at);
```

Image bytes go to R2 under `r2_key`; only the key is stored in D1.

## 4. Decisions applied (defaults, given "keep the demo simple" priority)

| Question | Decision | Why |
|---|---|---|
| Gemini model | `gemini-2.5-flash` (unchanged) | Google's stated pick for low-latency/high-volume/reasoning; matches existing tuned prompts; not deprecated. Benchmark `gemini-3.1-flash-lite` later once real volume is known — it's now stable and cheaper. |
| Gemini call shape | One multi-label call per crop/burst | Existing prompt already returns Cigarette/Vape/Litter/Person in one response — no reason to split into per-behavior calls. |
| Models→Client transport | Direct HTTPS POST | Cloudflare Queues would work (supports HTTP producers from non-Worker services) but adds a binding, a consumer Worker, and ack/retry logic you don't need to prove the pipeline. Revisit once there's real load. |
| "Encrypted" images | Base64 JPEG over HTTPS (TLS = the encryption) | Matches "pure working demo" instruction; no app-layer crypto in v1. |
| Auth between services | Shared bearer-token secret per hop, env-var based | Simplest thing that isn't wide open; upgrade to signed JWTs/mTLS/Cloudflare Access in the hardening pass. |
| Evidence storage | D1 (metadata row) + R2 (image blob) | Both are trivial Workers bindings; persistence shape in §3; UI `EvidenceEvent` gets a mapping layer (issue #7b). |
| Sub-threshold detections | Discarded, not logged | Matches existing `GEMINI_VIOLATION_THRESHOLD` pattern — nothing in the current code persists sub-threshold detections either. |
| Evidence de-dupe | Reuse `EVIDENCE_COOLDOWN_MS` (8s) per camera+label | Already-proven value, avoids re-deriving one. |
| Evidence POST format | JSON + base64 (§3) | Multipart FormData in today's `cameraAiUtils.ts` is legacy; migrate sender in #7b, don't change the target contract. |

## 5. Env vars to add

**Client (`client/`, Cloudflare Pages secrets):**
- `GEMINI_API_KEY` — moves here from server; client/server split changes,
  see note below
- `GEMINI_MODEL` (default `gemini-2.5-flash`)
- `MODELS_CLIENT_SECRET` — validates inbound calls from Models
- `CLIENT_SERVER_SECRET` — used to call Server
- `SERVER_URL`

**Server (`server/`, Cloudflare Worker secrets/bindings):**
- `CLIENT_SERVER_SECRET` — validates inbound calls from Client
- D1 binding (`evidence_events` table above)
- R2 binding (evidence images)

> Note: `client/.env.example` currently says explicitly "this project holds NO
> secrets — server keys live in aegis-cctv-backend." That statement becomes false
> under this design — the Client now holds `GEMINI_API_KEY`. That's fine
> (Pages Functions env vars are server-side, never shipped to the browser) but
> update that comment so nobody re-reads it and assumes otherwise.

## 6. Open items (not blocking the demo)

- ffmpeg-on-Workers incompatibility (§2) — needs a decision before `server`
  fully moves to Cloudflare.
- `.github/workflows/deploy-cloudflare.yml` — broken build path (`aegis-cctv-front/`
  doesn't exist; real dir is `client/`) and static export strips all `app/api/**`
  routes. Folded into issue #8 — not optional cleanup.
- `PROJECT_STATUS.md` and `SETUP.md` both describe a different/stale plan —
  worth a cleanup pass once this lands so Claude Code (and humans) don't get
  confused reading them.
- Models track (separate from issues #1–#10): extend `models/server.py` to crop
  detected persons and POST to Client `/api/analyze` per §3 — detection exists,
  crop-and-POST does not. (`models/README.md` is stale; ignore it for this pipeline.)
