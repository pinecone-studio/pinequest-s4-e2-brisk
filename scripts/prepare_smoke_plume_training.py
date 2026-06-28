"""
Import visible smoke-plume images (exhaling, thick smoke) with expanded labels.

Drop photos into:
  models/custom-smoking/smoke-plume/

Labels should cover mouth + rising smoke (class 1). Auto-label expands tight boxes
4x upward to include the plume.

Usage:
  python scripts/prepare_smoke_plume_training.py --auto-label --force
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
SMOKING_CLASS = 1

ROOT = Path(__file__).resolve().parents[1]
PLUME_DIR = ROOT / "models" / "custom-smoking" / "smoke-plume"
TRAIN_IMAGES = ROOT / "models" / "smoking-dataset" / "train" / "images"
TRAIN_LABELS = ROOT / "models" / "smoking-dataset" / "train" / "labels"
WEIGHTS = ROOT / "models" / "smoking.pt"


def expand_plume_box(cx: float, cy: float, w: float, h: float) -> tuple[float, float, float, float]:
    """Expand cigarette box to mouth + exhale smoke plume."""
    new_w = min(0.92, max(w * 2.2, 0.12))
    new_h = min(0.92, max(h * 4.5, 0.18))
    new_cy = max(new_h / 2, cy - h * 1.8)
    new_cx = min(max(cx, new_w / 2), 1 - new_w / 2)
    new_cy = min(max(new_cy, new_h / 2), 1 - new_h / 2)
    return new_cx, new_cy, new_w, new_h


def parse_label_lines(content: str) -> list[tuple[int, float, float, float, float]]:
    rows: list[tuple[int, float, float, float, float]] = []
    for line in content.splitlines():
        parts = line.strip().split()
        if len(parts) != 5:
            continue
        rows.append((int(parts[0]), float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])))
    return rows


def format_label_lines(rows: list[tuple[int, float, float, float, float]]) -> str:
    lines: list[str] = []
    for cls_id, cx, cy, w, h in rows:
        if cls_id == SMOKING_CLASS:
            cx, cy, w, h = expand_plume_box(cx, cy, w, h)
        lines.append(f"{cls_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
    return "\n".join(lines) + ("\n" if lines else "")


def auto_label(model, image: Path) -> str:
    results = model.predict(str(image), conf=0.12, verbose=False)[0]
    rows: list[tuple[int, float, float, float, float]] = []
    if results.boxes is None:
        return ""
    for box in results.boxes:
        cls_id = int(box.cls[0])
        if cls_id not in (0, SMOKING_CLASS):
            continue
        cx, cy, w, h = box.xywhn[0].tolist()
        rows.append((cls_id, cx, cy, w, h))
    if not any(r[0] == SMOKING_CLASS for r in rows) and rows:
        px1 = min(r[1] - r[3] / 2 for r in rows)
        py1 = min(r[2] - r[4] / 2 for r in rows)
        px2 = max(r[1] + r[3] / 2 for r in rows)
        py2 = max(r[2] + r[4] / 2 for r in rows)
        cx = (px1 + px2) / 2
        cy = py1 + (py2 - py1) * 0.22
        w = min(0.35, (px2 - px1) * 0.45)
        h = min(0.4, (py2 - py1) * 0.35)
        rows.append((SMOKING_CLASS, cx, cy, w, h))
    return format_label_lines(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--auto-label", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    PLUME_DIR.mkdir(parents=True, exist_ok=True)
    TRAIN_IMAGES.mkdir(parents=True, exist_ok=True)
    TRAIN_LABELS.mkdir(parents=True, exist_ok=True)

    model = None
    if args.auto_label:
        if not WEIGHTS.exists():
            sys.exit(f"Weights not found: {WEIGHTS}")
        from ultralytics import YOLO

        model = YOLO(str(WEIGHTS))

    added = 0
    for img in sorted(PLUME_DIR.iterdir()):
        if img.suffix.lower() not in IMAGE_EXTS:
            continue
        stem = f"custom_plume_{img.stem}"
        dest_img = TRAIN_IMAGES / f"{stem}{img.suffix.lower()}"
        dest_lbl = TRAIN_LABELS / f"{stem}.txt"
        if dest_img.exists() and not args.force:
            continue

        label_path = img.with_suffix(".txt")
        if label_path.exists():
            content = format_label_lines(parse_label_lines(label_path.read_text()))
        elif args.auto_label and model is not None:
            content = auto_label(model, img)
        else:
            print(f"  skip (no label): {img.name}")
            continue

        if not any(line.startswith(f"{SMOKING_CLASS} ") for line in content.splitlines()):
            print(f"  skip (no class-1): {img.name}")
            continue

        shutil.copy2(img, dest_img)
        dest_lbl.write_text(content)
        print(f"  added: {img.name}")
        added += 1

    print(f"\nImported {added} smoke-plume image(s).")


if __name__ == "__main__":
    main()
