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
    from app.reporter import process, report_littering_event
    from app.api import push_violation

    temporal_window = config.get("temporal_window", 5)
    cooldown_minutes = config.get("cooldown_minutes", 5)
    confidence_threshold = config.get("confidence_threshold", 0.75)
    cameras = config["cameras"]

    # Attempt to load the littering pipeline — requires training/checkpoints/yolo11s.pt.
    # If weights are absent the smoking loop continues unaffected.
    littering_enabled = False
    detect_and_track = None
    try:
        from app.detect_frame import detect_and_track
        from app.association import Associator
        from app.abandonment import AbandonmentMachine
        littering_enabled = True
        logger.info("Littering pipeline loaded")
    except Exception as exc:
        logger.warning("Littering pipeline unavailable — skipping (reason: %s)", exc)

    # Per-camera state; created once and kept alive for the session.
    associators: Dict[str, object] = {}
    machines: Dict[str, object] = {}
    frame_counters: Dict[str, int] = {}
    if littering_enabled:
        for cam in cameras:
            cam_id = cam["id"]
            associators[cam_id] = Associator()
            machines[cam_id] = AbandonmentMachine()
            frame_counters[cam_id] = 0

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

                # ── Smoking detection (unchanged) ──────────────────────────
                detections = detect(frame, cam, confidence_threshold)
                violations = process(
                    frame, detections, cam,
                    temporal_window, cooldown_minutes
                )
                for v in violations:
                    push_violation(v)

                # ── Littering / abandonment detection ──────────────────────
                if littering_enabled:
                    frame_counters[cam_id] += 1
                    try:
                        tracked = detect_and_track(frame)
                        associators[cam_id].update(frame_counters[cam_id], tracked)
                        events = machines[cam_id].update(
                            time.time(), tracked,
                            associators[cam_id].object_states,
                            associators[cam_id].reown_map,
                        )
                        for evt in events:
                            v = report_littering_event(frame, evt, cam_id, cam)
                            if v:
                                push_violation(v)
                    except Exception as exc:
                        logger.error("Littering error on %s: %s", cam_id, exc)

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
