"""Packs the VFX textures used by src/render/vfx.

Sources (art-work/vfx/*.png, git-ignored, generated with the Codex image tool; prompts in docs/ART.md):
  explosion.png  4x6 flipbook (24 frames)      smoke.png  4x6 flipbook (first 20 frames used)
  fire.png       4x4 loop, 256x384 cells       decals.png 2x3 sheet of 512 px ground decals
Outputs (committed):
  src/render/vfx/assets/atlas.webp   2048x2048, 8x8 cells of 256 px, RGB on black (alpha = luminance in the shader)
  src/render/vfx/assets/decals.webp  1024x1536, 2x3 cells of 512 px, greyscale masks on black

  python tools/vfx/build_atlas.py
"""
import os
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'art-work', 'vfx')
OUT = os.path.join(ROOT, 'src', 'render', 'vfx', 'assets')
C = 256
COLS = 8


def load(name):
    a = np.asarray(Image.open(os.path.join(SRC, name)).convert('RGB')).astype(np.float32)
    # the generator's "black" sits a few levels above zero: pull the floor down
    return np.clip((a - 7.0) * (255.0 / 248.0), 0, 255)


def edge_mask(h, w, margin=0.1, power=1.0):
    """1 in the middle, smoothly 0 at the cell border, so neighbours never bleed in."""
    y = np.linspace(-1, 1, h)[:, None]
    x = np.linspace(-1, 1, w)[None, :]
    r = np.sqrt(x * x + y * y)
    m = np.clip((1.0 - r) / margin, 0, 1)
    box = np.clip((1.0 - np.maximum(np.abs(x), np.abs(y))) / (margin * 0.6), 0, 1)
    return (np.maximum(m, box * np.clip((1.08 - r) / margin, 0, 1)) ** power)[:, :, None]


def recenter(cell):
    """Shift a frame so its brightness centroid sits in the middle of the cell."""
    lum = cell.max(axis=2)
    s = lum.sum()
    if s < 1e3:
        return cell
    h, w = lum.shape
    cy = (lum.sum(axis=1) * np.arange(h)).sum() / s
    cx = (lum.sum(axis=0) * np.arange(w)).sum() / s
    dy, dx = int(round(h / 2 - cy)), int(round(w / 2 - cx))
    dy, dx = max(-24, min(24, dy)), max(-24, min(24, dx))
    out = np.zeros_like(cell)
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = cell[ys, xs]
    return out


atlas = np.zeros((C * COLS, C * COLS, 3), np.float32)


def put(i, cell):
    r, c = divmod(i, COLS)
    atlas[r * C:(r + 1) * C, c * C:(c + 1) * C] = cell


# explosion: 24 frames, cells 0..23
ex = load('explosion.png')
for i in range(24):
    r, c = divmod(i, 4)
    put(i, recenter(ex[r * 256:(r + 1) * 256, c * 256:(c + 1) * 256]) * edge_mask(C, C, 0.14))

# smoke: first 20 frames, cells 24..43 (greyscale)
sm = load('smoke.png')
for i in range(20):
    r, c = divmod(i, 4)
    cell = recenter(sm[r * 256:(r + 1) * 256, c * 256:(c + 1) * 256])
    g = cell.mean(axis=2, keepdims=True)
    put(24 + i, np.repeat(g, 3, axis=2) * edge_mask(C, C, 0.16))

# fire loop: 16 frames of 256x384 -> 171x256 centred, cells 44..59
fi = load('fire.png')
for i in range(16):
    r, c = divmod(i, 4)
    cell = fi[r * 384:(r + 1) * 384, c * 256:(c + 1) * 256] * edge_mask(384, 256, 0.12)
    im = Image.fromarray(cell.astype(np.uint8)).resize((171, 256), Image.LANCZOS)
    out = np.zeros((C, C, 3), np.float32)
    out[:, 42:42 + 171] = np.asarray(im).astype(np.float32)
    put(44 + i, out)

# procedural: 60 dot, 61 spark streak, 62 ring, 63 star
y, x = np.mgrid[0:C, 0:C].astype(np.float32)
u = (x - C / 2 + 0.5) / (C / 2)
v = (y - C / 2 + 0.5) / (C / 2)
r = np.sqrt(u * u + v * v)
grey = lambda a: np.repeat((np.clip(a, 0, 1) * 255)[:, :, None], 3, axis=2)
dot = np.exp(-(r * 2.6) ** 2) * 0.75 + np.exp(-(r * 7.0) ** 2) * 0.6
put(60, grey(dot * np.clip((1 - r) * 4, 0, 1)))
streak = np.exp(-(u * 9.0) ** 2) * np.clip(1 - np.abs(v), 0, 1) ** 1.5 + np.exp(-(u * 30.0) ** 2) * np.clip(1 - np.abs(v) * 1.05, 0, 1)
put(61, grey(streak))
ring = np.exp(-((r - 0.8) / 0.05) ** 2) + np.exp(-((r - 0.8) / 0.14) ** 2) * 0.35
put(62, grey(ring * np.clip((1 - r) * 8, 0, 1)))
ray = lambda uu, vv, w, l: np.exp(-(vv / w) ** 2) * np.clip(1 - np.abs(uu) / l, 0, 1) ** 2
d1 = (u + v) / np.sqrt(2)
d2 = (u - v) / np.sqrt(2)
star = np.exp(-(r * 5.0) ** 2) + ray(u, v, 0.022, 0.98) + ray(v, u, 0.022, 0.98) + 0.6 * ray(d1, d2, 0.018, 0.55) + 0.6 * ray(d2, d1, 0.018, 0.55) + 0.3 * np.exp(-(r * 2.2) ** 2)
put(63, grey(star * np.clip((1 - r) * 6, 0, 1)))

os.makedirs(OUT, exist_ok=True)
Image.fromarray(np.clip(atlas, 0, 255).astype(np.uint8)).save(os.path.join(OUT, 'atlas.webp'), quality=82, method=6)

# decals: grey masks, cell borders feathered
de = load('decals.png').mean(axis=2, keepdims=True)
out = np.zeros_like(de)
for i in range(6):
    rr, cc = divmod(i, 2)
    cell = de[rr * 512:(rr + 1) * 512, cc * 512:(cc + 1) * 512]
    out[rr * 512:(rr + 1) * 512, cc * 512:(cc + 1) * 512] = cell * edge_mask(512, 512, 0.06)
Image.fromarray(np.clip(out[:, :, 0], 0, 255).astype(np.uint8), 'L').save(os.path.join(OUT, 'decals.webp'), quality=80, method=6)
for f in ('atlas.webp', 'decals.webp'):
    print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, 'KB')
