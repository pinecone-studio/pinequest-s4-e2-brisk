"""
Export a YOLO11 .pt file to ONNX format suitable for onnxruntime-web.

Usage:
    python training/export_onnx.py --weights <path>.pt --output <path>.onnx

Constraints:
  - opset >= 12  (onnxruntime-web requires 12+)
  - static batch dim (batch=1, no dynamic axes on batch)
  - input shape: 1 x 3 x 640 x 640
"""

import argparse
import shutil
import sys
from pathlib import Path

import onnx
from ultralytics import YOLO


def export(weights: Path, output: Path) -> None:
    if not weights.exists():
        sys.exit(f"Weights not found: {weights}")

    output.parent.mkdir(parents=True, exist_ok=True)

    model = YOLO(str(weights))

    # Ultralytics exports to <weights_stem>.onnx in the same directory as weights.
    # We control opset, imgsz, and dynamic=False (static batch).
    export_path = model.export(
        format="onnx",
        imgsz=640,
        opset=12,
        dynamic=False,   # static batch=1; required for onnxruntime-web WASM
        simplify=True,
    )

    src = Path(export_path)
    if not src.exists():
        sys.exit(f"Export produced no file at expected path: {src}")

    # Validate the exported graph before moving it
    onnx_model = onnx.load(str(src))
    onnx.checker.check_model(onnx_model)

    shutil.move(str(src), str(output))
    print(f"[export] {weights.name} → {output}  (opset {onnx_model.opset_import[0].version})")

    # Print input/output metadata for downstream debugging
    graph = onnx_model.graph
    for inp in graph.input:
        shape = [d.dim_value for d in inp.type.tensor_type.shape.dim]
        print(f"  input : {inp.name}  shape={shape}")
    for out in graph.output:
        shape = [d.dim_value for d in out.type.tensor_type.shape.dim]
        print(f"  output: {out.name}  shape={shape}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Export YOLO11 .pt to ONNX for onnxruntime-web")
    parser.add_argument("--weights", required=True, type=Path, help="Path to .pt checkpoint")
    parser.add_argument("--output",  required=True, type=Path, help="Destination .onnx path")
    args = parser.parse_args()
    export(args.weights, args.output)


if __name__ == "__main__":
    main()
