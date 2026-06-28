"""
Prepare a 3-class smoking dataset: 0=person/background, 1=cigarette, 2=vape.

Steps:
  1. Patch models/smoking-dataset/data.yaml (nc: 3)
  2. Download Roboflow vape/cigarette supplement (if missing)
  3. Merge supplement + models/custom-smoking/vape/ into train split

Usage:
  python scripts/prepare_smoking_types_training.py
  python scripts/prepare_smoking_types_training.py --force-redownload
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

import yaml
from dotenv import load_dotenv
from roboflow import Roboflow

load_dotenv()

ROOT = Path(__file__).resolve().parents[1]
DATASET_DIR = ROOT / "models" / "smoking-dataset"
DATA_YAML = DATASET_DIR / "data.yaml"
SUPPLEMENT_DIR = ROOT / "models" / "vape-cigarette-supplement"
VAPE_CUSTOM_DIR = ROOT / "models" / "custom-smoking" / "vape"
TRAIN_IMAGES = DATASET_DIR / "train" / "images"
TRAIN_LABELS = DATASET_DIR / "train" / "labels"

CIGARETTE_CLASS = 1
VAPE_CLASS = 2
BG_CLASS = 0
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

ROBOFLOW_SOURCES = [
    ("takoyati", "cigarette-vape-detection", 1),
    ("tiara-fb7pp", "vaping-ulrul", 1),
]


def _map_class_name(name: str) -> int | None:
    n = name.lower().strip()
    if any(k in n for k in ("vape", "vaping", "e-cig", "ecig", "e_cig", "pod")):
        return VAPE_CLASS
    if any(k in n for k in ("cigarette", "smoking", "cigar", "smoke", "tobacco")):
        return CIGARETTE_CLASS
    if n in ("-", "person", "background", "human", "people"):
        return BG_CLASS
    return None


def patch_data_yaml() -> None:
    with open(DATA_YAML) as f:
        cfg = yaml.safe_load(f)

    cfg["nc"] = 3
    cfg["names"] = ["-", "cigarette", "vape"]

    with open(DATA_YAML, "w") as f:
        yaml.dump(cfg, f, default_flow_style=False, sort_keys=False)
    print(f"Patched {DATA_YAML} -> nc=3 (cigarette / vape)")


def download_supplement(force: bool) -> bool:
    if SUPPLEMENT_DIR.is_dir() and any(SUPPLEMENT_DIR.rglob("*.jpg")) and not force:
        print(f"Supplement already at {SUPPLEMENT_DIR}, skipping download.")
        return True

    api_key = os.getenv("ROBOFLOW_API_KEY")
    if not api_key:
        print("ROBOFLOW_API_KEY not set — skipping Roboflow supplement.")
        return False

    rf = Roboflow(api_key=api_key)
    for workspace, project, version in ROBOFLOW_SOURCES:
        try:
            print(f"Downloading {workspace}/{project} v{version}…")
            if SUPPLEMENT_DIR.exists():
                shutil.rmtree(SUPPLEMENT_DIR)
            version_obj = rf.workspace(workspace).project(project).version(version)
            version_obj.download("yolov11", location=str(SUPPLEMENT_DIR))
            print("Download complete.")
            return True
        except Exception as exc:
            print(f"  failed: {exc}")
    return False


def _load_names(yaml_path: Path) -> dict[int, str]:
    with open(yaml_path) as f:
        cfg = yaml.safe_load(f)
    names = cfg.get("names", [])
    if isinstance(names, dict):
        return {int(k): str(v) for k, v in names.items()}
    return {i: str(n) for i, n in enumerate(names)}


def _remap_label_file(label_path: Path, names: dict[int, str]) -> str:
    lines: list[str] = []
    for line in label_path.read_text().splitlines():
        parts = line.strip().split()
        if len(parts) != 5:
            continue
        old_cls = int(parts[0])
        old_name = names.get(old_cls, str(old_cls))
        new_cls = _map_class_name(old_name)
        if new_cls is None:
            new_cls = VAPE_CLASS if old_cls >= 2 else CIGARETTE_CLASS if old_cls == 1 else BG_CLASS
        lines.append(f"{new_cls} {parts[1]} {parts[2]} {parts[3]} {parts[4]}")
    return "\n".join(lines) + ("\n" if lines else "")


def _merge_split(split: str, prefix: str) -> int:
    images_dir = SUPPLEMENT_DIR / split / "images"
    labels_dir = SUPPLEMENT_DIR / split / "labels"
    if not images_dir.is_dir():
        return 0

    names = _load_names(SUPPLEMENT_DIR / "data.yaml")
    added = 0
    TRAIN_IMAGES.mkdir(parents=True, exist_ok=True)
    TRAIN_LABELS.mkdir(parents=True, exist_ok=True)

    for img in sorted(images_dir.iterdir()):
        if img.suffix.lower() not in IMAGE_EXTS:
            continue
        stem = f"{prefix}{img.stem}"
        dest_img = TRAIN_IMAGES / f"{stem}{img.suffix.lower()}"
        dest_lbl = TRAIN_LABELS / f"{stem}.txt"
        if dest_img.exists():
            continue

        lbl = labels_dir / f"{img.stem}.txt"
        content = _remap_label_file(lbl, names) if lbl.exists() else ""
        if not content.strip():
            continue

        shutil.copy2(img, dest_img)
        dest_lbl.write_text(content)
        added += 1
    return added


def merge_supplement() -> int:
    if not SUPPLEMENT_DIR.is_dir():
        return 0
    total = 0
    for split, pfx in (("train", "rf_vape_"), ("valid", "rf_vape_val_"), ("test", "rf_vape_test_")):
        n = _merge_split(split, pfx)
        if n:
            print(f"  merged {n} image(s) from supplement/{split}")
        total += n
    return total


def merge_custom_vape() -> int:
    if not VAPE_CUSTOM_DIR.is_dir():
        VAPE_CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
        print(f"Created {VAPE_CUSTOM_DIR} — drop vape photos + .txt labels (class 2) here.")
        return 0

    added = 0
    TRAIN_IMAGES.mkdir(parents=True, exist_ok=True)
    TRAIN_LABELS.mkdir(parents=True, exist_ok=True)

    for img in sorted(VAPE_CUSTOM_DIR.iterdir()):
        if img.suffix.lower() not in IMAGE_EXTS:
            continue
        stem = f"custom_vape_{img.stem}"
        dest_img = TRAIN_IMAGES / f"{stem}{img.suffix.lower()}"
        dest_lbl = TRAIN_LABELS / f"{stem}.txt"
        if dest_img.exists():
            continue

        lbl = img.with_suffix(".txt")
        if lbl.exists():
            content = lbl.read_text()
        else:
            content = f"{VAPE_CLASS} 0.5 0.45 0.12 0.18\n"
            print(f"  no label for {img.name}, using default mouth vape box")

        remapped: list[str] = []
        for line in content.splitlines():
            parts = line.strip().split()
            if len(parts) != 5:
                continue
            cls = int(parts[0])
            if cls not in (BG_CLASS, CIGARETTE_CLASS, VAPE_CLASS):
                cls = VAPE_CLASS
            remapped.append(f"{cls} {parts[1]} {parts[2]} {parts[3]} {parts[4]}")
        if not remapped:
            continue

        shutil.copy2(img, dest_img)
        dest_lbl.write_text("\n".join(remapped) + "\n")
        added += 1
        print(f"  added custom vape: {img.name}")
    return added


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force-redownload", action="store_true")
    args = parser.parse_args()

    if not DATA_YAML.exists():
        sys.exit(f"Missing {DATA_YAML}. Run scripts/train_model.py first.")

    patch_data_yaml()
    download_supplement(force=args.force_redownload)
    n_sup = merge_supplement()
    n_custom = merge_custom_vape()
    print(f"\nDone. Supplement: {n_sup}, custom vape: {n_custom}")


if __name__ == "__main__":
    main()
