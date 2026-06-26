"""
Process a single motion-triggered clip from the command line.

Usage:
  python scripts/process_motion_clip.py --clip input/motion/event.mp4 --camera cam_010
  python scripts/process_motion_clip.py --clip input/motion/event.mp4 --camera cam_010 --no-db
"""

import argparse
import json
import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)


def main():
    parser = argparse.ArgumentParser(description="Process motion clip (YOLO11 + audio)")
    parser.add_argument("--clip", required=True, help="Path to MP4/AVI motion clip")
    parser.add_argument("--camera", required=True, help="Camera ID from cameras.json")
    parser.add_argument("--config", default="cameras.json")
    parser.add_argument("--no-db", action="store_true", help="Skip database writes")
    args = parser.parse_args()

    clip = Path(args.clip)
    if not clip.exists():
        sys.exit(f"Clip not found: {clip}")

    with open(args.config) as f:
        config = json.load(f)

    from app.clip_processor import process_motion_clip

    print(f"\nAegis Motion Clip Processor")
    print(f"  Clip   : {clip}")
    print(f"  Camera : {args.camera}")
    print(f"  Audio  : {'on' if config.get('audio_enabled', True) else 'off'}")
    print(f"  Fusion : {config.get('fusion_mode', 'any')}\n")

    violations = process_motion_clip(
        clip,
        args.camera,
        config=config,
        write_db=not args.no_db,
    )

    print(f"\n{'='*50}")
    print(f"Done — {len(violations)} violation(s)")
    for v in violations:
        print(
            f"  {v['type']:10} conf={v['confidence']:.2f} "
            f"source={v.get('source', '?')}  evidence={v['image_path']}"
        )


if __name__ == "__main__":
    main()
