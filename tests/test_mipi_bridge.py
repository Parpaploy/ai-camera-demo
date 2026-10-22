"""Hardware-independent lifecycle/fault injection tests (spawn real processes)."""
import multiprocessing as mp
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from rdk_mipi_bridge import MipiCameraFeed, create_handler


def frames(config, stop, buffer, metadata, lock):
    while not stop.is_set():
        with lock:
            buffer[:4] = b"jpeg"
            metadata[0] = 4
            metadata[1] += 1
        stop.wait(0.01)


def stuck(config, stop, buffer, metadata, lock):
    # Simulate a native SDK read/close that ignores cooperative stop.
    time.sleep(120)


def stuck_after_frame(config, stop, buffer, metadata, lock):
    with lock:
        buffer[:4] = b"jpeg"
        metadata[0] = 4
        metadata[1] = 1
    time.sleep(120)


def dead_with_lock(config, stop, buffer, metadata, lock):
    lock.acquire()
    sys.exit(2)


class LifecycleTests(unittest.TestCase):
    def feed(self, target=frames, timeout=0.3):
        feed = MipiCameraFeed(16, 16, 20, 80, -1,
                              frame_timeout=timeout, worker_target=target)
        self.addCleanup(feed.stop_capture)
        return feed

    def wait_for(self, predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.02)
        self.fail("Timed out waiting for expected state")

    def test_reopen_twenty_times(self):
        feed = self.feed()
        for _ in range(20):
            feed.start_capture()
            self.assertEqual(feed.wait_until_ready(3)["state"], "ready")
            previous_stop = feed.stop_event
            feed.stop_capture()
            self.assertTrue(previous_stop.is_set())
            self.assertEqual(feed.snapshot()["state"], "stopped")
            self.assertIsNone(feed.latest_jpeg)
            self.assertFalse(feed.thread.is_alive())

    def test_stop_blocked_native_read_is_bounded(self):
        feed = self.feed(stuck, timeout=30)
        feed.start_capture()
        time.sleep(0.15)
        started = time.monotonic()
        feed.stop_capture()
        self.assertLess(time.monotonic() - started, 4)
        self.assertFalse(feed.thread.is_alive())
        feed.worker_target = frames
        feed.start_capture()
        self.assertEqual(feed.wait_until_ready(3)["state"], "ready")

    def test_watchdog_retries_are_bounded(self):
        feed = self.feed(stuck_after_frame)
        feed.start_capture()
        self.assertEqual(feed.wait_until_ready(3)["state"], "ready")
        self.wait_for(lambda: feed.snapshot()["state"] == "error")
        self.assertEqual(feed.restart_count, 3)
        self.assertIn("Timed out", feed.error)
        self.assertIsNone(feed.latest_jpeg)

    def test_worker_dying_with_lock_does_not_deadlock_server(self):
        feed = self.feed(dead_with_lock)
        feed.start_capture()
        self.wait_for(lambda: feed.snapshot()["state"] == "error")
        feed.stop_capture()
        self.assertFalse(feed.thread.is_alive())

    def test_duplicate_start_and_latest_buffer(self):
        feed = self.feed()
        feed.start_capture()
        thread = feed.thread
        feed.start_capture()
        self.assertIs(feed.thread, thread)
        self.assertEqual(feed.wait_until_ready(3)["state"], "ready")
        self.wait_for(lambda: feed.frame_id >= 30)
        self.assertEqual(feed.latest_jpeg, b"jpeg")
        feed.stop_capture()
        self.assertFalse(mp.active_children())


class FrameRouteTests(unittest.TestCase):
    """The rdk_detector.py process polls this snapshot endpoint instead of the MJPEG stream."""

    def setUp(self):
        self.feed = MipiCameraFeed(16, 16, 20, 80, -1, frame_timeout=2, worker_target=frames)
        self.addCleanup(self.feed.stop_capture)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(self.feed, Path("dist/public"), 8766))
        self.port = self.server.server_address[1]
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        # addCleanup runs LIFO: register server_close first so shutdown (which
        # must happen before the socket is closed) runs ahead of it.
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def get(self, path):
        try:
            response = urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=2)
            return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers

    def test_frame_route_503_before_camera_ready(self):
        status, _body, _headers = self.get("/api/mipi/frame.jpg")
        self.assertEqual(status, 503)

    def test_frame_route_returns_latest_jpeg_once_ready(self):
        self.feed.start_capture()
        self.assertEqual(self.feed.wait_until_ready(3)["state"], "ready")
        status, body, headers = self.get("/api/mipi/frame.jpg")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "image/jpeg")
        self.assertEqual(body, b"jpeg")
        self.assertEqual(int(headers.get("X-Frame-Id")), self.feed.frame_id)


if __name__ == "__main__":
    unittest.main()
