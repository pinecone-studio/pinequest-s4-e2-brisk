import logging
import threading
import time
import signal
import sys
from pathlib import Path
from typing import Dict

import uvicorn
import numpy as np

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
    from app.detector import detect
    from app.reporter import process
    from app.api import push_violation

    temporal_window = config.get("temporal_window", 5)
    cooldown_minutes = config.get("cooldown_minutes", 5)
    confidence_threshold = config.get("confidence_threshold", 0.75)
    cameras = config["cameras"]

    logger.info("Detection loop started")
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
                buf = np.frombuffer(jpeg, dtype=np.uint8)
                import cv2
                frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
                if frame is None:
                    continue
                detections = detect(frame, cam, confidence_threshold)
                violations = process(
                    frame, detections, cam,
                    temporal_window, cooldown_minutes
                )
                for v in violations:
                    push_violation(v)
            except Exception as exc:
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

    def handle_signal(sig, frame):
        logger.info("Shutdown requested")
        stop_event.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    from app.api import app as fastapi_app
    uvicorn.run(fastapi_app, host="0.0.0.0", port=8080, log_level="warning")

    stop_event.set()
    det_thread.join(timeout=5)
    logger.info("GuardAI stopped")


if __name__ == "__main__":
    main()
