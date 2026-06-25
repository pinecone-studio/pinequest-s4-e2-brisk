"""
Fine-tune YOLOv8 on the trash/litter dataset and save weights to models/trash.pt.

Preferred training (YOLO CLI):
  yolo train model=yolov8n.pt data=models/trash-dataset/data.yaml epochs=20 imgsz=640 device=0 name=trash_run_v1

Or via this script:
  py scripts/train_trash_model.py --epochs 20 --imgsz 640
"""

import argparse
import os
import shutil
import sys
from pathlib import Path

import torch
import yaml
from dotenv import load_dotenv
from ultralytics import YOLO

load_dotenv()

DATASET_DIR = Path("models/trash-dataset")
OUTPUT_WEIGHTS = Path("models/trash.pt")
DATA_YAML = DATASET_DIR / "data.yaml"
BASE_WEIGHTS = Path("training/checkpoints/litter.pt")


def _fix_data_yaml(yaml_path: Path) -> Path:
    """Rewrite relative paths in data.yaml to absolute paths."""
    with open(yaml_path) as f:
        cfg = yaml.safe_load(f)

    base = yaml_path.parent.resolve()
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


def download_dataset(force: bool = False):
    train_n = _count_images("train")
    if train_n > 0 and not force:
        print(f"Dataset already at {DATASET_DIR} ({train_n} train images), skipping download.")
        return

    sys.path.insert(0, str(Path(__file__).parent))
    from download_trash_dataset import download_dataset as _download

    _download(force=force)


def ensure_dataset():
    train_n = _count_images("train")
    val_n = _count_images("valid")
    if train_n == 0:
        download_dataset()
        train_n = _count_images("train")
        val_n = _count_images("valid")
    if train_n == 0:
        sys.exit(
            f"No training images in {DATASET_DIR / 'train' / 'images'}.\n"
            "Run: py scripts/download_trash_dataset.py"
        )
    if val_n == 0:
        sys.exit(
            f"No validation images in {DATASET_DIR / 'valid' / 'images'}.\n"
            "Add at least a few valid images before training."
        )
    print(f"Dataset: train={train_n}  valid={val_n}  test={_count_images('test')}")


def ensure_base_weights() -> Path:
    if BASE_WEIGHTS.exists():
        print(f"Base weights: {BASE_WEIGHTS}")
        return BASE_WEIGHTS

    from huggingface_hub import hf_hub_download

    BASE_WEIGHTS.parent.mkdir(parents=True, exist_ok=True)
    print("Downloading litter base weights from Hugging Face…")
    src = hf_hub_download(
        repo_id="esapzoi/litter-detection-yolov8",
        filename="best.pt",
    )
    shutil.copy2(src, BASE_WEIGHTS)
    print(f"Saved base weights → {BASE_WEIGHTS}")
    return BASE_WEIGHTS


def train(epochs: int, imgsz: int, batch: int):
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Training on device: {device}  epochs={epochs}  imgsz={imgsz}")

    ensure_dataset()
    base = ensure_base_weights()
    data_yaml = _fix_data_yaml(DATA_YAML)

    model = YOLO(str(base))
    results = model.train(
        data=str(data_yaml),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        device=device,
        project="models/runs",
        name="trash",
        exist_ok=True,
        verbose=False,
    )

    best = Path(results.save_dir) / "weights" / "best.pt"
    shutil.copy(best, OUTPUT_WEIGHTS)
    print(f"\nWeights saved to {OUTPUT_WEIGHTS}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--download-only", action="store_true", help="Only download dataset from Roboflow")
    parser.add_argument("--force-download", action="store_true", help="Re-download even if images exist")
    args = parser.parse_args()

    if args.download_only or args.force_download:
        sys.path.insert(0, str(Path(__file__).parent))
        from download_trash_dataset import download_dataset as _download

        _download(force=args.force_download)
        if args.download_only:
            sys.exit(0)

    train(args.epochs, args.imgsz, args.batch)
