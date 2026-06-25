"""
Download pretrained models for smoking and littering detection.
Run from repo root: python3 scripts/download_pretrained.py

Smoking:  models/smoking.pt (trained on Roboflow timmy-ji8jf/smoking-bjzv1 v4)
Littering: esapzoi/litter-detection-yolov8 from Hugging Face
Output:   training/checkpoints/pretrained.pt  (smoking — primary)
          training/checkpoints/litter.pt       (litter — secondary)
"""

import shutil
from pathlib import Path

from huggingface_hub import hf_hub_download
from ultralytics import YOLO

CHECKPOINTS = Path("training/checkpoints")
CHECKPOINTS.mkdir(parents=True, exist_ok=True)

SMOKING_SRC = Path("models/smoking.pt")
SMOKING_DST = CHECKPOINTS / "pretrained.pt"
LITTER_DST  = CHECKPOINTS / "litter.pt"


def copy_smoking():
    if not SMOKING_SRC.exists():
        raise FileNotFoundError(
            f"Smoking weights not found at {SMOKING_SRC}. "
            "Run: python3 scripts/train_model.py"
        )
    shutil.copy2(SMOKING_SRC, SMOKING_DST)
    size_mb = SMOKING_DST.stat().st_size / 1e6
    print(f"[smoking]  {SMOKING_SRC} → {SMOKING_DST}  ({size_mb:.1f} MB)")

    model = YOLO(str(SMOKING_DST))
    print(f"           classes: {model.names}")


def download_litter():
    print("[litter]   downloading esapzoi/litter-detection-yolov8 from Hugging Face…")
    src = hf_hub_download(repo_id="esapzoi/litter-detection-yolov8", filename="best.pt")
    shutil.copy2(src, LITTER_DST)
    size_mb = LITTER_DST.stat().st_size / 1e6
    print(f"[litter]   saved → {LITTER_DST}  ({size_mb:.1f} MB)")

    model = YOLO(str(LITTER_DST))
    print(f"           classes: {model.names}")


if __name__ == "__main__":
    copy_smoking()
    download_litter()
    print("\nDone. Weights saved to training/checkpoints/")
