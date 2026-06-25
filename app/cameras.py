from typing import Dict, List, Optional
import cv2
import json
import logging
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_CONFIG: dict = {}
_streams: dict = {}  # camera_id -> CameraStream


def load_config(path: str = "cameras.json") -> dict:
    global _CONFIG
    with open(path) as f:
        _CONFIG = json.load(f)
    return _CONFIG


def _build_rtsp(ip: str) -> str:
    return _CONFIG["rtsp_template"].format(ip=ip)


class CameraStream:
    def __init__(self, camera: dict, sample_rate: int, stop_event: threading.Event):
        self.camera = camera
        self.camera_id = camera["id"]
        self.url = _build_rtsp(camera["ip"])
        self.sample_rate = sample_rate
        self.stop_event = stop_event

        self._frame_lock = threading.Lock()
        self._latest_jpeg: Optional[bytes] = None
        self._online = False

        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name=f"cam-{self.camera_id}")
        self._thread.start()

    @property
    def online(self) -> bool:
        return self._online

    def get_frame(self) -> Optional[bytes]:
        with self._frame_lock:
            return self._latest_jpeg

    def _run(self):
        frame_count = 0
        cap = None
        while not self.stop_event.is_set():
            try:
                if cap is None or not cap.isOpened():
                    logger.info("%s connecting to %s", self.camera_id, self.url)
                    cap = cv2.VideoCapture(self.url)
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    if not cap.isOpened():
                        raise ConnectionError("Cannot open stream")
                    self._online = True
                    logger.info("%s connected", self.camera_id)

                ret, frame = cap.read()
                if not ret:
                    raise ConnectionError("Frame read failed")

                frame_count += 1
                if frame_count % self.sample_rate == 0:
                    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                    if ok:
                        with self._frame_lock:
                            self._latest_jpeg = buf.tobytes()

            except Exception as exc:
                self._online = False
                if cap:
                    cap.release()
                    cap = None
                logger.warning("%s stream error: %s — retrying in 5 s", self.camera_id, exc)
                for _ in range(50):
                    if self.stop_event.is_set():
                        break
                    time.sleep(0.1)

        if cap:
            cap.release()
        logger.info("%s thread stopped", self.camera_id)


def start_all(stop_event: threading.Event) -> dict:
    global _streams
    cfg = _CONFIG
    sample_rate = cfg.get("sample_rate", 15)
    for cam in cfg["cameras"]:
        _streams[cam["id"]] = CameraStream(cam, sample_rate, stop_event)
    return _streams


def get_frame(camera_id: str) -> Optional[bytes]:
    stream = _streams.get(camera_id)
    if stream is None:
        return None
    return stream.get_frame()


def get_camera_statuses() -> List[Dict]:
    cfg = _CONFIG
    result = []
    for cam in cfg.get("cameras", []):
        stream = _streams.get(cam["id"])
        result.append({
            "id": cam["id"],
            "floor": cam["floor"],
            "zone": cam["zone"],
            "ip": cam["ip"],
            "online": stream.online if stream else False,
        })
    return result
