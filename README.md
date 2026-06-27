# Pinequest — Smoking Detection System

AI-powered smoking and litter detection. Uses YOLO11 to detect violations in real-time video streams and in the browser demo.

---

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Create a `.env` file in the project root:
```
ROBOFLOW_API_KEY=your_key_here
```

---

## Train the Model

The dataset is included at `models/smoking-dataset/`. Run training once before using the detector.

**Quick run (~10 min, prototype quality):**
```bash
python3 scripts/train_model.py --epochs 5 --imgsz 416
```

**Full training (~2–3 hrs, production quality):**
```bash
python3 scripts/train_model.py --epochs 30
```

Trained weights are saved to `models/smoking.pt`.

---

## Run Detection on a Video File

```bash
python3 run.py --video input/your_video.mp4 --camera cam_01
```

| Flag | Description |
|---|---|
| `--video` | Path to video file or RTSP URL |
| `--camera` | Camera ID from `cameras.json` (e.g. `cam_01`) |
| `--output` | Output video path (auto-named if omitted) |
| `--no-db` | Skip database writes (useful for quick tests) |

Output:
- Annotated video saved to `output/`
- Violation snapshots saved to `evidence/`
- Summary printed to stdout

---

## Dashboard (No Live Cameras)

```bash
python3 serve.py
# open http://localhost:8080
```

Use `--port 8081` if port 8080 is already in use.

---

## Live Camera Mode

Runs detection continuously against all RTSP streams defined in `cameras.json`:

```bash
python3 main.py
# open http://localhost:8080
```

Edit `cameras.json` to configure camera IPs, floors, and zones.

---

## Configuration (`cameras.json`)

| Key | Default | Description |
|---|---|---|
| `sample_rate` | 15 | Process every Nth frame |
| `confidence_threshold` | 0.75 | Minimum detection confidence |
| `temporal_window` | 5 | Consecutive positive frames before alert fires |
| `cooldown_minutes` | 5 | Minimum gap between alerts per camera |

---

## Project Structure

```
app/
  api.py          — FastAPI routes + WebSocket broadcast
  cameras.py      — RTSP stream management
  database.py     — SQLite violation log
  detector.py     — YOLO11 inference + VideoProcessor
  reporter.py     — Temporal windowing + violation writer (live mode)
  templates/      — Dashboard HTML
  static/         — CSS + JS
scripts/
  train_model.py  — Training script
main.py           — Live camera entrypoint
run.py            — Video file entrypoint
serve.py          — Standalone dashboard server
cameras.json      — Camera config
```
