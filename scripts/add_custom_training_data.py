"""
Import custom images into the smoking training set.

Folder layout (create these and drop files in):

  models/custom-smoking/positive/   — person smoking (jpg/png)
      optional: same-name .txt YOLO labels (class 0 = person region, class 1 = smoking)
      if no .txt: run with --auto-label to generate labels from models/smoking.pt

  models/custom-smoking/negative/   — NOT smoking (toy, red light, normal face, etc.)
      empty labels are created automatically

Then train:
  python scripts/improve_smoking_model.py --epochs 50

Usage:
  python scripts/add_custom_training_data.py
  python scripts/add_custom_training_data.py --auto-label
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

ROOT = Path(__file__).resolve().parents[1]
CUSTOM_DIR = ROOT / "models" / "custom-smoking"
POSITIVE_DIR = CUSTOM_DIR / "positive"
NEGATIVE_DIR = CUSTOM_DIR / "negative"
TRAIN_IMAGES = ROOT / "models" / "smoking-dataset" / "train" / "images"
TRAIN_LABELS = ROOT / "models" / "smoking-dataset" / "train" / "labels"
SMOKING_CLASS = 1


def _ensure_dirs() -> None:
    POSITIVE_DIR.mkdir(parents=True, exist_ok=True)
    NEGATIVE_DIR.mkdir(parents=True, exist_ok=True)
    TRAIN_IMAGES.mkdir(parents=True, exist_ok=True)
    TRAIN_LABELS.mkdir(parents=True, exist_ok=True)


def _find_label(image: Path) -> Path | None:
    for ext in (".txt",):
        candidate = image.with_suffix(ext)
        if candidate.exists():
            return candidate
    return None


def _auto_label_image(model, image: Path) -> str:
    """Run smoking.pt on one image; return YOLO label file content."""
    results = model.predict(str(image), conf=0.2, verbose=False)[0]
    lines: list[str] = []
    if results.boxes is None:
        return ""

    for box in results.boxes:
        cls_id = int(box.cls[0])
        if cls_id not in (0, 1):
            continue
        cx, cy, w, h = box.xywhn[0].tolist()
        lines.append(f"{cls_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")

    return "\n".join(lines)


def auto_label_positive(model) -> int:
    labeled = 0
    for img in sorted(POSITIVE_DIR.iterdir()):
        if img.suffix.lower() not in IMAGE_EXTS:
            continue
        if _find_label(img):
            continue
        content = _auto_label_image(model, img)
        if not content.strip():
            print(f"  no boxes found: {img.name} (label manually or retake photo)")
            continue
        out = img.with_suffix(".txt")
        out.write_text(content + "\n")
        labeled += 1
        print(f"  auto-labeled: {img.name}")
    return labeled


def _copy_pair(prefix: str, image: Path, label_content: str | None) -> bool:
    stem = f"{prefix}{image.stem}"
    dest_img = TRAIN_IMAGES / f"{stem}{image.suffix.lower()}"
    dest_lbl = TRAIN_LABELS / f"{stem}.txt"

    if dest_img.exists():
        print(f"  skip (exists): {dest_img.name}")
        return False

    shutil.copy2(image, dest_img)
    dest_lbl.write_text(label_content or "")
    print(f"  added: {image.name} -> {dest_img.name}")
    return True


def import_positive(auto_label: bool) -> tuple[int, int]:
    if auto_label:
        from ultralytics import YOLO

        weights = ROOT / "models" / "smoking.pt"
        if not weights.exists():
            sys.exit(f"Weights not found: {weights}. Run scripts/train_model.py first.")
        print("Auto-labeling positive images without .txt files…")
        model = YOLO(str(weights))
        auto_label_positive(model)

    added = 0
    skipped_no_label = 0
    for img in sorted(POSITIVE_DIR.iterdir()):
        if img.suffix.lower() not in IMAGE_EXTS:
            continue
        label_path = _find_label(img)
        if not label_path:
            print(f"  skip (no label): {img.name} — add .txt or use --auto-label")
            skipped_no_label += 1
            continue
        content = label_path.read_text().strip()
        has_smoking = any(
            line.split()[0] == str(SMOKING_CLASS) for line in content.splitlines() if line.strip()
        )
        if not has_smoking:
            print(f"  warn: {img.name} has no class-1 (smoking) box in label")
        if _copy_pair("custom_pos_", img, content):
            added += 1

    return added, skipped_no_label


def import_negative() -> int:
    added = 0
    for img in sorted(NEGATIVE_DIR.iterdir()):
        if img.suffix.lower() not in IMAGE_EXTS:
            continue
        if _copy_pair("custom_neg_", img, ""):
            added += 1
    return added


def main() -> None:
    parser = argparse.ArgumentParser(description="Import custom smoking training images")
    parser.add_argument(
        "--auto-label",
        action="store_true",
        help="Generate .txt labels for positive images using models/smoking.pt",
    )
    args = parser.parse_args()

    if not TRAIN_IMAGES.parent.parent.exists():
        sys.exit("Smoking dataset missing. Run: python scripts/train_model.py (download step)")

    _ensure_dirs()

    pos_images = [p for p in POSITIVE_DIR.iterdir() if p.suffix.lower() in IMAGE_EXTS]
    neg_images = [p for p in NEGATIVE_DIR.iterdir() if p.suffix.lower() in IMAGE_EXTS]

    print(f"Custom positive folder: {len(pos_images)} image(s)")
    print(f"Custom negative folder: {len(neg_images)} image(s)")

    pos_added, pos_skipped = import_positive(args.auto_label)
    neg_added = import_negative()

    print(f"\nImported {pos_added} positive + {neg_added} negative image(s) into training set.")
    if pos_skipped:
        print(f"Skipped {pos_skipped} positive image(s) without labels.")
    if pos_added + neg_added == 0:
        print("\nDrop files into:")
        print(f"  {POSITIVE_DIR}")
        print(f"  {NEGATIVE_DIR}")
        print("Then re-run this script.")


if __name__ == "__main__":
    main()
