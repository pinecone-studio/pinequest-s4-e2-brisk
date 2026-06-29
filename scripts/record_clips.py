"""
Continuously record short clips (video + audio) from each camera's RTSP stream
into the motion-clip folder, where the watcher (scripts/watch_motion_clips.py or
main.py's motion_clip_watcher) picks them up for video+audio violence detection.

Each camera gets its own ffmpeg process that segments the live stream into
fixed-length clips named  <camera_id>_<YYYY-MM-DD_HH-MM-SS>.mp4  so the watcher
can map a clip back to its camera.

Usage:
  python scripts/record_clips.py                 # all enabled cameras, 10s clips
  python scripts/record_clips.py --seconds 15
  python scripts/record_clips.py --camera cam_010 --source input/motion/recording.mov  # test with a file

Requires ffmpeg on PATH (the project venv installs imageio-ffmpeg; symlink its
binary into the venv's bin as `ffmpeg`, or install ffmpeg system-wide).
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import signal
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("record_clips")


def _resolve_rtsp_url(camera: dict, config: dict) -> str | None:
    url = camera.get("rtsp_url") or camera.get("remote_rtsp_url") or camera.get("stream_url")
    if url:
        return url
    ip = camera.get("ip") or camera.get("host")
    if ip:
        template = config.get("rtsp_template", "rtsp://{ip}:554/")
        return template.format(ip=ip)
    return None


def _ffmpeg_bin() -> str:
    """Find ffmpeg: PATH first, then the imageio-ffmpeg bundled binary."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        sys.exit("ffmpeg not found. Install ffmpeg or `pip install imageio-ffmpeg`.")


def _segment_cmd(ffmpeg: str, source: str, out_pattern: str, seconds: int, is_rtsp: bool) -> list[str]:
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-y"]
    if is_rtsp:
        # TCP transport is more reliable than UDP for most NVRs.
        cmd += ["-rtsp_transport", "tcp"]
    cmd += ["-i", source]
    # Copy streams (no re-encode) so audio is preserved and CPU stays low.
    cmd += [
        "-c", "copy",
        "-f", "segment",
        "-segment_time", str(seconds),
        "-reset_timestamps", "1",
        "-strftime", "1",
        out_pattern,
    ]
    return cmd


def main():
    parser = argparse.ArgumentParser(description="Record RTSP cameras into motion clips")
    parser.add_argument("--config", default="cameras.json")
    parser.add_argument("--seconds", type=int, default=10, help="Clip length in seconds")
    parser.add_argument("--camera", default=None, help="Only record this camera id")
    parser.add_argument("--source", default=None, help="Override source (file/RTSP) — for testing")
    args = parser.parse_args()

    with open(args.config) as f:
        config = json.load(f)

    out_dir = Path(config.get("motion_clip_dir", "input/motion"))
    out_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = _ffmpeg_bin()

    cameras = config.get("cameras", [])
    if args.camera:
        cameras = [c for c in cameras if c["id"] == args.camera]
        if not cameras:
            sys.exit(f"Camera '{args.camera}' not found in {args.config}")

    procs: list[tuple[str, subprocess.Popen]] = []
    for cam in cameras:
        if cam.get("enabled") is False and not args.camera:
            continue
        cam_id = cam["id"]
        source = args.source or _resolve_rtsp_url(cam, config)
        if not source:
            logger.warning("No source for %s — skipping", cam_id)
            continue

        is_rtsp = str(source).lower().startswith("rtsp")
        out_pattern = str(out_dir / f"{cam_id}_%Y-%m-%d_%H-%M-%S.mp4")
        cmd = _segment_cmd(ffmpeg, source, out_pattern, args.seconds, is_rtsp)
        logger.info("Recording %s from %s -> %s (every %ds)", cam_id, source, out_pattern, args.seconds)
        procs.append((cam_id, subprocess.Popen(cmd)))

    if not procs:
        sys.exit("No cameras to record.")

    print(f"\nAegis Clip Recorder — {len(procs)} camera(s), {args.seconds}s clips -> {out_dir}/")
    print("Press Ctrl+C to stop.\n")

    def _shutdown(*_):
        logger.info("Stopping recorders…")
        for _cam_id, p in procs:
            p.terminate()
        for _cam_id, p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    # Block until any process exits (e.g., stream drops), then report.
    while procs:
        for cam_id, p in list(procs):
            ret = p.poll()
            if ret is not None:
                logger.warning("Recorder for %s exited (code %s)", cam_id, ret)
                procs.remove((cam_id, p))
        if not procs:
            break
        signal.pause()


if __name__ == "__main__":
    main()
