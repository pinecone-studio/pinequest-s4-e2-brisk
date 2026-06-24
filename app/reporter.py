import cv2
import logging
import numpy as np
from collections import defaultdict, deque
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Set, Tuple

from app.database import insert_violation

logger = logging.getLogger(__name__)

EVIDENCE_DIR = Path("evidence")
EVIDENCE_DIR.mkdir(exist_ok=True)

# {(camera_id, vtype): deque of detection lists}
_windows: Dict[Tuple[str, str], deque] = defaultdict(lambda: deque(maxlen=5))
# {(camera_id, vtype): datetime of last confirmed violation}
_cooldowns: Dict[Tuple[str, str], datetime] = {}


def _is_on_cooldown(camera_id: str, vtype: str, cooldown_minutes: int) -> bool:
    key = (camera_id, vtype)
    last = _cooldowns.get(key)
    if last is None:
        return False
    return datetime.now() - last < timedelta(minutes=cooldown_minutes)


def _set_cooldown(camera_id: str, vtype: str):
    _cooldowns[(camera_id, vtype)] = datetime.now()


def _annotate_frame(frame: np.ndarray, detections: List[Dict],
                    camera_info: dict, vtype: str) -> np.ndarray:
    annotated = frame.copy()
    for det in detections:
        if det["type"] != vtype:
            continue
        x1, y1, x2, y2 = det["bbox"]
        cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 0, 255), 2)

    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    label = (f"{camera_info['id']} | Floor {camera_info['floor']} "
             f"| {camera_info['zone']} | {vtype.upper()} | {ts}")
    cv2.putText(annotated, label, (10, 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 0, 255), 2, cv2.LINE_AA)
    return annotated


def process(frame: np.ndarray, detections: List[Dict],
            camera_info: dict, temporal_window: int, cooldown_minutes: int) -> List[Dict]:
    camera_id = camera_info["id"]
    fired: List[Dict] = []

    violation_types = {d["type"] for d in detections if d["type"] != "person"}

    for vtype in violation_types:
        key = (camera_id, vtype)
        window = _windows[key]
        window.append(True)

        # need temporal_window consecutive positive frames
        if len(window) < temporal_window or not all(window):
            continue

        if _is_on_cooldown(camera_id, vtype, cooldown_minutes):
            continue

        relevant = [d for d in detections if d["type"] == vtype]
        best_conf = max(d["confidence"] for d in relevant)

        annotated = _annotate_frame(frame, detections, camera_info, vtype)
        ts_str = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        fname = f"{ts_str}_{camera_id}_{vtype}.jpg"
        img_path = str(EVIDENCE_DIR / fname)
        cv2.imwrite(img_path, annotated)

        row_id = insert_violation(
            camera_id=camera_id,
            floor=camera_info["floor"],
            zone=camera_info["zone"],
            vtype=vtype,
            confidence=round(best_conf, 4),
            image_path=img_path,
        )
        _set_cooldown(camera_id, vtype)
        window.clear()

        violation = {
            "id": row_id,
            "camera_id": camera_id,
            "floor": camera_info["floor"],
            "zone": camera_info["zone"],
            "type": vtype,
            "confidence": round(best_conf, 4),
            "image_path": img_path,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        logger.info("Violation confirmed: %s", violation)
        fired.append(violation)

    # fill window with False for types not detected this frame
    for key in list(_windows.keys()):
        cam, vtype = key
        if cam == camera_id and vtype not in violation_types:
            _windows[key].append(False)

    return fired
