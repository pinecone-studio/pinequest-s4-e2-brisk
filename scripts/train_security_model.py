"""
Train YOLO11 for violence / vandalism detection.

Downloads a Roboflow dataset (configure via .env) and saves weights to models/security.pt.

Quick prototype:
  python scripts/train_security_model.py --epochs 10 --imgsz 640

Env vars (optional — defaults shown):
  ROBOFLOW_SECURITY_WORKSPACE=roboflow-100
  ROBOFLOW_SECURITY_PROJECT=violence-detection-oqjqy
  ROBOFLOW_SECURITY_VERSION=1
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

DATASET_DIR = Path("models/security-dataset")
OUTPUT_WEIGHTS = Path("models/security.pt")
DATA_YAML = DATASET_DIR / "data.yaml"

ROBOFLOW_WORKSPACE = os.getenv("ROBOFLOW_SECURITY_WORKSPACE", "roboflow-100")
ROBOFLOW_PROJECT = os.getenv("ROBOFLOW_SECURITY_PROJECT", "violence-detection-oqjqy")
ROBOFLOW_VERSION = int(os.getenv("ROBOFLOW_SECURITY_VERSION", "1"))


def _fix_data_yaml(yaml_path: Path) -> Path:
    with open(yaml_path) as f:
        cfg = yaml.safe_load(f)

    base = yaml_path.parent.resolve()
    for split in ("train", "valid", "test"):
        cfg[split] = str(base / split / "images")

    fixed = yaml_path.parent / "data_abs.yaml"
    with open(fixed, "w") as f:
        yaml.dump(cfg, f, default_flow_style=False)
    return fixed.resolve()


def _pick_device() -> str:
    if torch.cuda.is_available():
        return "0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def download_dataset(force: bool = False):
    if DATASET_DIR.exists() and not force:
        print(f"Dataset already at {DATASET_DIR}, skipping download.")
        return

    api_key = os.getenv("ROBOFLOW_API_KEY")
    if not api_key:
        sys.exit(
            "ROBOFLOW_API_KEY not set in .env\n"
            "Also set ROBOFLOW_SECURITY_WORKSPACE / PROJECT / VERSION for your dataset."
        )

    print(
        f"Downloading security dataset: "
        f"{ROBOFLOW_WORKSPACE}/{ROBOFLOW_PROJECT} v{ROBOFLOW_VERSION}…"
    )
    rf = Roboflow(api_key=api_key)
    version = (
        rf.workspace(ROBOFLOW_WORKSPACE)
        .project(ROBOFLOW_PROJECT)
        .version(ROBOFLOW_VERSION)
    )
    version.download("yolov11", location=str(DATASET_DIR))
    print("Download complete.")


def train(epochs: int, imgsz: int, batch: int, base: str):
    device = _pick_device()
    print(f"Training on device: {device}  epochs={epochs}  imgsz={imgsz}  base={base}")

    if not DATA_YAML.exists():
        sys.exit(f"Dataset not found at {DATA_YAML}. Run with --download-only first.")

    data_yaml = _fix_data_yaml(DATA_YAML)
    model = YOLO(base)
    results = model.train(
        data=str(data_yaml),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        device=device,
        project="models/runs",
        name="security",
        exist_ok=True,
        verbose=False,
    )

    best = Path(results.save_dir) / "weights" / "best.pt"
    shutil.copy(best, OUTPUT_WEIGHTS)
    print(f"\nWeights saved to {OUTPUT_WEIGHTS}")
    print("Next: python training/export_onnx.py --weights models/security.pt --output public/models/security.onnx")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train YOLO11 violence/vandalism detector")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--base", default="yolo11n.pt", help="Base checkpoint (yolo11n.pt or models/security.pt)")
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--force-download", action="store_true")
    args = parser.parse_args()

    download_dataset(force=args.force_download)
    if args.download_only:
        sys.exit(0)

    train(args.epochs, args.imgsz, args.batch, args.base)
