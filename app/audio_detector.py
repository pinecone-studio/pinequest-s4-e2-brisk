"""
Audio event detection for motion-triggered camera clips.

Uses YAMNet (AudioSet) to flag violence/vandalism-related sounds:
screams, glass breaking, impacts, explosions, gunshots, etc.

Usage:
    from app.audio_detector import analyze_clip
    events = analyze_clip("input/motion_clip.wav")
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import numpy as np

logger = logging.getLogger(__name__)

# YAMNet / AudioSet display names we treat as security-relevant
SECURITY_SOUND_KEYWORDS = {
    "violence": [
        "Scream", "Yell", "Shout", "Groan", "Grunt", "Crying, sobbing",
        "Slap, smack", "Punch", "Whack, thwack", "Smash, crash",
        "Explosion", "Gunshot, gunfire", "Machine gun", "Burst, pop",
        "Glass", "Shatter", "Breaking", "Crack", "Snap",
        "Scrape", "Scratch", "Hammer", "Power tool", "Drill",
        "Alarm", "Siren", "Emergency vehicle",
    ],
}

# Map keyword hits to violation types surfaced in the dashboard
KEYWORD_TO_TYPE = {
    "Scream": "violence",
    "Yell": "violence",
    "Shout": "violence",
    "Groan": "violence",
    "Crying, sobbing": "violence",
    "Slap, smack": "violence",
    "Punch": "violence",
    "Whack, thwack": "violence",
    "Smash, crash": "vandalism",
    "Explosion": "violence",
    "Gunshot, gunfire": "violence",
    "Machine gun": "violence",
    "Glass": "vandalism",
    "Shatter": "vandalism",
    "Breaking": "vandalism",
    "Crack": "vandalism",
    "Snap": "vandalism",
    "Hammer": "vandalism",
    "Power tool": "vandalism",
    "Drill": "vandalism",
}

_model = None
_class_names: Optional[List[str]] = None


@dataclass
class AudioEvent:
    label: str
    vtype: str
    confidence: float
    start_sec: float
    end_sec: float


def _load_yamnet():
    global _model, _class_names
    if _model is not None:
        return _model, _class_names

    import tensorflow_hub as hub

    logger.info("Loading YAMNet from TensorFlow Hub…")
    _model = hub.load("https://tfhub.dev/google/yamnet/1")
    class_map_path = _model.class_map_path().numpy().decode("utf-8")
    _class_names = [line.strip() for line in Path(class_map_path).read_text().splitlines()[1:]]
    logger.info("YAMNet ready (%d classes)", len(_class_names))
    return _model, _class_names


def extract_audio_from_video(video_path: str | Path, wav_path: Optional[str | Path] = None) -> Path:
    """Extract mono 16 kHz WAV from a video clip (requires ffmpeg on PATH)."""
    video_path = Path(video_path)
    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    if wav_path is None:
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        wav_path = Path(tmp.name)
        tmp.close()
    else:
        wav_path = Path(wav_path)

    cmd = [
        "ffmpeg", "-y", "-i", str(video_path),
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        str(wav_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[-500:]}")

    return wav_path


def _load_wav(path: Path) -> np.ndarray:
    import scipy.io.wavfile as wavfile

    sr, audio = wavfile.read(str(path))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    audio = audio.astype(np.float32)
    if audio.max() > 1.0:
        audio /= 32768.0
    if sr != 16000:
        raise ValueError(f"Expected 16 kHz WAV, got {sr} Hz — re-extract with ffmpeg")
    return audio


def _match_security_label(display_name: str) -> Optional[str]:
    for keyword, vtype in KEYWORD_TO_TYPE.items():
        if keyword.lower() in display_name.lower():
            return vtype
    for group in SECURITY_SOUND_KEYWORDS.values():
        for keyword in group:
            if keyword.lower() in display_name.lower():
                return KEYWORD_TO_TYPE.get(keyword, "violence")
    return None


def analyze_wav(
    wav_path: str | Path,
    threshold: float = 0.35,
    clip_duration: float = 0.96,
) -> List[AudioEvent]:
    """Run YAMNet on a WAV file and return security-relevant events."""
    model, class_names = _load_yamnet()
    wav_path = Path(wav_path)
    waveform = _load_wav(wav_path)

    scores, embeddings, spectrogram = model(waveform)
    scores_np = scores.numpy()

    events: List[AudioEvent] = []
    for frame_idx, frame_scores in enumerate(scores_np):
        top_idx = int(np.argmax(frame_scores))
        top_score = float(frame_scores[top_idx])
        if top_score < threshold:
            continue

        label = class_names[top_idx]
        vtype = _match_security_label(label)
        if vtype is None:
            continue

        start = frame_idx * clip_duration
        events.append(AudioEvent(
            label=label,
            vtype=vtype,
            confidence=top_score,
            start_sec=round(start, 2),
            end_sec=round(start + clip_duration, 2),
        ))

    # Deduplicate: keep highest-confidence event per (vtype, ~1s bucket)
    best: dict[tuple[str, int], AudioEvent] = {}
    for ev in events:
        bucket = int(ev.start_sec)
        key = (ev.vtype, bucket)
        if key not in best or ev.confidence > best[key].confidence:
            best[key] = ev

    return sorted(best.values(), key=lambda e: e.confidence, reverse=True)


def analyze_clip(
    clip_path: str | Path,
    threshold: float = 0.35,
    keep_wav: bool = False,
) -> List[AudioEvent]:
    """
    Analyze a motion clip (MP4/AVI/WAV). Extracts audio if needed.
    Returns list of AudioEvent sorted by confidence.
    """
    clip_path = Path(clip_path)
    suffix = clip_path.suffix.lower()

    if suffix == ".wav":
        return analyze_wav(clip_path, threshold=threshold)

    wav_path = extract_audio_from_video(clip_path)
    try:
        return analyze_wav(wav_path, threshold=threshold)
    finally:
        if not keep_wav:
            wav_path.unlink(missing_ok=True)


def top_event(events: List[AudioEvent]) -> Optional[AudioEvent]:
    return events[0] if events else None
