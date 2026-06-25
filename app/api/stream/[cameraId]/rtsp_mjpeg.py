from __future__ import annotations

import json
import os
import sys
import time
from typing import Optional

os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;tcp|stimeout;8000000|max_delay;500000",
)

import cv2


BOUNDARY = b"--frame\r\n"
JPEG_QUALITY = 80
RETRY_DELAY_SEC = 2
OPEN_TIMEOUT_MSEC = 8000
READ_TIMEOUT_MSEC = 3000


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit_cache_url(url: str, path_name: str) -> None:
    print(
        "__GUARDAI_STREAM_CACHE__ " + json.dumps({"url": url, "pathName": path_name}),
        file=sys.stderr,
        flush=True,
    )


def open_capture(candidates: list[dict]) -> tuple[Optional[cv2.VideoCapture], Optional[str]]:
    for candidate in candidates:
        label = candidate["label"]
        path_name = candidate.get("pathName") or label
        url = candidate["url"]
        log(f"stream open attempt {label}")
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, OPEN_TIMEOUT_MSEC)
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, READ_TIMEOUT_MSEC)
        if not cap.isOpened():
            cap.release()
            log(f"stream open failure {label}")
            continue

        for _ in range(10):
            ok, frame = cap.read()
            if ok and frame is not None:
                log(f"stream open success {label}")
                emit_cache_url(url, path_name)
                return cap, label
            time.sleep(0.1)

        cap.release()
        log(f"stream read failure {label}")

    return None, None


def encode_frame(frame: np.ndarray) -> Optional[bytes]:
    ok, buffer = cv2.imencode(
        ".jpg",
        frame,
        [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY],
    )
    return buffer.tobytes() if ok else None


def write_mjpeg_frame(jpeg: bytes) -> None:
    if not jpeg:
        return
    sys.stdout.buffer.write(BOUNDARY)
    sys.stdout.buffer.write(b"Content-Type: image/jpeg\r\n")
    sys.stdout.buffer.write(b"Cache-Control: no-store\r\n\r\n")
    sys.stdout.buffer.write(jpeg)
    sys.stdout.buffer.write(b"\r\n")
    sys.stdout.buffer.flush()


def main() -> int:
    config = json.loads(sys.stdin.read())
    stream_candidates = config["stream_candidates"]

    cap, _label = open_capture(stream_candidates)
    if cap is None:
        log("stream unavailable: configured RTSP URL failed")
        return 2

    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                log("stream frame read failure")
                return 3
            jpeg = encode_frame(frame)
            if jpeg:
                write_mjpeg_frame(jpeg)
    finally:
        cap.release()


if __name__ == "__main__":
    raise SystemExit(main())
