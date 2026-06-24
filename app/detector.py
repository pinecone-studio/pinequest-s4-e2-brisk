import logging
import numpy as np
from pathlib import Path
from typing import Dict, List

logger = logging.getLogger(__name__)

# YOLO class indices we care about (COCO dataset)
_PERSON = 0
_SUITCASE = 28
_HANDBAG = 26
_BACKPACK = 24

_GARBAGE_CLASSES = {_SUITCASE, _HANDBAG, _BACKPACK}

_model = None


def _get_model():
    global _model
    if _model is None:
        from ultralytics import YOLO
        model_path = Path("models/yolov8n.pt")
        _model = YOLO(str(model_path) if model_path.exists() else "yolov8n.pt")
        logger.info("YOLOv8n model loaded")
    return _model


def detect(frame: np.ndarray, camera_info: dict, confidence_threshold: float) -> List[Dict]:
    model = _get_model()
    try:
        results = model(frame, verbose=False)[0]
    except Exception as exc:
        logger.error("Detection error on %s: %s", camera_info.get("id"), exc)
        return []

    detections = []
    boxes = results.boxes
    if boxes is None:
        return detections

    for box in boxes:
        cls_id = int(box.cls[0])
        conf = float(box.conf[0])
        if conf < confidence_threshold:
            continue

        x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
        bbox = [x1, y1, x2, y2]

        if cls_id == _PERSON:
            detections.append({"type": "person", "confidence": conf, "bbox": bbox})
        elif cls_id in _GARBAGE_CLASSES:
            detections.append({"type": "garbage", "confidence": conf, "bbox": bbox})

    return detections
