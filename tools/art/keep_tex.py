"""Keep material textures: per faction one albedo strip + one normal strip (8 tiling layers of 512 px stacked
vertically; the renderer slices them into texture arrays) and a banner (RGB cloth, A = 128 + team mask * 127).

    python tools/art/keep_tex.py [--fetch]

In : CC0 Poly Haven scans in art-work/keep/src/ (--fetch downloads the 1k maps), emblem silhouettes
     art-work/keep/gen/emblem_<faction>.png (Codex image generation, black on white).
Out: public/textures/keep/<faction>_a.webp, <faction>_n.webp, <faction>_banner.webp

Layer order (tools/art/blender/keep_kit.py LAYERS and src/render/terrain/keep-art.ts must agree):
    0 wall  1 trim (dressed stone)  2 roof  3 wood  4 metal  5 accent  6 floor  7 plain
"""
import json, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
SRC = os.path.join(ROOT, 'art-work', 'keep', 'src')
GEN = os.path.join(ROOT, 'art-work', 'keep', 'gen')
OUT = os.path.join(ROOT, 'public', 'textures', 'keep')
S = 512

# layer -> (source id | procedural name, saturation, tint rgb, mean luminance, contrast, normal strength)
SETS = {
    'kingdom': [
        ('medieval_blocks_03', 0.35, (1.00, 1.00, 1.00), 0.50, 1.15, 1.0),      # wall: grey ashlar
        ('sandstone_blocks_08', 0.30, (1.00, 0.99, 0.97), 0.55, 2.2, 1.3),      # trim: pale dressed limestone
        ('grey_roof_tiles_02', 0.55, (0.86, 0.95, 1.12), 0.30, 1.3, 1.2),        # roof: blue-grey slate
        ('weathered_planks', 0.8, (1.05, 0.98, 0.90), 0.16, 1.2, 1.0),          # wood
        ('metal_plate_02', 0.15, (0.95, 1.0, 1.08), 0.11, 1.3, 0.8),            # iron
        ('medieval_wall_01', 0.5, (1.0, 0.98, 0.92), 0.62, 0.9, 0.7),           # plaster
        ('cobblestone_floor_08', 0.5, (1.0, 1.0, 1.0), 0.30, 1.1, 1.0),         # floor
        ('@plain', 0, (1, 1, 1), 0.9, 1, 0),
    ],
    'ashen': [
        ('stone_wall_04', 0.30, (0.88, 0.98, 1.04), 0.30, 1.25, 1.2),           # wall: charcoal crypt stone
        ('medieval_blocks_03', 0.2, (0.90, 1.0, 1.04), 0.24, 1.5, 1.0),         # trim: black basalt ashlar
        ('metal_plate_02', 0.5, (0.74, 1.0, 1.02), 0.25, 1.7, 1.3),             # roof: iron plates
        ('weathered_planks', 0.3, (0.9, 1.0, 0.95), 0.11, 1.2, 1.0),            # wood: charred
        ('rusty_metal_04', 0.45, (0.9, 0.95, 0.9), 0.17, 1.3, 0.8),             # iron, rusted
        ('medieval_wall_01', 0.55, (1.0, 0.95, 0.80), 0.60, 1.25, 0.9),         # bone
        ('cobblestone_floor_08', 0.2, (0.9, 1.0, 1.0), 0.22, 1.2, 1.0),         # floor
        ('@plain', 0, (1, 1, 1), 0.9, 1, 0),
    ],
    'caliphate': [
        ('sandstone_blocks_05', 1.25, (1.16, 0.98, 0.72), 0.60, 0.9, 1.0),      # wall: warm sandstone
        ('sandstone_blocks_08', 0.7, (1.05, 0.99, 0.86), 0.66, 1.9, 1.2),       # trim: smooth pale ashlar
        ('@teal_tile', 1, (1, 1, 1), 0, 1, 1.0),                                # roof: glazed teal tile
        ('weathered_planks', 1.0, (1.12, 0.95, 0.80), 0.20, 1.2, 1.0),          # wood: warm cedar
        ('metal_plate_02', 0.5, (1.30, 1.0, 0.42), 0.52, 0.9, 0.6),             # brass
        ('@star_tile', 1, (1, 1, 1), 0, 1, 0.8),                                # geometric tilework
        ('sandstone_blocks_08', 0.7, (1.05, 0.98, 0.86), 0.52, 1.6, 1.0),       # floor: paved sandstone
        ('@plain', 0, (1, 1, 1), 0.9, 1, 0),
    ],
}
CREDITS = sorted({l[0] for v in SETS.values() for l in v if not l[0].startswith('@')})


def http(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'env-fetch/1.0'}), timeout=120).read()


def fetch():
    os.makedirs(SRC, exist_ok=True)

    def one(tid):
        d = json.loads(http('https://api.polyhaven.com/files/' + tid))
        for short, key in {'diff': 'Diffuse', 'nor': 'nor_gl', 'ao': 'AO'}.items():
            if key not in d:
                continue
            f = d[key]['1k'].get('jpg') or d[key]['1k']['png']
            p = os.path.join(SRC, f'{tid}_{short}.{f["url"].rsplit(".", 1)[1]}')
            if not os.path.exists(p):
                open(p, 'wb').write(http(f['url']))
                print('fetched', os.path.basename(p))
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(one, CREDITS))


def load(tid, short, mode='RGB'):
    for ext in ('jpg', 'png'):
        p = os.path.join(SRC, f'{tid}_{short}.{ext}')
        if os.path.exists(p):
            return np.asarray(Image.open(p).convert(mode).resize((S, S), Image.LANCZOS), np.float32) / 255
    return None


def lum(a):
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def grade(a, sat, tint, mean, contrast):
    g = lum(a)[..., None]
    a = g + (a - g) * sat
    a = a * np.asarray(tint, np.float32)
    m = float(lum(a).mean())
    a = (a - m) * contrast + m
    a = a * (mean / max(1e-4, float(lum(np.clip(a, 0, 1)).mean())))
    return np.clip(a, 0, 1)


def normal_from_height(h, strength):
    """Tiling GL normal map (RGB) of a height field in 0..1."""
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    n = np.stack([-dx * strength * S / 64, dy * strength * S / 64, np.ones_like(h)], -1)   # image rows run down: +Y up
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def tile_noise(rng, n, octaves=4):
    """Seamless value noise in 0..1."""
    out = np.zeros((S, S), np.float32)
    amp = 1.0
    tot = 0
    for o in range(octaves):
        k = n * 2 ** o
        g = rng.random((k, k)).astype(np.float32)
        im = Image.fromarray((np.tile(g, (3, 3)) * 255).astype(np.uint8)).resize((S * 3, S * 3), Image.BICUBIC)
        out += amp * np.asarray(im, np.float32)[S:2 * S, S:2 * S] / 255
        tot += amp
        amp *= 0.5
    return out / tot


def plain():
    rng = np.random.default_rng(7)
    v = 0.9 + 0.1 * tile_noise(rng, 8, 3)
    return np.repeat(v[..., None], 3, -1), np.full((S, S, 3), (0.5, 0.5, 1.0), np.float32)


def teal_tile():
    """Glazed fish-scale roof tiles: 10 columns x 12 courses, half-offset courses, rounded lower edge."""
    rng = np.random.default_rng(11)
    cols, rows = 10, 12
    y, x = np.mgrid[0:S, 0:S].astype(np.float32)
    u = x / S * cols
    v = (S - 1 - y) / S * rows                       # v up
    r = np.floor(v)
    uu = u + 0.5 * (r % 2)
    c = np.floor(uu) % cols
    fx = uu - np.floor(uu) - 0.5                     # -0.5..0.5 across a tile
    fy = v - r                                       # 0 lower edge .. 1 upper (covered by the next course)
    # rounded lower edge: distance from the tile's arc
    edge = np.sqrt(fx ** 2 + np.maximum(0.55 - fy, 0) ** 2 * 0.8)
    inside = edge < 0.5
    h = np.where(inside, 0.35 + 0.65 * fy, 0.15)     # each course tilts up towards its lower lip... (lower lip highest)
    h = np.where(inside, 1.0 - 0.6 * fy - 0.25 * (edge / 0.5) ** 6, 0.2)
    pal = np.array([[0.06, 0.42, 0.44], [0.08, 0.50, 0.50], [0.05, 0.36, 0.42], [0.10, 0.55, 0.52], [0.07, 0.45, 0.50], [0.04, 0.30, 0.38]], np.float32)
    idx = rng.integers(0, len(pal), (rows, cols))
    col = pal[idx[r.astype(int) % rows, c.astype(int)]]
    shade = (0.72 + 0.28 * h) * (0.9 + 0.2 * tile_noise(rng, 16, 3))
    a = col * shade[..., None]
    gap = np.array([0.03, 0.12, 0.14], np.float32)
    a = np.where(inside[..., None], a, gap)
    # a thin glaze highlight under each lip
    a += (np.clip(1 - np.abs(fy - 0.12) * 14, 0, 1) * inside * 0.10)[..., None]
    hb = np.asarray(Image.fromarray((h * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255
    return np.clip(a, 0, 1), normal_from_height(hb, 2.2)


def star_tile():
    """Girih-like tilework: 4 x 4 eight-pointed stars (turquoise on cobalt, white outlines, gold centres)."""
    rng = np.random.default_rng(13)
    n = 4
    y, x = np.mgrid[0:S, 0:S].astype(np.float32)
    px = (x / S * n) % 1 * 2 - 1
    py = (y / S * n) % 1 * 2 - 1
    ax, ay = np.abs(px), np.abs(py)
    d1 = np.maximum(ax, ay)
    d2 = (ax + ay) / np.sqrt(2)
    star = np.minimum(d1, d2)
    # diamonds on the cell corners
    cx, cy = 1 - ax, 1 - ay
    dia = cx + cy
    cob = np.array([0.05, 0.17, 0.36], np.float32)
    tur = np.array([0.08, 0.52, 0.54], np.float32)
    wht = np.array([0.86, 0.84, 0.76], np.float32)
    gld = np.array([0.78, 0.56, 0.16], np.float32)
    a = np.empty((S, S, 3), np.float32)
    a[:] = cob
    a[dia < 0.42] = tur
    a[(dia >= 0.42) & (dia < 0.52)] = wht
    a[star < 0.66] = wht
    a[star < 0.56] = tur
    a[star < 0.27] = wht
    a[star < 0.20] = gld
    a *= (0.88 + 0.24 * tile_noise(rng, 32, 2))[..., None]
    grout = ((np.abs(star - 0.56) < 0.012) | (np.abs(star - 0.66) < 0.012) | (np.abs(star - 0.27) < 0.012) | (np.abs(dia - 0.42) < 0.02)).astype(np.float32)
    h = 1 - np.asarray(Image.fromarray((grout * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.0)), np.float32) / 255
    a = np.asarray(Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6)), np.float32) / 255
    return a, normal_from_height(h, 1.2)


PROC = {'@plain': plain, '@teal_tile': teal_tile, '@star_tile': star_tile}


def layer(spec):
    tid, sat, tint, mean, contrast, nstr = spec
    if tid in PROC:
        return PROC[tid]()
    a = load(tid, 'diff')
    if a is None:
        raise SystemExit(f'missing art-work/keep/src/{tid}_diff.*  (run with --fetch)')
    ao = load(tid, 'ao', 'L')
    if ao is not None:
        a = a * (0.35 + 0.65 * ao[..., None])
    a = grade(a, sat, tint, mean, contrast)
    n = load(tid, 'nor')
    if n is None:
        n = np.full((S, S, 3), (0.5, 0.5, 1.0), np.float32)
    else:
        v = n * 2 - 1
        v[..., :2] *= nstr
        v /= np.linalg.norm(v, axis=-1, keepdims=True)
        n = v * 0.5 + 0.5
    return a, n


BANNER = {
    # field shade (multiplied by the team colour), border / emblem colour, second colour (stripe)
    'kingdom': dict(emblem=(0.86, 0.66, 0.22), border=(0.80, 0.60, 0.20), stripe=(0.90, 0.86, 0.74)),
    'ashen': dict(emblem=(0.84, 0.80, 0.66), border=(0.10, 0.11, 0.10), stripe=(0.30, 0.62, 0.22)),
    'caliphate': dict(emblem=(0.90, 0.70, 0.22), border=(0.86, 0.82, 0.70), stripe=(0.08, 0.50, 0.50)),
}


def banner(faction):
    """256 x 512 cloth: v 0..1 runs down the hanging banner; u across. A = 128 + team mask * 127."""
    W, H = 256, 512
    spec = BANNER[faction]
    rng = np.random.default_rng(31)
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    u, v = x / W, y / H
    weave = 0.90 + 0.05 * np.sin(x * np.pi / 1.5) * np.sin(y * np.pi / 1.5)
    n = np.asarray(Image.fromarray((rng.random((H // 8, W // 8)) * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC), np.float32) / 255
    folds = 0.93 + 0.07 * np.sin(u * np.pi * 5 + n * 1.5)                 # soft vertical fold shading
    shade = weave * folds * (0.9 + 0.2 * n)
    rgb = np.repeat((0.95 * shade)[..., None], 3, -1)
    mask = np.ones((H, W), np.float32)

    def paint(sel, col):
        rgb[sel] = np.asarray(col, np.float32) * shade[sel][..., None]
        mask[sel] = 0

    b = 0.075
    paint((u < b) | (u > 1 - b) | (v < b * 0.5), spec['border'])
    paint(((u > b + 0.03) & (u < b + 0.05)) | ((u < 1 - b - 0.03) & (u > 1 - b - 0.05)), spec['stripe'])
    paint((np.abs(v - 0.72) < 0.012) | (np.abs(v - 0.09) < 0.012), spec['stripe'])
    # emblem silhouette, centred at v = 0.4
    p = os.path.join(GEN, f'emblem_{faction}.png')
    if os.path.exists(p):
        e = Image.open(p).convert('L')
        bb = Image.eval(e, lambda t: 255 - t).getbbox()
        e = e.crop(bb)
        ew = int(W * 0.66)
        eh = int(ew * e.size[1] / e.size[0])
        if eh > H * 0.5:
            eh = int(H * 0.5)
            ew = int(eh * e.size[0] / e.size[1])
        e = e.resize((ew, eh), Image.LANCZOS)
        full = Image.new('L', (W, H), 255)
        full.paste(e, ((W - ew) // 2, int(H * 0.40) - eh // 2))
        k = 1 - np.asarray(full, np.float32) / 255
        col = np.asarray(spec['emblem'], np.float32)
        rgb[:] = rgb * (1 - k[..., None]) + col * shade[..., None] * k[..., None]
        mask[:] = mask * (1 - k)
    else:
        print(f'warning: no emblem for {faction} ({p})')
    out = np.dstack([np.clip(rgb, 0, 1) * 255, 128 + mask * 127]).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(os.path.join(OUT, f'{faction}_banner.webp'), quality=90, method=6, exact=True)


def main():
    if '--fetch' in sys.argv:
        fetch()
    os.makedirs(OUT, exist_ok=True)
    for faction, layers in SETS.items():
        A = np.zeros((S * len(layers), S, 3), np.uint8)
        N = np.zeros((S * len(layers), S, 3), np.uint8)
        for i, spec in enumerate(layers):
            a, n = layer(spec)
            A[i * S:(i + 1) * S] = (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)
            N[i * S:(i + 1) * S] = (np.clip(n, 0, 1) * 255 + 0.5).astype(np.uint8)
        Image.fromarray(A).save(os.path.join(OUT, f'{faction}_a.webp'), quality=86, method=6)
        Image.fromarray(N).save(os.path.join(OUT, f'{faction}_n.webp'), quality=84, method=6)
        banner(faction)
        Image.fromarray(A).resize((S // 2, S * len(layers) // 2)).save(os.path.join(ROOT, 'art-work', 'keep', f'preview_{faction}_a.jpg'))
        sizes = [os.path.getsize(os.path.join(OUT, f'{faction}_{k}.webp')) // 1024 for k in ('a', 'n', 'banner')]
        print(f'{faction}: albedo {sizes[0]} KB, normal {sizes[1]} KB, banner {sizes[2]} KB')
    print('sources (CC0, polyhaven.com):', ', '.join(CREDITS))


if __name__ == '__main__':
    main()
