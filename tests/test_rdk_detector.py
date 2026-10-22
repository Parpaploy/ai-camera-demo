"""Logic tests for scripts/rdk_detector.py — no RDK hardware or camera SDK needed.

Covers the pieces ported from the browser (src/utils/yolo.ts, tracker.ts,
src/functions/demo.func.ts) so a regression there is caught without a board.
"""
import argparse
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from rdk_detector import (
    ATTIRE_TAG_RE,
    PERSON_CLASS_ID,
    YoloModel,
    AnnotatedStream,
    IouTracker,
    PersonEventRecorder,
    TrackQueue,
    _run_cycle,
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


class FakeModel:
    """Returns pre-scripted detections per call instead of running onnxruntime."""

    def __init__(self, detections_per_call):
        self.calls = list(detections_per_call)

    def detect(self, frame, conf_threshold, iou_threshold):
        return self.calls.pop(0) if self.calls else []


class FakeIoWorker:
    def __init__(self):
        self.jobs = []

    def submit_job(self, track_id, frames):
        self.jobs.append((track_id, frames))


class RunCycleTests(unittest.TestCase):
    """A person who steps out of frame for one cycle (occlusion) must not lose
    their in-progress crop queue — regression test for a bug where the queue
    was cleared based on this frame's detections instead of the tracker's own
    missed-frame tolerance, silently dropping thumbnails on stored events."""

    def setUp(self):
        self.frame = np.full((480, 640, 3), 127, dtype=np.uint8)
        self.tracker = IouTracker()
        self.recorder = PersonEventRecorder(lambda event: None)
        self.recorder.begin("sess", "cam-1", "camera", "student")
        self.track_queues = {}
        self.io_worker = FakeIoWorker()
        self.stream = AnnotatedStream()
        self.args = argparse.Namespace(conf_threshold=0.35, iou_threshold=0.45)
        self.person = {"classId": PERSON_CLASS_ID, "className": "person", "score": 0.9, "box": (100.0, 100.0, 80.0, 160.0)}

    def run_cycle(self, detections):
        model = FakeModel([detections])
        _run_cycle(self.frame, model, self.tracker, self.recorder, self.track_queues, self.io_worker, self.args, self.stream)

    def test_queue_survives_one_missed_frame(self):
        self.run_cycle([self.person])
        self.assertEqual(len(self.track_queues), 1)
        track_id = next(iter(self.track_queues))
        frames_before = len(self.track_queues[track_id].frames)
        self.assertGreater(frames_before, 0)

        self.run_cycle([])  # occluded for one frame — tracker still holds the ID
        self.assertIn(track_id, self.track_queues, "queue must survive a tolerated missed frame")
        self.assertEqual(len(self.track_queues[track_id].frames), frames_before, "crops already captured must not be lost")

    def test_queue_dropped_once_track_actually_expires(self):
        self.run_cycle([self.person])
        track_id = next(iter(self.track_queues))
        for _ in range(9):  # exceeds IouTracker's default max_missed_frames=8
            self.run_cycle([])
        self.assertNotIn(track_id, self.track_queues)
        self.assertFalse(self.tracker.has_track(track_id))


if __name__ == "__main__":
    unittest.main()
