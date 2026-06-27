"""
Shared frame-level detector using COCO weights.
Loads the model once at import time; designed so a tracker can consume
the returned list in a later pipeline stage.
"""

from pathlib import Path
from typing import List, Dict, Optional, Tuple

import numpy as np
import torch
from ultralytics import YOLO

# ── model ──────────────────────────────────────────────────────────────────────
# yolo11s: YOLO11 Small, COCO-pretrained.  mAP50-95 ≈ 47 vs 39 for nano.
# Switch back to coco.pt (nano) if FPS is too low on your hardware.
_WEIGHTS = Path(__file__).parent.parent / "training" / "checkpoints" / "yolo11s.pt"
_TRACKER = str(Path(__file__).parent.parent / "training" / "checkpoints" / "bytetrack_littering.yaml")

# ── confidence thresholds (tune here) ─────────────────────────────────────────
CONF_PERSON = 0.30   # person is well-detected; keep the original threshold
CONF_OBJECT = 0.25   # lower threshold for carriable objects (bottles flicker at ~0.3)

_COCO_FILTER = {"person", "bottle", "cup", "backpack", "handbag", "suitcase"}

_device = "mps" if torch.backends.mps.is_available() else "cpu"

if not _WEIGHTS.exists():
    raise FileNotFoundError(f"COCO weights not found at {_WEIGHTS}")

_model = YOLO(str(_WEIGHTS))

# Cache set by detect_and_track each frame; consumed by diag_raw_detections
# so the diag reuses pass-2 results instead of running a third inference.
_diag_cache = None


def _conf_threshold(cls_name: str) -> float:
    return CONF_PERSON if cls_name == "person" else CONF_OBJECT


def _iou(a: Tuple[int, int, int, int], b: Tuple[int, int, int, int]) -> float:
    """IoU of two (x1,y1,x2,y2) boxes."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter == 0:
        return 0.0
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def detect_frame(frame: np.ndarray) -> List[Dict]:
    """
    Run inference on a single BGR frame.

    Returns a list of dicts: {class, bbox (x1,y1,x2,y2), conf}.
    Filtered to _COCO_FILTER classes only with per-class thresholds.
    """
    results = _model(frame, verbose=False, device=_device)[0]
    detections: List[Dict] = []
    if results.boxes is None:
        return detections

    names = results.names
    for box in results.boxes:
        conf = float(box.conf[0])
        cls_name = names[int(box.cls[0])]
        if cls_name not in _COCO_FILTER or conf < _conf_threshold(cls_name):
            continue
        x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
        detections.append({"class": cls_name, "bbox": (x1, y1, x2, y2), "conf": conf})

    return detections


def diag_raw_detections(frame: np.ndarray) -> Tuple[int, List[float]]:
    """
    DIAGNOSTIC ONLY — returns (total_boxes, bottle_confs) from the raw inference
    already run inside detect_and_track this frame (no additional model call).

    total_boxes  — every box the model produced at conf >= 0.01
    bottle_confs — conf value for each bottle box at any confidence
    """
    global _diag_cache
    results = _diag_cache if _diag_cache is not None else _model(frame, conf=0.01, verbose=False, device=_device)[0]
    total_boxes = len(results.boxes) if results.boxes is not None else 0
    bottle_confs: List[float] = []
    if results.boxes is not None:
        names = results.names
        for box in results.boxes:
            if names[int(box.cls[0])] == "bottle":
                bottle_confs.append(float(box.conf[0]))
    return total_boxes, bottle_confs


def detect_and_track(frame: np.ndarray) -> List[Dict]:
    """
    Run inference + ByteTrack on a single BGR frame.

    Returns a list of dicts: {class, bbox (x1,y1,x2,y2), conf, track_id}.
    track_id is an int when the tracker has assigned one, or None on first appearance.
    Filtered to _COCO_FILTER classes only with per-class thresholds.

    ByteTrack requires two consecutive detections before a new track is "activated"
    and appears in its output. To avoid a one-frame blind-spot on every new or
    re-appearing object, this function runs a second plain inference (pass 2) and
    supplements the tracker output with any detection above the threshold that
    ByteTrack is still holding in its unconfirmed pool. Those entries carry
    track_id=None. The pass-2 result is cached for diag_raw_detections so no
    third inference is needed.
    """
    global _diag_cache

    # Pass 1 — ByteTrack: stable IDs for confirmed tracks
    track_results = _model.track(
        frame, persist=True, tracker=_TRACKER,
        verbose=False, device=_device,
    )[0]

    # Pass 2 — plain NMS at conf=0.01: catches unactivated new tracks; cached for diag
    raw_results = _model(frame, conf=0.01, verbose=False, device=_device)[0]
    _diag_cache = raw_results

    # Build dets from ByteTrack output
    detections: List[Dict] = []
    tracked_bboxes: List[Tuple[int, int, int, int]] = []

    if track_results.boxes is not None:
        names = track_results.names
        for box in track_results.boxes:
            conf = float(box.conf[0])
            cls_name = names[int(box.cls[0])]
            if cls_name not in _COCO_FILTER or conf < _conf_threshold(cls_name):
                continue
            x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
            track_id = int(box.id[0]) if box.id is not None else None
            detections.append({
                "class": cls_name,
                "bbox": (x1, y1, x2, y2),
                "conf": conf,
                "track_id": track_id,
            })
            tracked_bboxes.append((x1, y1, x2, y2))

    # Supplement with raw detections ByteTrack hasn't surfaced yet.
    # IoU > 0.3 with any tracked box means ByteTrack already owns this region.
    if raw_results.boxes is not None:
        names = raw_results.names
        for box in raw_results.boxes:
            conf = float(box.conf[0])
            cls_name = names[int(box.cls[0])]
            if cls_name not in _COCO_FILTER or conf < _conf_threshold(cls_name):
                continue
            x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
            if not any(_iou((x1, y1, x2, y2), tb) > 0.3 for tb in tracked_bboxes):
                detections.append({
                    "class": cls_name,
                    "bbox": (x1, y1, x2, y2),
                    "conf": conf,
                    "track_id": None,
                })

    return detections
