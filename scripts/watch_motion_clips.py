"""
Watch a folder for new motion clips and process them automatically.

Cameras save clips to `input/motion/` (or cameras.json `motion_clip_dir`).
Each file should be named with camera id prefix, e.g. cam_010_2026-06-26_143022.mp4

Usage:
  python scripts/watch_motion_clips.py
  python scripts/watch_motion_clips.py --dir input/motion --poll 3
"""

import argparse
import logging
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("motion_watcher")

VIDEO_EXTS = {".mp4", ".avi", ".mkv", ".mov"}


def _camera_id_from_filename(name: str, known_ids: set[str]) -> str | None:
    stem = Path(name).stem
    for cam_id in sorted(known_ids, key=len, reverse=True):
        if stem.startswith(cam_id):
            return cam_id
    parts = stem.split("_")
    if parts and parts[0].startswith("cam"):
        return parts[0]
    return None


def scan_once(watch_dir: Path, config: dict, seen: set[str] | None = None) -> int:
    """Process any new clips in watch_dir. Returns count processed."""
    from app.clip_processor import process_motion_clip

    if seen is None:
        seen = set()

    known_ids = {c["id"] for c in config.get("cameras", [])}
    processed_dir = watch_dir / "processed"
    processed_dir.mkdir(exist_ok=True)
    count = 0

    for path in sorted(watch_dir.iterdir()):
        if path.suffix.lower() not in VIDEO_EXTS:
            continue
        if path.name in seen:
            continue

        size1 = path.stat().st_size
        time.sleep(1.0)
        if not path.exists():
            continue
        size2 = path.stat().st_size
        if size1 != size2:
            continue

        camera_id = _camera_id_from_filename(path.name, known_ids)
        if camera_id is None:
            logger.warning("Cannot infer camera id from %s — skipping", path.name)
            seen.add(path.name)
            continue

        seen.add(path.name)
        try:
            process_motion_clip(path, camera_id, config=config)
            dest = processed_dir / path.name
            path.rename(dest)
            logger.info("Moved to %s", dest)
            count += 1
        except Exception as exc:
            logger.error("Failed to process %s: %s", path.name, exc)

    return count


def main():
    parser = argparse.ArgumentParser(description="Watch folder for motion clips")
    parser.add_argument("--dir", default=None, help="Watch directory (default: from cameras.json)")
    parser.add_argument("--config", default="cameras.json")
    parser.add_argument("--poll", type=float, default=5.0, help="Poll interval seconds")
    parser.add_argument("--once", action="store_true", help="Process existing files then exit")
    args = parser.parse_args()

    import json
    from app.database import init_db

    with open(args.config) as f:
        config = json.load(f)

    watch_dir = Path(args.dir or config.get("motion_clip_dir", "input/motion"))
    watch_dir.mkdir(parents=True, exist_ok=True)

    init_db()
    seen: set[str] = set()

    print(f"\nAegis Motion Clip Watcher")
    print(f"  Watching : {watch_dir.resolve()}")
    print(f"  Poll     : {args.poll}s")
    print(f"  Fusion   : {config.get('fusion_mode', 'any')}\n")

    if args.once:
        n = scan_once(watch_dir, config, seen)
        print(f"Processed {n} clip(s).")
        return

    try:
        while True:
            scan_once(watch_dir, config, seen)
            time.sleep(args.poll)
    except KeyboardInterrupt:
        print("\nWatcher stopped.")


if __name__ == "__main__":
    main()
