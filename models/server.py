import io
import base64

import litserve as ls
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
        # Stage 1 — person detector (stock COCO, class 0).
        self.person = YOLO("yolov8n.pt")

        # Stage 2 — cheap violation gates, pulled from Hugging Face at startup.
        smoke_weights = hf_hub_download("kittendev/YOLOv8m-smoke-detection", "best.pt")
        self.smoke = YOLO(smoke_weights)

        litter_weights = hf_hub_download(
            "turhancan97/yolov8-segment-trash-detection", "yolov8m-seg.pt"
        )
        self.litter = YOLO(litter_weights)

    def decode_request(self, request):
        data = request.get("image")
        if not data:
            raise ValueError("Payload missing field: 'image'")
        if "," in data:  # strip data-URL header if the client sent one
            data = data.split(",")[1]
        image_bytes = base64.b64decode(data)
        return Image.open(io.BytesIO(image_bytes)).convert("RGB")

    def _run(self, model, image, conf, classes=None):
        return model(image, conf=conf, classes=classes, verbose=False)[0]

    def predict(self, image):
        # Stage 1: no person -> nothing else runs, definitely no Gemini.
        person = self._run(self.person, image, PERSON_CONF, classes=[PERSON_CLASS_ID])
        if len(person.boxes) == 0:
            return {
                "has_person": False,
                "has_smoke": False,
                "has_litter": False,
                "litter_boxes": [],
                "should_analyze": False,
            }

        # Stage 2: person present -> run the cheap gates.
        smoke = self._run(self.smoke, image, GATE_CONF)
        litter = self._run(self.litter, image, GATE_CONF)

        has_smoke = len(smoke.boxes) > 0
        # Normalized [x1, y1, x2, y2] boxes so the client can dedup litter by
        # LOCATION — the same trash fires every frame otherwise.
        litter_boxes = (
            [[round(float(v), 4) for v in box] for box in litter.boxes.xyxyn.tolist()]
            if len(litter.boxes) > 0
            else []
        )
        has_litter = len(litter_boxes) > 0

        return {
            "has_person": True,
            "has_smoke": has_smoke,
            "has_litter": has_litter,
            "litter_boxes": litter_boxes,
            # Gemini is only called when a person AND a smoke/litter candidate are present.
            "should_analyze": has_smoke or has_litter,
        }

    def encode_response(self, output):
        return output


if __name__ == "__main__":
    print("Initializing ViolationGate (person -> smoke/litter) on port 8000...")
    server = ls.LitServer(ViolationGate(), accelerator="auto")
    server.run(port=8000)
