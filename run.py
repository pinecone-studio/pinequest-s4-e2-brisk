"""
Standalone smoking detection runner.
Usage: python3 run.py --video input/test.mp4 --camera cam_01

Webcam / COCO detector:
  python3 run.py --source 0            # webcam
  python3 run.py --source input/clip.mp4
  python3 run.py --source rtsp://...
"""

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import cv2

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("pinequest")

_BOX_COLORS = {
    "person":   (0, 200, 0),
    "bottle":   (0, 165, 255),
    "cup":      (255, 200, 0),
    "backpack": (200, 0, 200),
    "handbag":  (0, 200, 200),
    "suitcase": (100, 100, 255),
}


def _run_webcam(source: str) -> None:
    from app.detect_frame import detect_and_track, diag_raw_detections, CONF_OBJECT
    from app.association import Associator
    from app.abandonment import AbandonmentMachine

    raw = source.strip()
    cap_source = int(raw) if raw.isdigit() else raw
    cap = cv2.VideoCapture(cap_source)
    if not cap.isOpened():
        sys.exit(f"Cannot open source: {source}")

    print(f"[COCO detector] source={source}  press q or ESC to quit")

    fps_start = time.perf_counter()
    fps_count = 0
    fps_display = 0.0
    frame_count = 0  # used to skip spurious waitKey events on first frame (macOS Cocoa)
    associator = Associator()
    abandonment = AbandonmentMachine()
    alert_until: float = 0.0  # show banner until this wall-clock time

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            frame_count += 1
            _frame_t0 = time.perf_counter()

            try:
                dets = detect_and_track(frame)
            except Exception as exc:
                logger.warning("detect_and_track error: %s", exc)
                dets = []

            _frame_ms = (time.perf_counter() - _frame_t0) * 1000
            _frame_fps = 1000.0 / _frame_ms if _frame_ms > 0 else 0.0

            # ── DIAGNOSTIC ─────────────────────────────────────────────────────
            _raw_total, _raw_bottle_confs = diag_raw_detections(frame)
            _survived_bottles = [d for d in dets if d["class"] == "bottle"]
            _bottle_survived = len(_survived_bottles) > 0
            _bottle_tid = _survived_bottles[0].get("track_id") if _survived_bottles else None
            _bottle_conf_str = (
                ", ".join(f"{c:.3f}" for c in _raw_bottle_confs)
                if _raw_bottle_confs else "none"
            )
            print(
                f"[DIAG] frame={frame_count:>5}  raw_boxes={_raw_total:>3}"
                f"  bottle_raw_confs=[{_bottle_conf_str}]"
                f"  survived(>{CONF_OBJECT})={'YES' if _bottle_survived else 'NO '}"
                f"  track_id={_bottle_tid}"
                f"  fps={_frame_fps:.1f}"
            )
            # ── END DIAGNOSTIC ──────────────────────────────────────────────────

            now = time.time()
            associator.update(frame_count, dets)
            events = abandonment.update(now, dets, associator.object_states)
            for evt in events:
                print(evt)
                alert_until = now + 5.0

            # Build a map of person_id → current center for line drawing
            person_centers = {
                d["track_id"]: (
                    (d["bbox"][0] + d["bbox"][2]) // 2,
                    (d["bbox"][1] + d["bbox"][3]) // 2,
                )
                for d in dets
                if d["class"] == "person" and d.get("track_id") is not None
            }

            for det in dets:
                cls = det["class"]
                x1, y1, x2, y2 = det["bbox"]
                conf = det["conf"]
                track_id = det.get("track_id")
                color = _BOX_COLORS.get(cls, (255, 255, 255))
                cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                label = f"{cls} {track_id}" if track_id is not None else f"{cls} {conf:.2f}"
                cv2.putText(
                    frame, label,
                    (x1, max(y1 - 8, 12)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2, cv2.LINE_AA,
                )

                # Draw ownership line: object → its current owner's position
                if cls != "person" and track_id is not None:
                    state = associator.object_states.get(track_id)
                    if state and state.is_carried and state.owner_id in person_centers:
                        ocx = (x1 + x2) // 2
                        ocy = (y1 + y2) // 2
                        cv2.line(frame, (ocx, ocy), person_centers[state.owner_id],
                                 (0, 255, 255), 2)
                    elif state and state.drop_location and not state.is_carried:
                        cv2.circle(frame, state.drop_location, 8, (0, 80, 255), -1)
                        aban_state = abandonment.get_state(track_id)
                        if aban_state:
                            cv2.putText(
                                frame, aban_state.value,
                                (x1, y2 + 18),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 80, 255), 1, cv2.LINE_AA,
                            )

            # Alert banner — shown for 5 s after a littering event fires
            if now < alert_until:
                cv2.rectangle(frame, (0, 0), (frame.shape[1], 64), (0, 0, 180), -1)
                cv2.putText(
                    frame, "!! LITTERING DETECTED !!",
                    (20, 46),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 255, 255), 3, cv2.LINE_AA,
                )

            fps_count += 1
            elapsed = time.perf_counter() - fps_start
            if elapsed >= 1.0:
                fps_display = fps_count / elapsed
                fps_count = 0
                fps_start = time.perf_counter()

            cv2.putText(
                frame, f"FPS: {fps_display:.1f}",
                (10, 28),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2, cv2.LINE_AA,
            )

            cv2.imshow("Aegis AI — COCO detector", frame)

            # Skip the quit-key check on the first frame: macOS/Cocoa flushes
            # pending system events through the first waitKey call, which can
            # spuriously return ord('q') and immediately break the loop.
            key = cv2.waitKey(1) & 0xFF
            if frame_count > 1 and key in (ord("q"), ord("Q"), 27):
                break

    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
        cv2.destroyAllWindows()

    print(f"[COCO detector] stopped")


def main():
    parser = argparse.ArgumentParser(description="Pinequest smoking detector")
    parser.add_argument("--source", default=None,
                        help="Webcam index, file path, or RTSP URL for COCO detector")
    parser.add_argument("--video", default=None, help="Video file path or RTSP URL")
    parser.add_argument("--camera", default=None, help="Camera ID (e.g. cam_01)")
    parser.add_argument("--config", default="cameras.json", help="Camera config file")
    parser.add_argument("--output", default=None, help="Output video path (auto if omitted)")
    parser.add_argument("--no-db", action="store_true", help="Skip database writes")
    args = parser.parse_args()

    if args.source is not None:
        _run_webcam(args.source)
        return

    if not args.video or not args.camera:
        parser.error("--video and --camera are required when --source is not used")

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
