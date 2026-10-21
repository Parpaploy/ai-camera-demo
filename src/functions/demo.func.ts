import { BOX_COLORS, GEMINI_MODEL } from "../constants/demo.const";
import {
  AgeGroupType,
  AttireDetectionMode,
  AttireType,
  GenderType,
} from "../interfaces/demo.interface";
import { Detection } from "../utils/yolo";

export type BoxColorResolver = (
  det: Detection & { trackId?: number },
) => string;

export function drawImageDetections(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  dets: Detection[],
  getColor?: BoxColorResolver,
) {
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  const ctx = canvas.getContext("2d");

  if (!ctx) return;

  ctx.drawImage(img, 0, 0);

  drawBoxes(ctx, img.naturalWidth, dets, getColor);
}

export function drawBoxes(
  ctx: CanvasRenderingContext2D,
  refWidth: number,
  dets: (Detection & { trackId?: number })[],
  getColor?: BoxColorResolver,
) {
  dets.forEach((det) => {
    const color =
      getColor?.(det) ?? BOX_COLORS[det.classId % BOX_COLORS.length];
    const [x, y, w, h] = det.box;

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, refWidth / 400);
    ctx.strokeRect(x, y, w, h);

    const idPrefix = det.trackId !== undefined ? `#${det.trackId} ` : "";
    const label = `${idPrefix}${det.className} ${(det.score * 100).toFixed(0)}%`;

    const fontSize = Math.max(14, refWidth / 60);
    ctx.font = `${fontSize}px Inter, sans-serif`;

    const textWidth = ctx.measureText(label).width;
    const textHeight = fontSize * 1.4;

    ctx.fillStyle = color;
    ctx.fillRect(x, Math.max(0, y - textHeight), textWidth + 10, textHeight);

    ctx.fillStyle = "#12151a";
    ctx.fillText(label, x + 5, Math.max(textHeight - 4, y - 5));
  });
}

export function cropDetectionToDataUrl(
  source: HTMLImageElement | HTMLVideoElement,
  det: Detection,
  maxDim = 512,
  quality = 0.85,
  minAspectRatio = 0,
): string {
  const [x, y, w, h] = det.box;

  const sourceWidth =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : source.naturalWidth;

  const sourceHeight =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : source.naturalHeight;

  const safeX = Math.max(0, Math.min(x, sourceWidth - 1));
  const safeY = Math.max(0, Math.min(y, sourceHeight - 1));

  const safeW = Math.max(1, Math.min(w, sourceWidth - safeX));
  const safeH = Math.max(1, Math.min(h, sourceHeight - safeY));
  const cropW = Math.min(sourceWidth, Math.max(safeW, safeH * minAspectRatio));
  const cropX = Math.max(
    0,
    Math.min(sourceWidth - cropW, safeX + safeW / 2 - cropW / 2),
  );

  const scale = Math.min(1, maxDim / Math.max(cropW, safeH));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cropW * scale));
  canvas.height = Math.max(1, Math.round(safeH * scale));

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("ไม่สามารถสร้าง canvas สำหรับ crop ภาพได้");
  }

  ctx.drawImage(
    source,
    cropX,
    safeY,
    cropW,
    safeH,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  return canvas.toDataURL("image/jpeg", quality);
}

export function parseDataUrl(dataUrl: string): {
  mimeType: string;
  data: string;
} {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);

  if (!match) {
    throw new Error("รูปภาพมีรูปแบบ data URL ที่ไม่ถูกต้อง");
  }

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function buildAttirePrompt(mode: AttireDetectionMode): string {
  const attireInstruction =
    mode === "medical"
      ? "1. การแต่งกาย: [TARGET] หากสวมชุดบุคลากรทางการแพทย์ เช่น เสื้อสครับ (scrubs) ชุดหมอ ชุดพยาบาล หรือชุดพาราเมดิก/เจ้าหน้าที่กู้ชีพ " +
        "(ชุดประเภทนี้อาจเป็นสีอะไรก็ได้ ไม่จำเป็นต้องเป็นสีกรมท่า และมักมีลักษณะ เช่น คอวี กระเป๋าหน้าอก ตราสัญลักษณ์โรงพยาบาล/หน่วยงาน ป้ายชื่อ/ตำแหน่งงาน หรือแถบสะท้อนแสง), " +
        "[OTHER] สำหรับชุดทั่วไปที่ไม่ใช่ชุดบุคลากรทางการแพทย์, [UNCERTAIN_ATTIRE] หากไม่แน่ใจ\n"
      : "1. การแต่งกาย: [TARGET] สำหรับผู้ที่สวมชุดนักศึกษา/เครื่องแบบนักเรียน หรือเสื้อโปโล ให้จัดเป็นนักศึกษาหรือบุคลากร; [OTHER] สำหรับผู้ที่สวมเสื้อผ้าแบบอื่น ให้จัดเป็นบุคคลภายนอก; [UNCERTAIN_ATTIRE] หากมองไม่ชัดหรือไม่แน่ใจ\n";

  const example =
    mode === "medical"
      ? 'ตัวอย่าง: "[TARGET][FEMALE][ADULT] สวมชุดสครับสีเขียวมีป้ายชื่อโรงพยาบาลติดที่อก..."\n'
      : 'ตัวอย่าง: "[TARGET][FEMALE][TEEN] สวมเสื้อเชิ้ตสีขาวและกระโปรงสีดำ..."\n';

  return (
    "วิเคราะห์บุคคลในภาพและระบุข้อมูล 3 ส่วน โดยใช้ Tag ต่อไปนี้ไว้ที่จุดเริ่มต้นของข้อความเสมอ:\n" +
    attireInstruction +
    "2. เพศ/สไตล์: [MALE] สำหรับผู้ชาย, [FEMALE] สำหรับผู้หญิง, [UNISEX] หากก้ำกึ่งหรือไม่แน่ใจ\n" +
    "3. ช่วงวัย: [TEEN] สำหรับวัยรุ่น/วัยเรียน, [ADULT] สำหรับวัยทำงาน/ผู้ใหญ่, [ELDERLY] สำหรับวัยสูงอายุ, [UNCERTAIN_AGE] หากไม่แน่ใจ\n" +
    'รูปแบบการตอบที่ต้องการ: "[ATTIRE_TAG][GENDER_TAG][AGE_TAG] คำอธิบายลักษณะเสื้อผ้าสั้นๆ..."\n' +
    example +
    "ตอบคำอธิบายเป็นภาษาไทย ไม่เกิน 2 ประโยค"
  );
}

export async function describePersonImage(
  dataUrl: string,
  apiKey: string,
  mode: AttireDetectionMode = "student",
): Promise<string> {
  return describePersonImages([{ dataUrl, frameIndex: 1, elapsedMs: 0 }], apiKey, mode);
}

export interface PersonImageFrame {
  dataUrl: string;
  frameIndex: number;
  elapsedMs: number;
}

export interface OllamaModel {
  name: string;
  size: number;
  details: Record<string, unknown>;
}

export async function getOllamaModels(): Promise<OllamaModel[]> {
  const response = await fetch("/api/ai/ollama/models", { cache: "no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Data API ที่ทำงานอยู่ยังไม่มี Ollama API (อาจเป็นโปรเซสเก่า) ให้หยุดแล้วเริ่ม npm run dev ใหม่");
    }
    throw new Error(result?.error?.message || "ติดต่อ Ollama ไม่ได้");
  }
  return Array.isArray(result?.data?.models) ? result.data.models : [];
}

export async function describePersonImagesWithOllama(
  frames: PersonImageFrame[],
  model: string,
  mode: AttireDetectionMode = "student",
): Promise<string> {
  if (frames.length === 0) throw new Error("ไม่มีภาพในคิวสำหรับวิเคราะห์");
  const prompt =
    `${buildAttirePrompt(mode)}\n` +
    `ภาพต่อไปนี้เป็นลำดับเฟรมของบุคคลคนเดียวกัน จำนวน ${frames.length} ภาพ\n` +
    frames
      .map((frame) => `เฟรม ${frame.frameIndex} (หลังเริ่มพบ ${Math.round(frame.elapsedMs)} ms)`)
      .join("\n") +
    "\nใช้ทุกเฟรมประกอบกัน ถ้าบางเฟรมเบลอหรือถูกบังให้ดูเฟรมอื่น และตอบตามรูปแบบ tag ที่กำหนดเท่านั้น";
  const images = frames.map((frame) => parseDataUrl(frame.dataUrl).data);
  const response = await fetch("/api/ai/ollama/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ model, prompt, images }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result?.error?.message || `Ollama HTTP ${response.status}`);
  }
  if (typeof result?.data?.text !== "string" || !result.data.text.trim()) {
    throw new Error("Ollama ไม่ได้ส่งคำอธิบายกลับมา");
  }
  return result.data.text.trim();
}

export async function describePersonImages(
  frames: PersonImageFrame[],
  apiKey: string,
  mode: AttireDetectionMode = "student",
): Promise<string> {
  if (frames.length === 0) throw new Error("ไม่มีภาพในคิวสำหรับวิเคราะห์");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const parts = [
    {
      text:
        `${buildAttirePrompt(mode)}\n` +
        `ภาพต่อไปนี้เป็นลำดับเฟรมของบุคคลคนเดียวกัน จำนวน ${frames.length} ภาพ ` +
        "ให้ใช้ข้อมูลจากทุกเฟรมประกอบกัน หากบางเฟรมเบลอหรือบัง ให้พิจารณาเฟรมอื่นด้วย ไม่ต้องบรรยายความเปลี่ยนแปลงระหว่างเฟรม",
    },
    ...frames.flatMap((frame) => {
      const { mimeType, data } = parseDataUrl(frame.dataUrl);
      return [
        { text: `เฟรม ${frame.frameIndex} (หลังเริ่มพบ ${Math.round(frame.elapsedMs)} ms)` },
        { inlineData: { mimeType, data } },
      ];
    }),
  ];

  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts,
        },
      ],
      generationConfig: { maxOutputTokens: 200 },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    let message = body;

    try {
      const parsed = JSON.parse(body);
      message = parsed?.error?.message || parsed?.error?.status || body;
    } catch {
      // Keep raw body.
    }

    if (response.status === 429) {
      throw new Error(`Gemini API quota/rate limit เต็ม: ${message}`);
    }

    if (response.status === 400) {
      throw new Error(`Gemini API request ไม่ถูกต้อง: ${message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Gemini API key ไม่ถูกต้องหรือไม่มีสิทธิ์ใช้งาน: ${message}`,
      );
    }

    throw new Error(`Gemini API error (${response.status}): ${message}`);
  }

  const result = await response.json();

  const text = result?.candidates
    ?.flatMap((candidate: any) => candidate?.content?.parts ?? [])
    ?.map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    ?.join("")
    ?.trim();

  if (!text) {
    const finishReason = result?.candidates?.[0]?.finishReason;

    if (finishReason) {
      throw new Error(`Gemini ไม่ได้ส่งข้อความกลับมา (${finishReason})`);
    }

    throw new Error("ไม่ได้รับคำอธิบายจาก Gemini API");
  }

  return text;
}

export function getAttireLabel(
  attire?: AttireType,
  mode: AttireDetectionMode = "student",
): string | null {
  switch (attire) {
    case "target":
      return mode === "medical" ? "บุคลากรทางการแพทย์" : "นักศึกษา/บุคลากร";
    case "other":
      return mode === "medical" ? "ชุดทั่วไป" : "บุคคลภายนอก";
    case "uncertain":
      return "ไม่แน่ใจ";
    default:
      return null;
  }
}

export function getAttireClass(attire?: AttireType): string {
  switch (attire) {
    case "target":
      return "border-accent/30 bg-accent/10 text-accent";
    case "other":
      return "border-orange-400/30 bg-orange-400/10 text-orange-300";
    case "uncertain":
      return "border-warn/30 bg-warn/10 text-warn";
    default:
      return "border-line bg-white/5 text-slate-500";
  }
}

export function parseAttireType(text: string): AttireType {
  const normalized = text.toUpperCase();
  if (normalized.includes("[TARGET]")) return "target";
  if (normalized.includes("[OTHER]")) return "other";
  return "uncertain";
}

export function parseGenderType(text: string): GenderType {
  const normalized = text.toUpperCase();
  if (normalized.includes("[MALE]")) return "male";
  if (normalized.includes("[FEMALE]")) return "female";
  if (normalized.includes("[UNISEX]")) return "unisex";
  return "uncertain";
}

export function parseAgeGroupType(text: string): AgeGroupType {
  const normalized = text.toUpperCase();
  if (normalized.includes("[TEEN]")) return "teen";
  if (normalized.includes("[ADULT]")) return "adult";
  if (normalized.includes("[ELDERLY]")) return "elderly";
  return "uncertain";
}

export function cleanGeminiText(text: string): string {
  return text.replace(/\[.*?\]/g, "").trim();
}
