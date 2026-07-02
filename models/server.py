import io
import os
import time
import base64
import sys
import subprocess
from typing import Any, Dict, List, Optional

REQUIRED_PACKAGES = ["litserve", "ultralytics", "pillow", "requests", "huggingface_hub"]
for package in REQUIRED_PACKAGES:
    try:
        __import__(package if package != "pillow" else "PIL")
    except ImportError:
        print(f"📦 Package '{package}' is missing. Installing...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", package])

import litserve as ls
import requests
from PIL import Image
from ultralytics import YOLO
from huggingface_hub import hf_hub_download

PERSON_CLASS_ID = 0


class ViolationGate(ls.LitAPI):
    def setup(self, device):
        self.person_conf_threshold = float(os.getenv("PERSON_CONF_THRESHOLD", "0.75"))
        self.gate_conf_threshold = float(os.getenv("GATE_CONF_THRESHOLD", "0.25"))
        self.max_crops = int(os.getenv("MAX_PERSON_CROPS", "4"))
        self.jpeg_quality = int(os.getenv("CROP_JPEG_QUALITY", "85"))
        self.client_analyze_url = os.getenv("CLIENT_ANALYZE_URL", "").strip()
        self.models_client_secret = os.getenv("MODELS_CLIENT_SECRET", "").strip()
        self.forward_timeout_s = float(os.getenv("CLIENT_FORWARD_TIMEOUT_S", "8"))
        self.forward_retries = int(os.getenv("CLIENT_FORWARD_RETRIES", "2"))
        self.forward_retry_delay_s = float(os.getenv("CLIENT_FORWARD_RETRY_DELAY_S", "0.5"))

        self.person = YOLO("yolov8n.pt")
        smoke_weights = hf_hub_download("kittendev/YOLOv8m-smoke-detection", "best.pt")
        self.smoke = YOLO(smoke_weights)
        litter_weights = hf_hub_download(
            "turhancan97/yolov8-segment-trash-detection", "yolov8m-seg.pt"
        )
        self.litter = YOLO(litter_weights)

        print(f"✅ Person threshold: {self.person_conf_threshold}")
        print(f"✅ Gate threshold: {self.gate_conf_threshold}")
        if self.client_analyze_url:
            print(f"✅ Forwarding enabled: {self.client_analyze_url}")
        else:
            print("ℹ️ Forwarding disabled (CLIENT_ANALYZE_URL not set)")

    def decode_request(self, request):
        camera_id = "unknown-camera"
        timestamp_ms = int(time.time() * 1000)

        if isinstance(request, dict):
            data = request.get("image")
            if not data:
                raise ValueError("Payload missing field: 'image'")
            if "," in data:
                data = data.split(",", 1)[1]
            camera_id = str(request.get("cameraId") or camera_id)
            timestamp_ms = int(request.get("timestamp") or timestamp_ms)
            image_bytes = base64.b64decode(data)
        elif isinstance(request, (bytes, bytearray)):
            image_bytes = bytes(request)
        else:
            raise ValueError("Payload must be JSON with 'image' or raw JPEG bytes")

        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        return {"image": image, "cameraId": camera_id, "timestamp": timestamp_ms}

    @staticmethod
    def _norm_boxes(result):
        if len(result.boxes) == 0:
            return []
        return [[round(float(v), 4) for v in box] for box in result.boxes.xyxyn.tolist()]

    @staticmethod
    def _clip_box(x1: float, y1: float, x2: float, y2: float, width: int, height: int) -> Optional[tuple]:
        left = max(0, min(int(x1), width - 1))
        top = max(0, min(int(y1), height - 1))
        right = max(0, min(int(x2), width))
        bottom = max(0, min(int(y2), height))
        if right <= left or bottom <= top:
            return None
        return left, top, right, bottom

    def _crop_to_base64_jpeg(self, image: Image.Image, box: tuple) -> str:
        crop = image.crop(box)
        buf = io.BytesIO()
        crop.save(buf, format="JPEG", quality=self.jpeg_quality, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("utf-8")

    def _extract_person_crops(self, image: Image.Image, person_result) -> List[str]:
        raw_boxes = []
        for box in person_result.boxes:
            conf = float(box.conf[0])
            if conf < self.person_conf_threshold:
                continue
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            raw_boxes.append((conf, x1, y1, x2, y2))

        raw_boxes.sort(key=lambda x: x[0], reverse=True)
        raw_boxes = raw_boxes[: self.max_crops]

        frames: List[str] = []
        width, height = image.size
        for _, x1, y1, x2, y2 in raw_boxes:
            clipped = self._clip_box(x1, y1, x2, y2, width, height)
            if clipped is None:
                continue
            frames.append(self._crop_to_base64_jpeg(image, clipped))
        return frames

    def _forward_to_client(self, camera_id: str, timestamp_ms: int, frames: List[str]) -> Dict[str, Any]:
        if not self.client_analyze_url:
            return {"attempted": False, "ok": False, "reason": "CLIENT_ANALYZE_URL not configured"}
        if not self.models_client_secret:
            return {"attempted": False, "ok": False, "reason": "MODELS_CLIENT_SECRET not configured"}
        if not frames:
            return {"attempted": False, "ok": False, "reason": "no person crops to forward"}

        payload = {"cameraId": camera_id, "timestamp": timestamp_ms, "frames": frames}
        headers = {
            "Authorization": f"Bearer {self.models_client_secret}",
            "Content-Type": "application/json",
        }

        attempts = self.forward_retries + 1
        last_error = ""
        for attempt in range(1, attempts + 1):
            try:
                resp = requests.post(
                    self.client_analyze_url,
                    json=payload,
                    headers=headers,
                    timeout=self.forward_timeout_s,
                )
                if 200 <= resp.status_code < 300:
                    return {"attempted": True, "ok": True, "status": resp.status_code, "attempt": attempt}
                last_error = f"HTTP {resp.status_code}: {(resp.text or '')[:300]}"
            except requests.RequestException as exc:
                last_error = str(exc)
            if attempt < attempts:
                time.sleep(self.forward_retry_delay_s * attempt)
        return {"attempted": True, "ok": False, "error": last_error}

    def predict(self, requests_batch):
        if not isinstance(requests_batch, list):
            requests_batch = [requests_batch]

        images = [item["image"] for item in requests_batch]
        person_results = self.person(
            images,
            conf=self.person_conf_threshold,
            classes=[PERSON_CLASS_ID],
            verbose=False,
        )
        litter_results = self.litter(images, conf=self.gate_conf_threshold, verbose=False)
        smoke_results = self.smoke(images, conf=self.gate_conf_threshold, verbose=False)

        outputs = []
        for idx, request_item in enumerate(requests_batch):
            image = request_item["image"]
            camera_id = request_item["cameraId"]
            timestamp_ms = request_item["timestamp"]

            person_result = person_results[idx]
            person_boxes = self._norm_boxes(person_result)
            has_person = len(person_boxes) > 0
            litter_boxes = self._norm_boxes(litter_results[idx])
            has_litter = len(litter_boxes) > 0
            has_smoke = has_person and len(smoke_results[idx].boxes) > 0
            should_analyze = has_smoke or has_litter

            frames = self._extract_person_crops(image, person_result)
            forward = self._forward_to_client(camera_id, timestamp_ms, frames)

            outputs.append(
                {
                    "has_person": has_person,
                    "person_boxes": person_boxes,
                    "has_smoke": has_smoke,
                    "has_litter": has_litter,
                    "litter_boxes": litter_boxes,
                    "should_analyze": should_analyze,
                    "cameraId": camera_id,
                    "timestamp": timestamp_ms,
                    "person_count": len(frames),
                    "forward": forward,
                }
            )
        return outputs

    def encode_response(self, output):
        return output


if __name__ == "__main__":
    print("Initializing ViolationGate (person -> smoke/litter + client handoff) on port 8000...")
    server = ls.LitServer(
        ViolationGate(),
        accelerator="auto",
        max_batch_size=16,
        batch_timeout=0.02,
    )
    server.run(port=8000)
