# models — Person detector + Client handoff (LitServe + YOLOv8n)

This service detects people using `yolov8n.pt` and can auto-forward person crops to
the Client `POST /api/analyze` route for Gemini analysis.

## What it does

- Runs YOLOv8 person detection (`class 0`)
- Crops detected people above threshold
- Encodes crops as base64 JPEG frames
- Optionally forwards frames to Client `/api/analyze` using bearer auth
- Still returns a local `has_person` response for compatibility

## Run

```bash
cd models
pip install -r requirements.txt
python verify_gpu.py
python server.py
```

Server runs at `http://0.0.0.0:8000/predict`.

## Environment

Required for forwarding:

- `CLIENT_ANALYZE_URL` (example: `http://localhost:3000/api/analyze`)
- `MODELS_CLIENT_SECRET` (must match client secret)

Optional tuning:

- `PERSON_CONF_THRESHOLD` (default `0.75`)
- `MAX_PERSON_CROPS` (default `4`)
- `CROP_JPEG_QUALITY` (default `85`)
- `CLIENT_FORWARD_TIMEOUT_S` (default `8`)
- `CLIENT_FORWARD_RETRIES` (default `2`)
- `CLIENT_FORWARD_RETRY_DELAY_S` (default `0.5`)

If `CLIENT_ANALYZE_URL` is unset, detection still works but forwarding is skipped.

## Request contract (to models)

`POST /predict` JSON:

```json
{
  "image": "<base64-jpeg-or-data-url>",
  "cameraId": "cam_010",
  "timestamp": 1751470000000
}
```

- `cameraId` and `timestamp` are optional.
- If omitted: `cameraId = "unknown-camera"`, `timestamp = now`.
- Raw JPEG bytes are also accepted for local compatibility (`test_client.py` path).

## Forwarded contract (models -> client)

`POST <CLIENT_ANALYZE_URL>` with:

- Header: `Authorization: Bearer <MODELS_CLIENT_SECRET>`
- JSON body:

```json
{
  "cameraId": "cam_010",
  "timestamp": 1751470000000,
  "frames": ["<base64 jpeg>", "<base64 jpeg>"]
}
```

## Response contract (from models)

```json
{
  "has_person": true,
  "cameraId": "cam_010",
  "timestamp": 1751470000000,
  "person_count": 2,
  "forward": {
    "attempted": true,
    "ok": true,
    "status": 200,
    "attempt": 1
  }
}
```

When forwarding is disabled or fails, `forward` includes reason/error details.
