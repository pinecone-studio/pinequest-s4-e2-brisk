---
name: aegis-littering-pipeline
description: >
  Use this skill for ANY work on the Aegis AI (a.k.a. pinequest / GuardAI) littering-detection
  repo — a dual-stack project (Python Ultralytics/FastAPI backend + Next.js/ONNX browser demo)
  where littering must be detected as an ACTION over time (person carries object → drops it →
  walks away), not as single-frame "is there trash" classification. Trigger this whenever the
  task involves the detection pipeline: the COCO detector, ByteTrack tracking, person-object
  association, the abandonment state machine, alert/evidence wiring, webcam (--source 0) or RTSP
  input, or any file like detect_frame.py, association.py, abandonment.py, run.py, detector.py.
  Use it even when the user just says "next step", "implement the tracker", "do the association",
  "continue the pipeline", or pastes a Claude Code result and says "done". It enforces the
  one-step-at-a-time, verify-the-gate-before-continuing workflow this project requires.
---

# Aegis AI — Littering Pipeline Workflow

## The one idea that governs everything

Littering is **carry → drop → leave** over time. It is NOT "a bottle is visible in this frame."
Any code that fires an alert from a single frame's object confidence is the WRONG approach and a
rewrite candidate. The real signal is: a person was carrying an object, the object separated from
them, became stationary, and the owner left it behind for several seconds.

The pipeline is a chain of mostly-existing pieces glued by logic:

```
input (webcam 0 / file / RTSP)
  → detect_frame / detect_and_track   (COCO weights: person + carriables; ByteTrack IDs)
  → association                        (which person owns which object, over time)
  → abandonment state machine          (CARRIED→DROPPED→STATIONARY→OWNER_DEPARTED→ALERT)
  → alert                              (snapshot + clip + SQLite row, reuse reporter.py)
```

Detection and tracking come from pretrained Ultralytics weights already in the repo. The accuracy
comes from the **logic layer** (association + abandonment timers), not from training a model.

## Non-negotiable scope rules

These protect the parts of the repo that already work. Violating them is the most common way to
break this project.

1. **Never touch the smoking pipeline** (`app/detector.py`, `models/smoking.pt`, the
   `--video/--camera` path in `run.py`). It works; leave it byte-for-byte unchanged.
2. **Never touch the Next.js / browser stack** (`lib/*.ts`, `app/page.tsx`, `components/*`,
   `public/models/*.onnx`) when building the Python pipeline. The browser litter path is
   single-frame and is being superseded, not extended.
3. **Don't add heavy dependencies silently.** ByteTrack ships with Ultralytics
   (`tracker="bytetrack.yaml"`, needs `lap` which auto-installs). If a step seems to need
   DeepSORT/Norfair/supervision/TensorFlow, STOP and ask first.
4. **Build on the existing abstractions**: `cv2.VideoCapture(source)` in `VideoProcessor` already
   accepts `"0"`, a file path, or an RTSP URL — reuse it, don't reinvent capture. Reuse
   `reporter.py` cooldown and the SQLite/evidence convention for alerts.
5. **One issue/step at a time.** Implement exactly one stage, then stop. Do NOT start the next
   stage in the same run.

## The detection contract

`detect_frame(frame)` returns a list of dicts: `{class, bbox:(x1,y1,x2,y2), conf}`.
`detect_and_track(frame)` returns the same dicts plus a stable `track_id` (int; may be `None` on
first appearance — handle without crashing). Class filter throughout:
`person, bottle, cup, backpack, handbag, suitcase`. Every later stage consumes this list — keep
the contract stable so stages plug in at the list boundary.

## Workflow: how to run each step

For every step, follow this loop exactly:

1. **State the scope** in one or two sentences: which files you'll create/edit and why. Name the
   one stage you're implementing.
2. **Implement minimally.** New logic goes in its own module (`app/association.py`,
   `app/abandonment.py`). Wire visualization into the `run.py --source` loop only.
3. **Give the test command and the GATE** — the specific thing the user must see on webcam before
   moving on (see Gates below).
4. **STOP.** Do not implement the next stage. Wait for the user to run it and report the result.

If the user pastes a Claude Code result and says "done", verify it meets the gate before treating
the stage as complete. If a gate isn't met, fix that stage — do not proceed.

## The stages and their gates

Implement in this order. Each gate is what the user must see with their own eyes on
`venv/bin/python run.py --source 0` (press `q` **in the window**, not the terminal).

| Stage                | Module                                        | GATE (must pass before next stage)                                                                                                                  |
| -------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Webcam + detector | `detect_frame.py`, `run.py`                   | Window opens, boxes on person + held bottle/bag, FPS printed.                                                                                       |
| 2. Tracker           | extend `detect_frame.py` (`detect_and_track`) | Move a bottle slowly across frame — its ID number stays the SAME; two objects keep DIFFERENT stable IDs.                                            |
| 3. Association       | `association.py`                              | Holding a bottle draws a line to your person box; setting it down + stepping away registers separation (ownership persists briefly via hysteresis). |
| 4. Abandonment       | `abandonment.py`                              | Drop + walk away → LITTERING fires after timers. Drop + pick up quickly → NO alert. Pre-existing object with no person → NO alert.                  |
| 5. Alerts            | reuse `reporter.py` + SQLite                  | One event → one snapshot + short clip + one SQLite row (`type="littering"`), fires once (cooldown).                                                 |
| 6. RTSP (later)      | fix `cameras.py` schema                       | Same pipeline runs on an RTSP URL; `cameras.py` reads `rtsp_url`/`host`, not `ip`.                                                                  |

## Known repo gotchas (save time)

- **macOS webcam window closes instantly**: Cocoa flushes a phantom keycode on the first
  `cv2.waitKey`. Guard the quit-check to skip frame 1 (`if frame_count > 1 and key == ord('q')`).
- **macOS camera permission**: terminal/IDE needs Camera access in System Settings → Privacy;
  restart the app after granting. The real webcam may be index 1 if a depth-sensor SDK grabs 0.
- **`cam_01` doesn't exist** — real IDs look like `cam_010`. Check `cameras.json` before using one.
- **`cameras.py` schema bug**: expects `ip` + `rtsp_template`; config has `rtsp_url`/`host`.
  This is why the Python _live_ (`main.py`) path is broken — only fix it when you reach Stage 6.
- **Repo moved** on GitHub (`...-brisk` → `...-aegis`); update the remote URL if you see
  "repository moved".
- **Solo dev**: no PR reviewer. Working straight on one branch and committing is fine; gates
  replace code review.

## What NOT to do

- Don't train a model to "improve littering accuracy" — training improves _object visibility_
  (e.g. tiny litter the COCO weights miss), never the abandonment decision. Note it as future
  work; don't do it mid-pipeline.
- Don't put abandonment/temporal logic in the browser ONNX loop — wrong layer.
- Don't fix orphaned code (security/audio/fusion clip path, legacy FastAPI dashboard) while
  building the pipeline — gate it off if it interferes, otherwise ignore it.
- Don't skip a gate to "save time." An unverified stage poisons every stage built on top of it.
