# Cut the UI material kit (docs/UI-STYLE.md) out of the generated sheets in art-work/ui-kit/*.png:
# key the green background, split each sheet into its objects, derive button states and the two
# liveries, and write small WebPs to public/ui/kit/. Prints the 9-slice numbers the stylesheet uses.
#   python tools/art/ui-kit.py
import os
import numpy as np
from PIL import Image, ImageFilter

root = os.path.join(os.path.dirname(__file__), '..', '..')
SRC = os.path.join(root, 'art-work', 'ui-kit')
DST = os.path.join(root, 'public', 'ui', 'kit')
os.makedirs(DST, exist_ok=True)
ME = np.array([0x3B, 0x6F, 0xD8], np.float32)   # TEAM_COLORS in src/render/crowd/archetypes.ts
FOE = np.array([0xD8, 0x45, 0x3B], np.float32)
total = 0


def load(name):
    """RGBA float array with the green screen keyed out and the spill removed from the edges."""
    a = np.asarray(Image.open(os.path.join(SRC, name + '.png')).convert('RGB'), np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    other = np.maximum(r, b)
    key = np.clip((g - other - 30) / 70, 0, 1)          # 1 = pure screen
    alpha = 1 - key
    g2 = np.where(g > other, other + (g - other) * 0.15 * (1 - key), g)   # despill
    out = np.dstack([r, g2, b, alpha * 255])
    # choke the matte by a pixel so no green fringe survives the downscale
    al = Image.fromarray(out[..., 3].astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    out[..., 3] = np.asarray(al, np.float32)
    return out


def runs(mask, min_len=30, min_gap=12):
    """Runs of True in a 1D mask, merging gaps shorter than min_gap."""
    idx = np.flatnonzero(mask)
    if not len(idx):
        return []
    out, start, prev = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - prev > min_gap:
            out.append((start, prev + 1))
            start = i
        prev = i
    out.append((start, prev + 1))
    return [(a, b) for a, b in out if b - a >= min_len]


def objects(img):
    """Bounding boxes of the separate objects on a sheet, row by row then left to right."""
    solid = img[..., 3] > 40
    boxes = []
    for y0, y1 in runs(solid.any(axis=1)):
        for x0, x1 in runs(solid[y0:y1].any(axis=0)):
            yy = runs(solid[y0:y1, x0:x1].any(axis=1), 1, 9999)[0]
            boxes.append((x0, y0 + yy[0], x1, y0 + yy[1]))
    return boxes


def crop(img, box, pad=2):
    x0, y0, x1, y1 = box
    h, w = img.shape[:2]
    return img[max(0, y0 - pad):min(h, y1 + pad), max(0, x0 - pad):min(w, x1 + pad)].copy()


def pil(img):
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), 'RGBA' if img.shape[2] == 4 else 'RGB')


def save(img, name, size, q=84):
    """size: (w, h), or a width with the height following the aspect."""
    global total
    im = img if isinstance(img, Image.Image) else pil(img)
    if isinstance(size, int):
        size = (size, round(size * im.height / im.width))
    im = im.resize(size, Image.LANCZOS)
    path = os.path.join(DST, name + '.webp')
    im.save(path, 'WEBP', quality=q, method=6, alpha_quality=90)
    kb = os.path.getsize(path) / 1024
    total += kb
    print(f'  {name}.webp {im.width}x{im.height} {kb:.1f} KB')
    return im


def lum(img):
    return img[..., 0] * 0.299 + img[..., 1] * 0.587 + img[..., 2] * 0.114


def sat(img):
    mx, mn = img[..., :3].max(axis=2), img[..., :3].min(axis=2)
    return (mx - mn) / np.maximum(mx, 1)


def grade(img, gain=1.0, lift=0.0, saturation=1.0, tint=None, tint_amt=0.0):
    out = img.copy()
    rgb = out[..., :3]
    l = lum(out)[..., None]
    rgb = l + (rgb - l) * saturation
    if tint is not None:
        rgb = rgb * (1 - tint_amt) + (l / 255 * np.asarray(tint, np.float32)) * tint_amt * 1.6
    out[..., :3] = np.clip(rgb * gain + lift, 0, 255)
    return out


def dye(img, colour, mask, ref=None):
    """Recolour the masked cloth/enamel to a livery, keeping its weave and shading."""
    out = img.copy()
    l = lum(img)
    ref = ref or float(np.median(l[mask > 0.5]))
    shade = np.clip(l / ref, 0, 1.5)[..., None]
    dyed = np.clip(colour[None, None, :] * (0.25 + 0.75 * shade) * 0.95, 0, 255)
    m = mask[..., None]
    out[..., :3] = img[..., :3] * (1 - m) + dyed * m
    return out


def soft(mask, r=1.5):
    return np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r)), np.float32) / 255


def pressed(img):
    """A pushed-in plate: darker, and the light now comes from below (the bevel flips)."""
    out = grade(img, gain=0.78)
    h = out.shape[0]
    ramp = np.linspace(0.82, 1.08, h, dtype=np.float32)[:, None, None]
    out[..., :3] = np.clip(out[..., :3] * ramp, 0, 255)
    return out


# ---------------------------------------------------------------- steel frame (9-slice, no fill)
print('frame')
f = load('frame')
f = crop(f, objects(f)[0], 0)
save(f, 'frame-steel', (384, 384), 86)
# a slimmer cousin for small plates: the same frame with the corner plates kept and the bars as they are
print('  slice 36 (of 384): corner plates; bars repeat `round`')

# ---------------------------------------------------------------- stone tile (seamless)
print('stone')
s = np.asarray(Image.open(os.path.join(SRC, 'stone.png')).convert('RGB'), np.float32)
side = 640                                            # a patch this size keeps the chisel marks at 256px
s = s[200:200 + side, 200:200 + side]
# make it wrap: cross-fade each edge into the opposite one
n = side // 5
ramp = np.linspace(0, 1, n, dtype=np.float32)
t = s.copy()
t[:, :n] = s[:, :n] * ramp[None, :, None] + s[:, -n:] * (1 - ramp)[None, :, None]
t = t[:, : side - n]
u = t.copy()
u[:n] = t[:n] * ramp[:, None, None] + t[-n:] * (1 - ramp)[:, None, None]
u = u[: side - n]
# flatten the large-scale light so the tile does not read as a grid, then set it to slate-600
low = np.asarray(pil(u).filter(ImageFilter.GaussianBlur(side / 12)), np.float32)
u = u - low + low.mean(axis=(0, 1))
l = lum(u)[..., None]
u = l + (u - l) * 0.7
u = (u - u.mean(axis=(0, 1))) * 1.5 + np.array([0x2A, 0x31, 0x3B], np.float32)
save(u, 'stone', (256, 256), 80)

# ---------------------------------------------------------------- parchment (9-slice with fill)
print('parchment')
p = load('parchment')
p = crop(p, objects(p)[0], 0)
# calm the orange: towards parch-200, even out the middle so the stretched fill stays quiet
l = lum(p)[..., None]
rgb = l + (p[..., :3] - l) * 0.62
rgb = (rgb - rgb[200:-200, 200:-200].mean(axis=(0, 1))) * 0.8 + np.array([0xE2, 0xD3, 0xB0], np.float32)
p[..., :3] = np.clip(rgb, 0, 255)
save(p, 'parchment', (448, 448), 84)
print('  slice 44 (of 448) fill')

# ---------------------------------------------------------------- button plates and their states
print('buttons')
b = load('buttons')
boxes = objects(b)
assert len(boxes) == 3, boxes
for name, box in zip(['steel', 'gold', 'stone'], boxes):
    plate = crop(b, box, 0)
    if name == 'steel':
        plate = grade(plate, gain=0.92, saturation=0.7, tint=(150, 170, 200), tint_amt=0.18)
    if name == 'gold':
        plate = grade(plate, gain=1.0, saturation=0.92)
    if name == 'stone':
        plate = grade(plate, gain=0.6, saturation=0.8)
    size = (384, round(384 * plate.shape[0] / plate.shape[1]))
    save(plate, f'btn-{name}', size, 84)
    save(grade(plate, gain=1.22, lift=6), f'btn-{name}-hover', size, 84)
    save(pressed(plate), f'btn-{name}-down', size, 84)
    if name != 'stone':
        off = grade(plate, gain=0.6, saturation=0.15, lift=10)
        off[..., 3] *= 0.8
        save(off, f'btn-{name}-off', size, 80)
print('  slice 26 46 (of 384 x ~104) fill: the rivets sit in the side slices')

# ---------------------------------------------------------------- caps: seal, boss, shields, crown
print('caps')
c = load('caps')
boxes = objects(c)
assert len(boxes) == 4, boxes
seal, boss, shield, crown = [crop(c, bx) for bx in boxes]
save(grade(seal, gain=0.95, saturation=0.95), 'seal', 160, 84)
boss = grade(boss, gain=0.85, saturation=0.5, tint=(150, 170, 200), tint_amt=0.15)
save(boss, 'boss', 128, 84)
save(grade(boss, gain=1.25, lift=6), 'boss-hover', 128, 84)
face = soft(((lum(shield) > 135) & (sat(shield) < 0.16) & (shield[..., 3] > 200)).astype(np.float32), 2.5)
# only the big connected face, not the rivet highlights: erode with a min filter first
face = soft(np.asarray(Image.fromarray((face * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(15)).filter(ImageFilter.MinFilter(21)), np.float32) / 255, 3)
save(dye(shield, ME, face, 165), 'shield-blue', 112, 84)
save(dye(shield, FOE, face, 165), 'shield-red', 112, 84)
save(crown, 'crown', 96, 86)

# ---------------------------------------------------------------- cloth: ribbon, divider, pennant
print('cloth')
k = load('cloth')
boxes = objects(k)
assert len(boxes) == 3, boxes
ribbon, divider, pennant = [crop(k, bx) for bx in boxes]
linen = lambda im: soft(((sat(im) > 0.14) & (im[..., 3] > 128)).astype(np.float32), 1.2)
rl = lum(ribbon)[..., None]
parch_ribbon = ribbon.copy()
parch_ribbon[..., :3] = np.clip((rl + (ribbon[..., :3] - rl) * 0.6) * 1.08, 0, 255)
save(parch_ribbon, 'ribbon', 512, 84)
save(dye(ribbon, ME, linen(ribbon)), 'ribbon-blue', 512, 84)
save(dye(ribbon, FOE, linen(ribbon)), 'ribbon-red', 512, 84)
save(divider, 'divider', 512, 84)
save(dye(pennant, ME, linen(pennant)), 'pennant-blue', 160, 84)
save(dye(pennant, FOE, linen(pennant)), 'pennant-red', 160, 84)

# ---------------------------------------------------------------- item sockets, one per rarity
print('slots')
sl = load('slots')
boxes = objects(sl)
assert len(boxes) == 4, boxes
for name, box in zip(['common', 'magic', 'rare', 'legendary'], boxes):
    save(crop(sl, box, 0), f'slot-{name}', (128, 128), 84)

print(f'kit: {total:.0f} KB in public/ui/kit')
