"""Logic tests for scripts/rdk_detector.py — no RDK hardware or camera SDK needed.

Covers the pieces ported from the browser (src/utils/yolo.ts, tracker.ts,
src/functions/demo.func.ts) so a regression there is caught without a board.
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from rdk_detector import (
    ATTIRE_TAG_RE,
    YoloModel,
    IouTracker,
    box_iou,
    crop_to_jpeg,
    nms,
    parse_age_group_type,
    parse_attire_type,
    parse_gender_type,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = PROJECT_ROOT / "public" / "models" / "yolov8n.onnx"


class ParserTests(unittest.TestCase):
    def test_parse_attire_type(self):
        self.assertEqual(parse_attire_type("[TARGET][FEMALE][ADULT] blah"), "target")
        self.assertEqual(parse_attire_type("[other]"), "other")
        self.assertEqual(parse_attire_type("[UNCERTAIN_ATTIRE]"), "uncertain")

    def test_parse_gender_and_age(self):
        self.assertEqual(parse_gender_type("[FEMALE]"), "female")
        self.assertEqual(parse_gender_type("no tag"), "uncertain")
        self.assertEqual(parse_age_group_type("[ELDERLY]"), "elderly")

    def test_attire_tag_regex_matches_browser_check(self):
        self.assertTrue(ATTIRE_TAG_RE.search("[target][male][adult] text"))
        self.assertFalse(ATTIRE_TAG_RE.search("no tags here"))


class NmsAndIouTests(unittest.TestCase):
    def test_box_iou_identical_boxes(self):
        self.assertEqual(box_iou((0, 0, 10, 10), (0, 0, 10, 10)), 1.0)

    def test_box_iou_disjoint_boxes(self):
        self.assertEqual(box_iou((0, 0, 10, 10), (100, 100, 10, 10)), 0.0)

    def test_nms_suppresses_overlapping_lower_score(self):
        dets = [
            {"classId": 0, "className": "person", "score": 0.9, "box": (0, 0, 10, 10)},
            {"classId": 0, "className": "person", "score": 0.5, "box": (1, 1, 10, 10)},
            {"classId": 0, "className": "person", "score": 0.8, "box": (100, 100, 10, 10)},
        ]
        kept = nms(dets, iou_threshold=0.45)
        self.assertEqual(len(kept), 2)
        self.assertEqual({d["score"] for d in kept}, {0.9, 0.8})

    def test_nms_keeps_detections_from_different_classes(self):
        dets = [
            {"classId": 0, "className": "person", "score": 0.9, "box": (0, 0, 10, 10)},
            {"classId": 2, "className": "car", "score": 0.6, "box": (0, 0, 10, 10)},
        ]
        self.assertEqual(len(nms(dets, iou_threshold=0.45)), 2)


class IouTrackerTests(unittest.TestCase):
    def test_keeps_same_id_for_overlapping_box_next_frame(self):
        tracker = IouTracker()
        a = tracker.update([{"classId": 0, "className": "person", "score": 0.9, "box": (10.0, 10.0, 50.0, 100.0)}])
        b = tracker.update([{"classId": 0, "className": "person", "score": 0.91, "box": (12.0, 11.0, 50.0, 100.0)}])
        self.assertEqual(a[0]["trackId"], b[0]["trackId"])

    def test_assigns_new_id_to_distant_unrelated_detection(self):
        tracker = IouTracker()
        tracker.update([{"classId": 0, "className": "person", "score": 0.9, "box": (10.0, 10.0, 50.0, 100.0)}])
        far = tracker.update([{"classId": 0, "className": "person", "score": 0.9, "box": (900.0, 900.0, 50.0, 100.0)}])
        self.assertEqual(far[0]["trackId"], 2)

    def test_track_expires_after_max_missed_frames(self):
        tracker = IouTracker(max_missed_frames=2)
        tracker.update([{"classId": 0, "className": "person", "score": 0.9, "box": (10.0, 10.0, 50.0, 100.0)}])
        for _ in range(3):
            tracker.update([])
        self.assertFalse(tracker.has_track(1))

    def test_reset_clears_tracks_and_id_counter(self):
        tracker = IouTracker()
        tracker.update([{"classId": 0, "className": "person", "score": 0.9, "box": (0.0, 0.0, 10.0, 10.0)}])
        tracker.reset()
        again = tracker.update([{"classId": 0, "className": "person", "score": 0.9, "box": (0.0, 0.0, 10.0, 10.0)}])
        self.assertEqual(again[0]["trackId"], 1)


class CropTests(unittest.TestCase):
    def test_crop_to_jpeg_is_valid_small_jpeg(self):
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        jpeg = crop_to_jpeg(frame, (10, 10, 50, 100), max_dim=384, quality=72, min_aspect_ratio=0.58)
        self.assertEqual(jpeg[:3], b"\xff\xd8\xff")
        self.assertLess(len(jpeg), 96 * 1024)

    def test_crop_clamps_box_outside_frame_bounds(self):
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        jpeg = crop_to_jpeg(frame, (-50, -50, 300, 300), max_dim=384, quality=72)
        self.assertEqual(jpeg[:3], b"\xff\xd8\xff")


@unittest.skipUnless(MODEL_PATH.exists(), "yolov8n.onnx not present")
class YoloModelTests(unittest.TestCase):
    def test_detect_runs_end_to_end_on_blank_frame(self):
        model = YoloModel(MODEL_PATH)
        frame = np.full((480, 640, 3), 127, dtype=np.uint8)
        detections = model.detect(frame, conf_threshold=0.35, iou_threshold=0.45)
        self.assertIsInstance(detections, list)
        for det in detections:
            self.assertIn("classId", det)
            self.assertIn("box", det)
            self.assertEqual(len(det["box"]), 4)


if __name__ == "__main__":
    unittest.main()
