#!/usr/bin/env python3
"""Serve an RDK X5 MIPI camera as an MJPEG stream for the web app."""

from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WEB_ROOT = PROJECT_ROOT / "dist" / "public"


class MipiCameraFeed:
    def __init__(self, width: int, height: int, fps: int, jpeg_quality: int) -> None:
        self.width = width
        self.height = height
        self.fps = fps
        self.jpeg_quality = jpeg_quality
        self.condition = threading.Condition()
        self.lifecycle_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.latest_jpeg: bytes | None = None
        self.frame_id = 0
        self.state = "stopped"
        self.error = ""
        self.camera = None
        self.thread: threading.Thread | None = None

    def start_capture(self) -> None:
        with self.lifecycle_lock:
            with self.condition:
                if self.state in ("starting", "ready"):
                    return
                previous_thread = self.thread

            if previous_thread is not None and previous_thread.is_alive():
                previous_thread.join(timeout=5)

            with self.condition:
                if self.thread is not None and self.thread.is_alive():
                    self.state = "error"
                    self.error = "Previous MIPI camera session did not stop"
                    self.condition.notify_all()
                    return

                self.stop_event = threading.Event()
                self.latest_jpeg = None
                self.error = ""
                self.state = "starting"
                self.thread = threading.Thread(target=self._capture, daemon=True)
                self.thread.start()

    def wait_until_ready(self, timeout: float = 12) -> dict[str, object]:
        with self.condition:
            self.condition.wait_for(
                lambda: self.state != "starting", timeout=timeout
            )
            return self.snapshot()

    def stop_capture(self) -> None:
        with self.lifecycle_lock:
            with self.condition:
                thread = self.thread
                if thread is None or not thread.is_alive():
                    if self.state != "error":
                        self.state = "stopped"
                        self.latest_jpeg = None
                    return
                self.stop_event.set()
                self.condition.notify_all()

            thread.join(timeout=5)

    def snapshot(self) -> dict[str, object]:
        with self.condition:
            return {
                "state": self.state,
                "error": self.error,
                "width": self.width,
                "height": self.height,
                "fps": self.fps,
                "frameId": self.frame_id,
            }

    def _set_error(self, message: str) -> None:
        with self.condition:
            self.state = "error"
            self.error = message
            self.condition.notify_all()

    def _capture(self) -> None:
        try:
            import cv2
            import numpy as np
            from hobot_vio import libsrcampy

            self.camera = libsrcampy.Camera()
            result = self.camera.open_cam(0, -1, self.fps, self.width, self.height)
            if result not in (None, 0):
                raise RuntimeError(
                    f"Camera.open_cam returned {result}; check the MIPI sensor and cable"
                )

            frame_bytes = self.width * self.height * 3 // 2
            encode_options = [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality]

            while not self.stop_event.is_set():
                frame_started = time.monotonic()
                try:
                    raw = self.camera.get_img(2, self.width, self.height)
                except TypeError:
                    raw = self.camera.get_img(2)

                if raw is None:
                    time.sleep(0.01)
                    continue

                if isinstance(raw, np.ndarray):
                    nv12 = np.asarray(raw, dtype=np.uint8).reshape(-1)
                else:
                    nv12 = np.frombuffer(raw, dtype=np.uint8)

                if nv12.size < frame_bytes:
                    raise RuntimeError(
                        "MIPI frame is shorter than expected for "
                        f"{self.width}x{self.height} NV12 ({nv12.size} bytes)"
                    )

                nv12_image = nv12[:frame_bytes].reshape(
                    (self.height * 3 // 2, self.width)
                )
                bgr_image = cv2.cvtColor(nv12_image, cv2.COLOR_YUV2BGR_NV12)
                encoded, jpeg = cv2.imencode(".jpg", bgr_image, encode_options)
                if not encoded:
                    raise RuntimeError("OpenCV could not encode the MIPI frame")

                with self.condition:
                    self.latest_jpeg = jpeg.tobytes()
                    self.frame_id += 1
                    self.state = "ready"
                    self.error = ""
                    self.condition.notify_all()

                remaining = 1 / self.fps - (time.monotonic() - frame_started)
                if remaining > 0:
                    self.stop_event.wait(remaining)
        except Exception as exc:  # The board SDK is available only on RDK X5.
            self._set_error(
                f"{type(exc).__name__}: {exc}. Run this service on RDK X5 with "
                "an RDK-supported MIPI camera connected."
            )
        finally:
            if self.camera is not None:
                try:
                    self.camera.close_cam()
                except Exception:
                    pass
            if self.stop_event.is_set():
                with self.condition:
                    self.state = "stopped"
                    self.latest_jpeg = None
                    self.condition.notify_all()


def create_handler(feed: MipiCameraFeed, web_root: Path):
    class BridgeHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(web_root), **kwargs)

        def do_GET(self) -> None:
            route = urlsplit(self.path).path
            if route == "/api/mipi/status":
                self._send_json(feed.snapshot())
                return
            if route == "/api/mipi/stream.mjpg":
                self._send_stream()
                return

            super().do_GET()

        def do_POST(self) -> None:
            route = urlsplit(self.path).path
            if route == "/api/mipi/start":
                feed.start_capture()
                status = feed.wait_until_ready()
                if status["state"] == "starting":
                    feed.stop_capture()
                    status = {
                        **feed.snapshot(),
                        "state": "error",
                        "error": "Timed out waiting for the first MIPI frame",
                    }
                code = 200 if status["state"] == "ready" else 503
                self._send_json(status, status=code)
                return
            if route == "/api/mipi/stop":
                feed.stop_capture()
                self._send_json(feed.snapshot())
                return

            self._send_json({"error": "Not found"}, status=404)

        def _send_json(self, payload: dict[str, object], status: int = 200) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_stream(self) -> None:
            deadline = time.monotonic() + 8
            with feed.condition:
                while feed.latest_jpeg is None and feed.state != "error":
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        self._send_json(
                            {"error": "Timed out waiting for the first MIPI frame"},
                            status=503,
                        )
                        return
                    feed.condition.wait(timeout=remaining)

                if feed.state == "error" or feed.latest_jpeg is None:
                    self._send_json(
                        {"error": feed.error or "MIPI camera is unavailable"},
                        status=503,
                    )
                    return

            self.send_response(200)
            self.send_header(
                "Content-Type", "multipart/x-mixed-replace; boundary=frame"
            )
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()

            last_frame_id = -1
            try:
                while not feed.stop_event.is_set():
                    with feed.condition:
                        feed.condition.wait_for(
                            lambda: feed.frame_id != last_frame_id
                            or feed.state == "error"
                            or feed.stop_event.is_set(),
                            timeout=2,
                        )
                        if feed.state == "error" or feed.stop_event.is_set():
                            break
                        jpeg = feed.latest_jpeg
                        current_frame_id = feed.frame_id

                    if jpeg is None or current_frame_id == last_frame_id:
                        continue

                    self.wfile.write(
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        + f"Content-Length: {len(jpeg)}\r\n\r\n".encode("ascii")
                        + jpeg
                        + b"\r\n"
                    )
                    self.wfile.flush()
                    last_frame_id = current_frame_id
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

        def log_message(self, format: str, *args) -> None:
            print(f"[{self.log_date_time_string()}] {format % args}")

    return BridgeHandler


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Stream an RDK X5 MIPI camera to the local web app."
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=int, default=20)
    parser.add_argument("--jpeg-quality", type=int, default=80)
    parser.add_argument("--web-root", type=Path, default=DEFAULT_WEB_ROOT)
    args = parser.parse_args()

    if args.width <= 0 or args.width % 2 or args.height <= 0 or args.height % 2:
        parser.error("--width and --height must be positive even numbers")
    if args.fps <= 0:
        parser.error("--fps must be greater than zero")
    if not 1 <= args.jpeg_quality <= 100:
        parser.error("--jpeg-quality must be between 1 and 100")

    feed = MipiCameraFeed(args.width, args.height, args.fps, args.jpeg_quality)

    server = ThreadingHTTPServer(
        (args.host, args.port), create_handler(feed, args.web_root)
    )
    server.daemon_threads = True
    print(f"RDK MIPI bridge listening on http://{args.host}:{args.port}")
    if args.web_root.is_dir():
        print(f"Serving web app from {args.web_root}")
    else:
        print(
            f"No built web app found at {args.web_root}; "
            "use the Vite dev server and proxy /api/mipi to this port."
        )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping RDK MIPI bridge")
    finally:
        server.server_close()
        feed.stop_capture()


if __name__ == "__main__":
    main()
