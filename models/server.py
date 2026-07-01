import io
import base64
import sys
import subprocess

# 1. Automatic Dependency Check & Verification
REQUIRED_PACKAGES = ["litserve", "ultralytics", "pillow"]
for package in REQUIRED_PACKAGES:
    try:
        __import__(package if package != "pillow" else "PIL")
    except ImportError:
        print(f"📦 Package '{package}' is missing. Installing...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", package])

import litserve as ls
from PIL import Image
from ultralytics import YOLO

# 2. High-Performance Person Detection API Engine
class YOLOv8PersonDetector(ls.LitAPI):
    def setup(self, device):
        # Load small footprint nano weights onto active device (CPU/GPU)
        self.model = YOLO("yolov8n.pt")
        self.PERSON_CLASS_ID = 0

    def decode_request(self, request):
        base64_data = request.get("image")
        if not base64_data:
            raise ValueError("Payload missing field: 'image'")

        # Clean up Next.js Data URL headers if sent
        if "," in base64_data:
            base64_data = base64_data.split(",")[1]

        image_bytes = base64.b64decode(base64_data)
        return Image.open(io.BytesIO(image_bytes)).convert("RGB")

    def predict(self, image):
        # Target only human entities (class 0) to maximize performance speed
        results = self.model(image, classes=[self.PERSON_CLASS_ID], verbose=False)
        boxes = results[0].boxes

        # Immediate short-circuit if a human is detected above 75% confidence
        has_person = any(float(box.conf[0]) >= 0.75 for box in boxes) if len(boxes) > 0 else False
        return {"has_person": has_person}

    def encode_response(self, output):
        return output

if __name__ == "__main__":
    print("🚀 Initializing native LitServe framework on port 8000...")
    api = YOLOv8PersonDetector()
    server = ls.LitServer(api, accelerator="auto")
    server.run(port=8000)
