# Pull the red ink of every Caliphate woodcut portrait (art-work/ui/<id>.png) to ONE terracotta, so the faction's
# panels match across generation batches. Only the red-orange ink moves (hue, saturation and value are shifted by the
# difference between that portrait's median red and the target); sand, turquoise, black and paper are untouched.
# Idempotent. Run before tools/art/ui-webp.py:   python tools/art/panel-normalise.py
import colorsys, json, os
import numpy as np
from PIL import Image

root = os.path.join(os.path.dirname(__file__), '..', '..')
glyphs = json.load(open(os.path.join(root, 'tools', 'art', 'ui-prompts', 'glyphs.json'), encoding='utf8'))
TARGET = colorsys.rgb_to_hsv(206 / 255, 60 / 255, 26 / 255)  # the first batch (Scimitar Guard, Camel Archers, Mamluks)


def hsv(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1)
    d = mx - mn
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    h = np.zeros_like(mx)
    dd = np.maximum(d, 1e-6)
    h = np.where(mx == r, ((g - b) / dd) % 6, h)
    h = np.where(mx == g, (b - r) / dd + 2, h)
    h = np.where(mx == b, (r - g) / dd + 4, h)
    return (h / 6) % 1, s, mx


def rgb(h, s, v):
    i = np.floor(h * 6).astype(int) % 6
    f = h * 6 - np.floor(h * 6)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    out = np.zeros(h.shape + (3,))
    for k, (r, g, b) in enumerate([(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]):
        m = i == k
        out[m] = np.stack([r[m], g[m], b[m]], -1)
    return out


for id, g in glyphs.items():
    if g['faction'] != 'caliphate':
        continue
    path = os.path.join(root, 'art-work', 'ui', id + '.png')
    if not os.path.exists(path):
        continue
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float64) / 255
    h, s, v = hsv(a)
    hd = np.minimum(np.abs(h - TARGET[0]), 1 - np.abs(h - TARGET[0]))  # hue distance from the target red
    # weight 1 on saturated red-orange ink, fading out towards sand (hue > ~25 deg, or pale) and towards black
    w = np.clip((0.055 - hd) / 0.02, 0, 1) * np.clip((s - 0.55) / 0.2, 0, 1) * np.clip((v - 0.3) / 0.15, 0, 1)
    core = w > 0.99
    if core.mean() < 0.02:
        print('skip (no red panel):', id)
        continue
    mh, ms, mv = np.median(h[core]), np.median(s[core]), np.median(v[core])
    h2 = (h + w * (TARGET[0] - mh)) % 1
    s2 = np.clip(s * (1 + w * (TARGET[1] / ms - 1)), 0, 1)
    v2 = np.clip(v * (1 + w * (TARGET[2] / mv - 1)), 0, 1)
    out = (rgb(h2, s2, v2) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(out).save(path)
    print(f'{id:22s} red h {mh * 360:5.1f} s {ms:.2f} v {mv:.2f} -> h {TARGET[0] * 360:.1f} s {TARGET[1]:.2f} v {TARGET[2]:.2f}')
