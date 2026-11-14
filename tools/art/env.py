"""Environment textures: CC0 Poly Haven scans -> packed runtime textures in public/textures/env/.

    python tools/art/env.py            # download (cached in art-work/env/src) + pack everything
    python tools/art/env.py --only veg # just the vegetation atlas  (ground | stone | veg)

Outputs (see docs/ART.md section 6):
  ground_<layer>_a.webp   RGB = albedo, A = 128 + height * 127       (1024 and _512)
  ground_<layer>_n.webp   L = normal Y (GL), A = 128 + normal X / 2  (1024 and _512)
  veg_atlas.webp          1024x1024 RGBA: leaf clusters (oak, birch, fir bough, bush, reeds) + 3 bark strips
The alpha >= 128 packing keeps canvas un-premultiply (the loader reads pixels through a 2D canvas) lossless
enough: colour keeps >= 7 bits. Needs Pillow + numpy.
"""
import json, math, os, random, sys, urllib.request
import concurrent.futures as cf
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'art-work', 'env', 'src')
OUT = os.path.join(ROOT, 'public', 'textures', 'env')
os.makedirs(SRC, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

# layer -> (Poly Haven texture id, albedo grade (r, g, b gain), saturation, gamma)
GROUND = {
    'grass': ('sparse_grass', (0.8, 1.08, 0.6), 1.06, 0.9),
    'forest': ('forest_leaves_03', (1.0, 0.98, 0.9), 0.9, 0.95),
    'dirt': ('rocky_trail', (0.86, 0.79, 0.68), 0.95, 1.25),
    'mud': ('brown_mud_03', (1.0, 0.96, 0.9), 0.9, 1.0),
    'rock': ('mossy_rock', (1.0, 1.0, 0.98), 0.85, 0.95),
}
# masonry for the bridges: name -> (Poly Haven id, albedo gain, saturation)
STONE = {
    'wall': ('medieval_blocks_05', (0.9, 0.9, 0.9), 0.55),
    'deck': ('cobblestone_floor_08', (0.82, 0.8, 0.76), 0.7),
}
BARK = ['bark_brown_02', 'pine_bark', 'tree_bark_03']
# model id -> maps to fetch (leaf / twig atlases with a separate alpha map)
MODELS = {
    'island_tree_02': ['leaves_diff', 'leaves_alpha'],
    'shrub_03': ['Diffuse', 'Alpha'],
    'shrub_01': ['Diffuse', 'Alpha'],
    'fir_tree_01': ['twig_diff', 'twig_alpha'],
}


def http(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'env-fetch/1.0'})
    return urllib.request.urlopen(req, timeout=120).read()


def fetch():
    jobs = []
    for tid in [v[0] for v in GROUND.values()] + BARK:
        d = json.loads(http('https://api.polyhaven.com/files/' + tid))
        maps = {'diff': 'Diffuse', 'nor': 'nor_gl', 'disp': 'Displacement'} if tid not in BARK else {'diff': 'Diffuse'}
        for short, key in maps.items():
            f = d[key]['1k'].get('jpg') or d[key]['1k']['png']
            jobs.append((f['url'], os.path.join(SRC, f'{tid}_{short}.{f["url"].rsplit(".", 1)[1]}')))
    for tid, _, _ in STONE.values():
        d = json.loads(http('https://api.polyhaven.com/files/' + tid))
        for short, key in {'diff': 'Diffuse', 'nor': 'nor_gl', 'ao': 'AO'}.items():
            f = d[key]['1k'].get('jpg') or d[key]['1k']['png']
            jobs.append((f['url'], os.path.join(SRC, f'{tid}_{short}.{f["url"].rsplit(".", 1)[1]}')))
    for mid, keys in MODELS.items():
        d = json.loads(http('https://api.polyhaven.com/files/' + mid))
        for key in keys:
            f = d[key]['1k']['png']
            jobs.append((f['url'], os.path.join(SRC, f'{mid}__{key}.png')))

    def dl(j):
        if not os.path.exists(j[1]):
            with open(j[1], 'wb') as fh:
                fh.write(http(j[0]))
            print('fetched', os.path.basename(j[1]))

    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(dl, jobs))


def find(stem):
    for ext in ('jpg', 'png'):
        p = os.path.join(SRC, f'{stem}.{ext}')
        if os.path.exists(p):
            return p
    raise FileNotFoundError(stem)


def grade(img, gain, sat, gamma):
    a = np.asarray(img.convert('RGB')).astype(np.float32) / 255
    a = a ** gamma
    a = a * np.array(gain, np.float32)
    l = a.mean(axis=2, keepdims=True)
    a = l + (a - l) * sat
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))


# ----------------------------------------------------------------------------------- ground

def pack_ground():
    total = 0
    for name, (tid, gain, sat, gamma) in GROUND.items():
        diff = grade(Image.open(find(f'{tid}_diff')), gain, sat, gamma)
        nor = Image.open(find(f'{tid}_nor')).convert('RGB')
        disp = np.asarray(Image.open(find(f'{tid}_disp')).convert('F'))
        lo, hi = np.percentile(disp, 1), np.percentile(disp, 99)
        h = np.clip((disp - lo) / max(1e-6, hi - lo), 0, 1)
        himg = Image.fromarray((128 + h * 127).astype(np.uint8))
        n = np.asarray(nor)
        ny = Image.fromarray(n[:, :, 1])
        nx = Image.fromarray((128 + n[:, :, 0].astype(np.float32) * 127 / 255).astype(np.uint8))
        for size, suffix in ((1024, ''), (512, '_512')):
            a = diff.resize((size, size), Image.LANCZOS).convert('RGBA')
            a.putalpha(himg.resize((size, size), Image.LANCZOS))
            pa = os.path.join(OUT, f'ground_{name}_a{suffix}.webp')
            a.save(pa, 'WEBP', quality=74, alpha_quality=60, method=6, exact=True)
            total += os.path.getsize(pa)
            print(f'{name}{suffix}: a {os.path.getsize(pa) // 1024} KB')
        nn = Image.merge('LA', (ny.resize((512, 512), Image.LANCZOS), nx.resize((512, 512), Image.LANCZOS)))
        pn = os.path.join(OUT, f'ground_{name}_n.webp')
        nn.save(pn, 'WEBP', quality=78, alpha_quality=70, method=6, exact=True)
        total += os.path.getsize(pn)
        print(f'{name}: n {os.path.getsize(pn) // 1024} KB')
    print('ground total', total // 1024, 'KB')


def pack_stone():
    """Bridge masonry: stone_<name>_a.webp (albedo x AO, sRGB) and stone_<name>_n.webp (GL normal map), 512²."""
    for name, (tid, gain, sat) in STONE.items():
        diff = np.asarray(grade(Image.open(find(f'{tid}_diff')), gain, sat, 1.0)).astype(np.float32)
        ao = np.asarray(Image.open(find(f'{tid}_ao')).convert('L')).astype(np.float32) / 255
        a = Image.fromarray(np.clip(diff * (0.45 + 0.55 * ao[:, :, None]), 0, 255).astype(np.uint8)).resize((512, 512), Image.LANCZOS)
        pa = os.path.join(OUT, f'stone_{name}_a.webp')
        a.save(pa, 'WEBP', quality=80, method=6)
        pn = os.path.join(OUT, f'stone_{name}_n.webp')
        Image.open(find(f'{tid}_nor')).convert('RGB').resize((512, 512), Image.LANCZOS).save(pn, 'WEBP', quality=82, method=6)
        print(f'stone {name}: a {os.path.getsize(pa) // 1024} KB, n {os.path.getsize(pn) // 1024} KB')


# ----------------------------------------------------------------------------------- vegetation atlas

def components(alpha, min_area=600, grid=4):
    """Bounding boxes of connected opaque regions (labelled on a 1/grid mask)."""
    m = np.asarray(alpha.resize((alpha.width // grid, alpha.height // grid), Image.BILINEAR)) > 100
    hgt, wid = m.shape
    seen = np.zeros_like(m)
    out = []
    for y0 in range(hgt):
        for x0 in range(wid):
            if not m[y0, x0] or seen[y0, x0]:
                continue
            stack = [(y0, x0)]
            seen[y0, x0] = True
            xs = [x0, x0]
            ys = [y0, y0]
            area = 0
            own = np.zeros_like(m)
            while stack:
                y, x = stack.pop()
                area += 1
                own[y, x] = True
                xs = [min(xs[0], x), max(xs[1], x)]
                ys = [min(ys[0], y), max(ys[1], y)]
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < hgt and 0 <= xx < wid and m[yy, xx] and not seen[yy, xx]:
                        seen[yy, xx] = True
                        stack.append((yy, xx))
            if area * grid * grid >= min_area:
                mask = Image.fromarray((own * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3)).resize((alpha.width, alpha.height), Image.BILINEAR)
                out.append(((xs[0] - 1) * grid, (ys[0] - 1) * grid, (xs[1] + 2) * grid, (ys[1] + 2) * grid, area * grid * grid, mask))
    return out


def sprites(model, diff_key, alpha_key, keep):
    """RGBA sprites cut from a scanned atlas; `keep(box, sprite)` filters components."""
    diff = Image.open(os.path.join(SRC, f'{model}__{diff_key}.png')).convert('RGB')
    alpha = Image.open(os.path.join(SRC, f'{model}__{alpha_key}.png')).convert('L')
    out = []
    for (x0, y0, x1, y1, area, mask) in components(alpha):
        box = (max(0, x0), max(0, y0), min(diff.width, x1), min(diff.height, y1))
        s = diff.crop(box).convert('RGBA')
        # only this component's texels (neighbours inside the bounding box are masked out)
        s.putalpha(Image.fromarray(np.minimum(np.asarray(alpha.crop(box)), np.asarray(mask.crop(box)))))
        if keep(box, area, s):
            out.append(s)
    return out


def greenness(s):
    a = np.asarray(s).astype(np.float32)
    w = a[:, :, 3:4] / 255
    c = (a[:, :, :3] * w).sum(axis=(0, 1)) / max(1, w.sum())
    return c[1] / max(1, (c[0] + c[2]) / 2)


def tint(s, gain, bright):
    a = np.asarray(s).astype(np.float32)
    a[:, :, :3] = np.clip(a[:, :, :3] * np.array(gain, np.float32) * bright, 0, 255)
    return Image.fromarray(a.astype(np.uint8), 'RGBA')


def stamp(canvas, sprite, cx, cy, angle_deg, length_px, gain=(1, 1, 1), bright=1.0, squash=1.0):
    """Paste `sprite` (its long axis = up in the source) centred at (cx, cy), rotated, scaled to `length_px`."""
    k = length_px / max(sprite.height, 1)
    w = max(2, int(sprite.width * k * squash))
    h = max(2, int(sprite.height * k))
    s = tint(sprite.resize((w, h), Image.LANCZOS), gain, bright).rotate(angle_deg, expand=True, resample=Image.BICUBIC)
    x, y = int(cx - s.width / 2), int(cy - s.height / 2)
    x0, y0, x1, y1 = max(0, x), max(0, y), min(canvas.width, x + s.width), min(canvas.height, y + s.height)
    if x1 > x0 and y1 > y0:
        canvas.alpha_composite(s.crop((x0 - x, y0 - y, x1 - x, y1 - y)), (x0, y0))


def leaf_cluster(rnd, leaves, size, n, leaf_len, twig=(70, 52, 34), gain=(1, 1, 1), spread=0.40, hole=0.0):
    """A round, lacy clump: twigs, then leaves painted back (dark) to front (bright), pointing outward."""
    S = size * 2
    c = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(c)
    cx = cy = S / 2
    R = S * spread
    # twigs from the centre
    for i in range(9):
        a = rnd.uniform(0, math.tau)
        r = R * rnd.uniform(0.55, 0.95)
        mx, my = cx + math.cos(a + 0.3) * r * 0.5, cy + math.sin(a + 0.3) * r * 0.5
        d.line([(cx, cy), (mx, my), (cx + math.cos(a) * r, cy + math.sin(a) * r)], fill=twig + (255,), width=max(2, S // 170), joint='curve')
    for i in range(n):
        t = i / max(1, n - 1)
        a = rnd.uniform(0, math.tau)
        # early (back) leaves reach further out: the rim is thin and dark, the middle full and bright
        r = R * math.sqrt(rnd.uniform(hole, 1.0)) * (1.0 - 0.22 * t)
        x = cx + math.cos(a) * r
        y = cy + math.sin(a) * r
        out_deg = -math.degrees(a) - 90  # sprite tip (up) -> pointing outward
        ang = out_deg + rnd.uniform(-55, 55)
        b = (0.42 + 0.7 * t * t) * rnd.uniform(0.88, 1.12)
        g = (gain[0] * rnd.uniform(0.92, 1.1), gain[1], gain[2] * rnd.uniform(0.85, 1.1))
        stamp(c, rnd.choice(leaves), x, y, ang, leaf_len * 2 * rnd.uniform(0.75, 1.2), g, b, rnd.uniform(0.8, 1.0))
    return c.resize((size, size), Image.LANCZOS)


def fir_bough(rnd, twigs, w, h, gain):
    """A flat conifer bough: a spine from the bottom centre to the top, side twigs shortening to the tip."""
    W, H = w * 2, h * 2
    c = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(c)
    x0, y0, y1 = W / 2, H * 0.97, H * 0.06
    d.line([(x0, y0), (x0, y1)], fill=(64, 46, 30, 255), width=max(3, W // 60))
    n = 20
    for layer in range(2):
        for i in range(n):
            t = (i + 0.5 * layer) / n
            y = y0 + (y1 - y0) * t
            ln = W * (0.5 * (1 - t) ** 0.85 + 0.1)
            for side in (-1, 1):
                ang = side * rnd.uniform(52, 72) * (1 - 0.3 * t)
                rad = math.radians(ang)
                # sprite centre sits half a length out along the twig direction (up = -y)
                px = x0 + math.sin(-rad) * ln * 0.45 * -1
                py = y - math.cos(rad) * ln * 0.45
                b = (0.62 + 0.3 * layer) * rnd.uniform(0.85, 1.12)
                stamp(c, rnd.choice(twigs), px, py, -ang, ln, gain, b, rnd.uniform(0.75, 1.0))
    stamp(c, rnd.choice(twigs), x0, y1 + H * 0.1, 0, H * 0.24, gain, 1.0)
    return c.resize((w, h), Image.LANCZOS)


def reed_clump(rnd, w, h):
    """Upright reed blades (tapered, curved, dark base -> light tip) fanning from the bottom, plus cattail heads."""
    W, H = w * 2, h * 2
    c = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(c)
    n = 46
    for i in range(n):
        t = i / (n - 1)
        bx = W / 2 + rnd.uniform(-0.3, 0.3) * W
        lean = rnd.uniform(-0.34, 0.34) + (bx - W / 2) / W * 0.5
        ln = H * rnd.uniform(0.45, 0.95)
        bend = rnd.uniform(-0.25, 0.25)
        wid = W * rnd.uniform(0.022, 0.04)
        shade = (0.5 + 0.6 * t) * rnd.uniform(0.9, 1.1)
        base = np.array([0.20, 0.30, 0.10]) * shade
        tip = np.array([0.56, 0.62, 0.26]) * shade
        if rnd.random() < 0.15:
            tip = np.array([0.66, 0.58, 0.32]) * shade
        segs = 14
        pts = []
        for k in range(segs + 1):
            u = k / segs
            ang = lean + bend * u * u
            pts.append((bx + math.sin(ang) * ln * u, H * 0.995 - math.cos(ang) * ln * u, wid * (1 - u) ** 0.7))
        for k in range(segs):
            (xa, ya, wa), (xb, yb, wb) = pts[k], pts[k + 1]
            col = base + (tip - base) * ((k + 0.5) / segs)
            fill = tuple(int(max(0, min(1, v)) * 255) for v in col) + (255,)
            d.polygon([(xa - wa, ya), (xa + wa, ya), (xb + wb, yb), (xb - wb, yb)], fill=fill)
        if i % 9 == 4:
            xe, ye, _ = pts[-1]
            hl = H * 0.075
            ang = lean + bend
            d.line([(xe, ye), (xe - math.sin(ang) * hl, ye + math.cos(ang) * hl)], fill=(92, 58, 32, 255), width=max(6, W // 26))
    return c.resize((w, h), Image.LANCZOS)


def bark_strip(tid, w, h, pad, gain):
    """Tileable bark column: content w - 2 * pad wide with wrapped padding left / right, h tall (tiles vertically)."""
    src = grade(Image.open(find(f'{tid}_diff')), gain, 0.9, 1.0)
    inner = w - 2 * pad
    tile = src.resize((inner, h // 2), Image.LANCZOS)
    col = Image.new('RGB', (inner, h))
    col.paste(tile, (0, 0))
    col.paste(tile, (0, h // 2))
    out = Image.new('RGBA', (w, h), (0, 0, 0, 255))
    out.paste(col, (pad, 0))
    out.paste(col.crop((inner - pad, 0, inner, h)), (0, 0))
    out.paste(col.crop((0, 0, pad, h)), (pad + inner, 0))
    return out


def bleed(img):
    """Fill RGB under transparent texels with nearby opaque colour (no dark halos when filtered)."""
    a = np.asarray(img).astype(np.float32) / 255
    alpha = a[:, :, 3]
    rgb = a[:, :, :3].copy()
    filled = alpha > 0.03
    pm = Image.fromarray((np.clip(rgb * alpha[:, :, None], 0, 1) * 255).astype(np.uint8))
    am = Image.fromarray((alpha * 255).astype(np.uint8))
    for radius in (2, 5, 12, 30, 80):
        bp = np.asarray(pm.filter(ImageFilter.GaussianBlur(radius))).astype(np.float32) / 255
        ba = np.asarray(am.filter(ImageFilter.GaussianBlur(radius))).astype(np.float32) / 255
        ok = (~filled) & (ba > 0.004)
        rgb[ok] = (bp[ok] / ba[ok][:, None])
        filled |= ok
    rgb[~filled] = rgb[filled].mean(axis=0) if filled.any() else 0
    out = np.dstack([np.clip(rgb, 0, 1), alpha])
    return Image.fromarray((out * 255 + 0.5).astype(np.uint8), 'RGBA')


def pack_veg():
    rnd = random.Random(7)
    big = lambda box, area, s: area > 9000
    oak = sprites('island_tree_02', 'leaves_diff', 'leaves_alpha', big)
    birch = sprites('shrub_03', 'Diffuse', 'Alpha', lambda b, area, s: area > 9000 and 0.6 < s.width / s.height < 1.5 and greenness(s) > 1.15)
    bush = sprites('shrub_01', 'Diffuse', 'Alpha', lambda b, area, s: area > 6000 and greenness(s) > 1.25 and b[3] < 700)
    twigs = sprites('fir_tree_01', 'twig_diff', 'twig_alpha', lambda b, area, s: area > 4000 and b[0] > 170 and b[3] < 760 and s.height > 80)
    print('sprites: oak', len(oak), 'birch', len(birch), 'bush', len(bush), 'fir twigs', len(twigs))
    atlas = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    atlas.alpha_composite(leaf_cluster(rnd, oak, 512, 380, 60, gain=(0.86, 1.0, 0.72), spread=0.43), (0, 0))
    atlas.alpha_composite(leaf_cluster(rnd, birch, 512, 300, 42, twig=(96, 88, 76), gain=(0.96, 1.06, 0.66), spread=0.43), (512, 0))
    atlas.alpha_composite(fir_bough(rnd, twigs, 320, 512, (0.62, 1.0, 0.72)), (0, 512))
    atlas.alpha_composite(leaf_cluster(rnd, bush + oak[:3], 320, 240, 44, gain=(0.84, 1.0, 0.66), spread=0.45), (320, 512 + 96))
    atlas.alpha_composite(reed_clump(rnd, 192, 512), (640, 512))
    atlas = bleed(atlas)
    for i, (tid, gain) in enumerate(zip(BARK, ((0.95, 0.9, 0.82), (1.0, 0.92, 0.84), (1.5, 1.5, 1.45)))):
        atlas.paste(bark_strip(tid, 64, 512, 12, gain), (832 + i * 64, 512))
    p = os.path.join(OUT, 'veg_atlas.webp')
    atlas.save(p, 'WEBP', quality=86, alpha_quality=90, method=6, exact=True)
    prev = Image.new('RGBA', atlas.size, (120, 120, 130, 255))
    prev.alpha_composite(atlas)
    prev.convert('RGB').save(os.path.join(ROOT, 'art-work', 'env', 'veg_atlas_preview.png'))
    print('veg atlas', os.path.getsize(p) // 1024, 'KB')


if __name__ == '__main__':
    only = sys.argv[sys.argv.index('--only') + 1] if '--only' in sys.argv else None
    fetch()
    if only in (None, 'ground'):
        pack_ground()
    if only in (None, 'stone'):
        pack_stone()
    if only in (None, 'veg'):
        pack_veg()
