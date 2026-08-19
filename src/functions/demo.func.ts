import { BOX_COLORS, GEMINI_MODEL } from "../constants/demo.const";
import {
  AgeGroupType,
  AttireType,
  GenderType,
} from "../interfaces/demo.interface";
import { Detection } from "../utils/yolo";

export function drawImageDetections(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  dets: Detection[],
) {
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  const ctx = canvas.getContext("2d");

  if (!ctx) return;

  ctx.drawImage(img, 0, 0);

  drawBoxes(ctx, img.naturalWidth, dets);
}

export function drawBoxes(
  ctx: CanvasRenderingContext2D,
  refWidth: number,
  dets: Detection[],
) {
  dets.forEach((det) => {
    const color = BOX_COLORS[det.classId % BOX_COLORS.length];

    const [x, y, w, h] = det.box;

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, refWidth / 400);

    ctx.strokeRect(x, y, w, h);

    const label = `${det.className} ${(det.score * 100).toFixed(0)}%`;

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

  const scale = Math.min(1, maxDim / Math.max(safeW, safeH));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(safeW * scale));
  canvas.height = Math.max(1, Math.round(safeH * scale));

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("ไม่สามารถสร้าง canvas สำหรับ crop ภาพได้");
  }

  ctx.drawImage(
    source,
    safeX,
    safeY,
    safeW,
    safeH,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  return canvas.toDataURL("image/jpeg", 0.85);
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

export async function describePersonImage(
  dataUrl: string,
  apiKey: string,
): Promise<string> {
  const { mimeType, data } = parseDataUrl(dataUrl);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inlineData: { mimeType, data } },
            {
              text:
                "วิเคราะห์บุคคลในภาพและระบุข้อมูล 3 ส่วน โดยใช้ Tag ต่อไปนี้ไว้ที่จุดเริ่มต้นของข้อความเสมอ:\n" +
                "1. การแต่งกาย: [STUDENT] สำหรับชุดนักศึกษา/เครื่องแบบ, [GENERAL] สำหรับชุดทั่วไป, [UNCERTAIN_ATTIRE] หากไม่แน่ใจ\n" +
                "2. เพศ/สไตล์: [MALE] สำหรับผู้ชาย, [FEMALE] สำหรับผู้หญิง, [UNISEX] หากก้ำกึ่งหรือไม่แน่ใจ\n" +
                "3. ช่วงวัย: [TEEN] สำหรับวัยรุ่น/วัยเรียน, [ADULT] สำหรับวัยทำงาน/ผู้ใหญ่, [ELDERLY] สำหรับวัยสูงอายุ, [UNCERTAIN_AGE] หากไม่แน่ใจ\n" +
                'รูปแบบการตอบที่ต้องการ: "[ATTIRE_TAG][GENDER_TAG][AGE_TAG] คำอธิบายลักษณะเสื้อผ้าสั้นๆ..."\n' +
                'ตัวอย่าง: "[STUDENT][FEMALE][TEEN] สวมเสื้อเชิ้ตสีขาวและกระโปรงสีดำ..."\n' +
                "ตอบคำอธิบายเป็นภาษาไทย ไม่เกิน 2 ประโยค",
            },
          ],
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

export function getAttireLabel(attire?: AttireType): string | null {
  switch (attire) {
    case "student":
      return "ชุดนักศึกษา";
    case "general":
      return "ชุดทั่วไป";
    case "uncertain":
      return "ไม่แน่ใจ";
    default:
      return null;
  }
}

export function getAttireClass(attire?: AttireType): string {
  switch (attire) {
    case "student":
      return "border-accent/30 bg-accent/10 text-accent";
    case "general":
      return "border-line bg-white/5 text-slate-400";
    case "uncertain":
      return "border-warn/30 bg-warn/10 text-warn";
    default:
      return "border-line bg-white/5 text-slate-500";
  }
}

export function parseAttireType(text: string): AttireType {
  const normalized = text.toUpperCase();
  if (normalized.includes("[STUDENT]")) return "student";
  if (normalized.includes("[GENERAL]")) return "general";
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
