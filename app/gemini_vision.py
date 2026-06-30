"""
Gemini vision detection for the Aegis CCTV pipeline.

Sends a single camera frame to Google's standard Gemini vision model and asks
for labeled bounding boxes. Unlike the YOLO detectors in this repo (which output
fixed classes), Gemini is prompted to report three things:

  * "smoking"     — a person smoking / holding a lit cigarette/vape
  * "littering"   — a person dropping/leaving trash on the ground
  * "suspicious"  — any other notable activity, with a free-text description
                    (fighting, a fall, loitering, intrusion, an abandoned bag...)

Gemini returns boxes in its documented spatial-understanding format:
`box_2d = [ymin, xmin, ymax, xmax]` normalised to 0-1000. We convert those to
pixel (x1, y1, x2, y2) against the real frame size before returning them, so the
rest of the pipeline can treat them exactly like a YOLO bbox.

Requires:
  pip install google-genai
  GEMINI_API_KEY=... in your environment (or .env)
"""

from __future__ import annotations

import json
import logging
import os
from typing import Dict, List, Optional

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Categories we map straight onto the existing "violations" table types.
# Anything else Gemini reports is recorded as type "suspicious".
_KNOWN_TYPES = {"smoking", "littering"}

_PROMPT = (
    "You are a security camera analyst. Look at this single CCTV frame and report "
    "ONLY genuinely notable events. Detect:\n"
    "  - smoking: a person smoking or holding a lit cigarette/cigar/vape.\n"
    "  - littering: a person dropping, throwing, or leaving trash on the ground.\n"
    "  - suspicious: any other clearly notable activity (a fight, a person falling, "
    "an abandoned bag, forced entry, someone climbing/jumping a barrier, loitering).\n\n"
    "Do NOT report ordinary, harmless behaviour. If nothing notable is happening, "
    "return an empty array.\n\n"
    "Return STRICT JSON: an array of objects, each with exactly these keys:\n"
    '  "type": one of "smoking", "littering", "suspicious"\n'
    '  "label": a short human label (e.g. "person smoking", "abandoned backpack")\n'
    '  "description": one short sentence describing what you see\n'
    '  "confidence": a number from 0 to 1\n'
    '  "box_2d": [ymin, xmin, ymax, xmax] integers normalised to 0-1000\n'
    "Return only the JSON array, no markdown, no commentary."
)

_client = None
_model_name = "gemini-2.5-flash"


def configure(model: Optional[str] = None) -> None:
    """Initialise the Gemini client. Safe to call more than once."""
    global _client, _model_name
    if model:
        _model_name = model
    if _client is not None:
        return

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Add it to your .env or environment. "
            "Get a key at https://aistudio.google.com/apikey"
        )

    from google import genai  # imported lazily so the rest of the app doesn't need it

    _client = genai.Client(api_key=api_key)
    logger.info("Gemini vision client ready (model=%s)", _model_name)


def _extract_json(text: str) -> list:
    """Gemini usually returns clean JSON, but strip ```json fences just in case."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1] if "```" in text[3:] else text
        text = text.lstrip("json").strip().strip("`").strip()
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end == -1:
        return []
    try:
        parsed = json.loads(text[start : end + 1])
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError as exc:
        logger.warning("Could not parse Gemini JSON: %s", exc)
        return []


def _to_pixels(box_2d, width: int, height: int):
    """[ymin, xmin, ymax, xmax] in 0-1000 -> (x1, y1, x2, y2) clamped pixels."""
    try:
        ymin, xmin, ymax, xmax = (float(v) for v in box_2d)
    except (ValueError, TypeError):
        return None
    x1 = int(max(0, min(width - 1, xmin / 1000.0 * width)))
    y1 = int(max(0, min(height - 1, ymin / 1000.0 * height)))
    x2 = int(max(0, min(width, xmax / 1000.0 * width)))
    y2 = int(max(0, min(height, ymax / 1000.0 * height)))
    if x2 <= x1 or y2 <= y1:
        return None
    return (x1, y1, x2, y2)


def detect(frame: np.ndarray, confidence_threshold: float = 0.5) -> List[Dict]:
    """
    Run Gemini on one BGR frame.

    Returns a list of dicts shaped like the YOLO detectors in this repo:
      {type, label, description, confidence, bbox: (x1, y1, x2, y2)}
    """
    if _client is None:
        configure()

    height, width = frame.shape[:2]
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        return []

    from google.genai import types

    try:
        response = _client.models.generate_content(
            model=_model_name,
            contents=[
                types.Part.from_bytes(data=buf.tobytes(), mime_type="image/jpeg"),
                _PROMPT,
            ],
            config=types.GenerateContentConfig(
                temperature=0.0,
                response_mime_type="application/json",
            ),
        )
    except Exception as exc:  # noqa: BLE001 — network/quota/etc shouldn't crash the loop
        logger.warning("Gemini request failed: %s", exc)
        return []

    items = _extract_json(response.text or "")
    detections: List[Dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        raw_type = str(item.get("type", "suspicious")).lower().strip()
        vtype = raw_type if raw_type in _KNOWN_TYPES else "suspicious"
        try:
            conf = float(item.get("confidence", 0))
        except (ValueError, TypeError):
            conf = 0.0
        if conf < confidence_threshold:
            continue
        bbox = _to_pixels(item.get("box_2d"), width, height)
        if bbox is None:
            continue
        detections.append(
            {
                "type": vtype,
                "label": str(item.get("label", vtype))[:80],
                "description": str(item.get("description", ""))[:200],
                "confidence": conf,
                "bbox": bbox,
            }
        )
    return detections
