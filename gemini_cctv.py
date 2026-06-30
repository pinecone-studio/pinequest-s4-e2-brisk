"""
Hybrid CCTV detector (standalone tester).

A cheap local motion detector runs on every frame and boxes whatever is moving.
Only when something moves — and at most once per `gemini_interval_sec` — is a
Gemini call made, and Gemini does the heavy work: the real labelled boxes and the
smoking/littering/suspicious judgment. Confirmed events get an annotated snapshot
in evidence/, a row in the violations DB, and (with --serve) a live broadcast
over the dashboard WebSocket.

For the full production runner (all cameras + dashboard + WebSocket in one
process) use:  python main.py

USAGE
-----
  # Webcam test with a live window showing the motion boxes:
  python gemini_cctv.py --source 0 --show

  # One RTSP URL or a video file:
  python gemini_cctv.py --source "rtsp://user:pass@192.168.1.10:554/..." --show
  python gemini_cctv.py --source clip.mp4 --show

  # All enabled cameras from cameras.json, broadcasting to the dashboard:
  python gemini_cctv.py --serve

SETUP
-----
  pip install google-genai opencv-python python-dotenv
  Add to .env:   GEMINI_API_KEY=your-key   (https://aistudio.google.com/apikey)

Relevant cameras.json knobs (all optional, defaults shown):
  "gemini_model": "gemini-2.5-flash"
  "gemini_interval_sec": 3        # min seconds between Gemini calls per camera
  "gemini_confidence": 0.5        # ignore Gemini detections below this
  "gemini_confirm": 1             # consecutive hits needed to fire an event
  "cooldown_minutes": 5           # min gap between events of the same type/camera
  "motion_min_area": 1500         # ignore moving blobs smaller than this (px area)
"""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Optional

import cv2

from app import gemini_vision
from app.hybrid_pipeline import HybridDetector

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("gemini_cctv")


class CameraWorker(threading.Thread):
    """Opens one stream, samples frames, runs Gemini, fires confirmed events."""

    def __init__(self, camera: dict, source: str, cfg: dict, stop: threading.Event,
                 on_event: Optional[Callable[[dict], None]] = None, show: bool = False):
        super().__init__(daemon=True, name=f"gemini-{camera['id']}")
        self.camera = camera
        self.camera_id = camera["id"]
        self.source = source
        self.stop = stop
        self.on_event = on_event
        self.show = show
        self.detector = HybridDetector(camera, cfg)
        self._alert_until = 0.0  # wall-clock time to keep flashing the event banner

    _MOTION_COLOR = (0, 220, 0)

    def run(self):
        # `0`/`1` mean a local webcam index; anything else is an RTSP/file source.
        src = int(self.source) if self.source.isdigit() else self.source
        cap = None
        win = f"Aegis hybrid — {self.camera_id}"

        while not self.stop.is_set():
            try:
                if cap is None or not cap.isOpened():
                    logger.info("%s connecting to source...", self.camera_id)
                    cap = cv2.VideoCapture(src)
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    if not cap.isOpened():
                        raise ConnectionError("cannot open source")
                    logger.info("%s connected", self.camera_id)

                ok, frame = cap.read()
                if not ok or frame is None:
                    raise ConnectionError("frame read failed")

                # Motion runs every frame (the gate); Gemini only fires when
                # something moves and the throttle interval has passed.
                motion_boxes, fired = self.detector.process(frame)
                for violation in fired:
                    self._emit(violation)
                    self._alert_until = time.time() + 5.0

                if self.show:
                    self._render(frame, motion_boxes, win)
                    if cv2.waitKey(1) & 0xFF in (ord("q"), ord("Q"), 27):
                        self.stop.set()
                        break

            except Exception as exc:  # noqa: BLE001
                logger.warning("%s stream error: %s — retrying in 5s", self.camera_id, exc)
                if cap:
                    cap.release()
                    cap = None
                self.stop.wait(5)

        if cap:
            cap.release()
        if self.show:
            cv2.destroyWindow(win)
        logger.info("%s worker stopped", self.camera_id)

    def _render(self, frame, motion_boxes, win):
        for det in motion_boxes:
            x1, y1, x2, y2 = det["bbox"]
            cv2.rectangle(frame, (x1, y1), (x2, y2), self._MOTION_COLOR, 2)
            cv2.putText(
                frame, "motion", (x1, max(y1 - 6, 12)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, self._MOTION_COLOR, 2, cv2.LINE_AA,
            )
        if time.time() < self._alert_until:
            cv2.rectangle(frame, (0, 0), (frame.shape[1], 50), (0, 0, 180), -1)
            cv2.putText(
                frame, "!! EVENT — see console / dashboard !!", (16, 34),
                cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA,
            )
        cv2.imshow(win, frame)

    def _emit(self, violation: dict):
        desc = f" — {violation['description']}" if violation.get("description") else ""
        print(
            f"[{violation['type'].upper()}] camera={violation['camera_id']} "
            f"conf={violation['confidence']:.2f} ts={violation['created_at']}{desc}"
            f"  -> {violation['image_path']}",
            flush=True,
        )
        if self.on_event:
            try:
                self.on_event(violation)
            except Exception as exc:  # noqa: BLE001
                logger.warning("event broadcast failed: %s", exc)


def _resolve_rtsp(camera: dict) -> Optional[str]:
    url = camera.get("rtsp_url") or camera.get("remote_rtsp_url") or camera.get("stream_url")
    if url:
        return url
    ip = camera.get("ip") or camera.get("host")
    return f"rtsp://{ip}:554/" if ip else None


def _start_server() -> Callable[[dict], None]:
    """Start the FastAPI server in a thread; return a push_violation callable."""
    import uvicorn

    from app.api import app as fastapi_app
    from app.api import push_violation

    threading.Thread(
        target=uvicorn.run,
        kwargs={"app": fastapi_app, "host": "0.0.0.0", "port": 8080, "log_level": "warning"},
        daemon=True, name="fastapi",
    ).start()
    time.sleep(1.5)  # let lifespan create the violation queue + broadcaster
    logger.info("Dashboard live at http://localhost:8080  (WebSocket ws://localhost:8080/ws)")
    return push_violation


def main() -> int:
    parser = argparse.ArgumentParser(description="Gemini CCTV detector")
    parser.add_argument("--config", default="cameras.json", help="path to cameras.json")
    parser.add_argument(
        "--source",
        help="override: run on a single webcam index (0), RTSP URL, or video file",
    )
    parser.add_argument(
        "--serve", action="store_true",
        help="also start the dashboard/WebSocket server so events broadcast live",
    )
    parser.add_argument(
        "--show", action="store_true",
        help="open a window showing the live YOLO boxes (best with a single --source)",
    )
    args = parser.parse_args()

    cfg: dict = {}
    if Path(args.config).exists():
        cfg = json.loads(Path(args.config).read_text())
    elif not args.source:
        logger.error(
            "No %s found and no --source given. Copy cameras.example.json to "
            "cameras.json, or run with --source 0 to test on your webcam.",
            args.config,
        )
        return 1

    try:
        gemini_vision.configure(cfg.get("gemini_model"))
    except RuntimeError as exc:
        logger.error("%s", exc)
        return 1

    from app.database import init_db
    init_db()

    on_event = _start_server() if args.serve else None

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda *_: stop.set())

    workers = []
    if args.source:
        camera = {"id": "test", "floor": 0, "zone": "test"}
        workers.append(CameraWorker(camera, args.source, cfg, stop, on_event, show=args.show))
    else:
        for cam in cfg.get("cameras", []):
            if cam.get("enabled") is False:
                continue
            url = _resolve_rtsp(cam)
            if not url:
                logger.warning("Skipping %s: no rtsp_url/ip/host", cam.get("id"))
                continue
            workers.append(CameraWorker(cam, url, cfg, stop, on_event, show=args.show))

    if not workers:
        logger.error("No cameras to watch.")
        return 1

    logger.info("Watching %d source(s). Press Ctrl+C to stop.", len(workers))
    for w in workers:
        w.start()

    try:
        while not stop.is_set():
            time.sleep(0.5)
    except KeyboardInterrupt:
        stop.set()

    for w in workers:
        w.join(timeout=8)
    logger.info("Shutdown complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
