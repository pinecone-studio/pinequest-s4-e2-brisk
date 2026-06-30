"""
Train YOLO11n on the Roboflow smoking dataset and save weights to models/smoking.pt.
Run from repo root: python3 scripts/train_model.py [--epochs N] [--imgsz N]

Quick prototype run (5-10 min on M2):  python3 scripts/train_model.py --epochs 5 --imgsz 416
Full training (~2-3 hrs on M2):        python3 scripts/train_model.py --epochs 30
"""

import argparse
import os
import shutil
import subprocess
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
BACKUP_WEIGHTS = Path("models/smoking.prev.pt")
ONNX_OUTPUT = Path("public/models/pretrained.onnx")
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


def _count_images(split: str) -> int:
    images_dir = DATASET_DIR / split / "images"
    if not images_dir.exists():
        return 0
    exts = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    return sum(1 for p in images_dir.iterdir() if p.suffix.lower() in exts)


def download_dataset():
    api_key = os.getenv("ROBOFLOW_API_KEY")
    if not api_key:
        sys.exit("ROBOFLOW_API_KEY not set in .env")

    workspace = os.getenv("ROBOFLOW_WORKSPACE", "timmy-ji8jf")
    project = os.getenv("ROBOFLOW_PROJECT", "smoking-bjzv1")
    version = int(os.getenv("ROBOFLOW_VERSION", "4"))

    if _count_images("train") > 0:
        print(f"Dataset already at {DATASET_DIR} ({_count_images('train')} train images), skipping download.")
        return

    print(f"Downloading smoking dataset from Roboflow ({workspace}/{project} v{version})…")
    rf = Roboflow(api_key=api_key)
    version_obj = rf.workspace(workspace).project(project).version(version)
    version_obj.download("yolov11", location=str(DATASET_DIR))
    print("Download complete.")


def _pick_device() -> str:
    if torch.cuda.is_available():
        return "0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def train(epochs: int, imgsz: int, batch: int, export_onnx: bool = False):
    device = _pick_device()
    print(f"Training on device: {device}  epochs={epochs}  imgsz={imgsz}")

    data_yaml = _fix_data_yaml(DATA_YAML)
    base_weights = OUTPUT_WEIGHTS if OUTPUT_WEIGHTS.exists() else Path("yolo11n.pt")
    if OUTPUT_WEIGHTS.exists():
        shutil.copy2(OUTPUT_WEIGHTS, BACKUP_WEIGHTS)
        print(f"Fine-tuning from {OUTPUT_WEIGHTS} (backup: {BACKUP_WEIGHTS})")
    else:
        print(f"Training from scratch with {base_weights}")

    model = YOLO(str(base_weights))
    results = model.train(
        data=str(data_yaml),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        device=device,
        project="models/runs",
        name="smoking",
        exist_ok=True,
        patience=10,
        verbose=False,
        mosaic=1.0,
        mixup=0.08,
        close_mosaic=10,
    )

    best = Path(results.save_dir) / "weights" / "best.pt"
    shutil.copy2(best, OUTPUT_WEIGHTS)
    print(f"\nWeights saved to {OUTPUT_WEIGHTS}")

    if export_onnx:
        subprocess.check_call(
            [sys.executable, "training/export_onnx.py", "--weights", str(best), "--output", str(ONNX_OUTPUT)]
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--export-onnx", action="store_true", help="Export to public/models/pretrained.onnx after training")
    args = parser.parse_args()

    download_dataset()
    train(args.epochs, args.imgsz, args.batch, export_onnx=args.export_onnx)
