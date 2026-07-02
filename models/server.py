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
