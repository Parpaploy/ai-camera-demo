import { ModelOption } from "../interfaces/demo.interface";
import { COCO_CLASSES } from "../utils/yolo";

export const BOX_COLORS = [
  "#5eead4",
  "#fb923c",
  "#a78bfa",
  "#f472b6",
  "#facc15",
  "#60a5fa",
];

export const MODEL_INPUT_SIZE = 640;
export const DEFAULT_CONF_THRESHOLD = 0.35;
export const DEFAULT_IOU_THRESHOLD = 0.45;

export const CAMERA_DETECT_INTERVAL_MS = 400;

export const CAMERA_GEMINI_INTERVAL_MS = 5000;

export const PERSON_CLASS_ID = COCO_CLASSES.indexOf("person");

export const SESSION_API_KEY = "yolo-demo-gemini-key";

export const GEMINI_MODEL = "gemini-3.5-flash-lite";

export const MODEL_OPTIONS: ModelOption[] = [
  {
    label: "YOLOv8n",
    url: "/models/yolov8n.onnx",
    description: "เร็วสุด · เบาสุด · แม่นยำน้อยสุด",
  },
  {
    label: "YOLOv8s",
    url: "/models/yolov8s.onnx",
    description: "สมดุลระหว่างความเร็วกับความแม่นยำ",
  },
  {
    label: "YOLOv8m",
    url: "/models/yolov8m.onnx",
    description: "แม่นยำสุด · ช้าสุด เหมาะกับรูปนิ่ง",
  },
];

export const DEFAULT_MODEL_URL = MODEL_OPTIONS[0].url;

export const CONF_THRESHOLD_RANGE = { min: 0.1, max: 0.9, step: 0.05 };
export const IOU_THRESHOLD_RANGE = { min: 0.1, max: 0.9, step: 0.05 };
