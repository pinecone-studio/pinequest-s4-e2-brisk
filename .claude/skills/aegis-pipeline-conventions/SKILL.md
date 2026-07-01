---
name: aegis-pipeline-conventions
description: >
  Background knowledge for the CURRENT Aegis AI pipeline — the Models (Lightning
  AI) → Client (front-end, Cloudflare Pages) → Server (back-end, Cloudflare
  Workers) split that detects smoking/vaping/littering via the Gemini API.
  Load this whenever touching front-end/app/api/analyze, front-end/lib/ai*,
  back-end/app/api/evidence, back-end/lib/geminiAnalyze.ts, or anything
  described in AEGIS_AI_PIPELINE_ARCHITECTURE.md / AEGIS_ISSUES.md at repo
  root. Also load this if you're about to reach for guidance in
  .claude/skills-archive/ — those are stale, this is current.
user-invocable: false
---

# Aegis AI Pipeline — Current Conventions

This repo has been through three architecture generations. If you find
yourself looking at Python FastAPI (`app/api.py`, `cameras.json`, SQLite),
ByteTrack, YAMNet, or browser ONNX (`public/models/*.onnx`, Vercel deploy) —
stop. That's a prior generation, archived under `.claude/skills-archive/` and
partly still referenced in `PROJECT_STATUS.md`. It is not what's being built.
Current generation: TypeScript, Gemini API, three separately-deployed pieces.

`AEGIS_AI_PIPELINE_ARCHITECTURE.md` at repo root is the authoritative design
doc. `AEGIS_ISSUES.md` is the current issue breakdown. Read both before
implementing anything this skill covers. This file is a quick-reference, not a
replacement for either.

## The three pieces

- **Models** (`ml/`) — Lightning AI, LitServe. Currently runs YOLO fire/smoke +
  litter/cigarette classification directly; being replaced with person-crop
  detection that POSTs to the Client. Out of scope for front-end/back-end work.
- **Client** (`front-end/`) — Cloudflare Pages. Receives person-crops from
  Models at `POST /api/analyze`, calls Gemini directly, forwards high-confidence
  results to the Server.
- **Server** (`back-end/`) — Cloudflare Workers. Owns `POST /api/evidence` and
  `GET /api/evidence`, backed by D1 (metadata) + R2 (image blobs).

## Conventions to reuse, not reinvent

- **Confidence thresholds** live in `front-end/lib/aiThresholds.ts` and
  `aiConfig.ts` — `GEMINI_VIOLATION_THRESHOLD` (0.7) gates what counts as
  evidence, `EVIDENCE_COOLDOWN_MS` (8000) de-dupes repeat saves per
  camera+label. Don't invent new threshold constants; extend these files.
- **`EvidenceEvent` shape** is defined in `front-end/lib/evidence.ts` and
  `back-end/lib/evidence.ts` (intentionally duplicated — see next point).
  New evidence-related types should match this shape, not a new one.
- **No shared imports between `front-end` and `back-end`.** This is a
  deliberate repo convention (see `README.md`, "How the split works") — small
  shared types get duplicated in both projects rather than pulled into a
  shared package. Follow it even though it looks redundant.
- **Gemini prompt design** — `back-end/lib/geminiAnalyze.ts` has a working
  single-frame prompt and a temporal multi-frame prompt (littering is judged
  as carry→drop→leave, not single-frame classification). When this logic moves
  to the Client (issue #5 in `AEGIS_ISSUES.md`), port the prompts as-is; don't
  redesign them without a specific reason.
- **Auth between services** — a shared bearer-token secret per hop
  (`MODELS_CLIENT_SECRET`, `CLIENT_SERVER_SECRET`), env-var based. This is
  intentionally minimal for the v1 demo — don't add JWT/mTLS/OAuth unless
  explicitly asked; that's a later hardening pass.

## One trap to avoid

`back-end/lib/geminiQueue.ts`'s concurrency limiter uses module-level `let`
counters (`activeCalls`, `waiters`, etc.). This only works correctly on a
single persistent Node process. Cloudflare Workers run many isolates with no
shared memory between them — porting this file as-is to the Client silently
stops enforcing the concurrency limit it looks like it enforces. Use a
per-request timeout + simple retry instead for v1; flag it rather than
building a Durable-Object-based replacement unless asked.

## Known gap, not yet solved

`back-end`'s RTSP ingestion uses `ffmpeg` (child_process) and `nmap` — neither
runs on Cloudflare Workers (no native binaries in `workerd`). This doesn't
block the `/api/analyze` → `/api/evidence` pipeline itself, but don't assume
all of `back-end` moves to Workers unchanged. If asked to deploy the camera
ingestion pieces, flag this rather than attempting it silently.
