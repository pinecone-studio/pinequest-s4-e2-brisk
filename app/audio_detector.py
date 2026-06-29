"""
Audio event detection for motion-triggered camera clips.

Uses YAMNet (AudioSet) to flag security-relevant sounds. Labels are filtered
in code — we do not alert on gunshot classes. Tune SECURITY_SOUND_KEYWORDS
and KEYWORD_TO_TYPE rather than retraining YAMNet unless you build a custom
classifier on top of its embeddings.

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

# YAMNet labels we never treat as alerts (even if they score highest)
BLOCKED_LABEL_KEYWORDS = [
    "Gunshot, gunfire",
    "Machine gun",
    "Cap gun",
]

# YAMNet / AudioSet display names we treat as security-relevant
SECURITY_SOUND_KEYWORDS = {
    "fighting": [
        "Screaming", "Yell", "Shout", "Children shouting",
        "Groan", "Grunt", "Crying, sobbing",
    ],
    "hitting": [
        "Slap, smack", "Whack, thwack", "Thump, thud", "Bang",
        "Smash, crash",
    ],
    "explosion": [
        "Explosion", "Boom",
    ],
    "loud_noise": [
        "Music", "Crowd", "Cheering", "Hubbub, speech noise, speech babble",
        "Dance music", "Electronic dance music", "Electronic music",
        "Rock music", "Pop music", "Drum", "Bass drum", "Drum roll",
    ],
}

# Map YAMNet display names → dashboard violation types
KEYWORD_TO_TYPE = {
    # fighting
    "Screaming": "violence",
    "Yell": "violence",
    "Shout": "violence",
    "Children shouting": "violence",
    "Groan": "violence",
    "Grunt": "violence",
    "Crying, sobbing": "violence",
    # hitting / impacts
    "Slap, smack": "violence",
    "Whack, thwack": "violence",
    "Thump, thud": "violence",
    "Bang": "violence",
    "Smash, crash": "violence",
    # explosion
    "Explosion": "violence",
    "Boom": "violence",
    # loud party / disturbance
    "Music": "disturbance",
    "Crowd": "disturbance",
    "Cheering": "disturbance",
    "Hubbub, speech noise, speech babble": "disturbance",
    "Dance music": "disturbance",
    "Electronic dance music": "disturbance",
    "Electronic music": "disturbance",
    "Rock music": "disturbance",
    "Pop music": "disturbance",
    "Drum": "disturbance",
    "Bass drum": "disturbance",
    "Drum roll": "disturbance",
}

# Per-category confidence bars (YAMNet scores are soft — impacts are often brief)
IMPACT_AUDIO_THRESHOLD = 0.22        # hitting / fighting
EXPLOSION_AUDIO_THRESHOLD = 0.52     # loud thuds confuse YAMNet — require high confidence
DISTURBANCE_AUDIO_THRESHOLD = 0.42   # music / party

# When several labels match the same second, prefer hitting over explosion
_GROUP_PRIORITY = {"hitting": 0, "fighting": 1, "explosion": 2, "loud_noise": 3, "other": 4}

# How many top classes to inspect per ~1s YAMNet frame (not argmax-only)
TOP_K_PER_FRAME = 15

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


def _is_blocked_label(display_name: str) -> bool:
    lower = display_name.lower()
    for blocked in BLOCKED_LABEL_KEYWORDS:
        if blocked.lower() in lower:
            return True
    return False


def _match_security_label(display_name: str) -> Optional[str]:
    if _is_blocked_label(display_name):
        return None
    for keyword, vtype in KEYWORD_TO_TYPE.items():
        if keyword.lower() in display_name.lower():
            return vtype
    for group in SECURITY_SOUND_KEYWORDS.values():
        for keyword in group:
            if keyword.lower() in display_name.lower():
                return KEYWORD_TO_TYPE.get(keyword, "violence")
    return None


def _sound_group(label: str) -> str:
    lower = label.lower()
    for group_name, keywords in SECURITY_SOUND_KEYWORDS.items():
        for keyword in keywords:
            if keyword.lower() in lower:
                return group_name
    return "other"


def _min_score_for_label(label: str, vtype: str, default: float) -> float:
    group = _sound_group(label)
    if group == "explosion":
        return EXPLOSION_AUDIO_THRESHOLD
    if group == "loud_noise" or vtype == "disturbance":
        return DISTURBANCE_AUDIO_THRESHOLD
    if group in ("hitting", "fighting") or vtype == "violence":
        return min(default, IMPACT_AUDIO_THRESHOLD)
    return default


def _event_rank(ev: AudioEvent) -> tuple:
    """Lower tuple = preferred when picking one label per time bucket."""
    return (_GROUP_PRIORITY.get(_sound_group(ev.label), 9), -ev.confidence)


def analyze_wav(
    wav_path: str | Path,
    threshold: float = 0.35,
    clip_duration: float = 0.96,
) -> List[AudioEvent]:
    """Run YAMNet on a WAV file and return security-relevant events.

    Inspects the top-K class scores each frame (not just argmax) so brief
    impacts are not drowned out by continuous background music.
    """
    model, class_names = _load_yamnet()
    wav_path = Path(wav_path)
    waveform = _load_wav(wav_path)

    scores, embeddings, spectrogram = model(waveform)
    scores_np = scores.numpy()

    events: List[AudioEvent] = []
    k = min(TOP_K_PER_FRAME, scores_np.shape[1] if scores_np.ndim > 1 else len(class_names))

    for frame_idx, frame_scores in enumerate(scores_np):
        top_indices = np.argpartition(frame_scores, -k)[-k:]
        start = frame_idx * clip_duration

        for idx in top_indices:
            score = float(frame_scores[idx])
            label = class_names[int(idx)]
            vtype = _match_security_label(label)
            if vtype is None:
                continue
            if score < _min_score_for_label(label, vtype, threshold):
                continue

            events.append(AudioEvent(
                label=label,
                vtype=vtype,
                confidence=score,
                start_sec=round(start, 2),
                end_sec=round(start + clip_duration, 2),
            ))

    # Deduplicate: one event per (vtype, ~1s bucket); prefer hitting over explosion
    best: dict[tuple[str, int], AudioEvent] = {}
    for ev in events:
        bucket = int(ev.start_sec)
        key = (ev.vtype, bucket)
        if key not in best or _event_rank(ev) < _event_rank(best[key]):
            best[key] = ev

    # Prefer violence/impact over disturbance when sorting for display
    priority = {"violence": 0, "disturbance": 1, "vandalism": 2}
    return sorted(
        best.values(),
        key=lambda e: (priority.get(e.vtype, 9), -e.confidence),
    )


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


def best_events_by_type(events: List[AudioEvent]) -> dict[str, AudioEvent]:
    """Pick the best audio hit per vtype (hitting beats explosion at same confidence)."""
    best: dict[str, AudioEvent] = {}
    for ev in events:
        if ev.vtype not in best or _event_rank(ev) < _event_rank(best[ev.vtype]):
            best[ev.vtype] = ev
    return best


def top_event(events: List[AudioEvent]) -> Optional[AudioEvent]:
    return events[0] if events else None
