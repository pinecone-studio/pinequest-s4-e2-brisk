"""
Train YOLO11n on the Roboflow smoking dataset and save weights to models/smoking.pt.
Run from repo root: python3 scripts/train_model.py [--epochs N] [--imgsz N]

Quick prototype run (5-10 min on M2):  python3 scripts/train_model.py --epochs 5 --imgsz 416
Full training (~2-3 hrs on M2):        python3 scripts/train_model.py --epochs 30
"""

import argparse
import os
import shutil
import sys
from pathlib import Path

import torch
import yaml
from dotenv import load_dotenv
from roboflow import Roboflow
from ultralytics import YOLO

load_dotenv()

DATASET_DIR = Path("models/smoking-dataset")
OUTPUT_WEIGHTS = Path("models/smoking.pt")
DATA_YAML = DATASET_DIR / "data.yaml"


def _fix_data_yaml(yaml_path: Path) -> Path:
    """Rewrite relative paths in data.yaml to absolute paths."""
    with open(yaml_path) as f:
        cfg = yaml.safe_load(f)

    base = yaml_path.parent.resolve()  # absolute path to models/smoking-dataset/
    cfg["train"] = str(base / "train" / "images")
    cfg["val"] = str(base / "valid" / "images")
    cfg["test"] = str(base / "test" / "images")

    fixed = yaml_path.parent / "data_abs.yaml"
    with open(fixed, "w") as f:
        yaml.dump(cfg, f, default_flow_style=False)
    return fixed.resolve()


def download_dataset():
    api_key = os.getenv("ROBOFLOW_API_KEY")
    if not api_key:
        sys.exit("ROBOFLOW_API_KEY not set in .env")

    if DATASET_DIR.exists():
        print(f"Dataset already at {DATASET_DIR}, skipping download.")
        return

    print("Downloading smoking dataset from Roboflow…")
    rf = Roboflow(api_key=api_key)
    version = rf.workspace("timmy-ji8jf").project("smoking-bjzv1").version(4)
    version.download("yolov8", location=str(DATASET_DIR))
    print("Download complete.")


def _pick_device() -> str:
    if torch.cuda.is_available():
        return "0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def train(epochs: int, imgsz: int, batch: int):
    device = _pick_device()
    print(f"Training on device: {device}  epochs={epochs}  imgsz={imgsz}")

    data_yaml = _fix_data_yaml(DATA_YAML)

    model = YOLO("yolo11n.pt")
    results = model.train(
        data=str(data_yaml),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        device=device,
        project="models/runs",
        name="smoking",
        exist_ok=True,
        verbose=False,
    )

    best = Path(results.save_dir) / "weights" / "best.pt"
    shutil.copy(best, OUTPUT_WEIGHTS)
    print(f"\nWeights saved to {OUTPUT_WEIGHTS}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    args = parser.parse_args()

    download_dataset()
    train(args.epochs, args.imgsz, args.batch)
