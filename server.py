"""Mesh Drift - local server (Python standard library only).

Serves the app in static/ and saves what the window exports. Every gradient is rendered in the browser (WebGL2),
so the server only writes files: images and WebM videos as they arrive, and MP4 by transcoding the WebM with
ffmpeg. Nothing leaves this computer.
"""
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

APP_DIR = os.path.dirname(os.path.abspath(__file__))
APP_ID = "mesh-drift"
APP_NAME = "Mesh Drift"
PORT = int(os.environ.get("MESH_DRIFT_PORT") or 47885)
STATIC = os.path.join(APP_DIR, "static")
DATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA", APP_DIR), "MeshDrift")
EXTS = {"png", "jpg", "webp", "webm", "mp4"}
MAX_UPLOAD = 4 * 1024 ** 3  # 4 GB: a 10 s 4K 60 fps loop is far below this
# Seconds without a heartbeat before an auto-exit server quits. Chrome slows timers in a minimised window to about
# one a minute, so this must stay well above 60 s.
IDLE_EXIT = 150

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")


def output_dir():
    """Videos\\<app name> in your user folder, unless MESH_DRIFT_OUT says otherwise."""
    env = os.environ.get("MESH_DRIFT_OUT")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), "Videos", APP_NAME)


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    root = os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Microsoft\WinGet\Packages")
    if os.path.isdir(root):
        for dirpath, _dirs, files in os.walk(root):
            if "ffmpeg.exe" in files:
                return os.path.join(dirpath, "ffmpeg.exe")
    return None


def safe_stem(name):
    """A file name stem that is safe on Windows: no path parts, no reserved characters, never empty."""
    name = os.path.basename(str(name or "").replace("\\", "/"))
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip(" .")
    name = re.sub(r"\s+", " ", name)[:120].strip(" .")
    if name.upper() in {"CON", "PRN", "AUX", "NUL"} or re.fullmatch(r"(?i)(COM|LPT)\d", name or ""):
        name = "_" + name
    return name or "gradient"


def unique_path(folder, stem, ext):
    """folder/stem.ext, or 'stem (2).ext', 'stem (3).ext'... so existing files are never overwritten."""
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{stem}.{ext}")
    n = 2
    while os.path.exists(path):
        path = os.path.join(folder, f"{stem} ({n}).{ext}")
        n += 1
    return path


def reserve(folder, stem, ext):
    """Like unique_path, but creates the file at once so two saves at the same moment never pick the same name."""
    while True:
        path = unique_path(folder, stem, ext)
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            return path
        except FileExistsError:
            continue


def transcode_mp4(ffmpeg, src, dst):
    """WebM (VP9/VP8) -> H.264 MP4 that every editor and Instagram accept."""
    cmd = [ffmpeg, "-v", "error", "-y", "-i", src, "-c:v", "libx264", "-preset", "slow", "-crf", "14",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", dst]
    r = subprocess.run(cmd, capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "ffmpeg failed").strip()[-600:])


class State:
    last_beat = time.time()
    beaten = False
    busy = 0
    lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "MeshDrift/1.0"

    def log_message(self, fmt, *args):  # keep the console and log quiet
        pass

    # ---- helpers -------------------------------------------------------------------------------------------
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit=MAX_UPLOAD):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > limit:
            raise ValueError("empty or too large")
        chunks, left = [], n
        while left > 0:
            c = self.rfile.read(min(left, 1 << 20))
            if not c:
                raise ValueError("connection closed during upload")
            chunks.append(c)
            left -= len(c)
        return b"".join(chunks)

    # ---- routes --------------------------------------------------------------------------------------------
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/ping":
            return self.send_json({"app": APP_ID, "ffmpeg": bool(self.server.ffmpeg), "outDir": output_dir()})
        rel = unquote(url.path).lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
            return self.send_error(HTTPStatus.NOT_FOUND)
        with open(full, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(full)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        url = urlparse(self.path)
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/api/heartbeat":
                State.last_beat, State.beaten = time.time(), True
                return self.send_json({"ok": True})
            if url.path == "/api/save":
                return self.save(q)
            if url.path == "/api/reveal":
                data = json.loads(self.read_body(1 << 16) or b"{}")
                path = os.path.normpath(str(data.get("path", "")))
                out = os.path.normpath(output_dir())
                if not path.startswith(out + os.sep) or not os.path.exists(path):
                    return self.send_json({"error": "not an export of this app"}, 400)
                subprocess.Popen(["explorer", "/select,", path])
                return self.send_json({"ok": True})
            return self.send_json({"error": "not found"}, 404)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001 - report every failure to the window
            return self.send_json({"error": str(e)}, 500)

    def save(self, q):
        ext = (q.get("ext") or "").lower().lstrip(".")
        if ext == "jpeg":
            ext = "jpg"
        if ext not in EXTS:
            raise ValueError(f"unsupported file type: {ext}")
        stem = safe_stem(q.get("name"))
        folder = q.get("folder") and os.path.join(output_dir(), safe_stem(q.get("folder"))) or output_dir()
        with State.lock:
            State.busy += 1
        try:
            data = self.read_body()
            if ext == "mp4":  # the window sends the WebM it encoded; ffmpeg turns it into H.264
                if not self.server.ffmpeg:
                    raise ValueError("MP4 needs ffmpeg, which was not found")
                fd, tmp = tempfile.mkstemp(suffix=".webm", dir=DATA_DIR)
                with os.fdopen(fd, "wb") as fh:
                    fh.write(data)
                path = reserve(folder, stem, ext)
                try:
                    transcode_mp4(self.server.ffmpeg, tmp, path)
                except Exception:
                    os.remove(path)
                    raise
                finally:
                    os.remove(tmp)
            else:
                path = reserve(folder, stem, ext)
                with open(path, "wb") as fh:
                    fh.write(data)
            return self.send_json({"path": path, "bytes": os.path.getsize(path)})
        finally:
            with State.lock:
                State.busy -= 1


def make_server(port=PORT):
    os.makedirs(DATA_DIR, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    srv.ffmpeg = find_ffmpeg()
    return srv


def serve(auto_exit=False, port=PORT):
    srv = make_server(port)
    if auto_exit:  # started by the Desktop launcher: quit a little after the window closes
        def watchdog():
            while True:
                time.sleep(2)
                idle = time.time() - State.last_beat
                if State.beaten and idle > IDLE_EXIT and State.busy == 0:
                    srv.shutdown()
                    return
                if not State.beaten and idle > 120:  # the window never opened
                    srv.shutdown()
                    return
        threading.Thread(target=watchdog, daemon=True).start()
    print(f"{APP_NAME} on http://127.0.0.1:{port}/  ->  saving to {output_dir()}")
    srv.serve_forever()


if __name__ == "__main__":
    if sys.stdout is None or sys.stderr is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        sys.stdout = sys.stderr = open(os.path.join(DATA_DIR, "app.log"), "a", buffering=1, encoding="utf-8")
    serve(auto_exit="--auto-exit" in sys.argv)
