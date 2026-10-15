# SQL และ Dashboard ของ ai-camera

โครงการนี้แยกจาก MurataWeb โดยสิ้นเชิง ไม่ใช้บัญชี ตาราง หรือข้อมูลของ Murata
ตัวอย่าง Murata ใช้ Next.js อ่าน MySQL/TiDB ผ่าน `mysql2` มี connection pool,
API แบบ GET, timezone ไทย, ตัวกรองและ pagination ฝั่ง SQL และรีเฟรชทุก 30 วินาที
ใน source ที่ตรวจไม่พบ endpoint รับ CV events — ตัวเขียนข้อมูลเป็นระบบภายนอก

ai-camera จึงเพิ่มส่วนรับข้อมูลของตัวเอง:

```text
YOLO/Gemini ในเบราว์เซอร์
  → ผลราย track + เวลา + รหัสกล้อง
  → IndexedDB outbox (ส่งเป็นชุด สูงสุด 100 รายการ ทุก 5 วินาที)
  → POST /api/data/events ผ่าน Vite หรือ Python bridge
  → Node Data API บน 127.0.0.1:8787
  → MySQL/TiDB ผ่าน TLS
  → GET /api/data/dashboard และ /api/data/events
  → Dashboard ของ ai-camera
```

## ข้อมูลที่เก็บและวิธีนับ

ตาราง `ai_camera_person_events` เก็บ event ID, session ID, camera ID, track ID,
track epoch, source, โหมดชุดนักศึกษา/แพทย์, เวลาพบครั้งแรก/ล่าสุด,
ความมั่นใจ YOLO, ผลจำแนกชุด, เพศและช่วงอายุที่ AI ประเมิน, revision และเวลารับข้อมูล
ไม่เก็บภาพ, thumbnail, Gemini prompt/คำบรรยาย หรือ API key ในตารางเหตุการณ์

- หนึ่งแถวต่อ track ภายในหนึ่งรอบตรวจจับ ไม่ใช่หนึ่งแถวต่อเฟรม
- รหัส `session:epoch:track` กันซ้ำ แม้ track เริ่มนับใหม่หลังปิด–เปิดกล้อง/รีเซ็ต
- เก็บทันทีเมื่อพบคนใหม่ อัปเดตทุก 5 วินาที เมื่อจำแนกสำเร็จ และเมื่อ track จบ
- SQL upsert รับเฉพาะ revision ใหม่ ผลตอบกลับช้า/การส่งซ้ำไม่ทับผลใหม่
- บุคคลเดิมอาจได้หลาย track หรือหลาย session: จำนวนใน Dashboard คือจำนวน
  **เหตุการณ์บุคคล ไม่ใช่จำนวนบุคคลไม่ซ้ำ** ไม่มีการระบุตัวตนข้ามกล้อง
- ใช้ epoch milliseconds สำหรับเวลา แสดงวันและชั่วโมงตาม Asia/Bangkok เสมอ
- การกรองช่วงเวลาและการนับรายวันอ้างอิงเวลาพบครั้งแรกของเหตุการณ์
- ประวัติ localStorage รุ่นเก่ามีแค่ยอดสรุป ไม่มีข้อมูลรายบุคคล จึงไม่แปลงเป็น
  เหตุการณ์ SQL ปลอม ดูข้อมูลเดิมได้ที่แท็บ “ประวัติในเครื่อง”

## ตั้งค่า TiDB Cloud

ต้องมี Node.js 20.12 ขึ้นไปและ TiDB Cloud Starter หรือ MySQL 8 ที่พร้อมใช้งาน
TiDB เป็นบริการฐานข้อมูล ส่วน Data API ยังต้องรันบน RDK/เซิร์ฟเวอร์ของคุณ

1. สร้าง TiDB Cloud Starter instance ในบัญชีของคุณ โดยเลือกแพ็กเกจฟรีและตรวจ
   spending limit ของ instance ใน Console
2. ใน SQL Editor สร้างฐานข้อมูลใหม่สำหรับ ai-camera เท่านั้น:

   ```sql
   CREATE DATABASE IF NOT EXISTS ai_camera;
   ```

3. จากหน้า Connect ของ TiDB คัดลอก Host, Port, User และ Password มาใส่ไฟล์
   `.env.server` ในเครื่องที่จะรัน Data API:

   ```bash
   npm install
   cp .env.server.example .env.server
   nano .env.server
   ```

   ```dotenv
   DB_HOST=<host จาก TiDB Connect>
   DB_PORT=4000
   DB_USER=<user จาก TiDB Connect>
   DB_PASSWORD=<password ของฐานข้อมูล>
   DB_NAME=ai_camera
   DB_SSL=true
   DATA_API_HOST=127.0.0.1
   DATA_API_PORT=8787
   DATA_API_KEY=<key สุ่มอย่างน้อย 24 ตัว>
   DASHBOARD_ADMIN_PASSWORD=<รหัสผ่านแอดมินอย่างน้อย 16 ตัว>
   ```

   สร้าง secrets แบบสุ่มได้ด้วย:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   ไม่ใช้ prefix `VITE_` กับค่าลับ ไม่ใส่ password ฐานข้อมูลในหน้าเว็บ
   ไฟล์ `.env.server` ถูก gitignore ไว้แล้ว
4. สร้างตาราง (รันซ้ำได้):

   ```bash
   npm run data:migrate
   ```

5. เปิดเว็บและ Data API พร้อมกันด้วยคำสั่งเดียว:

   ```bash
   npm run dev -- --host 0.0.0.0
   ```

6. เปิดกล้องบนบอร์ดในอีกเทอร์มินัล โดยใช้ค่าที่ทดสอบแล้ว:

   ```bash
   python3 scripts/rdk_mipi_bridge.py \
     --width 1280 --height 720 --fps 30 --jpeg-quality 55
   ```

7. เปิด `http://<IP-บอร์ด>:5173` หรือใช้ `npm run build` แล้วเปิด
   `http://<IP-บอร์ด>:8765` ผ่าน Python bridge ได้เช่นเดิม
   ทั้งสองแบบ proxy `/api/data/*` ไป Data API ที่ localhost:8787
8. เปิด Dashboard แล้วเข้าสู่ระบบด้วยรหัส `DASHBOARD_ADMIN_PASSWORD`
   จาก `.env.server` (บัญชีชื่อ admin) จากนั้นตั้งรหัสกล้องได้จาก
   “ตั้งค่าการเชื่อมต่อ” เช่น `rdk-lobby-01`
   เมื่อเริ่มตรวจจับ ข้อมูลจะส่งเข้า SQL และอ่านกลับมาแสดงได้

หน้าเว็บใช้ session cookie แบบ HttpOnly อายุ 8 ชั่วโมง มีการจำกัดการลองรหัสผิด
และตรวจ session ให้อัตโนมัติ API key อยู่ฝั่งเซิร์ฟเวอร์สำหรับ API client เท่านั้น
ส่วนเบราว์เซอร์ใช้ admin login และไม่อ่านหรือเก็บ API key
คิว IndexedDB ยังอยู่รอส่ง รหัสกล้องใหม่มีผลกับรอบถัดไปเท่านั้น
หากเปิดผ่านเครือข่ายสาธารณะ ให้ใช้ HTTPS reverse proxy หน้าเว็บ/API
TLS ของ TiDB ป้องกันช่วง API → DB แต่ไม่แทน HTTPS ช่วงเบราว์เซอร์ → API
ข้อมูล Dashboard ถูกป้องกันด้วย admin login ก่อนอ่านหรือส่งจากเบราว์เซอร์

## มุมมอง Dashboard

- ภาพรวมวันนี้: เวลาไทย, ยอดรวมตามผลจำแนก, เหตุการณ์ล่าสุด, กราฟแท่งรายชั่วโมง
- สถิติย้อนหลัง: ช่วง 1–366 วัน, ปุ่มวันนี้/7 วัน/30 วัน, กราฟแนวโน้ม,
  รายละเอียดแต่ละวันและเลื่อนไปวันก่อนหน้า/ถัดไป
- ตัวกรอง: วันที่, camera ID, โหมดจำแนก, แหล่งภาพ, ประเภทชุด, เพศ,
  ช่วงอายุ และความมั่นใจ YOLO ขั้นต่ำ
- กราฟแยกกล้องใช้สเกลเดียวกัน พร้อมสรุปเพศ/ช่วงอายุที่ AI ประเมิน
- ตารางรายบุคคลเรียงคอลัมน์และแบ่งหน้าฝั่ง SQL (25/50/100 แถว)
- รีเฟรช 30 วินาทีขณะแท็บเปิดอยู่ และมีปุ่มรีเฟรชทันที
- ไม่สร้างยอดเข้า/ออกเลียนแบบ Murata เพราะ ai-camera ยังไม่มี line-crossing detector

## การส่งซ้ำและข้อจำกัด

การส่ง SQL ไม่ถูก await ในลูปกล้อง จึงไม่ขวาง YOLO/Gemini ถ้า DB หรือเครือข่ายล่ม
เก็บ outbox ใน IndexedDB สูงสุด 10,000 เหตุการณ์ต่อ browser origin และ coalesce
การอัปเดตเหตุการณ์เดิม มี staging ในหน่วยความจำสูงสุด 1,000 เหตุการณ์
เมื่อเต็มหรือพื้นที่ browser ใช้ไม่ได้จะแสดง error; ข้อมูลที่ยังไม่เขียนลง IndexedDB
อาจสูญหายเมื่อปิดแท็บทันที คิวเป็น browser-local ไม่ใช่ durable queue บนบอร์ด
อย่าเคลียร์ site data ขณะยังมีรายการรอส่ง การย้ายจากพอร์ต 5173 ไป 8765 เป็นคนละ
origin จึงมีคิว/รหัสกล้องแยกกัน

ออกจากระบบส่งข้อมูลหยุดการส่ง แต่ไม่ลบ outbox การล้างประวัติในเครื่องก็ไม่ลบ SQL
ไม่มี endpoint ล้างฐานข้อมูลจากหน้าเว็บในรุ่นนี้

กล้องและ inference ยังทำงานเมื่อ Data API ไม่พร้อม แต่ไม่มีผู้ใช้เปิดหน้า detection
เบราว์เซอร์อยู่ก็จะไม่มี YOLO/Gemini events ใหม่ — bridge ส่งภาพเพียงอย่างเดียว

## API

ทุก endpoint ต้องมี `Authorization: Bearer <DATA_API_KEY>`; ไม่มี key ใน URL
ไม่เปิด CORS ใช้ same-origin proxy และให้ Data API bind localhost ตามตัวอย่าง

| Method | Path | หน้าที่ |
|---|---|---|
| GET | `/api/data/health` | ตรวจ key และ SQL connection |
| POST | `/api/data/events` | รับ JSON `{ "events": [...] }` สูงสุด 100 events / 256 KiB |
| GET | `/api/data/dashboard` | summary, time buckets, cameras, demographics, latest |
| GET | `/api/data/events` | รายการพร้อม `total`, `page`, `size` |

GET รับ `from`, `to` เป็น `YYYY-MM-DD` (เวลาไทย), `camera`, `attireMode`,
`source`, `gender`, `ageGroup`, `attire` (ซ้ำได้), `minConfidence`
รายการรับเพิ่ม `page` เริ่ม 0, `size` 25/50/100, `sort`, `direction` asc/desc
ผลลัพธ์เป็น `{ "data": ... }` หรือ `{ "error": { "message": ... } }`
ไม่ส่ง SQL error/connection string กลับไปยังเบราว์เซอร์

## ทดสอบ

```bash
node --test tests/data-*.test.* tests/runtime.test.cjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
npm run build
```

SQL integration และ browser tests แยกจาก unit tests โดย default จะ skip
ต้องเปิด MySQL container **สำหรับทดสอบเท่านั้น**:

```bash
docker run --rm -d --name ai-camera-sql-test \
  -p 127.0.0.1:3308:3306 \
  -e MYSQL_ROOT_PASSWORD=local-test-only \
  -e MYSQL_DATABASE=ai_camera_test mysql:8.4
# รอ MySQL พร้อมก่อนทดสอบ
RUN_SQL_TESTS=1 node --test tests/data-mysql.test.mjs
# ต้องมี Google Chrome และ Vite บน localhost:5173
RUN_BROWSER_TESTS=1 node --test tests/data-browser.test.mjs
# จบแล้วหยุดเฉพาะ container ที่สร้างเพื่อการทดสอบนี้
docker stop ai-camera-sql-test
```

Browser tests seed เฉพาะฐานข้อมูล `ai_camera_test` ด้วยข้อมูลจำลอง แล้วทดสอบ
เชื่อมต่อ, ตัวกรอง, pagination, การส่งคิวเมื่อเครือข่ายกลับมา, screenshot desktop/mobile
ชุดทดสอบไม่เชื่อม TiDB จริง และไม่ใช่การทดสอบ hardware กล้อง

อ้างอิง TiDB: [แพ็กเกจและ quota](https://docs.pingcap.com/tidbcloud/select-cluster-tier/),
[การเชื่อมต่อและข้อกำหนด TLS](https://docs.pingcap.com/tidbcloud/connect-to-tidb-cluster-serverless/)
