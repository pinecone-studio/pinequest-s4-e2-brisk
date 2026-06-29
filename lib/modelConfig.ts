export const ACTIVE_MODEL =
  (process.env.NEXT_PUBLIC_ACTIVE_MODEL as "pretrained" | "finetuned") ??
  "pretrained";

export const SMOKING_MODEL_PATH = `/models/${ACTIVE_MODEL}.onnx`;
export const LITTER_MODEL_PATH = `/models/litter.onnx`;
export const COCO_MODEL_PATH = "/models/coco.onnx";

/** Smoking class-1 decode threshold (composite filters handle precision). */
export const SMOKING_THRESHOLD = 0.28;
export const SMOKING_MODEL_MIN = 0.32;
export const SMOKING_COMPOSITE_THRESHOLD = 0.38;
export const SMOKING_HIGH_CONFIDENCE = 0.82;
export const SMOKING_MOUTH_BOX_MIN = 0.28;
/** Normalized area bounds for a cigarette/handheld smoking box. */
export const CIGARETTE_BOX_MAX_AREA = 0.065;
export const CIGARETTE_BOX_MIN_AREA = 0.0003;
/** Vape pens / pods are often larger than cigarettes. */
export const VAPE_BOX_MAX_AREA = 0.12;
/** Larger box allowed when visible smoke plume is present. */
export const SMOKE_PLUME_MAX_AREA = 0.2;
export const SMOKE_PLUME_MIN_PIXEL_RATIO = 0.14;
/** Only reject toy/red-light pixels below this model score. */
export const SMOKING_VISUAL_FP_MAX = 0.55;
export const LITTER_THRESHOLD = 0.48;
/** Lower decode threshold for carry/drop tracking (not instant alerts). */
export const LITTER_TRACK_THRESHOLD = 0.30;
export const ALERT_THRESHOLD = 0.55;
export const COCO_THRESHOLD = 0.25;
export const PERSON_THRESHOLD = 0.25;
export const SHOW_PERSON_DETECTIONS = true;

export const INPUT_SIZE = 640;
/** Class 0 = person/background, 1 = cigarette, 2 = vape (3-class smoking model). */
export const CIGARETTE_CLASS_IDX = 1;
export const VAPE_CLASS_IDX = 2;
/** @deprecated use CIGARETTE_CLASS_IDX */
export const SMOKING_CLASS_IDX = CIGARETTE_CLASS_IDX;

export const SMOKING_DECODE_CLASSES = [
  { idx: CIGARETTE_CLASS_IDX, label: "Cigarette" },
  { idx: VAPE_CLASS_IDX, label: "Vape" },
] as const;

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
