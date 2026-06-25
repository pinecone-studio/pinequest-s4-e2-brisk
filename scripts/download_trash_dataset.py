"""
Download trash/litter images from Roboflow into models/trash-dataset/.
Run from repo root: py scripts/download_trash_dataset.py

Requires ROBOFLOW_API_KEY in .env (same key as smoking dataset).
Dataset: https://universe.roboflow.com/ros/trash-plastic-bottle-detection (~338 images)
"""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from roboflow import Roboflow

load_dotenv()

DATASET_DIR = Path("models/trash-dataset")
# Smaller public dataset (~338 images) — fast download, plastic bottle / trash focus.
# Override in .env: ROBOFLOW_TRASH_WORKSPACE, ROBOFLOW_TRASH_PROJECT, ROBOFLOW_TRASH_VERSION
ROBOFLOW_WORKSPACE = os.getenv("ROBOFLOW_TRASH_WORKSPACE", "ros")
ROBOFLOW_PROJECT = os.getenv("ROBOFLOW_TRASH_PROJECT", "trash-plastic-bottle-detection")
ROBOFLOW_VERSION = int(os.getenv("ROBOFLOW_TRASH_VERSION", "2"))


def download_dataset(force: bool = False) -> None:
    api_key = os.getenv("ROBOFLOW_API_KEY")
    if not api_key:
        sys.exit(
            "ROBOFLOW_API_KEY not set.\n"
            "Create .env in the project root:\n"
            "  ROBOFLOW_API_KEY=your_key_here\n"
            "Get a free key at https://app.roboflow.com/settings/api"
        )

    images_dir = DATASET_DIR / "train" / "images"
    exts = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    n = sum(1 for p in images_dir.glob("*") if p.suffix.lower() in exts) if images_dir.exists() else 0
    if n > 0 and not force:
        print(f"Dataset already at {DATASET_DIR} ({n} train images). Use --force to re-download.")
        return

    print(
        f"Downloading from Roboflow: {ROBOFLOW_WORKSPACE}/{ROBOFLOW_PROJECT} v{ROBOFLOW_VERSION}…"
    )
    rf = Roboflow(api_key=api_key)
    version = rf.workspace(ROBOFLOW_WORKSPACE).project(ROBOFLOW_PROJECT).version(ROBOFLOW_VERSION)
    version.download("yolov8", location=str(DATASET_DIR), overwrite=True)
    print(f"Done. Dataset saved to {DATASET_DIR.resolve()}")


if __name__ == "__main__":
    force = "--force" in sys.argv
    download_dataset(force=force)
