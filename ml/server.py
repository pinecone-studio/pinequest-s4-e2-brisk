"""CCTV analytics API server (LitServe + Ultralytics YOLO).

Loads two YOLO models on the GPU and runs inference on incoming JPEG frames:
  - fire_smoke.pt  -> "safety"   group (fire / smoke)
  - litter_cig.pt  -> "behavior" group (litter / cigarettes)

Run:  python server.py   (serves on http://0.0.0.0:8000/predict)
"""

import base64
import io

import cv2
import numpy as np
import torch
import litserve as ls
from ultralytics import YOLO

# --- Model registry ---------------------------------------------------------
# Each model is tagged with the analytics group its detections belong to.
MODEL_REGISTRY = [
    {"name": "fire_smoke", "path": "weights/fire_smoke.pt", "group": "safety"},
    {"name": "litter_cig", "path": "weights/litter_cig.pt", "group": "behavior"},
]

# Inference config
CONF_THRESHOLD = 0.25
IMG_SIZE = 640


class CCTVAnalyticsAPI(ls.LitAPI):
    def setup(self, device):
        """Load both YOLO models onto the GPU (device='cuda')."""
        # LitServe passes the accelerator device (e.g. "cuda:0"). Fall back to a
        # cuda/cpu autodetect if it hands us something unusable.
        self.device = device if isinstance(device, str) and device else (
            "cuda" if torch.cuda.is_available() else "cpu"
        )

        self.models = []
        for cfg in MODEL_REGISTRY:
            model = YOLO(cfg["path"])
            model.to(self.device)
            self.models.append({**cfg, "model": model})

        print(f"[setup] loaded {len(self.models)} models on device={self.device}")

    def decode_request(self, request):
        """Decode incoming JPEG image bytes into a BGR numpy array.

        Accepts either raw JPEG bytes as the body, or a JSON object of the form
        {"image": "<base64-encoded-jpeg>"}.
        """
        if isinstance(request, (bytes, bytearray)):
            raw = bytes(request)
        elif isinstance(request, dict):
            payload = request.get("image") or request.get("img") or request.get("data")
            if payload is None:
                raise ValueError("Request JSON must contain an 'image' field.")
            raw = base64.b64decode(payload) if isinstance(payload, str) else bytes(payload)
        else:
            raise ValueError(f"Unsupported request payload type: {type(request)!r}")

        buffer = np.frombuffer(raw, dtype=np.uint8)
        image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("Failed to decode JPEG image bytes.")
        return image

    def predict(self, image):
        """Run both models sequentially and collect categorized detections."""
        detections = []

        for entry in self.models:
            model = entry["model"]
            results = model.predict(
                image,
                device=self.device,
                conf=CONF_THRESHOLD,
                imgsz=IMG_SIZE,
                verbose=False,
            )

            for result in results:
                names = result.names
                for box in result.boxes:
                    cls_id = int(box.cls[0])
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    detections.append(
                        {
                            "model": entry["name"],
                            "group": entry["group"],
                            "class_name": names.get(cls_id, str(cls_id)),
                            "class_id": cls_id,
                            "confidence": round(float(box.conf[0]), 4),
                            "bbox": {
                                "x1": round(x1, 2),
                                "y1": round(y1, 2),
                                "x2": round(x2, 2),
                                "y2": round(y2, 2),
                            },
                        }
                    )

        return {
            "detections": detections,
            "count": len(detections),
            "groups": {
                "safety": sum(1 for d in detections if d["group"] == "safety"),
                "behavior": sum(1 for d in detections if d["group"] == "behavior"),
            },
        }

    def encode_response(self, output):
        """Return the structured detection payload as JSON."""
        return output


if __name__ == "__main__":
    api = CCTVAnalyticsAPI()
    server = ls.LitServer(api, accelerator="cuda", devices=1)
    server.run(port=8000)
