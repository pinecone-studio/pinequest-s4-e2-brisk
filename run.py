"""
Standalone smoking detection runner.
Usage: python3 run.py --video input/test.mp4 --camera cam_01
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
logger = logging.getLogger("pinequest")


def main():
    parser = argparse.ArgumentParser(description="Pinequest smoking detector")
    parser.add_argument("--video", required=True, help="Video file path or RTSP URL")
    parser.add_argument("--camera", required=True, help="Camera ID (e.g. cam_01)")
    parser.add_argument("--config", default="cameras.json", help="Camera config file")
    parser.add_argument("--output", default=None, help="Output video path (auto if omitted)")
    parser.add_argument("--no-db", action="store_true", help="Skip database writes")
    args = parser.parse_args()

    with open(args.config) as f:
        config = json.load(f)

    camera_info = next((c for c in config["cameras"] if c["id"] == args.camera), None)
    if camera_info is None:
        sys.exit(f"Camera '{args.camera}' not found in {args.config}")

    if args.no_db:
        import app.detector as det_mod
        det_mod.VideoProcessor._record_violation = staticmethod(lambda *a, **k: None)
    else:
        from app.database import init_db
        init_db()

    source = args.video
    if args.output:
        output_path = args.output
    else:
        stem = Path(source).stem if not source.startswith("rtsp") else args.camera
        output_path = f"output/{stem}_{args.camera}_annotated.mp4"

    Path("output").mkdir(exist_ok=True)

    from app.detector import VideoProcessor

    processor = VideoProcessor(config)

    print(f"\nPinequest Smoking Detector")
    print(f"  Source  : {source}")
    print(f"  Camera  : {args.camera} (floor {camera_info.get('floor')}, {camera_info.get('zone')})")
    print(f"  Output  : {output_path}")
    print(f"  Sample  : every {config.get('sample_rate', 15)} frames")
    print(f"  Threshold: {config.get('confidence_threshold', 0.75)}")
    print(f"  Window  : {config.get('temporal_window', 5)} consecutive frames")
    print(f"  Cooldown: {config.get('cooldown_minutes', 5)} min\n")

    events = processor.process(source, camera_info, output_path=output_path)

    print(f"\n{'='*50}")
    print(f"Detection complete — {len(events)} smoking event(s) flagged")
    for e in events:
        print(
            f"  frame={e['frame_number']:>6}  conf={e['confidence']:.2f}"
            f"  ts={e['timestamp']}  snap={e['snapshot_path']}"
        )
    print(f"Annotated video saved to: {output_path}")


if __name__ == "__main__":
    main()
