"""
Fine-tune smoking model to distinguish cigarette (class 1) vs vape (class 2).

Workflow:
  1. python scripts/prepare_smoking_types_training.py
  2. Drop vape webcam photos -> models/custom-smoking/vape/ (+ optional .txt labels)
  3. python scripts/train_smoking_types.py --epochs 40

Exports to public/models/pretrained.onnx when metrics improve.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import torch
import yaml
from dotenv import load_dotenv
from ultralytics import YOLO

load_dotenv()

ROOT = Path(__file__).resolve().parents[1]
DATASET_DIR = ROOT / "models" / "smoking-dataset"
OUTPUT_WEIGHTS = ROOT / "models" / "smoking.pt"
BACKUP_WEIGHTS = ROOT / "models" / "smoking.prev.pt"
ONNX_OUTPUT = ROOT / "public" / "models" / "pretrained.onnx"
DATA_YAML = DATASET_DIR / "data.yaml"


def _fix_data_yaml(yaml_path: Path) -> Path:
    with open(yaml_path) as f:
        cfg = yaml.safe_load(f)

    base = yaml_path.parent.resolve()
    cfg["train"] = str(base / "train" / "images")
    cfg["val"] = str(base / "valid" / "images")
    cfg["test"] = str(base / "test" / "images")
    cfg["nc"] = 3
    cfg["names"] = ["-", "cigarette", "vape"]

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


def prepare_dataset(force_redownload: bool) -> None:
    script = ROOT / "scripts" / "prepare_smoking_types_training.py"
    cmd = [sys.executable, str(script)]
    if force_redownload:
        cmd.append("--force-redownload")
    subprocess.check_call(cmd, cwd=str(ROOT))


def merge_hard_negatives() -> None:
    neg_script = ROOT / "scripts" / "add_hard_negatives.py"
    hard_dir = ROOT / "models" / "hard-negatives"
    if not hard_dir.is_dir():
        return
    images = [p for p in hard_dir.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}]
    if not images:
        return
    subprocess.check_call([sys.executable, str(neg_script), str(hard_dir)], cwd=str(ROOT))


def train(epochs: int, imgsz: int, batch: int) -> Path:
    device = _pick_device()
    data_yaml = _fix_data_yaml(DATA_YAML)

    base_weights = OUTPUT_WEIGHTS if OUTPUT_WEIGHTS.exists() else ROOT / "yolo11n.pt"
    if OUTPUT_WEIGHTS.exists():
        shutil.copy2(OUTPUT_WEIGHTS, BACKUP_WEIGHTS)
        print(f"Backed up current weights to {BACKUP_WEIGHTS}")

    print(f"Fine-tuning 3-class smoking model from {base_weights} on {device}")

    model = YOLO(str(base_weights))
    results = model.train(
        data=str(data_yaml),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        device=device,
        project=str(ROOT / "models" / "runs"),
        name="smoking_types",
        exist_ok=True,
        patience=12,
        verbose=True,
        lr0=0.0025,
        lrf=0.01,
        mosaic=0.75,
        mixup=0.05,
        copy_paste=0.0,
        hsv_h=0.015,
        hsv_s=0.55,
        hsv_v=0.35,
        degrees=10,
        translate=0.1,
        scale=0.4,
        fliplr=0.5,
        close_mosaic=10,
        cache=True,
    )

    best = Path(results.save_dir) / "weights" / "best.pt"
    shutil.copy2(best, OUTPUT_WEIGHTS)
    print(f"Weights saved to {OUTPUT_WEIGHTS}")
    return best


def validate(weights: Path, data_yaml: Path) -> dict[str, float]:
    model = YOLO(str(weights))
    metrics = model.val(data=str(data_yaml), split="test", verbose=False)
    result = {
        "map50": float(metrics.box.map50),
        "map": float(metrics.box.map),
        "precision": float(metrics.box.mp),
        "recall": float(metrics.box.mr),
    }
    print("\n=== Test set metrics (3-class) ===")
    print(f"  mAP50:     {result['map50']:.4f}")
    print(f"  mAP50-95:  {result['map']:.4f}")
    print(f"  precision: {result['precision']:.4f}")
    print(f"  recall:    {result['recall']:.4f}")
    return result


def maybe_promote(best: Path, metrics: dict[str, float], force: bool = False) -> Path:
    if force:
        print("Force-promoting 3-class model (cigarette + vape).")
        return best

    if not BACKUP_WEIGHTS.exists():
        return best

    prev = YOLO(str(BACKUP_WEIGHTS))
    prev_metrics = prev.val(data=str(_fix_data_yaml(DATA_YAML)), split="test", verbose=False)
    prev_map50 = float(prev_metrics.box.map50)
    print(f"\nPrevious model test mAP50: {prev_map50:.4f}")

    # Allow a small regression when adding the vape class — still needs decent quality.
    min_acceptable = max(0.9, prev_map50 - 0.03)
    if metrics["map50"] < min_acceptable:
        print(f"New model mAP50 {metrics['map50']:.4f} < {min_acceptable:.4f} — restoring previous weights.")
        shutil.copy2(BACKUP_WEIGHTS, OUTPUT_WEIGHTS)
        return BACKUP_WEIGHTS

    print("New model accepted.")
    return best


def export_onnx(weights: Path) -> None:
    export_script = ROOT / "training" / "export_onnx.py"
    if ONNX_OUTPUT.exists():
        backup = ONNX_OUTPUT.with_suffix(".prev.onnx")
        shutil.copy2(ONNX_OUTPUT, backup)
        print(f"Backed up {ONNX_OUTPUT} -> {backup}")
    subprocess.check_call(
        [sys.executable, str(export_script), "--weights", str(weights), "--output", str(ONNX_OUTPUT)]
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--force-redownload", action="store_true")
    parser.add_argument("--skip-negatives", action="store_true")
    parser.add_argument("--force-promote", action="store_true", help="Always export best 3-class weights")
    parser.add_argument("--skip-export", action="store_true")
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT))
    from scripts.train_model import download_dataset

    download_dataset()
    prepare_dataset(force_redownload=args.force_redownload)

    if not args.skip_negatives:
        merge_hard_negatives()

    data_yaml = _fix_data_yaml(DATA_YAML)
    best = train(args.epochs, args.imgsz, args.batch)
    metrics = validate(best, data_yaml)
    promoted = maybe_promote(best, metrics, force=args.force_promote)

    if not args.skip_export:
        export_onnx(promoted)
        print(f"\nDone. Web demo uses {ONNX_OUTPUT} (Cigarette + Vape classes)")


if __name__ == "__main__":
    main()
