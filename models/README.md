# ml — CCTV analytics API (LitServe + YOLO)

GPU-accelerated inference server for the Aegis CCTV system. Loads two YOLO models
and returns categorized detections for each incoming JPEG frame:

| Model              | Group      | Detects            |
|--------------------|------------|--------------------|
| `weights/fire_smoke.pt` | `safety`   | fire / smoke       |
| `weights/litter_cig.pt` | `behavior` | litter / cigarettes |

> Model filenames are placeholders — swap in the correct weights under `weights/`.

## Layout

```
ml/
├── weights/           # YOLO weights (.pt) — gitignored
│   ├── fire_smoke.pt
│   └── litter_cig.pt
├── server.py          # LitServe inference server
├── verify_gpu.py      # CUDA visibility check
├── test_client.py     # sends a JPEG to the running server
└── requirements.txt
```

## Run in the Lightning AI T4 Studio

```bash
cd ml

# 1. Install deps (torch/CUDA is preinstalled in the Studio image)
pip install -r requirements.txt

# 2. Confirm the T4 is visible to PyTorch/Ultralytics
python verify_gpu.py

# 3. Put the weights in place
#    weights/fire_smoke.pt  and  weights/litter_cig.pt

# 4. Start the server (http://0.0.0.0:8000/predict)
python server.py
```

## Test

```bash
python test_client.py sample.jpg
```

## Request / response

**Request:** `POST /predict` with raw JPEG bytes as the body, or JSON
`{"image": "<base64-jpeg>"}`.

**Response:**

```json
{
  "detections": [
    {
      "model": "fire_smoke",
      "group": "safety",
      "class_name": "smoke",
      "class_id": 1,
      "confidence": 0.87,
      "bbox": { "x1": 12.0, "y1": 40.5, "x2": 220.1, "y2": 300.7 }
    }
  ],
  "count": 1,
  "groups": { "safety": 1, "behavior": 0 }
}
```
