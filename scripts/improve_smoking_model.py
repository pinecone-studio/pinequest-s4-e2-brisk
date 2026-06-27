"""
Improve smoking detection: merge custom + hard-negative images, fine-tune, export ONNX.

Best-quality training (RTX 4070 / M-series):
  python scripts/improve_smoking_model.py --epochs 50

Workflow:
  1. Drop smoking photos  -> models/custom-smoking/positive/
  2. Drop non-smoking     -> models/custom-smoking/negative/
  3. python scripts/add_custom_training_data.py --auto-label
  4. python scripts/improve_smoking_model.py --epochs 50
"""

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
HARD_NEGATIVES = ROOT / "models" / "hard-negatives"
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


def merge_custom_data(auto_label: bool) -> None:
    script = ROOT / "scripts" / "add_custom_training_data.py"
    cmd = [sys.executable, str(script)]
    if auto_label:
        cmd.append("--auto-label")
    subprocess.check_call(cmd, cwd=str(ROOT))


def merge_hard_negatives() -> int:
    neg_script = ROOT / "scripts" / "add_hard_negatives.py"
    if not HARD_NEGATIVES.is_dir():
        HARD_NEGATIVES.mkdir(parents=True, exist_ok=True)
        return 0

    images = [p for p in HARD_NEGATIVES.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}]
    if not images:
        return 0

    print(f"Merging {len(images)} hard-negative image(s) from {HARD_NEGATIVES}…")
    subprocess.check_call([sys.executable, str(neg_script), str(HARD_NEGATIVES)])
    return len(images)


def train(epochs: int, imgsz: int, batch: int) -> Path:
    device = _pick_device()
    data_yaml = _fix_data_yaml(DATA_YAML)

    base_weights = OUTPUT_WEIGHTS if OUTPUT_WEIGHTS.exists() else ROOT / "yolo11n.pt"
    if OUTPUT_WEIGHTS.exists():
        shutil.copy2(OUTPUT_WEIGHTS, BACKUP_WEIGHTS)
        print(f"Backed up current weights to {BACKUP_WEIGHTS}")

    print(f"Fine-tuning from {base_weights} on {device}  epochs={epochs}  imgsz={imgsz}")

    model = YOLO(str(base_weights))
    results = model.train(
        data=str(data_yaml),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        device=device,
        project=str(ROOT / "models" / "runs"),
        name="smoking_improved",
        exist_ok=True,
        patience=15,
        verbose=True,
        lr0=0.005,
        lrf=0.01,
        mosaic=1.0,
        mixup=0.1,
        copy_paste=0.0,
        hsv_h=0.015,
        hsv_s=0.7,
        hsv_v=0.4,
        degrees=15,
        translate=0.15,
        scale=0.6,
        fliplr=0.5,
        close_mosaic=15,
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
    print("\n=== Test set metrics ===")
    print(f"  mAP50:     {result['map50']:.4f}")
    print(f"  mAP50-95:  {result['map']:.4f}")
    print(f"  precision: {result['precision']:.4f}")
    print(f"  recall:    {result['recall']:.4f}")
    return result


def maybe_promote(best: Path, metrics: dict[str, float]) -> Path:
    if not BACKUP_WEIGHTS.exists():
        return best

    prev = YOLO(str(BACKUP_WEIGHTS))
    prev_metrics = prev.val(data=str(_fix_data_yaml(DATA_YAML)), split="test", verbose=False)
    prev_map50 = float(prev_metrics.box.map50)
    print(f"\nPrevious model test mAP50: {prev_map50:.4f}")

    if metrics["map50"] + 0.005 < prev_map50:
        print("New model is worse — restoring previous weights.")
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
    parser.add_argument("--epochs", type=int, default=50, help="Fine-tune epochs (default 50)")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--skip-custom", action="store_true", help="Skip models/custom-smoking/ import")
    parser.add_argument("--skip-negatives", action="store_true", help="Skip models/hard-negatives/ import")
    parser.add_argument("--auto-label", action="store_true", help="Auto-label positive custom images")
    parser.add_argument("--skip-export", action="store_true")
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT))
    from scripts.train_model import download_dataset

    download_dataset()

    if not args.skip_custom:
        merge_custom_data(auto_label=args.auto_label)

    if not args.skip_negatives:
        merge_hard_negatives()

    data_yaml = _fix_data_yaml(DATA_YAML)
    best = train(args.epochs, args.imgsz, args.batch)
    metrics = validate(best, data_yaml)
    promoted = maybe_promote(best, metrics)

    if not args.skip_export:
        export_onnx(promoted)
        print(f"\nDone. Web demo uses {ONNX_OUTPUT}")


if __name__ == "__main__":
    main()
