import logging
from collections import defaultdict, deque
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
import torch

logger = logging.getLogger(__name__)

# Class index for smoking in the Roboflow smoking-bjzv1 dataset
_SMOKING_CLASS = 1

_model = None


def _get_model() -> object:
    global _model
    if _model is None:
        from ultralytics import YOLO

        weights = Path("models/smoking.pt")
        if not weights.exists():
            raise FileNotFoundError(
                f"Model weights not found at {weights}. "
                "Run: python3 scripts/train_model.py"
            )
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        _model = YOLO(str(weights))
        logger.info("Smoking detection model loaded from %s (device: %s)", weights, device)
    return _model


def detect(frame: np.ndarray, camera_info: dict, confidence_threshold: float) -> List[Dict]:
    """Run inference on a single frame. Used by the live RTSP pipeline (main.py)."""
    model = _get_model()
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    try:
        results = model(frame, verbose=False, device=device)[0]
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
        if cls_id != _SMOKING_CLASS or conf < confidence_threshold:
            continue
        x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
        detections.append({"type": "smoking", "confidence": conf, "bbox": [x1, y1, x2, y2]})

    return detections


def _annotate(frame: np.ndarray, detections: List[Dict], camera_id: str, ts: str) -> np.ndarray:
    annotated = frame.copy()
    for det in detections:
        x1, y1, x2, y2 = det["bbox"]
        conf = det["confidence"]
        cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 0, 255), 2)
        cv2.putText(
            annotated,
            f"smoking {conf:.2f}",
            (x1, max(y1 - 8, 12)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 255), 2, cv2.LINE_AA,
        )
    cv2.putText(
        annotated,
        f"{camera_id} | {ts}",
        (10, 28),
        cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 200, 0), 2, cv2.LINE_AA,
    )
    return annotated


class VideoProcessor:
    """
    Processes a video source (file path or RTSP URL) for smoking detection.
    The source abstraction is intentional: swapping a .mp4 path for an rtsp:// URL
    requires no code changes.
    """

    def __init__(self, config: dict):
        self.sample_rate: int = config.get("sample_rate", 15)
        self.confidence_threshold: float = config.get("confidence_threshold", 0.75)
        self.temporal_window: int = config.get("temporal_window", 5)
        self.cooldown_minutes: int = config.get("cooldown_minutes", 5)

        # {camera_id: deque of bool} — consecutive detections counter
        self._windows: Dict[str, deque] = defaultdict(
            lambda: deque(maxlen=self.temporal_window)
        )
        # {camera_id: datetime} — last confirmed alert
        self._cooldowns: Dict[str, datetime] = {}

    def _on_cooldown(self, camera_id: str) -> bool:
        last = self._cooldowns.get(camera_id)
        if last is None:
            return False
        return datetime.now() - last < timedelta(minutes=self.cooldown_minutes)

    def process(
        self,
        source: str,
        camera_info: dict,
        output_path: Optional[str] = None,
    ) -> List[Dict]:
        """
        Process `source` (video file path or RTSP URL) and return detection events.
        Each event: {camera_id, timestamp, confidence, frame_number, snapshot_path}
        """
        camera_id = camera_info["id"]
        model = _get_model()
        device = "mps" if torch.backends.mps.is_available() else "cpu"

        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open source: {source}")

        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or -1

        writer = None
        if output_path:
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer = cv2.VideoWriter(output_path, fourcc, fps / self.sample_rate, (width, height))

        events: List[Dict] = []
        frame_idx = 0
        sampled = 0

        logger.info(
            "Processing %s — fps=%.1f size=%dx%d total_frames=%s sample_rate=%d",
            source, fps, width, height, total if total > 0 else "?", self.sample_rate,
        )

        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    break

                frame_idx += 1
                if frame_idx % self.sample_rate != 0:
                    continue

                sampled += 1
                ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                try:
                    results = model(frame, verbose=False, device=device)[0]
                except Exception as exc:
                    logger.error("Inference error frame %d: %s", frame_idx, exc)
                    continue

                detections = []
                if results.boxes is not None:
                    for box in results.boxes:
                        cls_id = int(box.cls[0])
                        conf = float(box.conf[0])
                        if cls_id == _SMOKING_CLASS and conf >= self.confidence_threshold:
                            x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
                            detections.append({
                                "type": "smoking",
                                "confidence": conf,
                                "bbox": [x1, y1, x2, y2],
                            })

                detected_now = len(detections) > 0
                window = self._windows[camera_id]
                window.append(detected_now)

                annotated = _annotate(frame, detections, camera_id, ts) if detections else frame

                if writer:
                    writer.write(annotated)

                confirmed = (
                    len(window) == self.temporal_window
                    and all(window)
                    and not self._on_cooldown(camera_id)
                )

                if confirmed:
                    best_conf = max(d["confidence"] for d in detections)
                    self._cooldowns[camera_id] = datetime.now()
                    window.clear()

                    snapshot_path = self._save_snapshot(annotated, camera_id, frame_idx)

                    event = {
                        "camera_id": camera_id,
                        "timestamp": ts,
                        "confidence": round(best_conf, 4),
                        "frame_number": frame_idx,
                        "snapshot_path": snapshot_path,
                    }
                    events.append(event)
                    print(
                        f"[SMOKING DETECTED] camera={camera_id} "
                        f"frame={frame_idx} conf={best_conf:.2f} ts={ts}"
                    )
                    logger.info("Smoking confirmed: %s", event)

                    self._record_violation(camera_info, best_conf, snapshot_path)

        finally:
            cap.release()
            if writer:
                writer.release()

        logger.info(
            "Done — %d frames read, %d sampled, %d events fired",
            frame_idx, sampled, len(events),
        )
        return events

    @staticmethod
    def _save_snapshot(frame: np.ndarray, camera_id: str, frame_idx: int) -> str:
        ts_str = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        path = Path("evidence") / f"{ts_str}_{camera_id}_f{frame_idx}.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(path), frame)
        return str(path)

    @staticmethod
    def _record_violation(camera_info: dict, confidence: float, snapshot_path: str):
        try:
            from app.database import insert_violation
            insert_violation(
                camera_id=camera_info["id"],
                floor=camera_info.get("floor", 0),
                zone=camera_info.get("zone", "unknown"),
                vtype="smoking",
                confidence=confidence,
                image_path=snapshot_path,
            )
        except Exception as exc:
            logger.warning("Could not write to database: %s", exc)
