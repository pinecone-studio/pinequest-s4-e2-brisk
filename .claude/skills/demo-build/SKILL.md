---
name: demo-build
description: Use whenever the user is working toward the Friday demo build — webcam-driven live detection web app (smoking + littering) deployed to a URL. Covers the Next.js demo page, in-browser ONNX inference, UI requirements, model toggling, deployment, and demo-day safety. Trigger on phrases like "demo page", "demo build", "live detection page", "deploy the demo", "switch the model", or any work touching the main `/` route of the Next.js app.
---

# Demo Build — Friday Live Detection Demo

## Goal
A clean Next.js page judges open via URL, grant webcam access, and immediately see live detections of **smoking** and **littering** with bounding boxes and confidence scores.

## Non-negotiable constraints
- **Inference runs in the browser** via ONNX Runtime Web. No server inference. No backend GPU. The page is fully static.
- **Two models must be swappable via config**, not code. See "Model toggle" below.
- **The existing multi-camera page is preserved** at a secondary route (e.g. `/cameras`). The new demo page becomes the main route `/`.
- **A backup video of the working demo must exist** before demo day ends.

## Architecture
- **Framework**: Next.js (App Router) — already in use.
- **Inference**: `onnxruntime-web` (WASM backend; WebGL backend optional but WASM is more reliable across machines).
- **Models**: YOLOv8 exported to ONNX. Two files in `public/models/`:
  - `public/models/pretrained.onnx` — Roboflow's pretrained smoking/littering weights, converted to ONNX.
  - `public/models/finetuned.onnx` — overnight fine-tuned version (may or may not exist on demo day; see `fine-tuning` skill).
- **Config**: a single env var or constant decides which file loads.

## Model toggle (the important part)
Create `lib/modelConfig.ts`:
```ts
export const ACTIVE_MODEL =
  (process.env.NEXT_PUBLIC_ACTIVE_MODEL as "pretrained" | "finetuned") ?? "pretrained";

export const MODEL_PATH = `/models/${ACTIVE_MODEL}.onnx`;
```
Switching models is a one-line env change + redeploy. **No component code changes ever.**

Default is `pretrained`. Only switch to `finetuned` after side-by-side testing confirms it's better. See "Demo-day safety" below.

## UI requirements
- **Layout**: single full-bleed webcam view, bounding boxes overlaid on a `<canvas>`.
- **Side panel** (or bottom bar on mobile): live list of current detections — label, confidence %, color-coded.
- **Color coding**: smoking = red, littering = orange. Confidence below threshold = grey/dimmed.
- **Aesthetic**: dark background, single accent color, generous spacing, one clean sans-serif (Inter or system stack). Judges read polish as competence — do not skip this.
- **No emojis, no clutter, no marketing copy.** This is a tool, not a landing page.
- **Header**: project name + small "view all cameras" link routing to `/cameras`.

## Confidence thresholds
- Default display threshold: **0.5**. Detections below this are not drawn.
- Default alert threshold (panel highlight): **0.7**.
- Expose both as constants in `lib/modelConfig.ts` so they're easy to tune mid-demo.

## File layout
```
app/
  page.tsx              ← NEW demo page (main route)
  cameras/page.tsx      ← MOVED from old main page
  layout.tsx
components/
  WebcamCanvas.tsx      ← webcam + canvas overlay
  DetectionPanel.tsx    ← live list of detections
  ModelStatusBadge.tsx  ← tiny indicator showing which model is active
lib/
  modelConfig.ts        ← model path + thresholds
  inference.ts          ← ONNX session, preprocess, postprocess (NMS)
  yoloDecode.ts         ← raw YOLOv8 output → bounding boxes
public/
  models/
    pretrained.onnx
    finetuned.onnx      ← only present if fine-tuning succeeded
```

## Inference loop (high level)
1. Grab webcam frame via `getUserMedia` → draw to hidden canvas → extract tensor.
2. Run ONNX session inference (~30–80ms on a modern laptop with WASM).
3. Decode YOLOv8 output → apply NMS → array of `{label, confidence, box}`.
4. Draw boxes on overlay canvas, update detection panel state.
5. `requestAnimationFrame` loop, but throttle inference to ~10 fps (don't run on every frame — wastes CPU).

## Deployment
- **Vercel.** Free, native Next.js support, deploy on push to `main`.
- Set `NEXT_PUBLIC_ACTIVE_MODEL=pretrained` in Vercel project env vars.
- HTTPS is required for `getUserMedia` — Vercel handles this automatically.

## Demo-day safety
- **Never deploy an untested model to the live URL.** Test `finetuned.onnx` on a `/test` route or local dev first.
- **Backup video**: record a screen capture of the working demo with both detections firing cleanly. If wifi dies tomorrow, play the video.
- **Practice the script**: where you stand, what prop you use for "smoking" (a pen works), where you drop the "litter."
- **Tune thresholds before demo, not during.** A false positive on a coffee cup is more embarrassing than a missed detection.

## Priority order if time runs out
1. Smoking detection working on webcam.
2. Deployed URL that loads on any laptop.
3. Backup video recorded.
4. Littering detection.
5. UI polish.

Drop from the bottom, never the top.
