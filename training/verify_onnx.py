"""
Verify ONNX exports by comparing predictions with original .pt models on a test frame.

Usage:
    python training/verify_onnx.py

Saves side-by-side annotated image to output/onnx_verify.jpg and a text report
to output/onnx_verify.txt for review.
"""

from __future__ import annotations

import textwrap
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from ultralytics import YOLO

# ── paths ──────────────────────────────────────────────────────────────────────
VIDEO          = Path("input/smoking_test.mp4")
PT_SMOKING     = Path("training/checkpoints/pretrained.pt")
PT_LITTER      = Path("training/checkpoints/litter.pt")
ONNX_SMOKING   = Path("public/models/pretrained.onnx")
ONNX_LITTER    = Path("public/models/litter.onnx")
OUT_IMAGE      = Path("output/onnx_verify.jpg")
OUT_REPORT     = Path("output/onnx_verify.txt")

CONF_THRESH    = 0.20   # low threshold to catch weak hits on a single frame
IOU_THRESH     = 0.45
IMGSZ          = 640
# Class 0 in the smoking model is '-' (background); class 1 is actual 'smoking'
SMOKING_CLS_ID = 1


# ── detection dataclass ────────────────────────────────────────────────────────
@dataclass
class Det:
    label: str
    conf: float
    x1: int
    y1: int
    x2: int
    y2: int

    def __str__(self) -> str:
        return f"{self.label}  conf={self.conf:.3f}  box=({self.x1},{self.y1},{self.x2},{self.y2})"


# ── frame extraction (same logic as scripts/test_inference.py) ─────────────────
def extract_best_frame(smoking_model: YOLO) -> np.ndarray:
    if not VIDEO.exists():
        raise FileNotFoundError(f"Test video not found: {VIDEO}")

    cap = cv2.VideoCapture(str(VIDEO))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    sample_rate = max(1, int(fps))

    best_frame, best_conf = None, 0.0
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
                if int(box.cls[0]) == SMOKING_CLS_ID:
                    c = float(box.conf[0])
                    if c > best_conf:
                        best_conf = c
                        best_frame = frame.copy()
    cap.release()

    if best_frame is None:
        cap2 = cv2.VideoCapture(str(VIDEO))
        cap2.set(cv2.CAP_PROP_POS_FRAMES, int(fps * 5))
        _, best_frame = cap2.read()
        cap2.release()

    print(f"[frame]  best smoking conf={best_conf:.3f}  total_frames={total}")
    return best_frame


# ── .pt inference ──────────────────────────────────────────────────────────────
def infer_pt_smoking(frame: np.ndarray, model: YOLO) -> list[Det]:
    results = model(frame, verbose=False, conf=CONF_THRESH)[0]
    dets = []
    if results.boxes is not None:
        for box in results.boxes:
            if int(box.cls[0]) != SMOKING_CLS_ID:
                continue
            dets.append(Det(
                label="smoking",
                conf=float(box.conf[0]),
                x1=int(box.xyxy[0][0]), y1=int(box.xyxy[0][1]),
                x2=int(box.xyxy[0][2]), y2=int(box.xyxy[0][3]),
            ))
    return dets


def infer_pt_litter(frame: np.ndarray, model: YOLO) -> list[Det]:
    results = model(frame, verbose=False, conf=CONF_THRESH)[0]
    dets = []
    if results.boxes is not None:
        for box in results.boxes:
            label = model.names[int(box.cls[0])]
            dets.append(Det(
                label=label,
                conf=float(box.conf[0]),
                x1=int(box.xyxy[0][0]), y1=int(box.xyxy[0][1]),
                x2=int(box.xyxy[0][2]), y2=int(box.xyxy[0][3]),
            ))
    return dets


# ── ONNX preprocessing / postprocessing ───────────────────────────────────────
def preprocess(frame: np.ndarray) -> np.ndarray:
    """BGR frame → float32 NCHW tensor normalised to [0,1]."""
    img = cv2.resize(frame, (IMGSZ, IMGSZ))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    img = img.astype(np.float32) / 255.0
    img = np.transpose(img, (2, 0, 1))          # HWC → CHW
    return np.expand_dims(img, axis=0)           # CHW → NCHW


def _xywh2xyxy(cx: float, cy: float, w: float, h: float,
               orig_w: int, orig_h: int) -> tuple[int, int, int, int]:
    """Convert normalised cx,cy,w,h (640-space) to pixel xyxy in original image space."""
    scale_x = orig_w / IMGSZ
    scale_y = orig_h / IMGSZ
    x1 = int((cx - w / 2) * scale_x)
    y1 = int((cy - h / 2) * scale_y)
    x2 = int((cx + w / 2) * scale_x)
    y2 = int((cy + h / 2) * scale_y)
    return x1, y1, x2, y2


def nms(boxes: list, scores: list, iou_thresh: float) -> list[int]:
    if not boxes:
        return []
    arr = np.array(boxes, dtype=np.float32)
    sc  = np.array(scores, dtype=np.float32)
    idxs = cv2.dnn.NMSBoxes(
        arr.tolist(), sc.tolist(), CONF_THRESH, iou_thresh
    )
    if isinstance(idxs, np.ndarray):
        return idxs.flatten().tolist()
    return [i[0] for i in idxs] if idxs else []


def infer_onnx(frame: np.ndarray, onnx_path: Path,
               class_names: list[str],
               filter_cls: int | None = None) -> list[Det]:
    """Run ONNX inference and return filtered detections."""
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name
    tensor = preprocess(frame)
    raw = sess.run(None, {inp_name: tensor})[0]   # shape [1, nc+4, 8400]

    orig_h, orig_w = frame.shape[:2]
    output = raw[0]                               # shape [nc+4, 8400]
    n_anchors = output.shape[1]
    nc = output.shape[0] - 4

    boxes, scores, class_ids = [], [], []
    for i in range(n_anchors):
        cx, cy, w, h = output[0, i], output[1, i], output[2, i], output[3, i]
        cls_scores = output[4:, i]
        cls_id = int(np.argmax(cls_scores))
        conf = float(cls_scores[cls_id])
        if conf < CONF_THRESH:
            continue
        if filter_cls is not None and cls_id != filter_cls:
            continue
        x1, y1, x2, y2 = _xywh2xyxy(cx, cy, w, h, orig_w, orig_h)
        boxes.append([x1, y1, x2 - x1, y2 - y1])
        scores.append(conf)
        class_ids.append(cls_id)

    kept = nms(boxes, scores, IOU_THRESH)
    dets = []
    for i in kept:
        x1, y1, bw, bh = boxes[i]
        dets.append(Det(
            label=class_names[class_ids[i]],
            conf=scores[i],
            x1=x1, y1=y1, x2=x1 + bw, y2=y1 + bh,
        ))
    return dets


# ── comparison helpers ─────────────────────────────────────────────────────────
def box_iou(a: Det, b: Det) -> float:
    ix1 = max(a.x1, b.x1); iy1 = max(a.y1, b.y1)
    ix2 = min(a.x2, b.x2); iy2 = min(a.y2, b.y2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    area_a = (a.x2 - a.x1) * (a.y2 - a.y1)
    area_b = (b.x2 - b.x1) * (b.y2 - b.y1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


DEMO_DISPLAY_THRESH = 0.5   # detections below this won't be shown in the demo app


def compare(pt_dets: list[Det], onnx_dets: list[Det], model_name: str) -> tuple[bool, list[str]]:
    lines = [f"\n=== {model_name} ==="]
    lines.append(f"  .pt   detections: {len(pt_dets)}")
    for d in pt_dets:
        lines.append(f"    {d}")
    lines.append(f"  .onnx detections: {len(onnx_dets)}")
    for d in onnx_dets:
        lines.append(f"    {d}")

    # Only consider detections at or above the demo display threshold as "critical"
    pt_critical   = [d for d in pt_dets   if d.conf >= DEMO_DISPLAY_THRESH]
    onnx_critical = [d for d in onnx_dets if d.conf >= DEMO_DISPLAY_THRESH]

    ok = True
    if len(pt_dets) != len(onnx_dets):
        sub_thresh = [d for d in pt_dets if d.conf < DEMO_DISPLAY_THRESH]
        note = (f" ({len(sub_thresh)} .pt det(s) are sub-threshold conf<{DEMO_DISPLAY_THRESH}"
                f" — NMS boundary differences are expected)" if sub_thresh else "")
        lines.append(f"  [WARN] detection count mismatch: .pt={len(pt_dets)} vs .onnx={len(onnx_dets)}{note}")

    # Match all detections by IoU
    matched = set()
    for i, pd in enumerate(pt_dets):
        best_iou, best_j = 0.0, -1
        for j, od in enumerate(onnx_dets):
            if j in matched:
                continue
            iou = box_iou(pd, od)
            if iou > best_iou:
                best_iou, best_j = iou, j
        critical = pd.conf >= DEMO_DISPLAY_THRESH
        if best_j >= 0 and best_iou >= 0.5:
            matched.add(best_j)
            od = onnx_dets[best_j]
            conf_delta = abs(pd.conf - od.conf)
            status = "OK" if conf_delta < 0.05 else "WARN"
            lines.append(f"  [{status}] match: .pt conf={pd.conf:.3f} | .onnx conf={od.conf:.3f} | IoU={best_iou:.3f} | delta={conf_delta:.4f}")
            if conf_delta >= 0.05 and critical:
                ok = False
        else:
            tag = "WARN" if critical else "INFO"
            lines.append(
                f"  [{tag}] .pt det '{pd.label}' conf={pd.conf:.3f} has no ONNX match "
                f"(best_iou={best_iou:.3f})"
                + ("" if critical else " [sub-threshold, not shown in demo]")
            )
            if critical:
                ok = False

    lines.append(f"  Critical (conf>={DEMO_DISPLAY_THRESH}) .pt: {len(pt_critical)}  .onnx: {len(onnx_critical)}")
    lines.append(f"  Result: {'PASS' if ok else 'FAIL (critical detection mismatch)'}")
    return ok, lines


# ── annotation helpers ────────────────────────────────────────────────────────
def draw_dets(img: np.ndarray, dets: list[Det], color: tuple, prefix: str) -> None:
    for d in dets:
        cv2.rectangle(img, (d.x1, d.y1), (d.x2, d.y2), color, 2)
        cv2.putText(img, f"{prefix} {d.label} {d.conf:.2f}",
                    (d.x1, max(d.y1 - 6, 12)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2, cv2.LINE_AA)


# ── main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    OUT_IMAGE.parent.mkdir(parents=True, exist_ok=True)

    smoking_pt_model = YOLO(str(PT_SMOKING))
    litter_pt_model  = YOLO(str(PT_LITTER))

    smoking_class_names = list(smoking_pt_model.names.values())
    litter_class_names  = list(litter_pt_model.names.values())

    print("[step]   extracting best smoking frame from test video…")
    frame = extract_best_frame(smoking_pt_model)

    print("[step]   running .pt inference…")
    pt_smoke  = infer_pt_smoking(frame, smoking_pt_model)
    pt_litter = infer_pt_litter(frame, litter_pt_model)

    print("[step]   running ONNX inference…")
    onnx_smoke  = infer_onnx(frame, ONNX_SMOKING, smoking_class_names, filter_cls=SMOKING_CLS_ID)
    onnx_litter = infer_onnx(frame, ONNX_LITTER,  litter_class_names)

    # Build comparison report
    report_lines: list[str] = ["ONNX Export Verification Report", "=" * 50]
    ok_smoke,  lines_smoke  = compare(pt_smoke,  onnx_smoke,  "Smoking model (pretrained.pt vs pretrained.onnx)")
    ok_litter, lines_litter = compare(pt_litter, onnx_litter, "Litter  model (litter.pt vs litter.onnx)")
    report_lines += lines_smoke + lines_litter

    overall = "PASS" if (ok_smoke and ok_litter) else "FAIL"
    report_lines.append(f"\nOverall: {overall}")

    report_text = "\n".join(report_lines)
    print(report_text)

    OUT_REPORT.write_text(report_text)
    print(f"\n[report] saved to {OUT_REPORT}")

    # Build side-by-side annotated image
    # Left = .pt detections, Right = .onnx detections
    left  = frame.copy()
    right = frame.copy()

    draw_dets(left,  pt_smoke,    (0, 0, 255),   ".pt")
    draw_dets(left,  pt_litter,   (0, 165, 255), ".pt")
    draw_dets(right, onnx_smoke,  (0, 255, 0),   ".onnx")
    draw_dets(right, onnx_litter, (255, 165, 0), ".onnx")

    # Add labels
    for img, label in [(left, ".pt predictions"), (right, ".onnx predictions")]:
        cv2.putText(img, label, (10, 26),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2, cv2.LINE_AA)

    side_by_side = np.hstack([left, right])
    cv2.imwrite(str(OUT_IMAGE), side_by_side)
    print(f"[image]  saved to {OUT_IMAGE}")


if __name__ == "__main__":
    main()
