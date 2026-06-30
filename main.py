import logging
import threading
import time
import signal
import sys
from pathlib import Path
from typing import Dict

import uvicorn
import numpy as np

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler("logs/guardai.log"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("guardai")

stop_event = threading.Event()


def detection_loop(config: Dict, streams: Dict):
    """
    Hybrid detection loop. Replaces the previous YOLO smoking + littering
    pipeline. A cheap local motion detector runs on every sampled frame and acts
    as the gate: only when something moves is a Gemini vision call made, and at
    most once per `gemini_interval_sec`. Gemini does the heavy work — the labelled
    boxes and the smoking/littering/suspicious judgment; confirmed events are
    pushed to the dashboard WebSocket exactly as before.
    """
    import cv2

    from app import gemini_vision
    from app.hybrid_pipeline import HybridDetector
    from app.api import push_violation

    cameras = config["cameras"]

    try:
        gemini_vision.configure(config.get("gemini_model"))
    except RuntimeError as exc:
        logger.error("Gemini detection disabled: %s", exc)
        return

    # Per-camera hybrid detector (YOLO gate + Gemini), kept for the session.
    detectors: Dict[str, HybridDetector] = {
        cam["id"]: HybridDetector(cam, config) for cam in cameras
    }

    logger.info(
        "Hybrid detection loop started — motion gate triggers Gemini '%s' "
        "(min %.1fs between calls per camera)",
        gemini_vision._model_name,
        float(config.get("gemini_interval_sec", 3)),
    )
    while not stop_event.is_set():
        for cam in cameras:
            cam_id = cam["id"]
            stream = streams.get(cam_id)
            if stream is None:
                continue
            jpeg = stream.get_frame()
            if jpeg is None:
                continue
            try:
                frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    continue
                _motion, fired = detectors[cam_id].process(frame)
                for v in fired:
                    push_violation(v)
            except Exception as exc:  # noqa: BLE001
                logger.error("Error processing %s: %s", cam_id, exc)

        time.sleep(0.1)

    logger.info("Detection loop stopped")


def main():
    from app.database import init_db
    import app.cameras as cameras_mod

    init_db()
    config = cameras_mod.load_config("cameras.json")
    streams = cameras_mod.start_all(stop_event)
    logger.info("Started %d camera streams", len(streams))

    det_thread = threading.Thread(
        target=detection_loop, args=(config, streams), daemon=True, name="detection"
    )
    det_thread.start()

    watcher_thread = None
    if config.get("motion_clip_watcher"):
        from scripts.watch_motion_clips import scan_once

        watch_dir = Path(config.get("motion_clip_dir", "input/motion"))
        watch_dir.mkdir(parents=True, exist_ok=True)
        _seen: set[str] = set()

        def _watch_clips():
            while not stop_event.is_set():
                try:
                    scan_once(watch_dir, config, _seen)
                except Exception as exc:
                    logger.error("Motion watcher error: %s", exc)
                stop_event.wait(5)

        watcher_thread = threading.Thread(target=_watch_clips, daemon=True, name="motion-watcher")
        watcher_thread.start()
        logger.info("Motion clip watcher enabled — dir: %s", watch_dir)

    def handle_signal(sig, frame):
        logger.info("Shutdown requested")
        stop_event.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    from app.api import app as fastapi_app
    uvicorn.run(fastapi_app, host="0.0.0.0", port=8080, log_level="warning")

    stop_event.set()
    det_thread.join(timeout=5)
    logger.info("Aegis stopped")


if __name__ == "__main__":
    main()
