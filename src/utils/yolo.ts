import * as ort from "onnxruntime-web";
import {
  DEFAULT_CONF_THRESHOLD,
  DEFAULT_IOU_THRESHOLD,
  MODEL_INPUT_SIZE,
} from "../constants/demo.const";

export const COCO_CLASSES = [
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "airplane",
  "bus",
  "train",
  "truck",
  "boat",
  "traffic light",
  "fire hydrant",
  "stop sign",
  "parking meter",
  "bench",
  "bird",
  "cat",
  "dog",
  "horse",
  "sheep",
  "cow",
  "elephant",
  "bear",
  "zebra",
  "giraffe",
  "backpack",
  "umbrella",
  "handbag",
  "tie",
  "suitcase",
  "frisbee",
  "skis",
  "snowboard",
  "sports ball",
  "kite",
  "baseball bat",
  "baseball glove",
  "skateboard",
  "surfboard",
  "tennis racket",
  "bottle",
  "wine glass",
  "cup",
  "fork",
  "knife",
  "spoon",
  "bowl",
  "banana",
  "apple",
  "sandwich",
  "orange",
  "broccoli",
  "carrot",
  "hot dog",
  "pizza",
  "donut",
  "cake",
  "chair",
  "couch",
  "potted plant",
  "bed",
  "dining table",
  "toilet",
  "tv",
  "laptop",
  "mouse",
  "remote",
  "keyboard",
  "cell phone",
  "microwave",
  "oven",
  "toaster",
  "sink",
  "refrigerator",
  "book",
  "clock",
  "vase",
  "scissors",
  "teddy bear",
  "hair drier",
  "toothbrush",
];

export interface Detection {
  classId: number;
  className: string;
  score: number;
  box: [number, number, number, number];
}

interface LetterboxResult {
  data: Float32Array;
  scale: number;
  padX: number;
  padY: number;
}

export interface DetectOptions {
  modelUrl?: string;
  confThreshold?: number;
  iouThreshold?: number;
}

const sessionCache = new Map<string, Promise<ort.InferenceSession>>();

export function loadYoloModel(modelUrl = "/models/yolov8n.onnx") {
  let cached = sessionCache.get(modelUrl);

  if (!cached) {
    ort.env.wasm.numThreads = navigator.hardwareConcurrency
      ? Math.min(4, navigator.hardwareConcurrency)
      : 1;

    cached = ort.InferenceSession.create(modelUrl, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });

    sessionCache.set(modelUrl, cached);
  }

  return cached;
}

export function isModelLoaded(modelUrl: string): boolean {
  return sessionCache.has(modelUrl);
}

function letterbox(
  source: HTMLImageElement | HTMLVideoElement,
  targetSize: number,
): LetterboxResult {
  const srcWidth =
    "videoWidth" in source ? source.videoWidth : source.naturalWidth;
  const srcHeight =
    "videoHeight" in source ? source.videoHeight : source.naturalHeight;

  const scale = Math.min(targetSize / srcWidth, targetSize / srcHeight);
  const scaledW = Math.round(srcWidth * scale);
  const scaledH = Math.round(srcHeight * scale);
  const padX = Math.floor((targetSize - scaledW) / 2);
  const padY = Math.floor((targetSize - scaledH) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, targetSize, targetSize);
  ctx.drawImage(
    source,
    0,
    0,
    srcWidth,
    srcHeight,
    padX,
    padY,
    scaledW,
    scaledH,
  );

  const { data } = ctx.getImageData(0, 0, targetSize, targetSize);
  const chwData = new Float32Array(3 * targetSize * targetSize);
  const plane = targetSize * targetSize;

  for (let i = 0; i < plane; i++) {
    chwData[i] = data[i * 4] / 255;
    chwData[i + plane] = data[i * 4 + 1] / 255;
    chwData[i + plane * 2] = data[i * 4 + 2] / 255;
  }

  return { data: chwData, scale, padX, padY };
}

function iou(
  a: [number, number, number, number],
  b: [number, number, number, number],
) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  const union = aw * ah + bw * bh - inter;
  return union <= 0 ? 0 : inter / union;
}

function nonMaxSuppression(
  detections: Detection[],
  iouThreshold: number,
): Detection[] {
  const byClass = new Map<number, Detection[]>();

  for (const det of detections) {
    const list = byClass.get(det.classId) ?? [];
    list.push(det);
    byClass.set(det.classId, list);
  }

  const kept: Detection[] = [];

  for (const list of byClass.values()) {
    list.sort((a, b) => b.score - a.score);
    const active = [...list];

    while (active.length) {
      const best = active.shift()!;
      kept.push(best);

      for (let i = active.length - 1; i >= 0; i--) {
        if (iou(best.box, active[i].box) > iouThreshold) active.splice(i, 1);
      }
    }
  }

  return kept;
}

function decodeOutput(
  output: ort.Tensor,
  letterboxInfo: LetterboxResult,
  origWidth: number,
  origHeight: number,
  confThreshold: number,
  iouThreshold: number,
): Detection[] {
  const [, numChannels, numAnchors] = output.dims;
  const numClasses = numChannels - 4;
  const data = output.data as Float32Array;
  const { scale, padX, padY } = letterboxInfo;

  const candidates: Detection[] = [];

  for (let i = 0; i < numAnchors; i++) {
    let bestScore = 0;
    let bestClass = -1;

    for (let c = 0; c < numClasses; c++) {
      const score = data[(4 + c) * numAnchors + i];

      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }

    if (bestScore < confThreshold) continue;

    const cx = data[0 * numAnchors + i];
    const cy = data[1 * numAnchors + i];
    const w = data[2 * numAnchors + i];
    const h = data[3 * numAnchors + i];

    const x = (cx - w / 2 - padX) / scale;
    const y = (cy - h / 2 - padY) / scale;
    const boxW = w / scale;
    const boxH = h / scale;

    candidates.push({
      classId: bestClass,
      className: COCO_CLASSES[bestClass] ?? `class_${bestClass}`,
      score: bestScore,
      box: [
        Math.max(0, x),
        Math.max(0, y),
        Math.min(boxW, origWidth - Math.max(0, x)),
        Math.min(boxH, origHeight - Math.max(0, y)),
      ],
    });
  }

  return nonMaxSuppression(candidates, iouThreshold);
}

export async function detectObjects(
  source: HTMLImageElement | HTMLVideoElement,
  options: DetectOptions = {},
): Promise<Detection[]> {
  const {
    modelUrl = "/models/yolov8n.onnx",
    confThreshold = DEFAULT_CONF_THRESHOLD,
    iouThreshold = DEFAULT_IOU_THRESHOLD,
  } = options;

  const session = await loadYoloModel(modelUrl);
  const letterboxResult = letterbox(source, MODEL_INPUT_SIZE);

  const inputTensor = new ort.Tensor("float32", letterboxResult.data, [
    1,
    3,
    MODEL_INPUT_SIZE,
    MODEL_INPUT_SIZE,
  ]);

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const results = await session.run({ [inputName]: inputTensor });

  const srcWidth =
    "videoWidth" in source ? source.videoWidth : source.naturalWidth;
  const srcHeight =
    "videoHeight" in source ? source.videoHeight : source.naturalHeight;

  return decodeOutput(
    results[outputName],
    letterboxResult,
    srcWidth,
    srcHeight,
    confThreshold,
    iouThreshold,
  );
}
