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
    template = _CONFIG.get("rtsp_template", "rtsp://{ip}:554/")
    return template.format(ip=ip)


def resolve_rtsp_url(camera: dict) -> Optional[str]:
    """Prefer an explicit per-camera rtsp_url (with credentials/path);
    fall back to building one from the template + ip/host."""
    url = camera.get("rtsp_url") or camera.get("remote_rtsp_url") or camera.get("stream_url")
    if url:
        return url
    ip = camera.get("ip") or camera.get("host")
    if ip:
        return _build_rtsp(ip)
    return None


class CameraStream:
    def __init__(self, camera: dict, sample_rate: int, stop_event: threading.Event):
        self.camera = camera
        self.camera_id = camera["id"]
        self.url = resolve_rtsp_url(camera)
        if not self.url:
            raise ValueError(f"Camera {self.camera_id} has no rtsp_url/ip/host configured")
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
    for cam in cfg.get("cameras", []):
        if cam.get("enabled") is False:
            continue
        try:
            _streams[cam["id"]] = CameraStream(cam, sample_rate, stop_event)
        except Exception as exc:  # noqa: BLE001
            logger.error("Skipping camera %s: %s", cam.get("id"), exc)
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
            "floor": cam.get("floor", 0),
            "zone": cam.get("zone", "unknown"),
            "ip": cam.get("ip") or cam.get("host", ""),
            "online": stream.online if stream else False,
        })
    return result
