#!/usr/bin/env python3
"""Run YOLO detection + tracking + attire classification on the RDK X5 board.

Pulls frames from scripts/rdk_mipi_bridge.py (a separate process — this script
never touches the camera SDK), runs the same detect/track/crop/classify
pipeline the browser used to run client-side, and posts finished person
events straight to the Node Data API so the web dashboard stays a pure
read-only client.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import queue
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import onnxruntime as ort

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL_PATH = PROJECT_ROOT / "dist" / "public" / "models" / "yolov8n.onnx"
CAMERA_ID_FILE = Path(__file__).resolve().parent / "rdk_camera_id.txt"

MODEL_INPUT_SIZE = 640
DEFAULT_CONF_THRESHOLD = 0.35
DEFAULT_IOU_THRESHOLD = 0.45
CAMERA_DETECT_INTERVAL_MS = 400
PERSON_QUEUE_FRAME_COUNT = 3
PERSON_QUEUE_SAMPLE_INTERVAL_MS = 1200
PERSON_QUEUE_MAX_ATTEMPTS = 3
EVENT_FLUSH_INTERVAL_S = 5
EVENT_PUBLISH_THROTTLE_MS = 30_000
OUTBOX_LIMIT = 2000
GEMINI_MODEL = "gemini-3.5-flash-lite"

# Mirrors src/utils/yolo.ts COCO_CLASSES exactly — order matters (classId == index).
COCO_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
    "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
    "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
    "toothbrush",
]
PERSON_CLASS_ID = COCO_CLASSES.index("person")


def log(message: str) -> None:
    print(f"[detector {time.strftime('%H:%M:%S')}] {message}", flush=True)


# ---------------------------------------------------------------------------
# YOLO inference — ports src/utils/yolo.ts (letterbox, decode, NMS) to numpy.
# ---------------------------------------------------------------------------

def letterbox(frame_bgr: np.ndarray, target_size: int):
    src_h, src_w = frame_bgr.shape[:2]
    scale = min(target_size / src_w, target_size / src_h)
    scaled_w, scaled_h = round(src_w * scale), round(src_h * scale)
    pad_x = (target_size - scaled_w) // 2
    pad_y = (target_size - scaled_h) // 2

    canvas = np.full((target_size, target_size, 3), 114, dtype=np.uint8)
    resized = cv2.resize(frame_bgr, (scaled_w, scaled_h), interpolation=cv2.INTER_LINEAR)
    canvas[pad_y:pad_y + scaled_h, pad_x:pad_x + scaled_w] = resized

    rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    chw = np.transpose(rgb, (2, 0, 1))[np.newaxis, ...]
    return np.ascontiguousarray(chw), scale, pad_x, pad_y


def nms(detections: list[dict], iou_threshold: float) -> list[dict]:
    by_class: dict[int, list[dict]] = {}
    for det in detections:
        by_class.setdefault(det["classId"], []).append(det)

    kept: list[dict] = []
    for items in by_class.values():
        items.sort(key=lambda d: -d["score"])
        active = list(items)
        while active:
            best = active.pop(0)
            kept.append(best)
            active = [d for d in active if box_iou(best["box"], d["box"]) <= iou_threshold]
    return kept


def box_iou(a, b) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = aw * ah + bw * bh - inter
    return 0.0 if union <= 0 else inter / union


def decode_output(output: np.ndarray, scale, pad_x, pad_y, orig_w, orig_h,
                   conf_threshold: float, iou_threshold: float) -> list[dict]:
    output = output[0]  # (channels, anchors)
    num_classes = output.shape[0] - 4
    boxes, scores = output[:4], output[4:4 + num_classes]

    best_class = np.argmax(scores, axis=0)
    best_score = np.max(scores, axis=0)
    mask = best_score >= conf_threshold
    if not mask.any():
        return []

    cx, cy, w, h = boxes[0][mask], boxes[1][mask], boxes[2][mask], boxes[3][mask]
    cls, sc = best_class[mask], best_score[mask]

    x = np.maximum(0.0, (cx - w / 2 - pad_x) / scale)
    y = np.maximum(0.0, (cy - h / 2 - pad_y) / scale)
    bw = np.minimum(w / scale, orig_w - x)
    bh = np.minimum(h / scale, orig_h - y)

    candidates = [
        {"classId": int(cls[i]), "className": COCO_CLASSES[int(cls[i])] if cls[i] < len(COCO_CLASSES) else f"class_{cls[i]}",
         "score": float(sc[i]), "box": (float(x[i]), float(y[i]), float(bw[i]), float(bh[i]))}
        for i in range(len(sc))
    ]
    return nms(candidates, iou_threshold)


class YoloModel:
    def __init__(self, model_path: Path):
        self.session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name

    def detect(self, frame_bgr: np.ndarray, conf_threshold: float, iou_threshold: float) -> list[dict]:
        tensor, scale, pad_x, pad_y = letterbox(frame_bgr, MODEL_INPUT_SIZE)
        outputs = self.session.run([self.output_name], {self.input_name: tensor})
        src_h, src_w = frame_bgr.shape[:2]
        return decode_output(outputs[0], scale, pad_x, pad_y, src_w, src_h, conf_threshold, iou_threshold)


# ---------------------------------------------------------------------------
# Tracking — ports src/utils/tracker.ts (IoU + velocity-predicted matching).
# ---------------------------------------------------------------------------

class IouTracker:
    def __init__(self, match_iou_threshold=0.3, max_missed_frames=8):
        self.tracks: dict[int, dict] = {}
        self.next_id = 1
        self.match_iou_threshold = match_iou_threshold
        self.max_missed_frames = max_missed_frames

    def update(self, detections: list[dict]) -> list[dict]:
        unmatched = set(self.tracks.keys())
        candidates = []
        for index, det in enumerate(detections):
            for track in self.tracks.values():
                if track["classId"] != det["classId"]:
                    continue
                x, y, w, h = track["box"]
                vx, vy = track["velocity"]
                steps = min(track["missedFrames"] + 1, 3)
                predicted = (x + vx * steps, y + vy * steps, w, h)
                overlap = box_iou(track["box"], det["box"])
                predicted_overlap = box_iou(predicted, det["box"])
                dx, dy, dw, dh = det["box"]
                area_ratio = dw * dh / max(1.0, w * h)
                distance = ((dx + dw / 2 - predicted[0] - w / 2) ** 2 + (dy + dh / 2 - predicted[1] - h / 2) ** 2) ** 0.5
                near = distance / max(1.0, (w * w + h * h) ** 0.5)
                if max(overlap, predicted_overlap) < self.match_iou_threshold and not (
                    near < 0.6 and 0.5 <= area_ratio <= 2
                ):
                    continue
                score = max(predicted_overlap * 0.8 + overlap * 0.2, 0.15 * (1 - near / 0.6))
                candidates.append((score, track["id"], index))

        candidates.sort(key=lambda c: (-c[0], c[1], c[2]))
        matches: dict[int, int] = {}
        for _score, track_id, index in candidates:
            if index in matches or track_id not in unmatched:
                continue
            matches[index] = track_id
            unmatched.discard(track_id)

        results = []
        for index, det in enumerate(detections):
            track_id = matches.get(index)
            if track_id is not None:
                track = self.tracks[track_id]
                elapsed = track["missedFrames"] + 1
                dx, dy, dw, dh = det["box"]
                tx, ty, tw, th = track["box"]
                vx = (dx + dw / 2 - tx - tw / 2) / elapsed
                vy = (dy + dh / 2 - ty - th / 2) / elapsed
                if track["hits"] == 1:
                    track["velocity"] = (vx, vy)
                else:
                    track["velocity"] = ((track["velocity"][0] + vx) / 2, (track["velocity"][1] + vy) / 2)
                track["hits"] += 1
                track["box"] = det["box"]
                track["missedFrames"] = 0
                results.append({**det, "trackId": track_id})
            else:
                new_id = self.next_id
                self.next_id += 1
                self.tracks[new_id] = {
                    "id": new_id, "box": det["box"], "classId": det["classId"],
                    "missedFrames": 0, "analyzed": False, "velocity": (0.0, 0.0), "hits": 1,
                }
                results.append({**det, "trackId": new_id})

        for track_id in unmatched:
            track = self.tracks[track_id]
            track["missedFrames"] += 1
            if track["missedFrames"] > self.max_missed_frames:
                del self.tracks[track_id]

        return results

    def has_track(self, track_id: int) -> bool:
        return track_id in self.tracks

    def mark_analyzed(self, track_id: int) -> None:
        if track_id in self.tracks:
            self.tracks[track_id]["analyzed"] = True

    def is_analyzed(self, track_id: int) -> bool:
        return self.tracks.get(track_id, {}).get("analyzed", False)

    def reset(self) -> None:
        self.tracks.clear()
        self.next_id = 1


# ---------------------------------------------------------------------------
# Event lifecycle — ports src/utils/personEvents.ts.
# ---------------------------------------------------------------------------

class PersonEventRecorder:
    def __init__(self, enqueue, now=lambda: time.time() * 1000):
        self.enqueue = enqueue
        self.now = now  # milliseconds, matching Date.now() in the ported TS
        self.active: dict[int, dict] = {}
        self.session: Optional[dict] = None
        self.epoch = 0

    def begin(self, session_id: str, camera_id: str, source: str, attire_mode: str) -> None:
        self.finish()
        self.session = {"id": session_id, "cameraId": camera_id, "source": source, "mode": attire_mode}
        self.epoch = 0

    def reset_tracks(self) -> None:
        self._flush_active()
        self.active.clear()
        self.epoch += 1

    def _publish(self, item: dict) -> None:
        event = item["event"]
        if event["attire"] == "unclassified" or not item["dirty"]:
            return
        event["revision"] += 1
        item["sentAt"] = self.now()
        snapshot = dict(event)
        event.pop("thumbnail", None)
        item["dirty"] = False
        self.enqueue(snapshot)

    def observe(self, people: list[dict], has_track) -> None:
        if not self.session:
            return
        for track_id in list(self.active.keys()):
            item = self.active[track_id]
            if not has_track(track_id):
                item["departed"] = True
                self._publish(item)
                if not item["analyzing"]:
                    del self.active[track_id]

        now_ms = int(self.now())
        session = self.session
        for person in people:
            track_id = person["trackId"]
            item = self.active.get(track_id)
            if item is None:
                event_id = f"{session['id']}:{self.epoch}:{track_id}"
                item = {
                    "sentAt": 0, "thumbnailAttached": False, "dirty": True,
                    "analyzing": False, "departed": False,
                    "event": {
                        "eventId": event_id, "sessionId": session["id"], "cameraId": session["cameraId"],
                        "trackId": track_id, "trackEpoch": self.epoch, "source": session["source"],
                        "attireMode": session["mode"], "firstSeen": now_ms, "lastSeen": now_ms,
                        "confidence": person["score"], "attire": "unclassified",
                        "gender": "uncertain", "ageGroup": "uncertain", "revision": 0,
                    },
                }
                self.active[track_id] = item
            event = item["event"]
            last_seen = max(event["lastSeen"], now_ms)
            confidence = max(event["confidence"], person["score"])
            item["dirty"] = item["dirty"] or last_seen != event["lastSeen"] or confidence != event["confidence"]
            event["lastSeen"] = last_seen
            event["confidence"] = confidence
            if self.now() - item["sentAt"] >= EVENT_PUBLISH_THROTTLE_MS:
                self._publish(item)

    def begin_analysis(self, track_id: int) -> None:
        item = self.active.get(track_id)
        if item:
            item["analyzing"] = True

    def end_analysis(self, track_id: int) -> None:
        item = self.active.get(track_id)
        if not item:
            return
        item["analyzing"] = False
        if item["departed"]:
            self._publish(item)
            del self.active[track_id]

    def classify(self, track_id: int, attire: str, gender: str, age_group: str) -> None:
        item = self.active.get(track_id)
        if not item or item["event"]["attire"] != "unclassified":
            return
        item["event"]["attire"] = attire
        item["event"]["gender"] = gender
        item["event"]["ageGroup"] = age_group
        item["dirty"] = True
        self._publish(item)

    def attach_thumbnail(self, track_id: int, thumbnail_data_url: str) -> None:
        item = self.active.get(track_id)
        if not item or item["thumbnailAttached"]:
            return
        item["thumbnailAttached"] = True
        item["event"]["thumbnail"] = thumbnail_data_url
        item["dirty"] = True

    def _flush_active(self) -> None:
        for item in self.active.values():
            self._publish(item)

    def finish(self) -> None:
        self._flush_active()
        self.active.clear()
        self.session = None


# ---------------------------------------------------------------------------
# Attire classification prompt — ports src/functions/demo.func.ts.
# ---------------------------------------------------------------------------

def build_attire_prompt(mode: str) -> str:
    if mode == "medical":
        attire_instruction = (
            "1. การแต่งกาย: [TARGET] หากสวมชุดบุคลากรทางการแพทย์ เช่น เสื้อสครับ (scrubs) ชุดหมอ ชุดพยาบาล หรือชุดพาราเมดิก/เจ้าหน้าที่กู้ชีพ "
            "(ชุดประเภทนี้อาจเป็นสีอะไรก็ได้ ไม่จำเป็นต้องเป็นสีกรมท่า และมักมีลักษณะ เช่น คอวี กระเป๋าหน้าอก ตราสัญลักษณ์โรงพยาบาล/หน่วยงาน ป้ายชื่อ/ตำแหน่งงาน หรือแถบสะท้อนแสง), "
            "[OTHER] สำหรับชุดทั่วไปที่ไม่ใช่ชุดบุคลากรทางการแพทย์, [UNCERTAIN_ATTIRE] หากไม่แน่ใจ\n"
        )
    else:
        attire_instruction = (
            "1. การแต่งกาย: [TARGET] สำหรับผู้ที่สวมชุดนักศึกษา/เครื่องแบบนักเรียน หรือเสื้อโปโล ให้จัดเป็นนักศึกษาหรือบุคลากร; "
            "[OTHER] สำหรับผู้ที่สวมเสื้อผ้าแบบอื่น ให้จัดเป็นบุคคลภายนอก; [UNCERTAIN_ATTIRE] หากมองไม่ชัดหรือไม่แน่ใจ\n"
        )
    example = (
        'ตัวอย่าง: "[TARGET][FEMALE][ADULT] สวมชุดสครับสีเขียวมีป้ายชื่อโรงพยาบาลติดที่อก..."\n'
        if mode == "medical"
        else 'ตัวอย่าง: "[TARGET][FEMALE][TEEN] สวมเสื้อเชิ้ตสีขาวและกระโปรงสีดำ..."\n'
    )
    return (
        "วิเคราะห์บุคคลในภาพและระบุข้อมูล 3 ส่วน โดยใช้ Tag ต่อไปนี้ไว้ที่จุดเริ่มต้นของข้อความเสมอ:\n"
        + attire_instruction
        + "2. เพศ/สไตล์: [MALE] สำหรับผู้ชาย, [FEMALE] สำหรับผู้หญิง, [UNISEX] หากก้ำกึ่งหรือไม่แน่ใจ\n"
        + "3. ช่วงวัย: [TEEN] สำหรับวัยรุ่น/วัยเรียน, [ADULT] สำหรับวัยทำงาน/ผู้ใหญ่, [ELDERLY] สำหรับวัยสูงอายุ, [UNCERTAIN_AGE] หากไม่แน่ใจ\n"
        + 'รูปแบบการตอบที่ต้องการ: "[ATTIRE_TAG][GENDER_TAG][AGE_TAG] คำอธิบายลักษณะเสื้อผ้าสั้นๆ..."\n'
        + example
        + "ตอบคำอธิบายเป็นภาษาไทย ไม่เกิน 2 ประโยค"
    )


def parse_attire_type(text: str) -> str:
    upper = text.upper()
    if "[TARGET]" in upper:
        return "target"
    if "[OTHER]" in upper:
        return "other"
    return "uncertain"


def parse_gender_type(text: str) -> str:
    upper = text.upper()
    if "[MALE]" in upper:
        return "male"
    if "[FEMALE]" in upper:
        return "female"
    if "[UNISEX]" in upper:
        return "unisex"
    return "uncertain"


def parse_age_group_type(text: str) -> str:
    upper = text.upper()
    if "[TEEN]" in upper:
        return "teen"
    if "[ADULT]" in upper:
        return "adult"
    if "[ELDERLY]" in upper:
        return "elderly"
    return "uncertain"


ATTIRE_TAG_RE = re.compile(r"\[(TARGET|OTHER|UNCERTAIN_ATTIRE)\]", re.IGNORECASE)


def crop_to_jpeg(frame_bgr: np.ndarray, box, max_dim=512, quality=85, min_aspect_ratio=0.0) -> bytes:
    x, y, w, h = box
    src_h, src_w = frame_bgr.shape[:2]
    safe_x = max(0.0, min(x, src_w - 1))
    safe_y = max(0.0, min(y, src_h - 1))
    safe_w = max(1.0, min(w, src_w - safe_x))
    safe_h = max(1.0, min(h, src_h - safe_y))
    crop_w = min(float(src_w), max(safe_w, safe_h * min_aspect_ratio))
    crop_x = max(0.0, min(src_w - crop_w, safe_x + safe_w / 2 - crop_w / 2))
    scale = min(1.0, max_dim / max(crop_w, safe_h))
    out_w = max(1, round(crop_w * scale))
    out_h = max(1, round(safe_h * scale))

    region = frame_bgr[int(safe_y):int(safe_y + safe_h), int(crop_x):int(crop_x + crop_w)]
    if region.size == 0:
        raise ValueError("empty crop region")
    resized = cv2.resize(region, (out_w, out_h), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("JPEG encode failed")
    return buf.tobytes()


def http_post_json(url: str, payload: dict, headers: dict, timeout: float) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def classify_frames(provider: str, frames: list[dict], attire_mode: str, config: argparse.Namespace) -> str:
    prompt = (
        f"{build_attire_prompt(attire_mode)}\n"
        f"ภาพต่อไปนี้เป็นลำดับเฟรมของบุคคลคนเดียวกัน จำนวน {len(frames)} ภาพ "
        "ให้ใช้ข้อมูลจากทุกเฟรมประกอบกัน หากบางเฟรมเบลอหรือบัง ให้พิจารณาเฟรมอื่นด้วย ไม่ต้องบรรยายความเปลี่ยนแปลงระหว่างเฟรม"
    )

    if provider == "ollama":
        url = f"{config.data_api_url}/api/ai/ollama/analyze"
        images_b64 = [frame["data_b64"] for frame in frames]
        full_prompt = prompt + "\n" + "\n".join(
            f"เฟรม {frame['frameIndex']} (หลังเริ่มพบ {round(frame['elapsedMs'])} ms)" for frame in frames
        )
        result = http_post_json(url, {"model": config.ollama_model, "prompt": full_prompt, "images": images_b64},
                                 headers={}, timeout=120)
        text = result.get("data", {}).get("text", "")
        if not text.strip():
            raise RuntimeError("Ollama ไม่ได้ส่งคำอธิบายกลับมา")
        return text.strip()

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{config.gemini_model}:generateContent"
    parts = [{"text": prompt}]
    for frame in frames:
        parts.append({"text": f"เฟรม {frame['frameIndex']} (หลังเริ่มพบ {round(frame['elapsedMs'])} ms)"})
        parts.append({"inlineData": {"mimeType": "image/jpeg", "data": frame["data_b64"]}})
    result = http_post_json(url, {"contents": [{"parts": parts}], "generationConfig": {"maxOutputTokens": 200}},
                             headers={"x-goog-api-key": config.gemini_api_key}, timeout=30)
    candidates = result.get("candidates") or []
    text = "".join(
        p.get("text", "") for c in candidates for p in (c.get("content", {}).get("parts") or [])
    ).strip()
    if not text:
        raise RuntimeError("ไม่ได้รับคำอธิบายจาก Gemini API")
    return text


# ---------------------------------------------------------------------------
# Bridge HTTP client.
# ---------------------------------------------------------------------------

def fetch_json(url: str, timeout: float = 5) -> Optional[dict]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None


def fetch_frame(url: str, timeout: float = 3) -> Optional[np.ndarray]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            data = response.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return None
    array = np.frombuffer(data, dtype=np.uint8)
    return cv2.imdecode(array, cv2.IMREAD_COLOR)


def get_camera_id() -> str:
    try:
        existing = CAMERA_ID_FILE.read_text().strip()
        if existing:
            return existing
    except OSError:
        pass
    generated = f"rdk-{secrets.token_hex(4)}"
    try:
        CAMERA_ID_FILE.write_text(generated)
    except OSError:
        pass
    return generated


# ---------------------------------------------------------------------------
# Annotated MJPEG preview — boxes/track IDs drawn on-device so a remote
# dashboard viewer can see what's being detected without running inference.
# ---------------------------------------------------------------------------

def draw_detections(frame_bgr: np.ndarray, tracked: list[dict]) -> np.ndarray:
    annotated = frame_bgr.copy()
    for det in tracked:
        x, y, w, h = (int(round(v)) for v in det["box"])
        cv2.rectangle(annotated, (x, y), (x + w, y + h), (110, 220, 110), 2)
        label = f"#{det['trackId']} {det['className']} {det['score'] * 100:.0f}%"
        text_y = max(16, y - 6)
        cv2.putText(annotated, label, (x, text_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (110, 220, 110), 2, cv2.LINE_AA)
    return annotated


class AnnotatedStream:
    def __init__(self):
        self.condition = threading.Condition()
        self.latest_jpeg: Optional[bytes] = None
        self.frame_id = 0

    def publish(self, frame_bgr: np.ndarray, tracked: list[dict]) -> None:
        annotated = draw_detections(frame_bgr, tracked)
        ok, buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if not ok:
            return
        with self.condition:
            self.latest_jpeg = buf.tobytes()
            self.frame_id += 1
            self.condition.notify_all()

    def clear(self) -> None:
        with self.condition:
            self.latest_jpeg = None
            self.condition.notify_all()


def make_stream_handler(stream: AnnotatedStream):
    class StreamHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path.split("?", 1)[0] != "/annotated.mjpg":
                self.send_response(404)
                self.end_headers()
                return

            deadline = time.monotonic() + 8
            with stream.condition:
                while stream.latest_jpeg is None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        self.send_response(503)
                        self.end_headers()
                        return
                    stream.condition.wait(timeout=remaining)

            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()

            self.connection.settimeout(5)
            last_frame_id = -1
            try:
                while True:
                    with stream.condition:
                        stream.condition.wait_for(lambda: stream.frame_id != last_frame_id, timeout=2)
                        jpeg = stream.latest_jpeg
                        current_frame_id = stream.frame_id
                    if jpeg is None or current_frame_id == last_frame_id:
                        continue
                    self.wfile.write(
                        b"--frame\r\nContent-Type: image/jpeg\r\n"
                        + f"Content-Length: {len(jpeg)}\r\n\r\n".encode("ascii")
                        + jpeg + b"\r\n"
                    )
                    self.wfile.flush()
                    last_frame_id = current_frame_id
            except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
                pass

        def log_message(self, format: str, *args) -> None:  # noqa: A002 — matches http.server's signature
            pass

    return StreamHandler


# ---------------------------------------------------------------------------
# Background I/O: classification calls + outbox flush, off the detect loop.
# ---------------------------------------------------------------------------

class IoWorker(threading.Thread):
    def __init__(self, config: argparse.Namespace):
        super().__init__(daemon=True)
        self.config = config
        self.jobs: queue.Queue = queue.Queue()
        self.results: queue.Queue = queue.Queue()
        self.outbox: dict[str, dict] = {}
        self.outbox_lock = threading.Lock()
        self.dropped = 0
        self.stop_flag = threading.Event()
        self.last_flush = 0.0

    def submit_job(self, track_id: int, frames: list[dict]) -> None:
        self.jobs.put((track_id, frames))

    def enqueue_event(self, event: dict) -> None:
        with self.outbox_lock:
            if event["eventId"] not in self.outbox and len(self.outbox) >= OUTBOX_LIMIT:
                self.dropped += 1
                log(f"outbox full ({OUTBOX_LIMIT}); dropped {self.dropped} events so far")
                return
            self.outbox[event["eventId"]] = event

    def run(self) -> None:
        while not self.stop_flag.is_set():
            try:
                track_id, frames = self.jobs.get(timeout=0.5)
            except queue.Empty:
                self._maybe_flush()
                continue
            try:
                text = classify_frames(self.config.ai_provider, frames, self.config.attire_mode, self.config)
                self.results.put((track_id, "ok", text))
            except Exception as exc:  # noqa: BLE001 — surfaced to the main loop as a retry signal
                self.results.put((track_id, "error", str(exc)))
            self._maybe_flush()

    def _maybe_flush(self) -> None:
        if time.monotonic() - self.last_flush < EVENT_FLUSH_INTERVAL_S:
            return
        self.flush_now()

    def flush_now(self) -> None:
        self.last_flush = time.monotonic()
        with self.outbox_lock:
            batch = list(self.outbox.values())[:100]
        if not batch:
            return
        try:
            result = http_post_json(
                f"{self.config.data_api_url}/api/data/events", {"events": batch},
                headers={"Authorization": f"Bearer {self.config.data_api_key}"}, timeout=10,
            )
            accepted = {(a["eventId"], a["revision"]) for a in result.get("data", {}).get("accepted", [])}
            with self.outbox_lock:
                for event_id, revision in accepted:
                    current = self.outbox.get(event_id)
                    if current and current["revision"] == revision:
                        del self.outbox[event_id]
            log(f"posted {len(accepted)}/{len(batch)} events; {len(self.outbox)} pending")
        except Exception as exc:  # noqa: BLE001 — keep the queue, retry next flush
            log(f"event post failed, will retry: {exc}")

    def stop(self) -> None:
        self.stop_flag.set()


# ---------------------------------------------------------------------------
# Per-track crop sampling (mirrors the PersonFrameQueue logic in App.tsx).
# ---------------------------------------------------------------------------

class TrackQueue:
    def __init__(self):
        self.started_at = time.monotonic()
        self.last_captured_at = 0.0
        self.frames: list[dict] = []
        self.attempts = 0
        self.retry_after = 0.0
        self.analyzing = False


def main() -> None:
    parser = argparse.ArgumentParser(description="Run detection on the RDK X5 board for the MIPI camera feed.")
    parser.add_argument("--bridge-url", default="http://127.0.0.1:8765")
    parser.add_argument("--data-api-url", default="http://127.0.0.1:8787")
    parser.add_argument("--data-api-key", default=os.environ.get("DATA_API_KEY", ""))
    parser.add_argument("--model-path", type=Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument("--conf-threshold", type=float, default=DEFAULT_CONF_THRESHOLD)
    parser.add_argument("--iou-threshold", type=float, default=DEFAULT_IOU_THRESHOLD)
    parser.add_argument("--attire-mode", choices=("student", "medical"), default="student")
    parser.add_argument("--ai-provider", choices=("gemini", "ollama"), default="gemini")
    parser.add_argument("--gemini-api-key", default=os.environ.get("GEMINI_API_KEY", ""))
    parser.add_argument("--gemini-model", default=GEMINI_MODEL)
    parser.add_argument("--ollama-model", default="qwen3.5:2b")
    parser.add_argument("--poll-interval-ms", type=int, default=CAMERA_DETECT_INTERVAL_MS)
    parser.add_argument("--stream-host", default="0.0.0.0")
    parser.add_argument("--stream-port", type=int, default=8766)
    args = parser.parse_args()

    if not args.data_api_key:
        parser.error("--data-api-key (or DATA_API_KEY env) is required")
    if args.ai_provider == "gemini" and not args.gemini_api_key:
        parser.error("--gemini-api-key (or GEMINI_API_KEY env) is required when --ai-provider=gemini")

    model = YoloModel(args.model_path)
    camera_id = get_camera_id()
    tracker = IouTracker()
    io_worker = IoWorker(args)
    io_worker.start()
    recorder = PersonEventRecorder(io_worker.enqueue_event)
    track_queues: dict[int, TrackQueue] = {}
    session_active = False

    stream = AnnotatedStream()
    stream_server = ThreadingHTTPServer((args.stream_host, args.stream_port), make_stream_handler(stream))
    threading.Thread(target=stream_server.serve_forever, daemon=True).start()

    log(f"ready; camera_id={camera_id} model={args.model_path} provider={args.ai_provider} "
        f"preview=http://{args.stream_host}:{args.stream_port}/annotated.mjpg")

    try:
        while True:
            loop_start = time.monotonic()
            status = fetch_json(f"{args.bridge_url}/api/mipi/status")
            ready = bool(status) and status.get("state") == "ready"

            if ready and not session_active:
                session_active = True
                tracker.reset()
                track_queues.clear()
                recorder.begin(f"rdk-{secrets.token_hex(4)}", camera_id, "camera", args.attire_mode)
                log("camera session started")
            elif not ready and session_active:
                session_active = False
                recorder.finish()
                tracker.reset()
                track_queues.clear()
                stream.clear()
                log(f"camera session ended ({status.get('error') if status else 'bridge unreachable'})")

            if session_active:
                frame = fetch_frame(f"{args.bridge_url}/api/mipi/frame.jpg")
                if frame is not None:
                    _run_cycle(frame, model, tracker, recorder, track_queues, io_worker, args, stream)

            while True:
                try:
                    track_id, outcome, payload = io_worker.results.get_nowait()
                except queue.Empty:
                    break
                _handle_classification_result(track_id, outcome, payload, tracker, recorder, track_queues)

            elapsed = time.monotonic() - loop_start
            time.sleep(max(0.0, args.poll_interval_ms / 1000 - elapsed))
    except KeyboardInterrupt:
        log("stopping")
    finally:
        recorder.finish()
        io_worker.stop()
        io_worker.join(timeout=5)
        io_worker.flush_now()
        stream_server.shutdown()


def _run_cycle(frame, model, tracker, recorder, track_queues, io_worker, args, stream) -> None:
    detections = [d for d in model.detect(frame, args.conf_threshold, args.iou_threshold) if d["classId"] == PERSON_CLASS_ID]
    tracked = tracker.update(detections)
    recorder.observe(tracked, tracker.has_track)
    stream.publish(frame, tracked)

    live_ids = {det["trackId"] for det in tracked}
    for track_id in list(track_queues.keys()):
        if track_id not in live_ids:
            del track_queues[track_id]

    now = time.monotonic()
    for det in tracked:
        track_id = det["trackId"]
        if tracker.is_analyzed(track_id):
            track_queues.pop(track_id, None)
            continue
        tq = track_queues.setdefault(track_id, TrackQueue())
        ready_to_sample = not tq.frames or (now - tq.last_captured_at) >= PERSON_QUEUE_SAMPLE_INTERVAL_MS / 1000
        if len(tq.frames) < PERSON_QUEUE_FRAME_COUNT and ready_to_sample:
            try:
                jpeg = crop_to_jpeg(frame, det["box"], max_dim=384, quality=72, min_aspect_ratio=0.58)
                tq.frames.append({
                    "data_b64": base64.b64encode(jpeg).decode("ascii"),
                    "frameIndex": len(tq.frames) + 1,
                    "elapsedMs": (now - tq.started_at) * 1000,
                })
                tq.last_captured_at = now
            except ValueError as exc:
                log(f"crop failed for track {track_id}: {exc}")
                track_queues.pop(track_id, None)
                continue

        if (not tq.analyzing and len(tq.frames) >= PERSON_QUEUE_FRAME_COUNT
                and tq.attempts < PERSON_QUEUE_MAX_ATTEMPTS and now >= tq.retry_after):
            tq.analyzing = True
            tq.attempts += 1
            recorder.begin_analysis(track_id)
            io_worker.submit_job(track_id, list(tq.frames))


def _handle_classification_result(track_id, outcome, payload, tracker, recorder, track_queues) -> None:
    tq = track_queues.get(track_id)
    recorder.end_analysis(track_id)
    if tq:
        tq.analyzing = False

    if not tracker.has_track(track_id):
        return

    if outcome == "error":
        log(f"classification failed for track {track_id}: {payload}")
        if tq:
            tq.retry_after = time.monotonic() + 10 * (2 ** (tq.attempts - 1))
        return

    text = payload
    if not ATTIRE_TAG_RE.search(text):
        log(f"classification for track {track_id} missing attire tag, will retry")
        if tq:
            tq.retry_after = time.monotonic() + 10 * (2 ** (tq.attempts - 1))
        return

    thumbnail_b64 = tq.frames[-1]["data_b64"] if tq and tq.frames else None
    if thumbnail_b64:
        recorder.attach_thumbnail(track_id, f"data:image/jpeg;base64,{thumbnail_b64}")
    recorder.classify(track_id, parse_attire_type(text), parse_gender_type(text), parse_age_group_type(text))
    tracker.mark_analyzed(track_id)
    track_queues.pop(track_id, None)


if __name__ == "__main__":
    main()
