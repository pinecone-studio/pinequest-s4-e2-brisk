export const ACTIVE_MODEL =
  (process.env.NEXT_PUBLIC_ACTIVE_MODEL as "pretrained" | "finetuned") ??
  "pretrained";

export const SMOKING_MODEL_PATH = `/models/${ACTIVE_MODEL}.onnx`;
export const LITTER_MODEL_PATH = `/models/litter.onnx`;
export const COCO_MODEL_PATH = "/models/coco.onnx";

/** Smoking class-1 decode threshold (composite filters handle precision). */
export const SMOKING_THRESHOLD = 0.22;
export const SMOKING_MODEL_MIN = 0.25;
export const SMOKING_COMPOSITE_THRESHOLD = 0.28;
export const SMOKING_HIGH_CONFIDENCE = 0.42;
export const SMOKING_MOUTH_BOX_MIN = 0.22;
/** Only reject toy/red-light pixels below this model score. */
export const SMOKING_VISUAL_FP_MAX = 0.48;
export const LITTER_THRESHOLD = 0.4;
export const ALERT_THRESHOLD = 0.55;
export const COCO_THRESHOLD = 0.25;
export const PERSON_THRESHOLD = 0.25;
export const SHOW_PERSON_DETECTIONS = true;

export const INPUT_SIZE = 640;
export const SMOKING_CLASS_IDX = 1;

export const PERSON_CLASS_IDX = 0;

export const COCO_CLASS_NAMES = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
  "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
  "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
  "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
  "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
  "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
  "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
  "toothbrush",
];
