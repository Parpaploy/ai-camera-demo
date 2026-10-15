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

## ความเสถียรของกล้องและสิ่งที่นำมาจาก CAMT_edgeAI

ตรวจเทียบกับ `CAMT_edgeAI/object_detection_tiled.py`, `mipi_camera_app.py`
และ `mipi_cam.py`: ใช้กล้องผ่าน `hobot_vio/libsrcampy` และแปลง NV12 เหมือนกัน
แนวทางอ่านกล้องแยกจาก inference และเก็บเฉพาะเฟรมล่าสุดใช้ร่วมกันได้ ส่วนโมเดล
YOLOv13 `.bin` ของ CAMT เป็นเส้นทาง BPU บนบอร์ด ไม่สามารถแทนไฟล์ ONNX
ของเว็บได้โดยตรง หากย้าย inference ไป BPU ต้องเพิ่ม API ส่งผล detection และปรับ
pre/postprocessing ให้ตรงโมเดลก่อน

CAMT ใช้ thread และ `close_cam()` ใน cleanup แต่ `join(timeout=2)`
ไม่ได้ยุติ thread ที่ติดใน native SDK จึงยังไม่ใช่หลักประกันว่าจะเปิดรอบสองได้
ai-camera ปรับการจัดการดังนี้:

- เว็บเรียงคำสั่ง MIPI stop/start และใช้หมายเลขรอบเพื่อทิ้งผล inference เก่า
  ป้องกันลูปเก่ากลับมาสร้าง timer ซ้ำหลังเปิดกล้องใหม่
- YOLO ทำงานต่อได้ระหว่างรอ Gemini; Gemini มี timeout 30 วินาทีและทิ้งผลจากรอบเก่า
- คืน tensor ทุกครั้งแม้ inference ล้มเหลว, ใช้ canvas preprocessing ซ้ำ,
  ล้าง thumbnail ของ track ที่หมดอายุ และรวมยอด track เก่าเป็นตัวนับ
- Bridge ให้ process ลูกเป็นเจ้าของ SDK เพียงตัวเดียว เก็บ JPEG ล่าสุดใน buffer
  ที่มีขนาดจำกัด ไม่มีคิวเฟรมสะสม; ปิดแบบปกติก่อน แล้ว terminate/kill เมื่อไม่ตอบสนอง
- Watchdog ตรวจเฟรมใหม่ (ค่าเริ่มต้น 10 วินาที) และลองเปิด process กล้องใหม่สูงสุด
  3 ครั้งต่อการกดเริ่มหนึ่งครั้ง จากนั้นรายงาน error ไม่วน restart ไม่สิ้นสุด
- การเชื่อมต่อ MJPEG เก่าจบตามรอบของตัวเอง และมี timeout สำหรับ client ที่อ่านช้า
  หน้าเว็บตรวจสถานะ bridge ทุก 2 วินาที

ปรับเวลาตรวจเฟรมค้างได้:

```bash
python3 scripts/rdk_mipi_bridge.py --width 1280 --height 720 --fps 20 --frame-timeout 10
```

ดูสถานะที่ `/api/mipi/status`: `state`, `error`, `frameId`, `frameAgeSeconds`,
`restartCount` ใช้แยกปัญหาเฟรมกล้องออกจากความช้าของ YOLO/Gemini
ค่า `restartCount` เป็นจำนวนครั้งที่ลองเปิดใหม่สะสมในรอบนั้น

### การตรวจสอบ

ทดสอบอัตโนมัติบนเครื่องพัฒนาโดยไม่ต้องติดตั้ง SDK กล้อง:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/runtime.test.cjs
npm run build
```

ชุด Python ใช้ process จำลองเพื่อทดสอบเปิด–ปิด 20 รอบ, หยุด native read ที่ค้าง,
watchdog จำกัดจำนวน retry, worker ตายขณะถือ lock และ start ซ้ำ
ชุด JavaScript จำลอง inference/Gemini เพื่อทดสอบการทิ้งผลจากรอบเก่า,
ไม่รอ Gemini ในลูปภาพ, คืน tensor เมื่อสำเร็จ/ล้มเหลว และ tracker 10,000 เฟรม
เป็น regression tests ของ logic ไม่ใช่การทดสอบกล้องหรือ ONNX จริง

ก่อนนำไปใช้งานต่อเนื่อง ให้ทดสอบบน RDK X5:

1. ปิดโปรแกรม CAMT/โปรแกรมอื่นที่ใช้กล้องเดียวกัน แล้วรัน bridge และเว็บรุ่นใหม่
2. เปิด–ปิดกล้อง 50 รอบ รวมการปิดระหว่างกำลังเริ่มและขณะ Gemini ยังวิเคราะห์
   ตรวจว่ารอบใหม่มี `frameId` เพิ่มและไม่มี process กล้องเก่าค้าง
3. รัน 8–24 ชั่วโมง ตรวจ RAM ของเบราว์เซอร์/bridge/worker, CPU, อุณหภูมิ,
   `frameAgeSeconds` และจำนวน restart ว่าหน่วยความจำไม่โตต่อเนื่อง
4. จำลองเครือข่าย/Gemini ช้า ตรวจว่า YOLO ยังทำงาน และการปิดกล้องยังตอบสนอง
5. หากใช้ IMX219 ความละเอียด sensor เต็มแบบ CAMT ให้ตรวจค่า resolution กับ SDK
   บนบอร์ดก่อนเปลี่ยน `open_cam`; ตัวอย่าง CAMT ใช้ raw sensor 3264×2464
   ขณะที่ bridge นี้คงการตั้งค่า output เดิมและใช้ raw sensor ค่าเริ่มต้นของ SDK

การแยก process ช่วยให้ HTTP server ไม่ติดไปกับ native call แต่ไม่รับประกันว่า
จะกู้ driver/kernel ที่ค้างได้ หาก kill process แล้วยังเปิดไม่ได้ ต้องตรวจ log บนบอร์ด
และอาจต้อง restart บริการหรือบอร์ด การแก้ชุดนี้ยังไม่ได้ทดสอบกับฮาร์ดแวร์ RDK จริง

อ้างอิง signature ของ SDK:
[RDK X5 Camera API](https://developer.d-robotics.cc/rdk_x_doc/en/Basic_Application/multi_media_sp_dev_api/RDK_X5/pydev_multimedia_api_x5/object_camera)

## SQL / TiDB และ Dashboard รายบุคคล

เพิ่ม Data API สำหรับเก็บผลรายบุคคลใน MySQL/TiDB และ Dashboard ที่อ่านจาก SQL:
ยอดวันนี้, กราฟรายวัน/รายชั่วโมง, รายละเอียดวัน, ตัวกรองกล้อง/ประเภท และตารางแบ่งหน้า
พร้อมคิวส่งซ้ำเมื่อเครือข่ายขาด โดยแยกจาก MurataWeb ทั้งระบบ

ดูขั้นตอนตั้งค่าบน Linux และ TiDB ที่ **[docs/sql-dashboard.md](docs/sql-dashboard.md)**
ต้องตั้ง `.env.server`, รัน `npm run data:migrate` แล้วเปิด `npm run data:dev`
เพิ่มควบคู่กับบริการกล้องและเว็บเดิม ไม่มีรหัสผ่านฐานข้อมูลฝังใน frontend
