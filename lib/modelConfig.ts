export const ACTIVE_MODEL =
  (process.env.NEXT_PUBLIC_ACTIVE_MODEL as "pretrained" | "finetuned") ??
  "pretrained";

export const SMOKING_MODEL_PATH = `/models/${ACTIVE_MODEL}.onnx`;
export const LITTER_MODEL_PATH = `/models/litter.onnx`;
export const COCO_MODEL_PATH = "/models/coco.onnx";

export const SMOKING_THRESHOLD = 0.5;
// Litter model (single 'plastic-bottles' class) is weak and often sits below
// 0.5 even on clear bottles, so it gets a more forgiving bar than smoking.
export const LITTER_THRESHOLD = 0.4;
export const ALERT_THRESHOLD = 0.7;
export const COCO_THRESHOLD = 0.35;

export const INPUT_SIZE = 640;

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
