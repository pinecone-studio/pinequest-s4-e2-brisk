"""
Extract a test frame from input video and run inference with pretrained models.
Run from repo root: python3 scripts/test_inference.py

Saves annotated output to output/test_inference.jpg
"""

import sys
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

VIDEO = Path("input/smoking_test.mp4")
OUTPUT = Path("output/test_inference.jpg")
OUTPUT.parent.mkdir(parents=True, exist_ok=True)

SMOKING_WEIGHTS = Path("training/checkpoints/pretrained.pt")
LITTER_WEIGHTS  = Path("training/checkpoints/litter.pt")

CONF_THRESHOLD = 0.30   # lower than prod so we catch weaker hits on this one frame

# Class index for smoking in timmy-ji8jf/smoking-bjzv1 dataset (class 0 = '-' / background)
_SMOKING_CLASS_ID = 1


def extract_best_frame(video_path: Path, smoking_model: YOLO) -> tuple:
    """Scan the video and return the frame with the highest smoking confidence."""
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    best_frame, best_idx, best_conf = None, 0, 0.0
    sample_rate = max(1, int(fps))  # check one frame per second

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_idx += 1
        if frame_idx % sample_rate != 0:
            continue
        results = smoking_model(frame, verbose=False, conf=0.20)[0]
        if results.boxes is not None:
            for box in results.boxes:
                if int(box.cls[0]) == _SMOKING_CLASS_ID:
                    conf = float(box.conf[0])
                    if conf > best_conf:
                        best_conf = conf
                        best_frame = frame.copy()
                        best_idx = frame_idx

    cap.release()
    if best_frame is None:
        # fallback: first frame
        cap2 = cv2.VideoCapture(str(video_path))
        cap2.set(cv2.CAP_PROP_POS_FRAMES, int(fps * 5))
        _, best_frame = cap2.read()
        cap2.release()
        best_idx = int(fps * 5)

    print(f"[frame]    best smoking frame: #{best_idx}/{total}  (conf={best_conf:.3f})  from {video_path}")
    return best_frame, best_idx


def run_smoking(frame: np.ndarray, annotated: np.ndarray, model: YOLO) -> list:
    results = model(frame, verbose=False, conf=CONF_THRESHOLD)[0]
    detections = []
    if results.boxes is not None:
        for box in results.boxes:
            cls_id = int(box.cls[0])
            if cls_id != _SMOKING_CLASS_ID:  # skip background class 0 ('-')
                continue
            conf  = float(box.conf[0])
            x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
            detections.append(("smoking", conf, x1, y1, x2, y2))
            cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 0, 255), 2)
            cv2.putText(annotated, f"smoking {conf:.2f}",
                        (x1, max(y1 - 8, 14)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2, cv2.LINE_AA)
    print(f"[smoking]  {len(detections)} detection(s)")
    for d in detections:
        print(f"           {d[0]}  conf={d[1]:.3f}  box=({d[2]},{d[3]},{d[4]},{d[5]})")
    return detections


def run_litter(frame: np.ndarray, annotated: np.ndarray) -> list:
    model = YOLO(str(LITTER_WEIGHTS))
    results = model(frame, verbose=False, conf=CONF_THRESHOLD)[0]
    detections = []
    if results.boxes is not None:
        for box in results.boxes:
            cls_id = int(box.cls[0])
            label = model.names[cls_id]
            conf  = float(box.conf[0])
            x1, y1, x2, y2 = (int(v) for v in box.xyxy[0])
            detections.append((label, conf, x1, y1, x2, y2))
            cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 165, 255), 2)
            cv2.putText(annotated, f"litter {conf:.2f}",
                        (x1, max(y1 - 8, 14)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 165, 255), 2, cv2.LINE_AA)
    print(f"[litter]   {len(detections)} detection(s)")
    for d in detections:
        print(f"           {d[0]}  conf={d[1]:.3f}  box=({d[2]},{d[3]},{d[4]},{d[5]})")
    return detections


def main():
    if not VIDEO.exists():
        sys.exit(f"Test video not found: {VIDEO}")

    smoking_model = YOLO(str(SMOKING_WEIGHTS))
    litter_model  = YOLO(str(LITTER_WEIGHTS))

    frame, frame_idx = extract_best_frame(VIDEO, smoking_model)
    annotated = frame.copy()

    smoke_dets = run_smoking(frame, annotated, smoking_model)
    litter_dets = run_litter(frame, annotated)

    total = len(smoke_dets) + len(litter_dets)
    label = f"detections: {total}  (smoking={len(smoke_dets)}, litter={len(litter_dets)})"
    cv2.putText(annotated, label, (10, 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2, cv2.LINE_AA)

    cv2.imwrite(str(OUTPUT), annotated)
    print(f"\n[output]   saved to {OUTPUT}")
    print(f"[summary]  total detections: {total}")
    if total == 0:
        print("           (no detections at conf>=0.30 on this frame — try a different second)")


if __name__ == "__main__":
    main()
