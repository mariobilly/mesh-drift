"""End-to-end test: drives the real app in Chrome and writes a review folder.

    python tests/test_e2e.py                      -> Desktop\\Mesh Drift - Test Review
    python tests/test_e2e.py --review <folder>    -> any folder

Every feature from the reel is exercised through the real window: New Gradient, dragging and adding points,
colours, locks, the four tabs, canvas formats, templates, Recent / Previous, undo / redo, and every export type.
Exported files are checked (size, codec, frame count, seamless loop) and copied into the review folder next to
screenshots and an HTML report. The run also includes the unit tests (node + python).
"""
import argparse
import html
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
sys.path.insert(0, APP)

DESKTOP = os.path.join(os.path.expanduser("~"), "Desktop")
DEFAULT_REVIEW = os.path.join(DESKTOP, "Mesh Drift - Test Review")
DIRS = {"shots": "01 Screenshots", "stills": "02 Still exports", "loops": "03 Motion loops",
        "templates": "04 Template pack", "random": "05 Random gradients"}


# ---- results ------------------------------------------------------------------------------------------------
class Results:
    def __init__(self):
        self.items = []
        self.section = "General"

    def check(self, name, ok, detail="", files=()):
        self.items.append({"section": self.section, "name": name, "ok": bool(ok), "detail": str(detail), "files": list(files)})
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {name}" + (f"  ({detail})" if detail else ""), flush=True)
        return ok

    def media(self, kind, path, caption):
        self.items.append({"section": self.section, "media": kind, "path": path, "caption": caption})

    @property
    def passed(self):
        return sum(1 for i in self.items if "ok" in i and i["ok"])

    @property
    def failed(self):
        return sum(1 for i in self.items if "ok" in i and not i["ok"])


R = Results()


def section(name):
    R.section = name
    print(f"\n== {name}", flush=True)


# ---- tools --------------------------------------------------------------------------------------------------
def ffmpeg_bin(name):
    import server
    ff = server.find_ffmpeg()
    if not ff:
        return None
    return ff if name == "ffmpeg" else os.path.join(os.path.dirname(ff), name + ".exe")


def probe(path):
    out = subprocess.run([ffmpeg_bin("ffprobe"), "-v", "error", "-select_streams", "v:0", "-count_frames",
                          "-show_entries", "stream=codec_name,width,height,nb_read_frames,pix_fmt,avg_frame_rate:format=duration",
                          "-of", "json", path], capture_output=True, text=True)
    j = json.loads(out.stdout or "{}")
    st = (j.get("streams") or [{}])[0]
    st["duration"] = float((j.get("format") or {}).get("duration") or 0)
    return st


def frames_small(path, width=96):
    """Every frame of a video, scaled down (area filter averages the grain out), as float arrays."""
    st = probe(path)
    w, h = st["width"], st["height"]
    sh = int(round(h * width / w / 2) * 2)
    raw = subprocess.run([ffmpeg_bin("ffmpeg"), "-v", "error", "-i", path, "-vf", f"scale={width}:{sh}:flags=area",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    arr = np.frombuffer(raw, np.uint8).astype(np.float32)
    return arr.reshape(-1, sh, width, 3)


def loop_metrics(path):
    f = frames_small(path)
    d = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2, 3))
    wrap = float(np.abs(f[0] - f[-1]).mean())
    half = float(np.abs(f[0] - f[len(f) // 2]).mean())
    return {"frames": len(f), "median_step": float(np.median(d)), "max_step": float(d.max()), "wrap_step": wrap, "half_loop_change": half}


def contact_sheet(paths, out, cols=4, cell=260):
    ims = [Image.open(p).convert("RGB") for p in paths]
    hcell = int(cell * ims[0].height / ims[0].width)
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (cell + 12) + 12, rows * (hcell + 12) + 12), (12, 12, 12))
    for k, im in enumerate(ims):
        t = im.resize((cell, hcell), Image.LANCZOS)
        sheet.paste(t, (12 + (k % cols) * (cell + 12), 12 + (k // cols) * (hcell + 12)))
    sheet.save(out, quality=92)


# ---- the run -------------------------------------------------------------------------------------------------
def run(review):
    from playwright.sync_api import sync_playwright

    if os.path.isdir(review):
        if not os.path.exists(os.path.join(review, "results.json")) and os.listdir(review):
            raise SystemExit(f"{review} exists and was not made by this test; pick another --review folder.")
        shutil.rmtree(review)
    for d in DIRS.values():
        os.makedirs(os.path.join(review, d), exist_ok=True)
    rel = lambda p: os.path.relpath(p, review).replace("\\", "/")  # noqa: E731

    out_dir = tempfile.mkdtemp(prefix="gs-e2e-")
    os.environ["MESH_DRIFT_OUT"] = out_dir
    import server
    srv = server.make_server(0)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}/"

    shot_n = [0]

    def shot(pg, name, caption, full=False, clip=None):
        shot_n[0] += 1
        path = os.path.join(review, DIRS["shots"], f"{shot_n[0]:02d} {name}.png")
        pg.screenshot(path=path, full_page=full, clip=clip)
        R.media("image", rel(path), caption)
        return path

    def keep(src, kind, name, caption, media="image"):
        dst = os.path.join(review, DIRS[kind], name)
        shutil.copy2(src, dst)
        R.media(media, rel(dst), caption)
        return dst

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        ctx = browser.new_context(viewport={"width": 1500, "height": 940}, device_scale_factor=1)
        pg = ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        ev = pg.evaluate

        def ready():
            pg.wait_for_function("window.gradientStudio && window.gradientStudio.ready", timeout=20000)
            pg.wait_for_timeout(400)

        def blur():
            ev("() => document.activeElement && document.activeElement.blur()")

        def stats(spots=()):
            return ev("(s) => gradientStudio.stats(s)", [list(x) for x in spots])

        grid = [(x / 6, y / 6) for x in range(1, 6) for y in range(1, 6)]

        def spot_diff(a, b):
            return float(np.abs(np.array(a["at"], float) - np.array(b["at"], float)).mean())

        def pause():
            if ev("gradientStudio.state.playing"):
                ev("gradientStudio.togglePlay(false)")

        def ui_export(set_options, shot_name=None, shot_caption=None, progress_at=None):
            """Opens the export dialog, applies options by clicking, exports, returns the server's reply."""
            blur()
            pg.click("#btnExport")
            pg.wait_for_selector("#exportModal:not([hidden])")
            set_options()
            if shot_name and progress_at is None:
                shot(pg, shot_name, shot_caption)
            ev("""() => { window.__exp = new Promise((res, rej) => {
                addEventListener('gs-exported', (e) => res(e.detail), { once: true });
                addEventListener('gs-export-failed', (e) => rej(new Error(e.detail)), { once: true }); }); }""")
            pg.click("#exGo")
            if progress_at is not None:
                pg.wait_for_function(f"!document.querySelector('#exProg').hidden && document.querySelector('#exStatus').textContent.startsWith('Rendering') "
                                     f"&& parseFloat(document.querySelector('#exBar').style.width) >= {progress_at}", timeout=120000, polling=50)
                shot(pg, shot_name, shot_caption)
            res = ev("() => window.__exp")
            pg.wait_for_selector("#exportModal", state="hidden")
            return res

        def module_export(doc, ext, w, h, name, fps=30, seconds=5):
            return ev("""async ([doc, ext, w, h, name, fps, seconds]) => {
                const ex = await import('/js/exporter.js');
                let blob;
                if (ext === 'webm') blob = (await ex.exportVideo(doc, { w, h, fps, seconds })).blob;
                else blob = await ex.exportImage(doc, { ext, w, h, t: 0 });
                const r = await fetch('/api/save?name=' + encodeURIComponent(name) + '&ext=' + ext, { method: 'POST', body: blob });
                return await r.json(); }""", [doc, ext, w, h, name, fps, seconds])

        def template_doc(name, fmt):
            return ev("""async ([name, fmt]) => {
                const G = await import('/js/generate.js');
                const t = G.TEMPLATES.find((x) => x.name === name);
                return G.applyTemplate(t, { name: 'Untitled gradient', format: fmt, points: [], motion: { mode: 'drift' } }, 4242); }""", [name, fmt])

        def check_video(path, w, h, frames, codec, label, still=False):
            st = probe(path)
            R.check(f"{label}: codec {codec}, {w}×{h}, {frames} frames",
                    st.get("codec_name") == codec and st.get("width") == w and st.get("height") == h and int(st.get("nb_read_frames", 0)) == frames,
                    f"{st.get('codec_name')} {st.get('width')}×{st.get('height')}, {st.get('nb_read_frames')} frames, {st.get('duration'):.2f} s")
            m = loop_metrics(path)
            seamless = m["wrap_step"] <= max(0.9, 3.0 * m["median_step"] + 0.25)
            R.check(f"{label}: loops seamlessly (last frame flows into the first)", seamless,
                    f"jump at the loop point {m['wrap_step']:.2f} vs a normal frame step {m['median_step']:.2f}")
            if still:
                R.check(f"{label}: Still mode does not move", m["half_loop_change"] < 1.0, f"change across half the loop {m['half_loop_change']:.2f}")
            else:
                R.check(f"{label}: the gradient moves", m["half_loop_change"] > 2.0, f"change across half the loop {m['half_loop_change']:.2f}")
            return m

        # ======================================================================================================
        section("Opening the app")
        t0 = time.time()
        pg.goto(base + "?seed=8A3F21C0")
        ready()
        s = stats()
        R.check("Window opens with a rendered gradient (not blank)", max(s["sd"]) > 6, f"preview {s['w']}×{s['h']}, colour spread {max(s['sd']):.1f}")
        R.check("Opening a fresh visit shows an export-ready gradient at once", ev("gradientStudio.doc.points.length") >= 4,
                f"{ev('gradientStudio.doc.points.length')} points, palette '{ev('gradientStudio.doc.paletteName')}'")
        shot(pg, "App on open", "A fresh visit: a new seed, palette, point layout and gentle motion straight away.")
        boxes = ev("""() => [document.querySelector('.canvas-panel').getBoundingClientRect(), document.querySelector('.side').getBoundingClientRect()]
                      .map((r) => ({ top: r.top, h: r.height, w: r.width }))""")
        R.check("Workspace: canvas panel and settings panel have exactly the same height", abs(boxes[0]["h"] - boxes[1]["h"]) < 1 and abs(boxes[0]["top"] - boxes[1]["top"]) < 1,
                f"{boxes[0]['h']:.0f}px and {boxes[1]['h']:.0f}px; settings panel {boxes[1]['w']:.0f}px wide")
        layout = "JSON.stringify([gradientStudio.doc.paletteName, gradientStudio.doc.points.map(p => [p.x, p.y, p.color])])"
        seed_a, pts_a = ev("gradientStudio.doc.seed"), ev(layout)
        pg.goto(base + "?seed=8A3F21C0")
        ready()
        R.check("The same seed always gives the same gradient", ev("gradientStudio.doc.seed") == seed_a and ev(layout) == pts_a)

        # ======================================================================================================
        section("New Gradient")
        pause()
        before = stats(grid)
        seed0 = ev("gradientStudio.doc.seed")
        pg.click("#btnNew")
        pg.wait_for_timeout(200)
        after = stats(grid)
        R.check("New Gradient gives a new seed and a different picture", ev("gradientStudio.doc.seed") != seed0 and spot_diff(before, after) > 8,
                f"seed {seed0:08X} → {ev('gradientStudio.doc.seed'):08X}, average colour change {spot_diff(before, after):.1f}")
        R.check("The replaced gradient goes to Recent and Previous becomes available",
                ev("gradientStudio.recent.items[0].doc.seed") == seed0 and not pg.is_disabled("#btnPrev"))
        names = set()
        for _ in range(12):
            pg.keyboard.press("n")
            names.add(ev("gradientStudio.doc.paletteName"))
        R.check("Pressing N twelve times gives twelve different palettes", len(names) >= 10, ", ".join(sorted(names)))
        shot(pg, "New gradient", "After pressing New Gradient a few times.")

        # ======================================================================================================
        section("Colour points: drag, add, recolour, lock, delete")
        pg.goto(base + "?template=Duotone%20Haze&seed=1234ABCD")
        ready()
        pause()
        ev("gradientStudio.setPhase(0)")
        orig = ev("({...gradientStudio.doc.points[2]})")
        h2 = pg.locator(".handle").nth(2).bounding_box()
        fr = pg.locator("#frame").bounding_box()
        tx, ty = fr["x"] + 0.62 * fr["width"], fr["y"] + 0.30 * fr["height"]
        pg.mouse.move(h2["x"] + h2["width"] / 2, h2["y"] + h2["height"] / 2)
        pg.mouse.down()
        for k in range(1, 11):
            pg.mouse.move(h2["x"] + h2["width"] / 2 + (tx - h2["x"] - h2["width"] / 2) * k / 10,
                          h2["y"] + h2["height"] / 2 + (ty - h2["y"] - h2["height"] / 2) * k / 10)
        pg.mouse.up()
        moved = ev("({...gradientStudio.doc.points[2]})")
        R.check("Dragging a point moves its colour to where you drop it", abs(moved["x"] - 0.62) < 0.02 and abs(moved["y"] - 0.30) < 0.02,
                f"({orig['x']:.2f}, {orig['y']:.2f}) → ({moved['x']:.2f}, {moved['y']:.2f}), target (0.62, 0.30)")
        shot(pg, "Dragging a point", "Point 03 (the orange) dragged up and to the right; it stays selected (orange ring).")
        blur()
        pg.keyboard.press("Control+z")
        und = ev("({...gradientStudio.doc.points[2]})")
        R.check("Undo puts the point back exactly", und["x"] == orig["x"] and und["y"] == orig["y"])
        pg.keyboard.press("Control+Shift+z")
        red = ev("({...gradientStudio.doc.points[2]})")
        R.check("Redo moves it again", red["x"] == moved["x"] and red["y"] == moved["y"])

        free = ev("""async () => { const M = await import('/js/motion.js'); const d = gradientStudio.doc, h = M.halfExtents(d.format.w, d.format.h);
            const hs = d.points.map((_, i) => M.handleUv(d, i, gradientStudio.state.t, h)); let best = null, bd = -1;
            for (let x = 1; x < 10; x++) for (let y = 1; y < 10; y++) { const u = x / 10, v = y / 10;
              const dd = Math.min(...hs.map(([a, b]) => Math.hypot(a - u, b - v))); if (dd > bd) { bd = dd; best = [u, v]; } }
            return best; }""")
        n0 = ev("gradientStudio.doc.points.length")
        pg.mouse.dblclick(fr["x"] + free[0] * fr["width"], fr["y"] + free[1] * fr["height"])
        pg.wait_for_timeout(150)
        newp = ev("gradientStudio.doc.points[gradientStudio.doc.points.length - 1]")
        R.check("Double-clicking the canvas adds a colour point there", ev("gradientStudio.doc.points.length") == n0 + 1 and
                abs(newp["x"] - free[0]) < 0.02 and abs(newp["y"] - free[1]) < 0.02, f"{n0} → {n0 + 1} points, new {newp['color']} at ({newp['x']:.2f}, {newp['y']:.2f})")

        pg.locator(".pt-row").nth(1).click()
        R.check("Clicking a row in the list selects that point", ev("gradientStudio.state.selected") == 1)
        before = stats(grid)
        pg.fill("#selHex", "#00FF88")
        pg.press("#selHex", "Enter")
        pg.wait_for_timeout(100)
        R.check("Typing a hex colour recolours the selected point", ev("gradientStudio.doc.points[1].color") == "#00FF88"
                and spot_diff(before, stats(grid)) > 2)
        pg.click("#selSwatch")
        pg.wait_for_selector(".pk-sv")
        sv = pg.locator(".pk-sv").bounding_box()
        c_before = ev("gradientStudio.doc.points[1].color")
        pg.mouse.move(sv["x"] + sv["width"] * 0.3, sv["y"] + sv["height"] * 0.5)
        pg.mouse.down()
        pg.mouse.move(sv["x"] + sv["width"] * 0.9, sv["y"] + sv["height"] * 0.1, steps=6)
        pg.mouse.up()
        hue = pg.locator(".pk-hue").bounding_box()
        pg.mouse.click(hue["x"] + hue["width"] * 0.55, hue["y"] + hue["height"] / 2)
        c_after = ev("gradientStudio.doc.points[1].color")
        R.check("The colour picker (square + hue strip) recolours the point live", c_after != c_before, f"{c_before} → {c_after}")
        shot(pg, "Colour picker", "Colors tab: point list, the selected point, the picker, quick colours and Radius / Softness / Influence.")
        pg.click("#selSwatch")
        pg.locator("#quick button").nth(2).click()
        R.check("Quick colours set the selected point", ev("gradientStudio.doc.points[1].color") == "#6EC6F5")
        # point sliders
        rad0 = ev("gradientStudio.doc.points[1].radius")
        ev("""() => { const i = document.querySelector('input[data-key="point.radius"]'); i.value = 1.4;
                i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }""")
        R.check("Radius slider changes only the selected point", ev("gradientStudio.doc.points[1].radius") == 1.4 and
                ev("gradientStudio.doc.points[0].radius") != 1.4 or rad0 == 1.4)

        pg.locator(".pt-row .lk").nth(0).click()
        locked = ev("({...gradientStudio.doc.points[0]})")
        R.check("The lock button locks a point", locked["locked"])
        blur()
        keep_ok = True
        for key in ("n", "c", "v", "n"):
            pg.keyboard.press(key)
            p0 = ev(f"gradientStudio.doc.points.find(p => p.id === '{locked['id']}')")
            keep_ok &= bool(p0) and p0["color"] == locked["color"] and p0["x"] == locked["x"] and p0["y"] == locked["y"]
        R.check("A locked point keeps its colour and place through New Gradient, Randomize colors and Generate variation", keep_ok)
        shot(pg, "Locked point", "Point 01 is locked (lock badge on the handle, orange lock in the list) and survived New Gradient.")
        n1 = ev("gradientStudio.doc.points.length")
        ev("gradientStudio.select(gradientStudio.doc.points.length - 1)")
        blur()
        pg.keyboard.press("Delete")
        R.check("Delete removes the selected point", ev("gradientStudio.doc.points.length") == n1 - 1)
        ev("gradientStudio.setDoc({...gradientStudio.doc, points: gradientStudio.doc.points.slice(0, 2)})")
        blur()
        pg.keyboard.press("Delete")
        R.check("A gradient never drops below two points", ev("gradientStudio.doc.points.length") == 2)

        # ======================================================================================================
        section("Shape, Motion and Finish tabs")
        pg.goto(base + "?template=Midnight%20Arc&seed=0BADC0DE")
        ready()
        pause()
        pg.click('.tabs [data-tab="shape"]')
        pg.click("details.adv summary")
        sc0 = ev("gradientStudio.doc.shape.scale")
        pg.focus('input[data-key="shape.scale"]')
        for _ in range(8):
            pg.keyboard.press("ArrowRight")
        sc1 = ev("gradientStudio.doc.shape.scale")
        R.check("Shape › Scale slider works from the keyboard", abs(sc1 - sc0 - 0.08) < 1e-6, f"{sc0:.2f} → {sc1:.2f}")
        pg.locator(".sl-label", has_text="Scale").dblclick()
        R.check("Double-clicking a slider name resets it", ev("gradientStudio.doc.shape.scale") == 1)
        shot(pg, "Shape tab", "Shape: Scale, Blend, Stretch X/Y, Rotation, the Advanced shape (Warp, Warp detail, Swirl) and Generate variation.")
        cols0 = ev("gradientStudio.doc.points.map(p => p.color).join()")
        xy0 = ev("gradientStudio.doc.points.map(p => p.x + ',' + p.y).join()")
        pg.click("#btnVariation")
        R.check("Generate variation keeps the colours and changes the arrangement",
                ev("gradientStudio.doc.points.map(p => p.color).join()") == cols0 and ev("gradientStudio.doc.points.map(p => p.x + ',' + p.y).join()") != xy0)

        pg.click('.tabs [data-tab="motion"]')
        shot(pg, "Motion tab", "Motion: six modes (Still, Drift, Orbit, Breathe, Flow, Tide), timing sliders and Randomize motion.")
        for mode in ("still", "drift", "orbit", "breathe", "flow", "tide"):
            pg.click(f'.mode[data-mode="{mode}"]')
            pause()
            ev("gradientStudio.setPhase(0)")
            a = stats(grid)
            ev("gradientStudio.setPhase(0.5)")
            b = stats(grid)
            ev("gradientStudio.setPhase(1.0)")
            c = stats(grid)
            diff, wrap = spot_diff(a, b), spot_diff(a, c)
            if mode == "still":
                R.check("Motion › Still: the picture does not change over the loop", diff < 0.5, f"change {diff:.2f}")
            else:
                R.check(f"Motion › {mode.title()}: the picture moves and returns to the start after one loop", diff > 2 and wrap < 0.5,
                        f"half-loop change {diff:.1f}, end-of-loop change {wrap:.2f}")
        m0 = ev("JSON.stringify(gradientStudio.doc.motion)")
        pg.click("#btnRandMotion")
        R.check("Randomize motion changes the timing but keeps the mode", ev("JSON.stringify(gradientStudio.doc.motion)") != m0 and ev("gradientStudio.doc.motion.mode") == "tide")
        blur()
        pg.keyboard.press("Space")
        p1 = ev("gradientStudio.state.playing")
        pg.wait_for_timeout(300)
        t1 = ev("gradientStudio.state.t")
        pg.wait_for_timeout(400)
        t2 = ev("gradientStudio.state.t")
        pg.keyboard.press("Space")
        R.check("Space plays and pauses the animation", p1 and t2 != t1 and not ev("gradientStudio.state.playing"))

        pg.click('.tabs [data-tab="finish"]')
        ev("gradientStudio.setDoc({...gradientStudio.doc, finish: {...gradientStudio.doc.finish, grain: 0}})")
        r0 = stats()["rough"]
        ev("""() => { const i = document.querySelector('input[data-key="finish.grain"]'); i.value = 0.3;
                i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }""")
        r1 = stats()["rough"]
        R.check("Finish › Grain adds visible film grain", r1 > r0 + 2, f"texture {r0:.2f} → {r1:.2f}")
        m_before = stats()["mean"]
        ev("""() => { const i = document.querySelector('input[data-key="finish.exposure"]'); i.value = 0.5;
                i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }""")
        m_after = stats()["mean"]
        R.check("Finish › Exposure brightens the picture", sum(m_after) > sum(m_before) + 20, f"mean {sum(m_before) / 3:.0f} → {sum(m_after) / 3:.0f}")
        shot(pg, "Finish tab", "Finish: Grain, Grain size, Animated grain, Exposure, Contrast, Saturation, Hue shift, Vignette.")
        pg.click("#btnResetFinish")
        R.check("Reset finish restores the defaults", ev("gradientStudio.doc.finish.exposure") == 0 and ev("gradientStudio.doc.finish.grain") == 0.08)

        # ======================================================================================================
        section("Canvas format, templates, Recent and Previous")
        pg.click("#btnFormat")
        shot(pg, "Canvas format menu", "Canvas Format: seven presets plus a custom size.")
        pg.click('#menuFormat .item[data-id="story"]')
        pg.wait_for_timeout(150)
        cw, ch = ev("[document.querySelector('#view').width, document.querySelector('#view').height]")
        R.check("Canvas Format › Story turns the canvas 9:16", ev("gradientStudio.doc.format.w") == 1080 and ev("gradientStudio.doc.format.h") == 1920
                and abs(cw / ch - 9 / 16) < 0.01 and pg.inner_text("#liveSize") == "1080 × 1920", f"preview {cw}×{ch}")
        pg.click("#btnFormat")
        pg.fill("#cfW", "1500")
        pg.fill("#cfH", "500")
        pg.click("#cfGo")
        pg.wait_for_timeout(150)
        R.check("Custom canvas size", ev("[gradientStudio.doc.format.w, gradientStudio.doc.format.h].join('x')") == "1500x500")
        shot(pg, "Custom banner format", "A custom 1500 × 500 banner canvas.")
        pg.click("#btnFormat")
        pg.click('#menuFormat .item[data-id="portrait"]')

        pg.click("#btnTemplates")
        pg.wait_for_selector("#menuTemplates .tcard")
        R.check("Template pack lists 14 looks", pg.locator("#menuTemplates .tcard").count() == 14)
        pg.wait_for_timeout(200)
        shot(pg, "Template pack", "The template pack: 14 hand-picked looks, each with its own motion.")
        pg.locator("#menuTemplates .tcard", has_text="Violet Dusk").click()
        R.check("Choosing a template loads it", ev("gradientStudio.doc.paletteName") == "Violet Dusk")

        for _ in range(3):
            pg.click("#btnNew")
        pg.click("#btnRecent")
        pg.wait_for_selector("#menuRecent .tcard")
        n_recent = pg.locator("#menuRecent .tcard").count()
        want = ev("gradientStudio.recent.items[1].doc.seed")
        shot(pg, "Recent", "Recent: every gradient you leave behind, newest first.")
        R.check("Recent remembers earlier gradients", n_recent >= 4, f"{n_recent} entries")
        pg.locator("#menuRecent .tcard").nth(1).click()
        R.check("Clicking a Recent entry brings that gradient back", ev("gradientStudio.doc.seed") == want)
        cur, prev = ev("gradientStudio.doc.seed"), ev("gradientStudio.state.previous.seed")
        pg.click("#btnPrev")
        a1 = ev("gradientStudio.doc.seed")
        pg.click("#btnPrev")
        a2 = ev("gradientStudio.doc.seed")
        R.check("Previous restores the gradient before, and pressing it again swaps back", a1 == prev and a2 == cur)

        last = ev("gradientStudio.doc.seed")
        pg.wait_for_timeout(400)  # session autosave
        pg.goto(base)
        ready()
        R.check("A fresh visit starts with a new gradient", ev("gradientStudio.doc.seed") != last)
        R.check("…the last session is first in Recent", ev("gradientStudio.recent.items[0].doc.seed") == last)
        pg.click("#btnPrev")
        R.check("…and Previous restores it", ev("gradientStudio.doc.seed") == last)

        blur()
        pg.keyboard.press("h")
        R.check("H hides the points", pg.locator(".handles").is_hidden() and "Show points" in pg.inner_text("#btnHide"))
        pg.keyboard.press("h")
        pg.keyboard.press("?")
        pg.wait_for_selector("#helpModal:not([hidden])")
        shot(pg, "Shortcuts", "The ? button: every shortcut and tip.")
        pg.keyboard.press("Escape")
        R.check("Help opens with ? and closes with Escape", pg.locator("#helpModal").is_hidden())

        # ======================================================================================================
        section("Export from the dialog")
        pg.goto(base + "?template=Duotone%20Haze&seed=00C0FFEE")
        ready()
        pause()
        ev("gradientStudio.setPhase(0)")
        prev_mean = stats()["mean"]

        def pick(sel):
            return lambda: pg.click(sel)

        seen = {}

        def png_first():
            pg.click('#exType [data-v="png"]')
            seen["x4"], seen["x2"] = pg.is_disabled('#exMult [data-v="4"]'), pg.is_disabled('#exMult [data-v="2"]')

        res = ui_export(png_first, "Export dialog - image", "Export: PNG / WEBP / JPEG / WEBM / MP4, size, 1× 2× 4× (4× is off because it would pass 4096 px).")
        R.check("For 900 × 1440, 2× is offered and 4× is disabled (it would pass 4096 px)", seen["x4"] and not seen["x2"])
        im = Image.open(res["path"])
        exp_mean = np.asarray(im.convert("RGB"), np.float32).reshape(-1, 3).mean(axis=0)
        R.check("Export PNG 1× → 900 × 1440 PNG", im.format == "PNG" and im.size == (900, 1440), f"{im.format} {im.size[0]}×{im.size[1]}")
        R.check("The exported file matches the live preview", float(np.abs(exp_mean - np.array(prev_mean)).max()) < 4,
                f"mean colour preview {np.round(prev_mean, 1).tolist()} vs file {np.round(exp_mean, 1).tolist()}")
        keep(res["path"], "stills", "PNG 1x - Duotone Haze 900x1440.png", "PNG 1× (900 × 1440)")

        res = ui_export(lambda: (pg.click('#exType [data-v="png"]'), pg.click('#exMult [data-v="2"]')))
        im = Image.open(res["path"])
        R.check("Export PNG 2× → 1800 × 2880", im.size == (1800, 2880), f"{im.size[0]}×{im.size[1]}")
        keep(res["path"], "stills", "PNG 2x - Duotone Haze 1800x2880.png", "PNG 2× (1800 × 2880)")
        for t, fmt in (("webp", "WEBP"), ("jpg", "JPEG")):
            res = ui_export(lambda t=t: (pg.click(f'#exType [data-v="{t}"]'), pg.click('#exMult [data-v="1"]')))
            im = Image.open(res["path"])
            R.check(f"Export {fmt} → 900 × 1440 {fmt}", im.format == fmt and im.size == (900, 1440), f"{im.format} {im.size[0]}×{im.size[1]}, {os.path.getsize(res['path']) // 1024} KB")
            keep(res["path"], "stills", f"{fmt} - Duotone Haze 900x1440.{t}", f"{fmt} (900 × 1440)")
        res = ui_export(lambda: (pg.click('#exType [data-v="png"]'), pg.fill("#exW", "1200"), pg.press("#exW", "Tab")))
        im = Image.open(res["path"])
        R.check("Typing a width keeps the canvas shape", im.size == (1200, 1920), f"{im.size[0]}×{im.size[1]}")

        res = ui_export(lambda: (pg.click('#exType [data-v="webm"]'), pg.click('#exVRes [data-v="hd"]'), pg.click('#exFps [data-v="30"]'), pg.click('#exDur [data-v="5"]')),
                        "Export dialog - rendering video", "WEBM export rendering frame by frame, with progress and Cancel export.", progress_at=55)
        dst = keep(res["path"], "loops", "WEBM from the dialog - Duotone Haze 1200x1920 30fps 5s.webm", "WEBM from the dialog (Drift, 1200 × 1920, 30 fps, 5 s)", "video")
        check_video(dst, 1200, 1920, 150, "vp9", "WEBM from the dialog")

        res = ui_export(lambda: (pg.click('#exType [data-v="mp4"]'), pg.click('#exVRes [data-v="hd"]'), pg.click('#exFps [data-v="30"]'), pg.click('#exDur [data-v="5"]')))
        dst = keep(res["path"], "loops", "MP4 from the dialog - Duotone Haze 1200x1920 30fps 5s.mp4", "MP4 (H.264) from the dialog", "video")
        st = probe(dst)
        R.check("MP4: H.264, yuv420p (plays everywhere, Instagram-ready)", st.get("codec_name") == "h264" and st.get("pix_fmt") == "yuv420p" and int(st.get("nb_read_frames", 0)) == 150,
                f"{st.get('codec_name')} {st.get('pix_fmt')} {st.get('width')}×{st.get('height')}, {st.get('nb_read_frames')} frames")

        # cancel
        blur()
        pg.click("#btnExport")
        pg.click('#exType [data-v="webm"]')
        pg.click('#exDur [data-v="10"]')
        ev("""() => { window.__exp = new Promise((res) => { addEventListener('gs-export-failed', (e) => res(e.detail), { once: true }); }); }""")
        pg.click("#exGo")
        pg.wait_for_function("!document.querySelector('#exProg').hidden && parseFloat(document.querySelector('#exBar').style.width) >= 10", polling=50)
        pg.click("#exCancel")
        msg = ev("() => window.__exp")
        R.check("Cancel export stops a video mid-render", "cancel" in msg.lower(), msg)
        pg.keyboard.press("Escape")

        # ======================================================================================================
        section("Every motion mode as a seamless loop (Story 1080 × 1920, 30 fps, 5 s)")
        story = {"id": "story", "label": "Story / Reel", "w": 1080, "h": 1920}
        for mode, tpl in (("still", "Peach Fuzz"), ("drift", "Duotone Haze"), ("orbit", "Midnight Arc"), ("breathe", "Ember Bloom"),
                          ("flow", "Violet Dusk"), ("tide", "Aurora")):
            doc = template_doc(tpl, story)
            doc["motion"]["mode"] = mode
            doc["motion"]["duration"] = 5
            t_start = time.time()
            res = module_export(doc, "webm", 1080, 1920, f"{mode} {tpl}")
            took = time.time() - t_start
            dst = keep(res["path"], "loops", f"{mode.title()} - {tpl} 1080x1920 30fps 5s.webm", f"{mode.title()} · {tpl} (rendered in {took:.1f} s)", "video")
            check_video(dst, 1080, 1920, 150, "vp9", f"{mode.title()} ({tpl})", still=(mode == "still"))

        doc = template_doc("Solar Flare", story)
        res = module_export(doc, "webm", 1080, 1920, "60fps", fps=60, seconds=3)
        dst = keep(res["path"], "loops", "60 fps - Solar Flare 1080x1920 3s.webm", "60 fps · Solar Flare (3 s)", "video")
        check_video(dst, 1080, 1920, 180, "vp9", "60 fps export")
        doc = template_doc("Neon Night", story)
        res = module_export(doc, "webm", 1440, 2560, "2k", fps=30, seconds=3)
        dst = keep(res["path"], "loops", "2K - Neon Night 1440x2560 3s.webm", "2K · Neon Night (1440 × 2560, 3 s)", "video")
        check_video(dst, 1440, 2560, 90, "vp9", "2K export")
        doc = template_doc("Lagoon", {"id": "wide", "label": "Widescreen", "w": 1920, "h": 1080})
        res = module_export(doc, "webm", 1920, 1080, "landscape", fps=30, seconds=5)
        dst = keep(res["path"], "loops", "Landscape - Lagoon 1920x1080 5s.webm", "Landscape · Lagoon (1920 × 1080)", "video")
        check_video(dst, 1920, 1080, 150, "vp9", "Landscape export")

        doc = template_doc("Midnight Arc", story)
        res = module_export(doc, "png", 2160, 3840, "4k")
        im = Image.open(res["path"])
        R.check("4K still: 2160 × 3840 PNG", im.size == (2160, 3840), f"{im.size[0]}×{im.size[1]}, {os.path.getsize(res['path']) / 1e6:.1f} MB")
        keep(res["path"], "stills", "4K PNG - Midnight Arc 2160x3840.png", "4K PNG (2160 × 3840)")

        # ======================================================================================================
        section("Template pack and random gradients")
        post = {"id": "post", "label": "Post", "w": 1080, "h": 1350}
        tnames = ev("async () => (await import('/js/generate.js')).TEMPLATES.map((t) => t.name)")
        tpaths = []
        for k, name in enumerate(tnames):
            res = module_export(template_doc(name, post), "png", 1080, 1350, name)
            tpaths.append(keep(res["path"], "templates", f"{k + 1:02d} {name}.png", name))
        R.check(f"All {len(tnames)} templates export", len(tpaths) == 14 and all(Image.open(x).size == (1080, 1350) for x in tpaths))
        contact_sheet(tpaths, os.path.join(review, DIRS["templates"], "_All templates.jpg"), cols=7, cell=200)
        R.media("image", rel(os.path.join(review, DIRS["templates"], "_All templates.jpg")), "Contact sheet of the template pack")

        rpaths = []
        for k in range(16):
            seed = (k + 1) * 0x9E3779B1 & 0xFFFFFFFF
            doc = ev("""async ([seed, fmt]) => (await import('/js/generate.js')).makeGradient(seed, { name: 'Untitled gradient', format: fmt, points: [], motion: { mode: 'drift' } })""", [seed, post])
            res = module_export(doc, "png", 1080, 1350, doc["paletteName"])
            rpaths.append(keep(res["path"], "random", f"{k + 1:02d} {doc['paletteName']} ({seed:08X}).png", doc["paletteName"]))
        contact_sheet(rpaths, os.path.join(review, DIRS["random"], "_All random.jpg"), cols=8, cell=180)
        R.media("image", rel(os.path.join(review, DIRS["random"], "_All random.jpg")), "16 gradients straight from New Gradient")
        R.check("16 New Gradient results export as 1080 × 1350 PNGs", all(Image.open(x).size == (1080, 1350) for x in rpaths))

        # ======================================================================================================
        section("Layout")
        for vw, vh in ((1920, 1080), (1280, 800)):
            pg.set_viewport_size({"width": vw, "height": vh})
            pg.wait_for_timeout(250)
            boxes = ev("""() => [document.querySelector('.canvas-panel').getBoundingClientRect(), document.querySelector('.side').getBoundingClientRect()].map((r) => r.height)""")
            R.check(f"{vw}×{vh}: canvas and settings panels share one height", abs(boxes[0] - boxes[1]) < 1, f"{boxes[0]:.0f} / {boxes[1]:.0f} px")
        shot(pg, "Small window 1280x800", "A smaller window: same layout, the canvas scales to fit.")
        pg.set_viewport_size({"width": 820, "height": 1100})
        pg.wait_for_timeout(250)
        shot(pg, "Narrow window", "A narrow window: settings move under the canvas.", full=True)
        pg.set_viewport_size({"width": 1500, "height": 940})

        R.check("No errors in the browser console during the whole run", not errors, "; ".join(errors[:5]))
        browser.close()
    srv.shutdown()
    shutil.rmtree(out_dir, ignore_errors=True)
    return time.time() - t0


def unit_tests():
    section("Unit tests")
    node = subprocess.run(["node", "--test", "tests/js/*.test.mjs"], cwd=APP, capture_output=True, text=True, shell=False)
    out = node.stdout
    npass = sum(1 for line in out.splitlines() if line.startswith("ok "))
    nfail = sum(1 for line in out.splitlines() if line.startswith("not ok "))
    R.check(f"Engine tests (node): {npass} passed, {nfail} failed", node.returncode == 0 and npass > 0,
            "; ".join(line[3:] for line in out.splitlines() if line.startswith("ok "))[:2000])
    py = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_server.py", "-v"], cwd=APP, capture_output=True, text=True)
    lines = [ln for ln in py.stderr.splitlines() if " ... " in ln]
    ok = sum(1 for ln in lines if ln.endswith("ok"))
    R.check(f"Server tests (python): {ok} of {len(lines)} passed", py.returncode == 0, "; ".join(ln.split(" ... ")[0].split(" ")[0] for ln in lines))


def write_report(review, seconds):
    items = R.items
    with open(os.path.join(review, "results.json"), "w", encoding="utf-8") as fh:
        json.dump({"passed": R.passed, "failed": R.failed, "seconds": round(seconds), "items": items,
                   "date": time.strftime("%Y-%m-%d %H:%M")}, fh, indent=1)
    e = html.escape
    sections = []
    for name in dict.fromkeys(i["section"] for i in items):
        checks = [i for i in items if i["section"] == name and "ok" in i]
        media = [i for i in items if i["section"] == name and "media" in i]
        rows = "".join(f'<li class="{"ok" if c["ok"] else "bad"}"><b>{"✓" if c["ok"] else "✗"}</b><span>{e(c["name"])}'
                       f'{f"<small>{e(c["detail"])}</small>" if c["detail"] else ""}</span></li>' for c in checks)
        tiles = ""
        for m in media:
            src = "/".join(map(html.escape, m["path"].split("/")))
            if m["media"] == "video":
                tiles += f'<figure class="v"><video src="{src}" autoplay loop muted playsinline></video><figcaption>{e(m["caption"])}</figcaption></figure>'
            else:
                tiles += f'<figure><a href="{src}"><img src="{src}" loading="lazy"></a><figcaption>{e(m["caption"])}</figcaption></figure>'
        sections.append(f"<section><h2>{e(name)}</h2><ul>{rows}</ul>{f'<div class=tiles>{tiles}</div>' if tiles else ''}</section>")
    status = "All checks passed" if not R.failed else f"{R.failed} check(s) failed"
    doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mesh Drift Tests</title><style>
:root{{--bg:#0a0a0a;--card:#121212;--line:#232323;--text:#ececec;--muted:#8b8b8b;--ok:#3ddc84;--bad:#ff6b5b;--accent:#ff4a1f}}
body{{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI",system-ui,sans-serif}}
header{{padding:32px 32px 8px}} h1{{margin:0;font-size:26px}} .sum{{color:var(--muted)}} .sum b{{color:{'var(--ok)' if not R.failed else 'var(--bad)'}}}
main{{padding:0 32px 48px;max-width:1500px}} section{{border-top:1px solid var(--line);padding:18px 0}} h2{{font-size:17px;margin:0 0 10px}}
ul{{list-style:none;padding:0;margin:0 0 14px}} li{{display:flex;gap:10px;padding:5px 0;border-bottom:1px solid #161616}}
li b{{width:16px;flex:none}} li.ok b{{color:var(--ok)}} li.bad b{{color:var(--bad)}} li.bad span{{color:var(--bad)}}
small{{display:block;color:var(--muted);font-size:12px;word-break:break-word}}
.tiles{{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}}
figure{{margin:0;background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:hidden}}
figure img,figure video{{display:block;width:100%;max-height:520px;object-fit:contain;background:#000}}
figure.v video{{max-height:460px}} figcaption{{padding:8px 10px;color:var(--muted);font-size:12px}}
a{{color:var(--accent)}} @media(max-width:600px){{header,main{{padding-left:16px;padding-right:16px}}}}
</style></head><body><header><h1>Mesh Drift · test review</h1>
<p class="sum"><b>{status}</b> · {R.passed} passed, {R.failed} failed · {time.strftime("%d %b %Y %H:%M")} · {seconds / 60:.1f} min ·
app in <code>{os.path.dirname(os.path.dirname(os.path.abspath(__file__)))}</code></p>
<p class="sum">Folders: {" · ".join(DIRS.values())}. Videos play here on loop: watch each one wrap around without a jump.</p></header>
<main>{''.join(sections)}</main></body></html>"""
    with open(os.path.join(review, "Test Report.html"), "w", encoding="utf-8") as fh:
        fh.write(doc)


def main():
    for stream in (sys.stdout, sys.stderr):  # a redirected Windows console is cp1252; the report uses arrows and ×
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--review", default=DEFAULT_REVIEW)
    a = ap.parse_args()
    seconds = 0
    try:
        seconds = run(a.review)
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 - record the crash in the report
        R.check("The end-to-end run finished", False, traceback.format_exc()[-1500:])
    unit_tests()
    write_report(a.review, seconds)
    print(f"\n{R.passed} passed, {R.failed} failed  ->  {os.path.join(a.review, 'Test Report.html')}")
    sys.exit(1 if R.failed else 0)


if __name__ == "__main__":
    main()
