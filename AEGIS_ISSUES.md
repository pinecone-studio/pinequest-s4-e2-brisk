<!-- 17 33 -->

# Proposed GitHub issues — AI pipeline v1

Sized to be workable one at a time with Claude Code, each roughly 30–90 min.
Copy these into GitHub as-is or trim. Suggested labels: `ai-pipeline`,
`client`, `server`, `demo-critical`.

---

**1. Server: D1 schema + migration for `evidence_events`**
Add the D1 table from `AEGIS_AI_PIPELINE_ARCHITECTURE.md` §3, a migration, and a
typed accessor (`insertEvidenceEvent`, `listEvidenceEvents`). No route yet.

**2. Server: R2 bucket + image upload helper**
Add an R2 binding and a small `saveEvidenceImage(cameraId, label, timestamp, bytes)`
helper that returns the `r2Key`. No route yet.

**3. Server: `POST /api/evidence` route**
Wire #1 + #2 behind the JSON + base64 contract in §3. Validate
`Authorization: Bearer <CLIENT_SERVER_SECRET>`. This is the route that's been
missing the whole time — `client/lib/cameraAiUtils.ts` already tries to call it
(today via multipart FormData; sender migration is #7b).

**4. Server: `GET /api/evidence` route (list, for the dashboard)**
Simple paginated list from D1, most recent first, optional `cameraId` filter.

**5. Client: move Gemini analysis from server to client**
Port `server/lib/geminiAnalyze.ts`'s prompt + parsing logic into `client/lib`.
Replace `server/lib/geminiQueue.ts`'s in-memory limiter with something that's safe
on Workers (a simple per-request timeout + retry is enough for v1 — do not carry
over the module-level counters as-is, they won't be consistent across isolates).

Read `client/app/cameras/components/FocusCameraHero.tsx` and
`client/app/cameras/lib/backgroundScanScheduler.ts` first — port/adapt rather than
write from scratch.

**6. Client: `POST /api/analyze` route**
New route accepting the Models→Client contract from §3. Validates
`Authorization: Bearer <MODELS_CLIENT_SECRET>`, calls the ported Gemini logic
from #5, applies `GEMINI_VIOLATION_THRESHOLD` (0.7) from `client/lib/aiConfig.ts`.

Read `FocusCameraHero.tsx` and `backgroundScanScheduler.ts` first — port/adapt
rather than write from scratch.

Leave `/api/gemini/[cameraId]` alone — it stays YOLO-only unless separately asked
to change it. New Gemini analysis belongs here, not on that route.

**7. Client: forward high-confidence detections to Server**
When #6 finds a detection ≥ threshold, POST to Server's `/api/evidence` (§3 JSON
contract), applying the existing `EVIDENCE_COOLDOWN_MS` de-dupe per camera+label.

**7b. Client: migrate `cameraAiUtils.ts` evidence sender to JSON contract**
`client/lib/cameraAiUtils.ts` currently POSTs multipart FormData to `/api/evidence`.
Migrate to the §3 JSON + base64 shape (`cameraId`, `label`, `confidence`,
`occurredAt`, `summary`, `image`). The UI `EvidenceEvent` type (`thumb`,
`savedPath`, `source`, `time`) does not map field-for-field to the persistence
payload (`image`, `r2Key`, `occurredAt`) — add an explicit mapping layer when
building the POST body and when updating the event feed from the Server response,
not just a fetch-call rewrite.

**8. Wrangler config + CF Pages/Workers deploy scaffolding**
`wrangler.jsonc`/`wrangler.toml` for both `client/` (Pages) and `server/`
(Worker), D1 + R2 bindings wired, secrets documented in a new `.env.example`
section for each. Deploy a hello-world version of both to confirm the targets
work before wiring real logic in.

Acceptance criteria must include fixing or replacing
`.github/workflows/deploy-cloudflare.yml`: it currently builds a non-existent path
(`aegis-cctv-front/` — real dir is `client/`), and even with the path fixed its
static export strips all `app/api/**` routes before deploy. Standing up real
Wrangler/Pages Functions deploy must address this — the current workflow cannot
produce a working API deploy no matter what else gets built.

**9. Contract fixtures for testing without the real Models service**
A small script/fixture set that POSTs sample base64 frames to `/api/analyze` so
#6/#7 can be tested end-to-end before `models/server.py` emits real person-crops.

**10. Docs cleanup**
Update `PROJECT_STATUS.md` and `SETUP.md`, which currently describe a different/
stale plan, to reflect this pipeline. Update `client/.env.example`'s "this
project holds no secrets" comment now that `GEMINI_API_KEY` lives here.

---

Not included here (separate track, per your scope): extending `models/server.py` to
crop detected persons and POST to Client `/api/analyze` per §3. Person detection
(`yolov8n.pt` → `{has_person}`) already exists; the gap is emit-the-crop-and-POST,
not detection from scratch. (`models/README.md` still describes an older contract —
ignore for this pipeline.)
