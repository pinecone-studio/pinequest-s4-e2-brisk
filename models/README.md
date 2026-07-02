# models — CCTV violation gate (LitServe + YOLO)

GPU inference server for the Aegis CCTV pipeline. It is a **cascade** whose only
job is to decide, cheaply, whether a frame is worth sending to Gemini:

```
frame → person? ──no──> stop (no Gemini)
          │yes
          ▼
     smoke OR litter? ──no──> stop (no Gemini)
          │yes
          ▼
     should_analyze = true  → Client calls Gemini (the accurate judge)
```

| Stage | Model | Threshold | Notes |
|-------|-------|-----------|-------|
| person | `yolov8n.pt` (COCO class 0) | 0.75 | stock, auto-downloaded |
| smoke | `kittendev/YOLOv8m-smoke-detection` (`best.pt`) | 0.25 | pulled from HF at startup |
| litter | `turhancan97/yolov8-segment-trash-detection` (`yolov8m-seg.pt`) | 0.25 | pulled from HF at startup |

The smoke/litter thresholds are intentionally **low (high recall)**: this is a
gate, not the final decision. Borderline cases should reach Gemini rather than
be dropped here.

## Run / deploy on Lightning AI

```bash
pip install -r requirements.txt
python server.py                 # local: http://0.0.0.0:8000/predict
# or deploy to Lightning cloud (gives a public URL):
lightning api deploy server.py --name person-detector --non-interactive --cloud
```

Set the resulting URL as `YOLO_API_URL` in the server (`back-end`) env so the
pipeline talks to the deployed model instead of `localhost:8000/predict`.

## Request / response

**Request:** `POST /predict` with JSON `{"image": "<base64-jpeg>"}` (a data-URL
header is stripped automatically).

**Response:**

```json
{
  "has_person": true,
  "has_smoke": false,
  "has_litter": true,
  "litter_boxes": [[0.41, 0.62, 0.55, 0.78]],
  "should_analyze": true
}
```

`should_analyze` = `has_person AND (has_smoke OR has_litter)` — the coarse flag.

`litter_boxes` are normalized `[x1, y1, x2, y2]` boxes. Litter is persistent
(the same trash fires every frame), so the Client registers each box by
location and only escalates **new, unregistered** litter to Gemini; once trash
is removed from the scene its registration is dropped. This is what stops Gemini
from being re-called for trash that's already recorded.

## Test

```bash
python test_client.py sample.jpg
```
