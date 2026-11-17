"""Server tests: python -m unittest discover -s tests"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import server  # noqa: E402


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = tempfile.mkdtemp(prefix="gs-test-")
        os.environ["MESH_DRIFT_OUT"] = cls.out
        cls.srv = server.make_server(0)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        del os.environ["MESH_DRIFT_OUT"]
        shutil.rmtree(cls.out, ignore_errors=True)

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def get(self, path):
        with urllib.request.urlopen(self.url(path), timeout=10) as r:
            return r.status, r.headers, r.read()

    def post(self, path, data=b""):
        req = urllib.request.Request(self.url(path), data=data, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_ping(self):
        status, _, body = self.get("/api/ping")
        j = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(j["app"], "mesh-drift")
        self.assertEqual(j["outDir"], self.out)

    def test_static_files(self):
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Mesh Drift", body)
        _, headers, _ = self.get("/js/main.js")
        self.assertIn("javascript", headers["Content-Type"])
        _, headers, _ = self.get("/app.css")
        self.assertIn("text/css", headers["Content-Type"])

    def test_static_cannot_escape_the_app_folder(self):
        for bad in ("/../server.py", "/%2e%2e/server.py", "/js/../../server.py", "/nope.js"):
            with self.assertRaises(urllib.error.HTTPError) as cm:
                self.get(bad)
            self.assertEqual(cm.exception.code, 404, bad)

    def test_save_never_overwrites(self):
        paths = []
        for k in range(3):
            status, j = self.post("/api/save?name=Duotone%20Haze%20900x1440&ext=png", b"PNG-%d" % k)
            self.assertEqual(status, 200, j)
            paths.append(j["path"])
        self.assertEqual([os.path.basename(p) for p in paths],
                         ["Duotone Haze 900x1440.png", "Duotone Haze 900x1440 (2).png", "Duotone Haze 900x1440 (3).png"])
        for k, p in enumerate(paths):
            with open(p, "rb") as fh:
                self.assertEqual(fh.read(), b"PNG-%d" % k)

    def test_save_names_are_made_safe(self):
        status, j = self.post("/api/save?name=..%5C..%5Cevil%3A%2A%3Fname&ext=jpeg", b"x")
        self.assertEqual(status, 200, j)
        self.assertEqual(os.path.dirname(j["path"]), self.out)
        self.assertEqual(os.path.basename(j["path"]), "evilname.jpg")
        status, j = self.post("/api/save?name=CON&ext=webp", b"x")
        self.assertEqual(os.path.basename(j["path"]), "_CON.webp")
        status, j = self.post("/api/save?name=&ext=webm", b"x")
        self.assertEqual(os.path.basename(j["path"]), "gradient.webm")

    def test_save_rejects_bad_requests(self):
        self.assertEqual(self.post("/api/save?name=a&ext=exe", b"x")[0], 400)
        self.assertEqual(self.post("/api/save?name=a&ext=png", b"")[0], 400)
        self.assertEqual(self.post("/api/nothing", b"x")[0], 404)

    def test_reveal_only_opens_exports(self):
        status, j = self.post("/api/reveal", json.dumps({"path": r"C:\Windows\notepad.exe"}).encode())
        self.assertEqual(status, 400)

    def test_heartbeat(self):
        self.assertEqual(self.post("/api/heartbeat", b"{}")[0], 200)

    @unittest.skipUnless(server.find_ffmpeg(), "ffmpeg not installed")
    def test_mp4_transcode(self):
        ff = server.find_ffmpeg()
        tmp = os.path.join(self.out, "src.webm")
        subprocess.run([ff, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1",
                        "-c:v", "libvpx-vp9", "-b:v", "1M", tmp], check=True)
        with open(tmp, "rb") as fh:
            status, j = self.post("/api/save?name=clip&ext=mp4", fh.read())
        self.assertEqual(status, 200, j)
        self.assertTrue(j["path"].endswith("clip.mp4"))
        probe = subprocess.run([ff.replace("ffmpeg.exe", "ffprobe.exe") if ff.endswith("ffmpeg.exe") else "ffprobe",
                                "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                                "stream=codec_name,pix_fmt,nb_read_frames,width,height", "-of", "json", j["path"]],
                               capture_output=True, text=True, check=True)
        st = json.loads(probe.stdout)["streams"][0]
        self.assertEqual(st["codec_name"], "h264")
        self.assertEqual(st["pix_fmt"], "yuv420p")
        self.assertEqual(int(st["nb_read_frames"]), 30)
        self.assertEqual((st["width"], st["height"]), (320, 240))

    def test_mp4_of_junk_reports_an_error_and_leaves_no_file(self):
        if not server.find_ffmpeg():
            self.skipTest("ffmpeg not installed")
        status, j = self.post("/api/save?name=junk&ext=mp4", b"not a video")
        self.assertEqual(status, 500)
        self.assertIn("error", j)
        self.assertFalse(os.path.exists(os.path.join(self.out, "junk.mp4")))

    def test_safe_stem_and_unique_path_units(self):
        self.assertEqual(server.safe_stem("a/b\\c"), "c")
        self.assertEqual(server.safe_stem("  ..  "), "gradient")
        self.assertEqual(server.safe_stem("x" * 300), "x" * 120)
        self.assertEqual(server.safe_stem("lpt1"), "_lpt1")


if __name__ == "__main__":
    unittest.main()
