# YOLOv8 + Vite + React + TypeScript + Tailwind

รัน object detection ด้วย YOLOv8 ฝั่ง client (เบราว์เซอร์) ผ่าน `onnxruntime-web`
กล้องทั่วไปใช้ Web Camera API ได้โดยตรง ส่วนกล้อง MIPI ของ RDK X5 ใช้บริการ Python
บนบอร์ดเพื่อส่งภาพเข้าหน้าเว็บ

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

## ใช้กล้อง MIPI บน RDK X5

บริการ `scripts/rdk_mipi_bridge.py` ใช้ `hobot_vio` ของ RDK X5 อ่านกล้อง MIPI
แล้วส่งภาพแบบ MJPEG ให้หน้าเว็บ ส่วน YOLO และการวิเคราะห์ Gemini ยังทำงานในเบราว์เซอร์
เหมือนเดิม

1. คัดลอกโปรเจกต์ไปไว้บน RDK X5 และตรวจสอบว่าบอร์ดติดตั้ง RDK Python SDK,
   `hobot_vio`, NumPy และ OpenCV แล้ว
2. รันบริการกล้อง:

   ```bash
   python3 scripts/rdk_mipi_bridge.py
   ```

3. สำหรับพัฒนา ให้เปิดอีกเทอร์มินัลบนบอร์ดแล้วรัน:

   ```bash
   npm install
   npm run dev -- --host 0.0.0.0
   ```

   เปิด `http://<IP ของ RDK X5>:5173` แล้วเลือก **กล้องสด → RDK X5 · MIPI**
   ในหน้าแอป

สำหรับใช้งานแบบ build ให้รัน `npm run build` ก่อน จากนั้นเริ่มบริการกล้องตามข้อ 2
แล้วเปิด `http://<IP ของ RDK X5>:8765` ได้เลย บริการจะเสิร์ฟไฟล์จาก `dist/public`
และสตรีมภาพจากกล้องใน origin เดียวกัน

ปรับความละเอียดและเฟรมเรตได้ เช่น:

```bash
python3 scripts/rdk_mipi_bridge.py --width 1920 --height 1080 --fps 30
```

ถ้า auto-detect เลือกช่องกล้องไม่ตรง ให้ระบุ `video_index` ตาม `mipi_host`
ใน `/etc/board_config.json` เช่น:

```bash
python3 scripts/rdk_mipi_bridge.py --video-index 2 --width 1920 --height 1080 --fps 30
```

กล้องต้องเป็นรุ่นที่ RDK X5 และ SDK บนบอร์ดรองรับ ดูรายละเอียดที่
[RDK X5 MIPI Camera API](https://developer.d-robotics.cc/rdk_x_doc/en/Basic_Application/multi_media_sp_dev_api/RDK_X5/pydev_multimedia_api_x5/object_camera)
และ [ตัวอย่างแสดงกล้องผ่านเว็บ](https://developer.d-robotics.cc/rdk_doc/en/Basic_Application/pydev_demo_sample/RDK_X5/web_display_camera_sample/)

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
