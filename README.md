# YOLOv8 + Vite + React + TypeScript + Tailwind

รัน object detection ด้วย YOLOv8 ทั้งหมดฝั่ง client (เบราว์เซอร์) ผ่าน `onnxruntime-web`
ไม่ต้องมี backend server

## 1. ติดตั้ง dependencies

```bash
npm install
```

## 2. Export โมเดล YOLOv8 เป็น ONNX

ต้องมี Python + ultralytics (ทำครั้งเดียว ไม่เกี่ยวกับโปรเจกต์ React นี้):

```bash
pip install ultralytics
yolo export model=yolov8n.pt format=onnx opset=12 simplify=True
```

จะได้ไฟล์ `yolov8n.onnx` — ย้ายมาวางที่:

```
public/models/yolov8n.onnx
```

> ใช้โมเดลอื่นได้ (yolov8s/m/l/x หรือโมเดลที่เทรนเอง) — ถ้าเป็น custom classes
> ให้แก้ `COCO_CLASSES` ใน `src/utils/yolo.ts` ให้ตรงกับ class ของคุณ

## 3. รัน dev server

```bash
npm run dev
```

เปิด `http://localhost:5173` เลือกรูปภาพ แล้วกด "ตรวจจับวัตถุ"

## โครงสร้างไฟล์สำคัญ

- `src/utils/yolo.ts` — preprocessing (letterbox resize), เรียก ONNX Runtime,
  postprocessing (decode output, NMS) — ส่วนที่ซับซ้อนที่สุดของระบบ
- `src/App.tsx` — UI: อัปโหลดรูป, วาด bounding box บน `<canvas>`, แสดงผลลัพธ์
- `public/models/` — วางไฟล์ `.onnx` ไว้ที่นี่

## หมายเหตุเรื่องประสิทธิภาพ

- รันด้วย WASM backend (`ort.env.wasm`) ซึ่งใช้ CPU — เร็วพอสำหรับรูปนิ่ง
  แต่ถ้าต้องการ real-time video ควรพิจารณา WebGPU execution provider
  (ต้องใช้ `onnxruntime-web` เวอร์ชันที่รองรับ + เบราว์เซอร์ที่รองรับ WebGPU)
- `yolov8n.onnx` (nano) ให้ความเร็วดีที่สุดในเบราว์เซอร์ ส่วน `yolov8x.onnx`
  จะแม่นกว่าแต่ช้ากว่ามาก ไม่ค่อยเหมาะกับ client-side

## ถ้าอยากใช้ backend แทน (แม่นกว่า/เร็วกว่า)

ทางเลือกอื่นคือรัน YOLOv8 บน Python backend (เช่น FastAPI ที่ใช้ `ultralytics`
ตรงๆ) แล้วให้ React ส่งรูปไปทาง REST API แทนที่จะรันในเบราว์เซอร์ — ถ้าต้องการ
แนวทางนี้แจ้งได้ จะจัดให้อีกชุด
