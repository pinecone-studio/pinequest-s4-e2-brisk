import io
import os
import time
import base64
import sys
import subprocess
from typing import Any, Dict, List, Optional

# 1. Automatic Dependency Check & Verification
REQUIRED_PACKAGES = ["litserve", "ultralytics", "pillow", "requests"]
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

# Person must be fairly confident before we bother running the other models.
PERSON_CONF = 0.75
# Smoke / litter are the CHEAP GATE for Gemini. Keep the threshold LOW on purpose:
# we would rather send a borderline case to Gemini (accurate judge) than miss a
# real violation here. High recall, low precision by design.
GATE_CONF = 0.25

PERSON_CLASS_ID = 0


class ViolationGate(ls.LitAPI):
    def setup(self, device):
        # Load small footprint nano weights onto active device (CPU/GPU)
        self.model = YOLO("yolov8n.pt")
        self.PERSON_CLASS_ID = 0
        self.person_conf_threshold = float(os.getenv("PERSON_CONF_THRESHOLD", "0.75"))
        self.max_crops = int(os.getenv("MAX_PERSON_CROPS", "4"))
        self.jpeg_quality = int(os.getenv("CROP_JPEG_QUALITY", "85"))
        self.client_analyze_url = os.getenv("CLIENT_ANALYZE_URL", "").strip()
        self.models_client_secret = os.getenv("MODELS_CLIENT_SECRET", "").strip()
        self.forward_timeout_s = float(os.getenv("CLIENT_FORWARD_TIMEOUT_S", "8"))
        self.forward_retries = int(os.getenv("CLIENT_FORWARD_RETRIES", "2"))
        self.forward_retry_delay_s = float(os.getenv("CLIENT_FORWARD_RETRY_DELAY_S", "0.5"))

        print(f"✅ Person threshold: {self.person_conf_threshold}")
        print(f"✅ Max person crops: {self.max_crops}")
        if self.client_analyze_url:
            print(f"✅ Forwarding enabled: {self.client_analyze_url}")
        else:
            print("ℹ️ Forwarding disabled (CLIENT_ANALYZE_URL not set)")

    def decode_request(self, request):
        camera_id = "unknown-camera"
        timestamp_ms = int(time.time() * 1000)

        if isinstance(request, dict):
            base64_data = request.get("image")
            if not base64_data:
                raise ValueError("Payload missing field: 'image'")
            camera_id = str(request.get("cameraId") or camera_id)
            timestamp_ms = int(request.get("timestamp") or timestamp_ms)
        elif isinstance(request, (bytes, bytearray)):
            base64_data = base64.b64encode(bytes(request)).decode("utf-8")
        else:
            raise ValueError("Payload must be JSON with 'image' or raw JPEG bytes")
        # Stage 1 — person detector (stock COCO, class 0).
        self.person = YOLO("yolov8n.pt")

        # Stage 2 — cheap violation gates, pulled from Hugging Face at startup.
        smoke_weights = hf_hub_download("kittendev/YOLOv8m-smoke-detection", "best.pt")
        self.smoke = YOLO(smoke_weights)

        litter_weights = hf_hub_download(
            "turhancan97/yolov8-segment-trash-detection", "yolov8m-seg.pt"
        )
        self.litter = YOLO(litter_weights)

        image_bytes = base64.b64decode(base64_data)
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        return {"image": image, "cameraId": camera_id, "timestamp": timestamp_ms}

    def _clip_box(self, x1: float, y1: float, x2: float, y2: float, width: int, height: int) -> Optional[tuple]:
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

    def _forward_to_client(
        self,
        camera_id: str,
        timestamp_ms: int,
        frames: List[str],
    ) -> Dict[str, Any]:
        if not self.client_analyze_url:
            return {"attempted": False, "ok": False, "reason": "CLIENT_ANALYZE_URL not configured"}
        if not self.models_client_secret:
            return {"attempted": False, "ok": False, "reason": "MODELS_CLIENT_SECRET not configured"}
        if not frames:
            return {"attempted": False, "ok": False, "reason": "no person crops to forward"}

        payload = {
            "cameraId": camera_id,
            "timestamp": timestamp_ms,
            "frames": frames,
        }
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
                    print(
                        f"✅ [forward:{camera_id}] acknowledged by client "
                        f"(status={resp.status_code}, attempt={attempt}/{attempts})"
                    )
                    return {"attempted": True, "ok": True, "status": resp.status_code, "attempt": attempt}

                body = (resp.text or "")[:300]
                last_error = f"HTTP {resp.status_code}: {body}"
                print(
                    f"⚠️ [forward:{camera_id}] non-2xx from client "
                    f"(attempt={attempt}/{attempts}): {last_error}"
                )
            except requests.RequestException as exc:
                last_error = str(exc)
                print(
                    f"⚠️ [forward:{camera_id}] request failed "
                    f"(attempt={attempt}/{attempts}): {last_error}"
                )

            if attempt < attempts:
                time.sleep(self.forward_retry_delay_s * attempt)

        return {"attempted": True, "ok": False, "error": last_error}

    def predict(self, request_payload):
        image: Image.Image = request_payload["image"]
        camera_id = request_payload["cameraId"]
        timestamp_ms = request_payload["timestamp"]

        # Target only human entities (class 0) to maximize performance speed
        results = self.model(image, classes=[self.PERSON_CLASS_ID], verbose=False)
        boxes = results[0].boxes

        person_boxes = []
        for box in boxes:
            conf = float(box.conf[0])
            if conf < self.person_conf_threshold:
                continue
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            person_boxes.append((conf, x1, y1, x2, y2))

        person_boxes.sort(key=lambda item: item[0], reverse=True)
        person_boxes = person_boxes[: self.max_crops]

        img_w, img_h = image.size
        frames: List[str] = []
        for _, x1, y1, x2, y2 in person_boxes:
            clipped = self._clip_box(x1, y1, x2, y2, img_w, img_h)
            if clipped is None:
                continue
            frames.append(self._crop_to_base64_jpeg(image, clipped))

        has_person = len(frames) > 0
        forward = self._forward_to_client(camera_id, timestamp_ms, frames)

        return {
            "has_person": has_person,
            "cameraId": camera_id,
            "timestamp": timestamp_ms,
            "person_count": len(frames),
            "forward": forward,
        }
    def decode_request(self, request):
        data = request.get("image")
        if not data:
            raise ValueError("Payload missing field: 'image'")
        if "," in data:  # strip data-URL header if the client sent one
            data = data.split(",")[1]
        image_bytes = base64.b64decode(data)
        return Image.open(io.BytesIO(image_bytes)).convert("RGB")

    @staticmethod
    def _boxes(result):
        # Normalized [x1, y1, x2, y2] so the client can match boxes across frames
        # regardless of resolution.
        if len(result.boxes) == 0:
            return []
        return [[round(float(v), 4) for v in box] for box in result.boxes.xyxyn.tolist()]

    def predict(self, images):
        # LitServe batches concurrent requests, so `images` is a LIST of frames.
        # YOLO runs a whole batch in one GPU call -> big throughput win for many
        # cameras. Litter + person run on every frame; smoke runs on the batch too
        # (cheap once batched) and is only reported when a person is present.
        litter_results = self.litter(images, conf=GATE_CONF, verbose=False)
        person_results = self.person(
            images, conf=PERSON_CONF, classes=[PERSON_CLASS_ID], verbose=False
        )
        smoke_results = self.smoke(images, conf=GATE_CONF, verbose=False)

        outputs = []
        for i in range(len(images)):
            person_boxes = self._boxes(person_results[i])
            has_person = len(person_boxes) > 0
            litter_boxes = self._boxes(litter_results[i])
            has_smoke = has_person and len(smoke_results[i].boxes) > 0
            outputs.append(
                {
                    "has_person": has_person,
                    "person_boxes": person_boxes,
                    "has_smoke": has_smoke,
                    "has_litter": len(litter_boxes) > 0,
                    "litter_boxes": litter_boxes,
                    # Coarse flag for the smoke path / legacy fallback. Litter is
                    # judged by the client's drop -> leave -> handled state machine.
                    "should_analyze": has_smoke or len(litter_boxes) > 0,
                }
            )
        return outputs

    def encode_response(self, output):
        return output


if __name__ == "__main__":
    print("Initializing ViolationGate (person -> smoke/litter) on port 8000...")
    # Batch concurrent camera requests into one GPU call. Tune for your load:
    # bigger batch = more throughput, small timeout = low added latency.
    server = ls.LitServer(
        ViolationGate(),
        accelerator="auto",
        max_batch_size=16,
        batch_timeout=0.02,
    )
    server.run(port=8000)
