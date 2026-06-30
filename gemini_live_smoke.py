#!/usr/bin/env python3
"""
Real-time smoke/cigarette detection orchestrator built on the Gemini Live API.

Architecture
------------
1. MOTION GATE (local, free):  OpenCV frame differencing runs continuously. The
   expensive Gemini Live WebSocket is only opened once motion is seen.
2. GEMINI LIVE (the brain):    While motion is active, frames are streamed to the
   `gemini-live-2.5-flash-native-audio` model at exactly 5 FPS, TEXT modality only.
   The model is instructed to emit ONLY JSON smoking logs.
3. THROTTLING:                 Send rate is paced to 5 FPS (one frame / 200 ms).
4. LIFECYCLE:                  If no motion for IDLE_TIMEOUT seconds, the session
   is closed to save cost. The next motion re-opens a fresh session.

The model has no clock, so the current wall-clock time is burned into the top-left
of every frame; the system instruction tells the model to read it for start/end.

Usage
-----
    python gemini_live_smoke.py --source 0 --show
    python gemini_live_smoke.py --source "rtsp://user:pass@host:554/stream"
    python gemini_live_smoke.py --source clip.mp4 --log-file events.jsonl

Setup
-----
    pip install opencv-python google-genai python-dotenv
    export GEMINI_API_KEY=...        # https://aistudio.google.com/apikey
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import time
from datetime import datetime
from typing import Optional

import cv2
import numpy as np

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # dotenv is optional
    pass

from google import genai
from google.genai import types


# ── Configuration defaults ───────────────────────────────────────────────────
DEFAULT_MODEL = "gemini-live-2.5-flash-native-audio"
TARGET_FPS = 5.0
IDLE_TIMEOUT_SEC = 10.0  # close the session after this long with no motion
JPEG_QUALITY = 80
RECONNECT_BACKOFF_SEC = 3.0

SYSTEM_INSTRUCTION = (
    "You are a real-time smoking-detection analyst watching a live video feed. "
    "Detect when a person is smoking: a lit or held cigarette, cigar, or vape, or "
    "visible exhaled smoke. The current wall-clock time is printed in the TOP-LEFT "
    "corner of every frame as HH:MM:SS — use it for timestamps.\n\n"
    "Output ONLY JSON log objects, one per line, with no prose, no markdown, no "
    "explanation. When a smoking event is happening, emit exactly:\n"
    '{"event": "smoking", "start": "HH:MM:SS", "end": "HH:MM:SS"}\n'
    "where 'start' is when smoking began and 'end' is the latest frame's time while "
    "it continues. If nothing relevant is happening, output NOTHING at all."
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("smoke-live")


# ── Motion detection ─────────────────────────────────────────────────────────
class MotionDetector:
    """Frame-to-frame differencing. `update()` returns True when motion is seen."""

    def __init__(self, threshold: int = 25, min_area_frac: float = 0.0025) -> None:
        self.threshold = threshold
        self.min_area_frac = min_area_frac
        self._prev: Optional[np.ndarray] = None

    def update(self, frame_bgr: np.ndarray) -> bool:
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (21, 21), 0)

        if self._prev is None:
            self._prev = gray
            return False

        delta = cv2.absdiff(self._prev, gray)
        self._prev = gray

        thresh = cv2.threshold(delta, self.threshold, 255, cv2.THRESH_BINARY)[1]
        thresh = cv2.dilate(thresh, None, iterations=2)
        changed = int(cv2.countNonZero(thresh))
        total = gray.shape[0] * gray.shape[1]
        return total > 0 and (changed / total) >= self.min_area_frac


# ── Frame utilities ──────────────────────────────────────────────────────────
def stamp_time(frame_bgr: np.ndarray) -> np.ndarray:
    """Burn the current HH:MM:SS into the top-left corner so the model can read it."""
    now = datetime.now().strftime("%H:%M:%S")
    cv2.putText(frame_bgr, now, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(frame_bgr, now, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                (255, 255, 255), 1, cv2.LINE_AA)
    return frame_bgr


def encode_jpeg(frame_bgr: np.ndarray) -> Optional[bytes]:
    ok, buf = cv2.imencode(".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    return buf.tobytes() if ok else None


async def read_frame(cap: "cv2.VideoCapture") -> Optional[np.ndarray]:
    """cap.read() is blocking — run it off the event loop."""
    loop = asyncio.get_running_loop()
    ok, frame = await loop.run_in_executor(None, cap.read)
    return frame if ok else None


# ── Gemini Live session ──────────────────────────────────────────────────────
class GeminiLiveSession:
    """
    A single Live API connection. Opens the WebSocket, streams frames in, and
    consumes the model's text output on a background task, parsing JSON logs.
    """

    def __init__(self, client: genai.Client, model: str, on_event) -> None:
        self.client = client
        self.model = model
        self.on_event = on_event
        self._cm = None
        self._session = None
        self._receiver: Optional[asyncio.Task] = None
        self._text_buffer = ""

    async def __aenter__(self) -> "GeminiLiveSession":
        config = types.LiveConnectConfig(
            response_modalities=["TEXT"],
            system_instruction=types.Content(
                parts=[types.Part(text=SYSTEM_INSTRUCTION)]
            ),
        )
        self._cm = self.client.aio.live.connect(model=self.model, config=config)
        self._session = await self._cm.__aenter__()
        self._receiver = asyncio.create_task(self._receive_loop())
        logger.info("Gemini Live session opened (model=%s)", self.model)
        return self

    async def __aexit__(self, *exc) -> None:
        if self._receiver:
            self._receiver.cancel()
            try:
                await self._receiver
            except asyncio.CancelledError:
                pass
        if self._cm:
            try:
                await self._cm.__aexit__(*exc)
            except Exception as err:  # noqa: BLE001 — closing best-effort
                logger.debug("Error closing Live session: %s", err)
        logger.info("Gemini Live session closed")

    async def send_frame(self, jpeg_bytes: bytes) -> None:
        await self._session.send_realtime_input(
            media=types.Blob(data=jpeg_bytes, mime_type="image/jpeg")
        )

    async def _receive_loop(self) -> None:
        try:
            async for response in self._session.receive():
                text = getattr(response, "text", None)
                if text:
                    self._consume_text(text)
                server_content = getattr(response, "server_content", None)
                if server_content and getattr(server_content, "turn_complete", False):
                    self._flush_buffer()
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001 — surfaced to the orchestrator via task
            logger.warning("Receive loop error: %s", err)

    def _consume_text(self, text: str) -> None:
        self._text_buffer += text
        # Greedily pull out any complete {...} objects as they arrive.
        while True:
            start = self._text_buffer.find("{")
            end = self._text_buffer.find("}", start + 1)
            if start == -1 or end == -1:
                break
            chunk = self._text_buffer[start : end + 1]
            self._text_buffer = self._text_buffer[end + 1 :]
            self._emit(chunk)

    def _flush_buffer(self) -> None:
        leftover = self._text_buffer.strip()
        self._text_buffer = ""
        if leftover:
            self._emit(leftover)

    def _emit(self, raw: str) -> None:
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            return
        if isinstance(event, dict) and event.get("event") == "smoking":
            self.on_event(event)


# ── Orchestrator ─────────────────────────────────────────────────────────────
class SmokeOrchestrator:
    def __init__(self, args: argparse.Namespace, client: genai.Client) -> None:
        self.args = args
        self.client = client
        self.motion = MotionDetector(
            threshold=args.motion_threshold, min_area_frac=args.motion_min_area
        )
        self.frame_interval = 1.0 / max(1.0, args.fps)
        self._stop = asyncio.Event()

    def request_stop(self) -> None:
        self._stop.set()

    def _on_event(self, event: dict) -> None:
        line = json.dumps(event)
        logger.info("SMOKING EVENT: %s", line)
        if self.args.log_file:
            with open(self.args.log_file, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")

    async def _pace(self, started: float) -> None:
        """Sleep so the loop holds the target FPS, accounting for work done."""
        elapsed = time.monotonic() - started
        remaining = self.frame_interval - elapsed
        if remaining > 0:
            await asyncio.sleep(remaining)

    def _maybe_show(self, frame: np.ndarray) -> bool:
        if not self.args.show:
            return True
        cv2.imshow("Gemini Live smoke detection", frame)
        return cv2.waitKey(1) & 0xFF not in (ord("q"), 27)

    async def _idle_until_motion(self, cap: "cv2.VideoCapture") -> bool:
        """Watch for motion without sending anything. Returns True once seen."""
        logger.info("Idle — watching for motion…")
        while not self._stop.is_set():
            started = time.monotonic()
            frame = await read_frame(cap)
            if frame is None:
                logger.warning("No frame from source; retrying…")
                await asyncio.sleep(0.5)
                continue
            motion = self.motion.update(frame)
            if not self._maybe_show(stamp_time(frame.copy())):
                self.request_stop()
                return False
            if motion:
                logger.info("Motion detected → opening Gemini Live session")
                return True
            await self._pace(started)
        return False

    async def _run_session(self, cap: "cv2.VideoCapture") -> None:
        """Stream frames while motion persists; close after IDLE_TIMEOUT of stillness."""
        try:
            async with GeminiLiveSession(self.client, self.args.model, self._on_event) as session:
                last_motion = time.monotonic()
                while not self._stop.is_set():
                    started = time.monotonic()
                    frame = await read_frame(cap)
                    if frame is None:
                        logger.warning("Source ended / no frame; closing session")
                        return

                    if self.motion.update(frame):
                        last_motion = started

                    stamped = stamp_time(frame.copy())
                    jpeg = encode_jpeg(stamped)
                    if jpeg is not None:
                        await session.send_frame(jpeg)

                    if not self._maybe_show(stamped):
                        self.request_stop()
                        return

                    idle_for = time.monotonic() - last_motion
                    if idle_for > self.args.idle_timeout:
                        logger.info("No motion for %.0fs → closing session", idle_for)
                        return

                    await self._pace(started)
        except Exception as err:  # noqa: BLE001 — keep the orchestrator alive
            logger.error("Live session failed: %s", err)
            await asyncio.sleep(RECONNECT_BACKOFF_SEC)

    async def run(self) -> None:
        source: object = self.args.source
        if isinstance(source, str) and source.isdigit():
            source = int(source)

        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            raise RuntimeError(f"Could not open video source: {self.args.source!r}")
        logger.info("Video source open: %s", self.args.source)

        try:
            while not self._stop.is_set():
                if await self._idle_until_motion(cap):
                    await self._run_session(cap)
        finally:
            cap.release()
            if self.args.show:
                cv2.destroyAllWindows()
            logger.info("Stopped.")


# ── Entrypoint ───────────────────────────────────────────────────────────────
def parse_args(argv: Optional[list] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Gemini Live real-time smoke detection.")
    p.add_argument("--source", default="0",
                   help="Webcam index (e.g. 0), RTSP URL, or video file path.")
    p.add_argument("--model", default=DEFAULT_MODEL, help="Gemini Live model id.")
    p.add_argument("--fps", type=float, default=TARGET_FPS, help="Send/sample FPS.")
    p.add_argument("--idle-timeout", type=float, default=IDLE_TIMEOUT_SEC,
                   help="Seconds of no motion before closing the session.")
    p.add_argument("--motion-threshold", type=int, default=25,
                   help="Per-pixel grayscale delta that counts as motion.")
    p.add_argument("--motion-min-area", type=float, default=0.0025,
                   help="Fraction of changed pixels required to trigger motion.")
    p.add_argument("--log-file", default=None,
                   help="Append detected events as JSONL to this file.")
    p.add_argument("--show", action="store_true", help="Show a live preview window.")
    return p.parse_args(argv)


async def main_async(args: argparse.Namespace) -> int:
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        logger.error("GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey")
        return 1

    client = genai.Client(api_key=api_key, http_options=types.HttpOptions(api_version="v1beta"))
    orchestrator = SmokeOrchestrator(args, client)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, orchestrator.request_stop)
        except NotImplementedError:  # Windows: add_signal_handler may be unavailable
            pass

    try:
        await orchestrator.run()
    except KeyboardInterrupt:
        orchestrator.request_stop()
    except RuntimeError as err:
        logger.error("%s", err)
        return 1
    return 0


def main() -> None:
    args = parse_args()
    try:
        sys.exit(asyncio.run(main_async(args)))
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
