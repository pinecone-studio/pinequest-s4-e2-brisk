"""
YOLO11 security detector — violence & vandalism from video frames.

Loads weights from cameras.json `security_model_path` (default: models/security.pt).
Falls back to smoking.pt if security weights are missing (dev convenience).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, List, Optional

import cv2
import numpy as np
import torch

logger = logging.getLogger(__name__)

_model = None
_class_map: Dict[int, str] = {}
_weights_path: Optional[Path] = None

# Normalise Roboflow / custom class names → dashboard violation types
_CLASS_ALIASES = {
    "violence": "violence",
    "fight": "violence",
    "fighting": "violence",
    "weapon": "violence",
    "gun": "violence",
    "knife": "violence",
    "person-fight": "violence",
    "vandalism": "vandalism",
    "graffiti": "vandalism",
    "damage": "vandalism",
    "broken": "vandalism",
    "smoking": "smoking",
}


def _pick_device() -> str:
    if torch.cuda.is_available():
        return "0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _resolve_weights(config: Optional[dict] = None) -> Path:
    if config:
        raw = config.get("security_model_path") or config.get("model_path")
        if raw:
            p = Path(raw)
            if p.exists():
                return p
    for candidate in (Path("models/security.pt"), Path("models/smoking.pt")):
        if candidate.exists():
            return candidate
    return Path("models/security.pt")


def _normalise_type(name: str) -> Optional[str]:
    key = name.lower().replace(" ", "-").replace("_", "-")
    if key in _CLASS_ALIASES:
        return _CLASS_ALIASES[key]
    for alias, vtype in _CLASS_ALIASES.items():
        if alias in key:
            return vtype
    return None


def load_model(config: Optional[dict] = None, force_reload: bool = False):
    global _model, _class_map, _weights_path

    weights = _resolve_weights(config)
    if _model is not None and _weights_path == weights and not force_reload:
        return _model

    if not weights.exists():
        raise FileNotFoundError(
            f"Security weights not found at {weights}.\n"
            "Run: python scripts/train_security_model.py --download-only\n"
            "Then: python scripts/train_security_model.py --epochs 10"
        )

    from ultralytics import YOLO

    device = _pick_device()
    _model = YOLO(str(weights))
    _weights_path = weights
    _class_map = {int(k): str(v) for k, v in _model.names.items()}
    logger.info("Security model loaded from %s (device: %s, classes: %s)", weights, device, _class_map)
    return _model


def detect_frame(
    frame: np.ndarray,
    confidence_threshold: float = 0.5,
    config: Optional[dict] = None,
) -> List[Dict]:
    """Return detections: {type, confidence, bbox, label}."""
    model = load_model(config)
    device = _pick_device()

    try:
        results = model(frame, verbose=False, device=device)[0]
    except Exception as exc:
        logger.error("Security detection error: %s", exc)
        return []

    detections: List[Dict] = []
    if results.boxes is None:
        return detections

    for box in results.boxes:
        cls_id = int(box.cls[0])
        conf = float(box.conf[0])
        if conf < confidence_threshold:
            continue

        raw_name = _class_map.get(cls_id, str(cls_id))
        vtype = _normalise_type(raw_name)
        if vtype is None:
            continue

        x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
        detections.append({
            "type": vtype,
            "label": raw_name,
            "confidence": conf,
            "bbox": [x1, y1, x2, y2],
        })

    return detections


def detect_video_clip(
    clip_path: str | Path,
    sample_rate: int = 15,
    confidence_threshold: float = 0.5,
    config: Optional[dict] = None,
) -> List[Dict]:
    """
    Sample frames from a motion clip and return per-frame detections.
    Each item: {frame_number, timestamp_sec, detections: [...]}
    """
    clip_path = Path(clip_path)
    cap = cv2.VideoCapture(str(clip_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open clip: {clip_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    frames_out: List[Dict] = []
    frame_idx = 0

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            frame_idx += 1
            if frame_idx % sample_rate != 0:
                continue

            dets = detect_frame(frame, confidence_threshold, config)
            if dets:
                frames_out.append({
                    "frame_number": frame_idx,
                    "timestamp_sec": round(frame_idx / fps, 2),
                    "detections": dets,
                })
    finally:
        cap.release()

    return frames_out
