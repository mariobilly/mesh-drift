"""Draws the Mesh Drift icon (icon.png, static/icon.png and a multi-size icon.ico).

A rounded tile filled with a soft mesh gradient (violet, pink, orange, cyan on deep plum) with a light film grain,
the app's ring logo in the middle, and two colour-point handles like the ones you drag in the app.
"""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
S = 1024  # drawn large, then scaled down for every size


def srgb_to_lin(c):
    c = np.asarray(c, dtype=np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1 / 2.4) - 0.055)


# The three dragged points sit on these colours: (x, y, colour, radius) in 0..1 tile units.
POINTS = [(0.27, 0.30, (255, 106, 26), 0.36), (0.70, 0.52, (139, 77, 255), 0.36), (0.36, 0.78, (24, 196, 240), 0.34)]


def mesh(size):
    pts = [(0.02, 0.02, (8, 6, 22), 0.42), (0.98, 0.04, (232, 70, 140), 0.42), *POINTS,
           (0.98, 0.98, (6, 10, 40), 0.40), (0.02, 0.98, (40, 20, 90), 0.30)]
    y, x = np.mgrid[0:size, 0:size] / (size - 1)
    # a swirl so the bands curve like the app's organic shapes
    cx, cy = x - 0.5, y - 0.5
    a = 1.3 * np.exp(-(cx ** 2 + cy ** 2) * 4.0)
    xs, ys = 0.5 + cx * np.cos(a) - cy * np.sin(a), 0.5 + cx * np.sin(a) + cy * np.cos(a)
    logw = np.stack([-(((xs - px) ** 2 + (ys - py) ** 2) ** 0.5 / r) ** 1.7 for px, py, _, r in pts])
    w = np.exp(3.2 * (logw - logw.max(axis=0)))
    w /= w.sum(axis=0)
    lin = np.stack([srgb_to_lin(c) for *_, c, _r in pts])  # (n, 3)
    img = np.einsum("nhw,nc->hwc", w, lin)
    rgb = lin_to_srgb(img)
    rng = np.random.default_rng(7)
    rgb += (rng.random((size, size, 1)) - 0.5) * 0.035  # film grain
    return Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), "RGB")


def draw():
    tile = mesh(S).convert("RGBA")
    white = (255, 255, 255, 255)
    # the three colour-point handles you drag in the app; the middle one is selected (orange ring)
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    hr = 92
    for px, py, _col, _r in POINTS:
        px, py = px * S, py * S
        sd.ellipse((px - hr, py - hr + 12, px + hr, py + hr + 12), outline=(0, 0, 0, 120), width=30)
    tile.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14)))
    d = ImageDraw.Draw(tile)
    for k, (px, py, col, _r) in enumerate(POINTS):
        px, py = px * S, py * S
        ring = (255, 74, 31, 255) if k == 1 else white
        d.ellipse((px - hr, py - hr, px + hr, py + hr), outline=ring, width=28)
        d.ellipse((px - 38, py - 38, px + 38, py + 38), fill=col + (255,), outline=(255, 255, 255, 200), width=6)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((24, 24, S - 24, S - 24), radius=220, fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(tile, (0, 0), mask)
    return out


if __name__ == "__main__":
    big = draw()
    im = big.resize((512, 512), Image.LANCZOS)
    im.save(os.path.join(HERE, "icon.png"))
    os.makedirs(os.path.join(HERE, "static"), exist_ok=True)
    big.resize((128, 128), Image.LANCZOS).save(os.path.join(HERE, "static", "icon.png"))
    big.resize((256, 256), Image.LANCZOS).save(os.path.join(HERE, "icon.ico"),
                                              sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("icon.png, static/icon.png and icon.ico written")
