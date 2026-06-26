"""
Fuse video (YOLO11) and audio (YAMNet) signals into confirmed violations.

Modes (cameras.json `fusion_mode`):
  any      — fire if either modality exceeds its threshold (default)
  both     — require video AND audio agreement
  weighted — combined score must exceed fusion_threshold
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Dict, List, Optional

from app.audio_detector import AudioEvent

logger = logging.getLogger(__name__)


@dataclass
class FusedAlert:
    vtype: str
    confidence: float
    source: str  # "video" | "audio" | "both"
    video_conf: float
    audio_conf: float
    audio_label: Optional[str] = None
    frame_number: Optional[int] = None


def _best_video_by_type(frame_results: List[Dict]) -> Dict[str, Dict]:
    """{vtype: {confidence, frame_number, detections}}"""
    best: Dict[str, Dict] = {}
    for frame in frame_results:
        for det in frame.get("detections", []):
            vtype = det["type"]
            conf = det["confidence"]
            if vtype not in best or conf > best[vtype]["confidence"]:
                best[vtype] = {
                    "confidence": conf,
                    "frame_number": frame.get("frame_number"),
                    "detections": frame.get("detections", []),
                }
    return best


def _best_audio_by_type(audio_events: List[AudioEvent]) -> Dict[str, AudioEvent]:
    best: Dict[str, AudioEvent] = {}
    for ev in audio_events:
        if ev.vtype not in best or ev.confidence > best[ev.vtype].confidence:
            best[ev.vtype] = ev
    return best


def fuse(
    frame_results: List[Dict],
    audio_events: List[AudioEvent],
    config: Optional[dict] = None,
) -> List[FusedAlert]:
    cfg = config or {}
    mode = cfg.get("fusion_mode", "any")
    video_threshold = cfg.get("confidence_threshold", 0.5)
    audio_threshold = cfg.get("audio_threshold", 0.35)
    fusion_threshold = cfg.get("fusion_threshold", 0.65)
    video_weight = cfg.get("fusion_video_weight", 0.6)
    audio_weight = cfg.get("fusion_audio_weight", 0.4)

    video_best = _best_video_by_type(frame_results)
    audio_best = _best_audio_by_type(audio_events)

    all_types = set(video_best.keys()) | set(audio_best.keys())
    alerts: List[FusedAlert] = []

    for vtype in all_types:
        v = video_best.get(vtype)
        a = audio_best.get(vtype)
        v_conf = v["confidence"] if v else 0.0
        a_conf = a.confidence if a else 0.0
        v_ok = v_conf >= video_threshold
        a_ok = a_conf >= audio_threshold

        fired = False
        source = "video"
        final_conf = v_conf

        if mode == "both":
            if v_ok and a_ok:
                fired = True
                source = "both"
                final_conf = round((v_conf + a_conf) / 2, 4)
        elif mode == "weighted":
            combined = video_weight * v_conf + audio_weight * a_conf
            if combined >= fusion_threshold and (v_ok or a_ok):
                fired = True
                source = "both" if v_ok and a_ok else ("video" if v_ok else "audio")
                final_conf = round(combined, 4)
        else:  # any
            if v_ok:
                fired = True
                source = "video"
                final_conf = v_conf
            elif a_ok:
                fired = True
                source = "audio"
                final_conf = a_conf
            if v_ok and a_ok:
                source = "both"
                final_conf = round(max(v_conf, a_conf), 4)

        if not fired:
            continue

        alerts.append(FusedAlert(
            vtype=vtype,
            confidence=final_conf,
            source=source,
            video_conf=round(v_conf, 4),
            audio_conf=round(a_conf, 4),
            audio_label=a.label if a else None,
            frame_number=v.get("frame_number") if v else None,
        ))
        logger.info(
            "Fusion alert: type=%s source=%s conf=%.2f (video=%.2f audio=%.2f)",
            vtype, source, final_conf, v_conf, a_conf,
        )

    return sorted(alerts, key=lambda x: x.confidence, reverse=True)
