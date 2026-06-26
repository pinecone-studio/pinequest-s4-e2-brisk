"""
Process a motion-triggered camera clip (video + audio) end-to-end.

Typical flow:
  Camera motion → saves MP4 to input/motion/ → this processor runs → violation logged
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

import cv2

from app.audio_detector import analyze_clip, AudioEvent
from app.database import insert_violation
from app.fusion import FusedAlert, fuse
from app.security_detector import detect_video_clip, load_model

logger = logging.getLogger(__name__)

EVIDENCE_DIR = Path("evidence")
EVIDENCE_DIR.mkdir(exist_ok=True)


def _camera_info(config: dict, camera_id: str) -> dict:
    for cam in config.get("cameras", []):
        if cam["id"] == camera_id:
            return {
                "id": cam["id"],
                "name": cam.get("name", camera_id),
                "floor": cam.get("floor", 0),
                "zone": cam.get("zone", "unknown"),
            }
    return {"id": camera_id, "name": camera_id, "floor": 0, "zone": "unknown"}


def _save_evidence_frame(clip_path: Path, frame_number: int, camera_id: str, vtype: str) -> str:
    cap = cv2.VideoCapture(str(clip_path))
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, frame_number - 1))
    ret, frame = cap.read()
    cap.release()

    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    if ret and frame is not None:
        path = EVIDENCE_DIR / f"{ts}_{camera_id}_{vtype}_f{frame_number}.jpg"
        cv2.imwrite(str(path), frame)
        return str(path)

    return str(clip_path)


def process_motion_clip(
    clip_path: str | Path,
    camera_id: str,
    config: Optional[dict] = None,
    config_path: str = "cameras.json",
    write_db: bool = True,
) -> List[Dict]:
    """
    Run video + audio detection on a motion clip, fuse, and optionally log violations.
    Returns list of violation dicts ready for the dashboard.
    """
    clip_path = Path(clip_path)
    if config is None:
        with open(config_path) as f:
            config = json.load(f)

    camera = _camera_info(config, camera_id)
    sample_rate = config.get("sample_rate", 15)
    video_threshold = config.get("confidence_threshold", 0.5)
    audio_threshold = config.get("audio_threshold", 0.35)
    audio_enabled = config.get("audio_enabled", True)

    logger.info("Processing motion clip %s for %s", clip_path.name, camera_id)

    load_model(config)
    frame_results = detect_video_clip(
        clip_path,
        sample_rate=sample_rate,
        confidence_threshold=video_threshold,
        config=config,
    )

    audio_events: List[AudioEvent] = []
    if audio_enabled:
        try:
            audio_events = analyze_clip(clip_path, threshold=audio_threshold)
            logger.info("Audio events: %d", len(audio_events))
        except Exception as exc:
            logger.warning("Audio analysis skipped: %s", exc)

    alerts: List[FusedAlert] = fuse(frame_results, audio_events, config)
    violations: List[Dict] = []

    for alert in alerts:
        frame_num = alert.frame_number or 1
        img_path = _save_evidence_frame(clip_path, frame_num, camera_id, alert.vtype)

        row = {
            "camera_id": camera_id,
            "floor": camera["floor"],
            "zone": camera["zone"],
            "type": alert.vtype,
            "confidence": alert.confidence,
            "source": alert.source,
            "image_path": img_path,
            "clip_path": str(clip_path),
            "audio_label": alert.audio_label,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }

        if write_db:
            row["id"] = insert_violation(
                camera_id=camera_id,
                floor=camera["floor"],
                zone=camera["zone"],
                vtype=alert.vtype,
                confidence=alert.confidence,
                image_path=img_path,
            )

        violations.append(row)
        print(
            f"[{alert.vtype.upper()}] camera={camera_id} "
            f"conf={alert.confidence:.2f} source={alert.source} "
            f"clip={clip_path.name}"
        )

    if not violations:
        logger.info("No violations in clip %s", clip_path.name)

    return violations
