"""
Hybrid detection: cheap local motion detection gates the Gemini calls.

Division of labour:

  * LOCAL motion detector (this module) runs on EVERY frame. It is essentially
    free, needs no model, and answers one question: "did something just move?"
    It draws a box around the moving region so the live view always has a marker.

  * GEMINI does ALL the heavy work — it is only called when something is moving,
    and at most once per `gemini_interval_sec`. Gemini produces the real labelled
    boxes and the smoking/littering/suspicious judgment.

So the local model is a dumb tripwire; Gemini is the brain. On a still scene,
zero Gemini calls are made.
"""

from __future__ import annotations

import logging
import time
from typing import Dict, List, Tuple

import cv2
import numpy as np

from app import gemini_vision
from app.gemini_pipeline import CameraEventTracker

logger = logging.getLogger(__name__)


def _find_motion(mask: np.ndarray, min_area: int) -> List[Dict]:
    """Turn a foreground mask into a list of motion boxes above min_area."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes: List[Dict] = []
    frame_area = mask.shape[0] * mask.shape[1]
    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area:
            continue
        x, y, w, h = cv2.boundingRect(c)
        boxes.append(
            {
                "class": "motion",
                "bbox": (x, y, x + w, y + h),
                "conf": min(area / frame_area * 10.0, 1.0),  # rough "how much moved"
            }
        )
    return boxes


class HybridDetector:
    """Per-camera: motion gate on every frame, throttled Gemini call when moving."""

    def __init__(self, camera_info: dict, cfg: dict):
        self.camera_id = camera_info["id"]
        self.tracker = CameraEventTracker(
            camera_info,
            confirm=int(cfg.get("gemini_confirm", 1)),
            cooldown_minutes=float(cfg.get("cooldown_minutes", 5)),
        )
        # Background-subtraction motion detector — good for fixed CCTV views.
        self._bg = cv2.createBackgroundSubtractorMOG2(
            history=500, varThreshold=25, detectShadows=False
        )
        self.min_area = int(cfg.get("motion_min_area", 1500))
        self.gemini_conf = float(cfg.get("gemini_confidence", 0.5))
        self.min_interval = float(cfg.get("gemini_interval_sec", 3))
        self._last_gemini = 0.0

    def _detect_motion(self, frame: np.ndarray) -> List[Dict]:
        mask = self._bg.apply(frame)
        # Drop speckle, then close gaps so a person reads as one blob.
        mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)[1]
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        mask = cv2.dilate(mask, np.ones((9, 9), np.uint8), iterations=2)
        return _find_motion(mask, self.min_area)

    def process(self, frame: np.ndarray) -> Tuple[List[Dict], List[Dict]]:
        """
        Detect motion, and call Gemini if something moved and the throttle allows.

        Returns (motion_boxes, fired_events):
          motion_boxes — every-frame motion regions for the live view
          fired_events — confirmed Gemini violation dicts (usually empty)
        """
        try:
            motion_boxes = self._detect_motion(frame)
        except Exception as exc:  # noqa: BLE001 — never let the gate crash the loop
            logger.warning("%s motion gate failed: %s", self.camera_id, exc)
            motion_boxes = []

        fired: List[Dict] = []
        now = time.monotonic()
        if motion_boxes and (now - self._last_gemini) >= self.min_interval:
            self._last_gemini = now
            gem_dets = gemini_vision.detect(frame, self.gemini_conf)
            fired = self.tracker.evaluate(frame, gem_dets)
        return motion_boxes, fired
