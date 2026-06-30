"""
Shared event logic for the Gemini detection pipeline.

Both the live runner (main.py) and the standalone tester (gemini_cctv.py) feed
Gemini's per-frame detections through a CameraEventTracker. The tracker applies
temporal confirmation + a per-type cooldown, writes an annotated snapshot to
evidence/, inserts a row in the violations DB, and returns a violation dict in
the exact shape the dashboard/WebSocket expects (see app/reporter.py).
"""

from __future__ import annotations

import logging
from collections import defaultdict, deque
from datetime import datetime, timedelta
from pathlib import Path
from typing import Deque, Dict, List

import cv2
import numpy as np

from app.database import insert_violation

logger = logging.getLogger(__name__)

EVIDENCE_DIR = Path("evidence")

# Box colour per event type (BGR).
_COLORS = {
    "smoking": (0, 0, 255),
    "littering": (0, 165, 255),
    "suspicious": (0, 255, 255),
}


def annotate(frame: np.ndarray, detections: List[Dict], camera_id: str, ts: str) -> np.ndarray:
    out = frame.copy()
    for det in detections:
        x1, y1, x2, y2 = det["bbox"]
        color = _COLORS.get(det["type"], (0, 200, 0))
        label = f"{det.get('label', det['type'])} {det['confidence']:.2f}"
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
        cv2.putText(
            out, label, (x1, max(y1 - 8, 14)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2, cv2.LINE_AA,
        )
    cv2.putText(
        out, f"{camera_id} | {ts}", (10, 26),
        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 0), 2, cv2.LINE_AA,
    )
    return out


class CameraEventTracker:
    """Per-camera confirmation + cooldown state for one source's Gemini events."""

    def __init__(self, camera_info: dict, confirm: int = 1, cooldown_minutes: float = 5):
        self.camera = camera_info
        self.camera_id = camera_info["id"]
        self.confirm = max(int(confirm), 1)
        self.cooldown = timedelta(minutes=float(cooldown_minutes))
        self._streak: Dict[str, Deque[bool]] = defaultdict(
            lambda: deque(maxlen=self.confirm)
        )
        self._last_fired: Dict[str, datetime] = {}

    def _on_cooldown(self, vtype: str) -> bool:
        last = self._last_fired.get(vtype)
        return last is not None and datetime.now() - last < self.cooldown

    def evaluate(self, frame: np.ndarray, detections: List[Dict]) -> List[Dict]:
        """
        Feed one Gemini result for this camera. Returns the list of violation
        dicts that were confirmed and recorded this call (usually empty).
        """
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        seen_types = {d["type"] for d in detections}

        # Every tracked type gets a sample: True if seen this frame, else False.
        for vtype in set(self._streak) | seen_types:
            self._streak[vtype].append(vtype in seen_types)

        fired: List[Dict] = []
        for vtype in seen_types:
            streak = self._streak[vtype]
            confirmed = len(streak) >= self.confirm and all(streak)
            if not confirmed or self._on_cooldown(vtype):
                continue

            best = max(
                (d for d in detections if d["type"] == vtype),
                key=lambda d: d["confidence"],
            )
            self._last_fired[vtype] = datetime.now()
            streak.clear()

            violation = self._record(frame, detections, best, vtype, ts)
            fired.append(violation)
        return fired

    def _record(self, frame, detections, best, vtype, ts) -> Dict:
        EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
        annotated = annotate(frame, detections, self.camera_id, ts)
        ts_str = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        img_path = str(EVIDENCE_DIR / f"{ts_str}_{self.camera_id}_{vtype}.jpg")
        cv2.imwrite(img_path, annotated)

        floor = int(self.camera.get("floor", 0) or 0)
        zone = str(self.camera.get("zone", "unknown"))
        conf = round(float(best["confidence"]), 4)

        row_id = None
        try:
            row_id = insert_violation(
                camera_id=self.camera_id, floor=floor, zone=zone,
                vtype=vtype, confidence=conf, image_path=img_path,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not write event to DB: %s", exc)

        violation = {
            "id": row_id,
            "camera_id": self.camera_id,
            "floor": floor,
            "zone": zone,
            "type": vtype,
            "confidence": conf,
            "image_path": img_path,
            "created_at": ts,
            "label": best.get("label", vtype),
            "description": best.get("description", ""),
        }
        desc = f" — {violation['description']}" if violation["description"] else ""
        logger.info(
            "[%s] camera=%s conf=%.2f%s -> %s",
            vtype.upper(), self.camera_id, conf, desc, img_path,
        )
        return violation
