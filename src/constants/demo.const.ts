import { COCO_CLASSES } from "../utils/yolo";

export const BOX_COLORS = [
  "#5eead4",
  "#fb923c",
  "#a78bfa",
  "#f472b6",
  "#facc15",
  "#60a5fa",
];

export const CAMERA_DETECT_INTERVAL_MS = 400;

export const CAMERA_GEMINI_INTERVAL_MS = 5000;

export const PERSON_CLASS_ID = COCO_CLASSES.indexOf("person");

export const SESSION_API_KEY = "yolo-demo-gemini-key";

export const GEMINI_MODEL = "gemini-3.5-flash-lite";
