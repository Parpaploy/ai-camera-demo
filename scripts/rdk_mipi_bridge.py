#!/usr/bin/env python3
"""Serve an RDK X5 MIPI camera as an MJPEG stream for the web app."""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WEB_ROOT = PROJECT_ROOT / "dist" / "public"


def capture_worker(config, stop, buffer, metadata, lock):
    """Only this process touches the SDK; a blocked native call can be terminated."""
    width, height, fps, quality, video_index = config
    camera = None
    try:
        import cv2
        import numpy as np
        from hobot_vio import libsrcampy

        camera = libsrcampy.Camera()
        result = camera.open_cam(0, video_index, fps, width, height)
        if result not in (None, 0):
            raise RuntimeError(f"Camera.open_cam returned {result}")
        frame_bytes = width * height * 3 // 2
        while not stop.is_set():
            started = time.monotonic()
            try:
                raw = camera.get_img(2, width, height)
            except TypeError:
                raw = camera.get_img(2)
            if raw is None:
                stop.wait(0.01)
                continue
            nv12 = (np.asarray(raw, dtype=np.uint8).reshape(-1)
                    if isinstance(raw, np.ndarray) else np.frombuffer(raw, dtype=np.uint8))
            if nv12.size < frame_bytes:
                raise RuntimeError("MIPI frame is shorter than the configured NV12 resolution")
            bgr = cv2.cvtColor(nv12[:frame_bytes].reshape(height * 3 // 2, width),
                              cv2.COLOR_YUV2BGR_NV12)
            ok, jpeg = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
            if not ok:
                raise RuntimeError("JPEG encoding failed")
            data = jpeg.tobytes()
            if len(data) > len(buffer):
                raise RuntimeError("JPEG exceeds the shared frame buffer")
            with lock:
                memoryview(buffer).cast("B")[:len(data)] = data
                metadata[0] = len(data)
                metadata[1] += 1
            stop.wait(max(0, 1 / fps - (time.monotonic() - started)))
    except Exception as exc:
        data = f"{type(exc).__name__}: {exc}".encode()[:len(buffer)]
        with lock:
            memoryview(buffer).cast("B")[:len(data)] = data
            metadata[0] = len(data)
            metadata[1] = -1
    finally:
        if camera is not None:
            camera.close_cam()


class MipiCameraFeed:
    def __init__(self, width, height, fps, jpeg_quality, video_index,
                 frame_timeout=10.0, worker_target=capture_worker):
        self.width, self.height, self.fps = width, height, fps
        self.jpeg_quality, self.video_index = jpeg_quality, video_index
        self.frame_timeout = frame_timeout
        self.worker_target = worker_target
        self.condition = threading.Condition()
        self.lifecycle_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.latest_jpeg = None
        self.frame_id = 0
        self.state = "stopped"
        self.error = ""
        self.thread = None
        self.last_frame_at = None
        self.restart_count = 0
        self.context = mp.get_context("spawn")
        self.blocked = False

    def start_capture(self):
        with self.lifecycle_lock:
            if self.blocked:
                return
            if self.thread is not None and self.thread.is_alive():
                return
            with self.condition:
                self.stop_event = threading.Event()
                self.latest_jpeg = None
                self.last_frame_at = None
                self.restart_count = 0
                self.error = ""
                self.state = "starting"
                self.thread = threading.Thread(target=self._capture, daemon=True)
                self.thread.start()

    def wait_until_ready(self, timeout=12):
        with self.condition:
            self.condition.wait_for(lambda: self.state != "starting", timeout)
            return self.snapshot()

    def stop_capture(self):
        with self.lifecycle_lock:
            with self.condition:
                self.stop_event.set()
                self.state = "stopping"
                self.latest_jpeg = None
                self.condition.notify_all()
            if self.thread is not None:
                self.thread.join(timeout=6)
            with self.condition:
                if self.blocked or (self.thread is not None and self.thread.is_alive()):
                    self.state = "error"
                    self.error = "Camera worker did not exit; restart the bridge/board"
                else:
                    self.state = "stopped"
                    self.error = ""
                self.condition.notify_all()

    def snapshot(self):
        with self.condition:
            return dict(state=self.state, error=self.error, width=self.width,
                        height=self.height, fps=self.fps, frameId=self.frame_id,
                        restartCount=self.restart_count,
                        frameAgeSeconds=(None if self.last_frame_at is None else
                                         round(time.monotonic() - self.last_frame_at, 2)))

    def _capture(self):
        # Bounded shared latest-frame buffer: no backlog and no pipe read that can
        # hang if a native worker dies halfway through sending a JPEG.
        for attempt in range(4):
            if self.stop_event.is_set():
                return
            buffer = self.context.RawArray("B", self.width * self.height * 3 + 65536)
            metadata = self.context.RawArray("q", 2)
            lock = self.context.Lock()
            worker_stop = self.context.Event()
            process = self.context.Process(target=self.worker_target, args=(
                (self.width, self.height, self.fps, self.jpeg_quality, self.video_index),
                worker_stop, buffer, metadata, lock), daemon=True)
            reason = "Camera stopped producing frames"
            started = False
            try:
                process.start()
                started = True
                last_received = time.monotonic()
                sequence = 0
                while not self.stop_event.wait(0.02):
                    data = None
                    worker_error = False
                    if lock.acquire(timeout=0.1):
                        try:
                            size, current = metadata[:]
                            if current == -1 or current != sequence:
                                data = bytes(memoryview(buffer).cast("B")[:size])
                                sequence = current
                                worker_error = current == -1
                        finally:
                            lock.release()
                    if worker_error:
                        reason = data.decode(errors="replace")
                        break
                    if data:
                        last_received = time.monotonic()
                        with self.condition:
                            if self.stop_event.is_set():
                                break
                            self.latest_jpeg = data
                            self.last_frame_at = last_received
                            self.frame_id += 1
                            self.state, self.error = "ready", ""
                            self.condition.notify_all()
                    if not process.is_alive():
                        reason = f"Camera worker exited ({process.exitcode})"
                        break
                    if time.monotonic() - last_received > self.frame_timeout:
                        reason = "Timed out waiting for a fresh MIPI frame"
                        break
            except Exception as exc:
                reason = str(exc)
            finally:
                if started:
                    worker_stop.set()
                    process.join(timeout=1)
                    if process.is_alive():
                        process.terminate()
                        process.join(timeout=1)
                    if process.is_alive():
                        process.kill()
                        process.join(timeout=1)
                    if process.is_alive():
                        # Never open another owner while the previous one lives.
                        with self.condition:
                            self.blocked = True
                            self.state, self.error = "error", "Camera process cannot be killed; restart board"
                            self.condition.notify_all()
                        return
                    process.close()
            with self.condition:
                self.latest_jpeg = None
                if self.stop_event.is_set():
                    return
                self.restart_count = attempt + 1 if attempt < 3 else 3
                self.state = "starting" if attempt < 3 else "error"
                self.error = reason
                self.condition.notify_all()
            if attempt < 3:
                self.stop_event.wait(0.5)


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

            self.connection.settimeout(5)
            session_stop = feed.stop_event
            last_frame_id = -1
            try:
                while not session_stop.is_set():
                    with feed.condition:
                        feed.condition.wait_for(
                            lambda: feed.frame_id != last_frame_id
                            or feed.state == "error"
                            or session_stop.is_set(),
                            timeout=2,
                        )
                        if feed.state == "error" or session_stop.is_set():
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
    parser.add_argument("--frame-timeout", type=float, default=10)
    parser.add_argument("--jpeg-quality", type=int, default=80)
    parser.add_argument(
        "--video-index",
        type=int,
        choices=(-1, 0, 1, 2),
        default=-1,
        help="MIPI host index from /etc/board_config.json; -1 auto-detects",
    )
    parser.add_argument("--web-root", type=Path, default=DEFAULT_WEB_ROOT)
    args = parser.parse_args()

    if args.width <= 0 or args.width % 2 or args.height <= 0 or args.height % 2:
        parser.error("--width and --height must be positive even numbers")
    if args.frame_timeout <= 0:
        parser.error("--frame-timeout must be greater than zero")
    if args.fps <= 0:
        parser.error("--fps must be greater than zero")
    if not 1 <= args.jpeg_quality <= 100:
        parser.error("--jpeg-quality must be between 1 and 100")

    feed = MipiCameraFeed(
        args.width,
        args.height,
        args.fps,
        args.jpeg_quality,
        args.video_index,
        frame_timeout=args.frame_timeout,
    )

    server = ThreadingHTTPServer(
        (args.host, args.port), create_handler(feed, args.web_root)
    )
    server.daemon_threads = True
    print(
        f"RDK MIPI bridge listening on http://{args.host}:{args.port} "
        f"(video index: {args.video_index})"
    )
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
