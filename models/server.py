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

    @staticmethod
    def _boxes(result):
        # Normalized [x1, y1, x2, y2] so the client can match boxes across frames
        # regardless of resolution.
        if len(result.boxes) == 0:
            return []
        return [[round(float(v), 4) for v in box] for box in result.boxes.xyxyn.tolist()]

    def predict(self, image):
        # Litter runs EVERY frame (even with no person): the client needs to watch
        # trash persist after a person leaves, and later see it get removed.
        litter = self._run(self.litter, image, GATE_CONF)
        litter_boxes = self._boxes(litter)

        person = self._run(self.person, image, PERSON_CONF, classes=[PERSON_CLASS_ID])
        person_boxes = self._boxes(person)
        has_person = len(person_boxes) > 0

        # Smoking requires a person -> only run that model when one is present.
        has_smoke = False
        if has_person:
            smoke = self._run(self.smoke, image, GATE_CONF)
            has_smoke = len(smoke.boxes) > 0

        return {
            "has_person": has_person,
            "person_boxes": person_boxes,
            "has_smoke": has_smoke,
            "has_litter": len(litter_boxes) > 0,
            "litter_boxes": litter_boxes,
            # Coarse flag, kept for the smoke path and legacy fallback. Litter is
            # now judged by the client's drop -> leave -> handled state machine.
            "should_analyze": has_smoke or len(litter_boxes) > 0,
        }

    def encode_response(self, output):
        return output


if __name__ == "__main__":
    print("Initializing ViolationGate (person -> smoke/litter) on port 8000...")
    server = ls.LitServer(ViolationGate(), accelerator="auto")
    server.run(port=8000)
