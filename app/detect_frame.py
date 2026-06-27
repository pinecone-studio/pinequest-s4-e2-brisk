"""
Shared frame-level detector using COCO weights.
Loads the model once at import time; designed so a tracker can consume
the returned list in a later pipeline stage.
"""

from pathlib import Path
from typing import List, Dict

import numpy as np
import torch
from ultralytics import YOLO

_WEIGHTS = Path(__file__).parent.parent / "training" / "checkpoints" / "coco.pt"
_COCO_FILTER = {"person", "bottle", "cup", "backpack", "handbag", "suitcase"}

_device = "mps" if torch.backends.mps.is_available() else "cpu"

if not _WEIGHTS.exists():
    raise FileNotFoundError(f"COCO weights not found at {_WEIGHTS}")

_model = YOLO(str(_WEIGHTS))


def detect_frame(frame: np.ndarray, conf_threshold: float = 0.3) -> List[Dict]:
    """
    Run inference on a single BGR frame.

    Returns a list of dicts: {class, bbox (x1,y1,x2,y2), conf}.
    Filtered to _COCO_FILTER classes only.
    """
    results = _model(frame, verbose=False, device=_device)[0]
    detections: List[Dict] = []
    if results.boxes is None:
        return detections

    names = results.names
    for box in results.boxes:
        conf = float(box.conf[0])
        cls_name = names[int(box.cls[0])]
        if cls_name not in _COCO_FILTER or conf < conf_threshold:
            continue
        x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
        detections.append({"class": cls_name, "bbox": (x1, y1, x2, y2), "conf": conf})

    return detections
