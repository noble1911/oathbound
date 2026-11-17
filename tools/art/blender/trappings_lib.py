"""Authored-part toolkit (docs/ART.md section 10): geometry helpers with authoring UVs, texture sources (flat
Codex art, CC0 scans, numpy procedural tiles) and the texture composer that turns a set of pieces into ONE mesh
with ONE atlas (basecolour, normal, metal/rough, team mask) -- no ray bake, CPU only, texels copied at native
resolution. Derived from art-work/elephant-ab/tools/b_lib.py / b_mats.py / b_bake.py (the A/B test's candidate B).

Authoring UV convention of a piece:
  * image source (flat art): u, v in 0..1 over the (cropped) image, v up
  * tile source: u, v in METRES on the surface (the source repeats every `tile` metres)
Images are numpy (H, W, C) arrays, row 0 = bottom (Blender), colour in sRGB display values.
"""
import math, os
from pathlib import Path
import bpy, bmesh
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[3]
FLAT = ROOT / 'art-work' / 'flat'
SCANS = ROOT / 'art-work' / 'keep' / 'src'          # CC0 Poly Haven 1k maps (tools/art/keep_tex.py --fetch)
F32 = np.float32


# =============================================================================================== numpy images
def load_px(path):
    img = bpy.data.images.load(str(path), check_existing=True)
    w, h = img.size
    a = np.empty(w * h * 4, F32); img.pixels.foreach_get(a)
    a = a.reshape(h, w, 4)
    if img.is_float:                                    # 16-bit files arrive linear: back to display values
        rgb = a[..., :3]
        a = a.copy(); a[..., :3] = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.clip(rgb, 1e-6, None) ** (1 / 2.4) - 0.055)
    return a


def resize(a, w, h):
    """Area-ish resize (box prefilter + bilinear). a: (H, W[, C])."""
    H, W = a.shape[:2]
    while W >= 2 * w and H >= 2 * h and W % 2 == 0 and H % 2 == 0:
        a = 0.25 * (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2]); H, W = a.shape[:2]
    if (W, H) == (w, h):
        return a
    ys = (np.arange(h) + 0.5) / h * H - 0.5; xs = (np.arange(w) + 0.5) / w * W - 0.5
    return bilinear(a, xs[None, :].repeat(h, 0), ys[:, None].repeat(w, 1), False)


def bilinear(a, X, Y, wrap):
    """Sample a at pixel-centre coordinates X, Y (arrays of the same shape)."""
    H, W = a.shape[:2]
    x0 = np.floor(X).astype(np.int64); y0 = np.floor(Y).astype(np.int64)
    fx = (X - x0).astype(F32); fy = (Y - y0).astype(F32)
    if wrap:
        x1 = (x0 + 1) % W; y1 = (y0 + 1) % H; x0 %= W; y0 %= H
    else:
        x1 = np.clip(x0 + 1, 0, W - 1); y1 = np.clip(y0 + 1, 0, H - 1); x0 = np.clip(x0, 0, W - 1); y0 = np.clip(y0, 0, H - 1)
    if a.ndim == 3:
        fx = fx[..., None]; fy = fy[..., None]
    return (a[y0, x0] * (1 - fx) + a[y0, x1] * fx) * (1 - fy) + (a[y1, x0] * (1 - fx) + a[y1, x1] * fx) * fy


def blur(a, k):
    if k <= 1:
        return a
    p = k // 2
    a2 = np.pad(a, [(p, p), (p, p)] + [(0, 0)] * (a.ndim - 2), mode='wrap')
    c = np.cumsum(np.cumsum(a2, 0, dtype=np.float64), 1)
    c = np.pad(c, [(1, 0), (1, 0)] + [(0, 0)] * (a.ndim - 2))
    k2 = 2 * p + 1
    return ((c[k2:, k2:] - c[:-k2, k2:] - c[k2:, :-k2] + c[:-k2, :-k2]) / (k2 * k2)).astype(F32)


def hsv(rgb):
    mx = rgb.max(2); mn = rgb.min(2); d = mx - mn + 1e-6
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) / 6.0
    return h, d / (mx + 1e-6), mx


def fbm(n, beta=1.6, seed=0, aniso=(1.0, 1.0)):
    """Tileable fractal noise in 0..1 (spectral synthesis). aniso > 1 stretches features along that axis (x, y)."""
    rng = np.random.default_rng(seed)
    fy = np.fft.fftfreq(n)[:, None] * n * aniso[1]; fx = np.fft.fftfreq(n)[None, :] * n * aniso[0]
    amp = 1.0 / (np.sqrt(fx * fx + fy * fy) + 1.0) ** beta; amp[0, 0] = 0
    a = np.fft.ifft2(amp * np.exp(2j * math.pi * rng.random((n, n)))).real
    lo, hi = np.percentile(a, 1), np.percentile(a, 99)
    return np.clip((a - lo) / (hi - lo), 0, 1).astype(F32)


def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# =============================================================================================== sources
class Src:
    """A texture source. col (H, W, 3); team (H, W) | None; h (H, W) height 0..1 | None; rough / metal: float or
    (H, W); tile: (metres per repeat in u, in v) | None for an image mapped 0..1; bump: relief in metres;
    solid: (H, W) bool silhouette of art isolated on black."""
    def __init__(self, col, team=None, h=None, rough=0.7, metal=0.0, tile=None, bump=0.004, solid=None, name=''):
        self.col = np.ascontiguousarray(col, F32); self.team = team; self.h = h; self.rough = rough; self.metal = metal
        self.tile = (tile, tile) if isinstance(tile, (int, float)) else tile
        self.bump = bump; self.solid = solid; self.name = name
        self._mips = {}

    def chan(self, key):
        v = getattr(self, key)
        H, W = self.col.shape[:2]
        if v is None:
            return np.zeros((H, W), F32) if key == 'team' else (self.col.mean(2) if key == 'h' else None)
        if np.isscalar(v):
            return np.full((H, W), v, F32)
        return v

    def mip(self, level):
        """(col, team, h, rough, metal) reduced by 2**level (box filter)."""
        if level not in self._mips:
            arrs = [self.col, self.chan('team'), self.chan('h'), self.chan('rough'), self.chan('metal')]
            for _ in range(level):
                if min(arrs[0].shape[:2]) < 8:
                    break
                arrs = [0.25 * (a[0:a.shape[0] // 2 * 2:2, 0:a.shape[1] // 2 * 2:2] + a[1::2, 0:a.shape[1] // 2 * 2:2]
                                + a[0:a.shape[0] // 2 * 2:2, 1::2] + a[1::2, 1::2]) for a in arrs]
            self._mips[level] = arrs
        return self._mips[level]

    def variant(self, tint=None, rough=None, metal=None, team=None, gain=1.0, name=None):
        col = np.clip(self.col * (np.array(tint, F32) if tint is not None else 1.0) * gain, 0, 1)
        return Src(col, self.team if team is None else team, self.h, self.rough if rough is None else rough,
                   self.metal if metal is None else metal, self.tile, self.bump, self.solid, name or self.name)


SRC = {}
TEAM_GREY = 0.80          # display value of neutralised team cloth (docs/ART.md section 3)


def key_team(px, hue=(0.80, 0.99), sat=0.45, val=0.15):
    """Flat art paints team cloth vivid magenta. -> (colour with the cloth neutralised to light grey, mask)."""
    rgb = px[..., :3]
    h_, s_, v_ = hsv(rgb)
    m = ((h_ > hue[0]) & (h_ < hue[1]) & (s_ > sat) & (v_ > val)).astype(F32)
    if m.mean() < 0.002:
        return rgb.copy(), None
    m = np.clip(blur(m, 3), 0, 1)
    lum = rgb.max(2)
    med = float(np.median(lum[m > 0.9])) if (m > 0.9).any() else 0.7
    grey = np.clip(lum / med * TEAM_GREY, 0, 1)                 # keeps the weave shading
    return rgb * (1 - m[..., None]) + grey[..., None] * m[..., None], m


def flat(name, crop=None, rough=0.8, metal=0.0, metal_gold=None, bump=0.004, fallback=(0.6, 0.6, 0.6)):
    """Source from art-work/flat/<name>.png. crop = (u0, v0, u1, v1) fractions (v up). metal_gold: metalness given
    to warm saturated (gold / brass) texels. Missing file -> a plain checker so builds never fail."""
    key = (name, crop, rough, metal, metal_gold, bump)
    if key in SRC:
        return SRC[key]
    f = FLAT / f'{name}.png'
    if f.exists():
        px = load_px(f)
    else:
        print(f'[trappings] MISSING flat art {f} (node tools/art/flat.mjs {name}); using a placeholder')
        n = 256
        v, u = np.mgrid[0:n, 0:n]
        chk = (((u // 32) + (v // 32)) % 2).astype(F32) * 0.15 + 0.85
        px = np.ones((n, n, 4), F32); px[..., :3] = np.array(fallback, F32) * chk[..., None]
    if crop:
        H, W = px.shape[:2]
        px = px[int(crop[1] * H):int(crop[3] * H), int(crop[0] * W):int(crop[2] * W)]
    col, team = key_team(px)
    lum = px[..., :3].max(2)
    solid = blur((lum > 0.06).astype(F32), 5) > 0.5
    h_, s_, v_ = hsv(col)
    mt = metal
    if metal_gold is not None:
        gold = smooth(s_, 0.35, 0.6) * ((h_ > 0.04) & (h_ < 0.19)) * smooth(v_, 0.3, 0.6)
        mt = (metal + (metal_gold - metal) * gold).astype(F32)
        rough = (rough - 0.35 * gold).astype(F32)
    s = Src(col, team, col.mean(2), rough, mt, None, bump, solid, name)
    SRC[key] = s
    return s


def _scan(stem, n=512):
    f = SCANS / f'{stem}_diff.jpg'
    if not f.exists():
        return None
    col = resize(load_px(f)[..., :3], n, n)
    return col


def _metal_tile(n, base, seed, dimple=0.5, blotch=None, blotch_amt=0.0):
    a = fbm(n, 1.2, seed); b = fbm(n, 2.2, seed + 1)
    d = fbm(n, 0.4, seed + 2)
    h = 0.5 + 0.35 * (a - 0.5) - dimple * 0.4 * smooth(d, 0.62, 0.9)
    col = np.array(base, F32)[None, None] * (0.78 + 0.34 * a[..., None]) * (0.92 + 0.16 * b[..., None])
    if blotch is not None:
        k = (smooth(b, 0.55, 0.8) * blotch_amt)[..., None]
        col = col * (1 - k) + np.array(blotch, F32) * (0.8 + 0.3 * a[..., None]) * k
    return np.clip(col, 0, 1), np.clip(h, 0, 1)


def tile(name):
    """Named tiling sources (512 px). Wood / iron come from the CC0 scans when present, else procedural."""
    if name in SRC:
        return SRC[name]
    n = 512
    s = None
    if name in ('oak', 'wood_dark', 'wood_grey'):
        scan = _scan('weathered_planks' if name != 'wood_dark' else 'dark_wooden_planks')
        if scan is None:
            g = fbm(n, 1.4, 5, aniso=(0.06, 1.0))
            scan = np.array((0.42, 0.3, 0.2), F32)[None, None] * (0.6 + 0.8 * g[..., None])
        scan = np.ascontiguousarray(np.transpose(scan, (1, 0, 2)))       # the scans' planks run along v: grain along u
        lum = scan.mean(2, keepdims=True)
        tint = dict(oak=(1.18, 0.84, 0.52), wood_dark=(0.78, 0.6, 0.46), wood_grey=(0.86, 0.8, 0.72))[name]
        col = np.clip((lum * 0.45 + scan * 0.55) * np.array(tint, F32) * dict(oak=1.25, wood_dark=1.0, wood_grey=1.0)[name], 0, 1)
        s = Src(col, None, smooth(lum[..., 0], 0.1, 0.6), 0.72, 0.0, 1.2, 0.006)
    elif name in ('iron', 'steel', 'iron_dark'):
        scan = _scan('metal_plate_02')
        if scan is None:
            col, h = _metal_tile(n, (0.42, 0.43, 0.46), 11)
        else:
            lum = scan.mean(2, keepdims=True)
            col = np.clip(lum * np.array(dict(iron=(0.9, 0.92, 1.0), steel=(1.25, 1.28, 1.36), iron_dark=(0.6, 0.6, 0.64))[name], F32), 0, 1)
            h = smooth(lum[..., 0], 0.1, 0.7)
        s = Src(col, None, h, 0.42 if name == 'steel' else 0.5, 0.85, 0.8, 0.003)
    elif name == 'rust':
        scan = _scan('rusty_metal_04')
        if scan is None:
            scan, _ = _metal_tile(n, (0.36, 0.2, 0.12), 13)
        s = Src(np.clip(scan * 0.9, 0, 1), None, scan.mean(2), 0.75, 0.5, 0.8, 0.004)
    elif name == 'bronze':                               # Ashen Covenant: corroded bronze with verdigris
        col, h = _metal_tile(n, (0.50, 0.33, 0.16), 21, blotch=(0.22, 0.47, 0.38), blotch_amt=0.75)
        s = Src(col, None, h, 0.55, 0.6, 0.5, 0.004)
    elif name in ('gold', 'brass'):                      # Sun Caliphate: burnished, not a gradient
        col, h = _metal_tile(n, (0.86, 0.60, 0.20) if name == 'gold' else (0.74, 0.56, 0.26), 31, dimple=0.8)
        s = Src(col, None, h, 0.36, 0.8, 0.4, 0.003)
    elif name == 'bone':
        f = FLAT / 'tile_bone.png'
        if f.exists():
            col = resize(load_px(f)[..., :3], n, n)
            col = col / blur(col, 201).clip(0.05) * col.mean((0, 1))        # flatten any lighting gradient
        else:
            a = fbm(n, 1.5, 41); c = fbm(n, 0.8, 42)
            col = np.array((0.80, 0.74, 0.60), F32)[None, None] * (0.82 + 0.25 * a[..., None]) * (1 - 0.35 * smooth(c, 0.78, 0.9)[..., None])
        s = Src(np.clip(col, 0, 1), None, col.mean(2), 0.6, 0.0, 0.6, 0.004)
    elif name == 'rope':
        v, u = np.mgrid[0:n, 0:n].astype(F32) / n
        st = 0.5 + 0.5 * np.sin(2 * math.pi * (u * 8 + v * 4))
        fib = fbm(n, 0.8, 51, aniso=(1.0, 0.2))
        col = np.array((0.62, 0.50, 0.30), F32)[None, None] * (0.55 + 0.5 * st[..., None]) * (0.85 + 0.3 * fib[..., None])
        s = Src(np.clip(col, 0, 1), None, st, 0.9, 0.0, (0.16, 0.16), 0.006)
    elif name == 'leather' or name == 'leather_dark' or name == 'leather_red':
        a = fbm(n, 1.3, 61); p = fbm(n, 0.3, 62)
        base = dict(leather=(0.36, 0.2, 0.1), leather_dark=(0.16, 0.1, 0.07), leather_red=(0.42, 0.12, 0.08))[name]
        col = np.array(base, F32)[None, None] * (0.7 + 0.6 * a[..., None]) * (1 - 0.25 * smooth(p, 0.7, 0.95)[..., None])
        s = Src(np.clip(col, 0, 1), None, 0.6 * a + 0.4 * (1 - smooth(p, 0.7, 0.95)), 0.6, 0.0, 0.5, 0.003)
    elif name.startswith('cloth'):                       # cloth_team | cloth_cream | cloth_dark | cloth_turquoise | cloth_red | cloth_black
        v, u = np.mgrid[0:n, 0:n].astype(F32) / n
        thr = (0.5 + 0.5 * np.sin(2 * math.pi * u * 64)) * (0.5 + 0.5 * np.sin(2 * math.pi * v * 64))
        fold = fbm(n, 2.2, 71)
        base = dict(cloth_team=(TEAM_GREY,) * 3, cloth_cream=(0.80, 0.72, 0.56), cloth_dark=(0.14, 0.12, 0.13), cloth_turquoise=(0.05, 0.56, 0.52),
                    cloth_red=(0.55, 0.1, 0.08), cloth_black=(0.07, 0.07, 0.08), cloth_grey=(0.42, 0.40, 0.38)).get(name, (0.6, 0.6, 0.6))
        col = np.array(base, F32)[None, None] * (0.86 + 0.1 * thr[..., None] + 0.12 * (fold[..., None] - 0.5))
        s = Src(np.clip(col, 0, 1), np.ones((n, n), F32) if name == 'cloth_team' else None, 0.5 * thr + 0.5 * fold, 0.85, 0.0, 0.25, 0.002)
    elif name == 'scales':                               # overlapping rounded gold scales (b_mats.scales_tile)
        v, u = np.mgrid[0:n, 0:n].astype(F32) / n * 4
        best_h = np.zeros((n, n), F32); edge = np.zeros((n, n), F32); done = np.zeros((n, n), bool)
        for dk in (-1, 0):
            k = np.floor(v) + dk
            off = 0.5 * (k % 2)
            cx = np.floor(u - off) + 0.5 + off
            dx = u - cx; dy = v - k
            r = np.sqrt(dx * dx + (dy - 0.62) ** 2)
            inside = (r < 0.72) & (np.abs(dx) < 0.5) & ~done
            hh = 0.35 + 0.5 * np.clip(dy / 1.3, 0, 1) - 0.25 * np.clip((r - 0.5) / 0.22, 0, 1) ** 2 + 0.1 * np.clip(1 - np.abs(dx) / 0.08, 0, 1)
            best_h[inside] = hh[inside]; edge[inside] = np.clip((r - 0.6) / 0.12, 0, 1)[inside]; done |= inside
        best_h[~done] = 0.1; edge[~done] = 1
        hgt = np.clip(best_h, 0, 1)
        shade = (0.72 + 0.4 * hgt) * (1 - 0.5 * edge)
        col = np.clip(np.array((0.98, 0.76, 0.26), F32)[None, None] * shade[..., None] + 0.12 * hgt[..., None] ** 3, 0, 1)
        s = Src(col[::-1].copy(), None, hgt[::-1].copy(), 0.4, 0.7, 0.52, 0.012)
    elif name == 'tassel':
        v, u = np.mgrid[0:n, 0:n].astype(F32) / n
        st = np.abs((u * 14) % 1 - 0.5) * 2
        col = np.ones(3, F32)[None, None] * (0.35 + 0.65 * st[..., None])                # tinted per faction
        s = Src(col, None, st, 0.7, 0.0, (1.0, 1.0), 0.004)
    elif name == 'fletch':
        s = Src(np.full((8, 8, 3), (0.75, 0.12, 0.1), F32), None, None, 0.8, 0.0, 0.2, 0.0)
    elif name == 'stone':
        a = fbm(n, 1.1, 81)
        s = Src(np.array((0.42, 0.41, 0.39), F32)[None, None] * (0.7 + 0.6 * a[..., None]), None, a, 0.9, 0.0, 0.6, 0.01)
    elif name == 'soulfire':                             # no emissive in the renderer: bright green albedo
        a = fbm(n, 1.2, 91)
        s = Src(np.clip(np.array((0.35, 1.0, 0.45), F32)[None, None] * (0.75 + 0.5 * a[..., None]), 0, 1), None, a, 0.9, 0.0, 0.3, 0.0)
    else:
        raise KeyError(f'unknown tile source {name}')
    s.name = name
    SRC[name] = s
    return s


# =============================================================================================== geometry
def new_obj(name, verts, faces, uvs=None, smooth_=True):
    """uvs: per face, per corner [(u, v)]."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in verts], [], [tuple(f) for f in faces])
    me.update()
    uv = me.uv_layers.new(name='UVMap')
    if uvs is not None:
        flat_ = np.array([c for f in uvs for c in f], F32)
        uv.data.foreach_set('uv', flat_.ravel())
    for p in me.polygons:
        p.use_smooth = smooth_
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def grid_mesh(name, P, UV, wrap_u=False, flip=False, smooth_=True):
    """P: (nu, nv, 3) points, UV: (nu [+1 when wrap_u], nv, 2) per-vertex UVs (a wrapped seam keeps u continuous)."""
    nu, nv = P.shape[:2]
    faces, fuv = [], []
    for i in range(nu if wrap_u else nu - 1):
        i2 = (i + 1) % nu
        for j in range(nv - 1):
            q = [(i, j), (i2, j), (i2, j + 1), (i, j + 1)]
            uq = [UV[i, j], UV[i + 1, j], UV[i + 1, j + 1], UV[i, j + 1]]
            if flip:
                q = q[::-1]; uq = uq[::-1]
            faces.append([a * nv + b for a, b in q]); fuv.append(uq)
    return new_obj(name, P.reshape(-1, 3), faces, fuv, smooth_)


def catmull(pts, n):
    P = np.array(pts, float)
    P = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    segs = len(P) - 3
    for t in np.linspace(0, segs, n):
        i = min(int(t), segs - 1); u = t - i
        p0, p1, p2, p3 = P[i:i + 4]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3))
    return np.array(out)


def interp_r(radii, n):
    r = np.array(radii, float)
    return np.interp(np.linspace(0, len(r) - 1, n), np.arange(len(r)), r)


def tube(name, pts, radii, nseg=8, cap=True, squash=None, up=(0, 0, 1), metric=True, u_rep=1.0):
    """Loft a tube along pts with radii. UV (metric): u = arc length (metres), v = around (metres at the mean radius)
    -- i.e. the grain / rope twist runs along the tube. metric=False: u = 0..u_rep around, v = 0..1 along."""
    pts = np.array(pts, float); radii = np.broadcast_to(np.array(radii, float), (len(pts),)).copy()
    n = len(pts)
    tan = np.gradient(pts, axis=0); tan /= np.linalg.norm(tan, axis=1)[:, None] + 1e-12
    upv = np.array(up, float)
    rings = np.zeros((nseg, n, 3)); UV = np.zeros((nseg + 1, n, 2))
    arc = np.concatenate([[0], np.cumsum(np.linalg.norm(pts[1:] - pts[:-1], axis=1))])
    prev = None
    circ = 2 * math.pi * float(radii.mean())
    sq = squash if squash else (1, 1)
    for j in range(n):
        a = np.cross(tan[j], upv)
        if np.linalg.norm(a) < 1e-3:
            a = np.cross(tan[j], (1, 0, 0)) if prev is None else prev
        a = a / np.linalg.norm(a)
        if prev is not None and a @ prev < 0:
            a = -a
        prev = a
        b = np.cross(tan[j], a)
        for i in range(nseg):
            th = 2 * math.pi * i / nseg
            rings[i, j] = pts[j] + radii[j] * (math.cos(th) * a * sq[0] + math.sin(th) * b * sq[1])
        for i in range(nseg + 1):
            UV[i, j] = (arc[j], i / nseg * circ) if metric else (i / nseg * u_rep, arc[j] / max(arc[-1], 1e-9))
    ob = grid_mesh(name, rings, UV, wrap_u=True)
    if cap:
        bm = bmesh.new(); bm.from_mesh(ob.data); bm.verts.ensure_lookup_table()
        uvl = bm.loops.layers.uv.active
        for j in (0, n - 1):
            if radii[j] < 1e-4:
                continue
            vs = [bm.verts[i * n + j] for i in range(nseg)]
            if j == 0:
                vs = vs[::-1]
            try:
                f = bm.faces.new(vs)
            except ValueError:
                continue
            c = pts[j]
            for l in f.loops:                               # planar cap UVs in metres (end grain)
                d = np.array(l.vert.co) - c
                l[uvl].uv = (float(d @ prev) + 10.0 + j, float(d @ np.cross(tan[j], prev)))
        bm.normal_update(); bm.to_mesh(ob.data); bm.free()
    return ob


def lathe(name, profile, nseg=10, centre=(0, 0, 0), metric=True, u_rep=1.0, axis='Z'):
    """profile: [(radius, z)] bottom to top around the Z axis. UV metric: u around (metres at max radius), v along."""
    pr = np.array(profile, float)
    n = len(pr)
    P = np.zeros((nseg, n, 3)); UV = np.zeros((nseg + 1, n, 2))
    arc = np.concatenate([[0], np.cumsum(np.linalg.norm(pr[1:] - pr[:-1], axis=1))])
    circ = 2 * math.pi * float(pr[:, 0].max())
    for i in range(nseg):
        th = 2 * math.pi * i / nseg
        P[i, :, 0] = pr[:, 0] * math.cos(th); P[i, :, 1] = pr[:, 0] * math.sin(th); P[i, :, 2] = pr[:, 1]
    for i in range(nseg + 1):
        UV[i, :, 0] = i / nseg * (circ if metric else u_rep); UV[i, :, 1] = arc if metric else arc / arc[-1]
    ob = grid_mesh(name, P, UV, wrap_u=True, flip=True)
    if axis == 'Y':
        ob.data.transform(Matrix.Rotation(math.pi / 2, 4, 'X'))
    elif axis == 'X':
        ob.data.transform(Matrix.Rotation(math.pi / 2, 4, 'Y'))
    ob.data.transform(Matrix.Translation(centre))
    return ob


def box(name, lo, hi, long_axis=None):
    """Axis-aligned box, per-face planar UVs in metres. The texture's u runs along `long_axis` (default: the longest)."""
    lo = np.array(lo, float); hi = np.array(hi, float)
    lo, hi = np.minimum(lo, hi), np.maximum(lo, hi)
    la = int(np.argmax(hi - lo)) if long_axis is None else long_axis
    c = [np.array([lo[0] if not (i & 1) else hi[0], lo[1] if not (i & 2) else hi[1], lo[2] if not (i & 4) else hi[2]]) for i in range(8)]
    quads = [(0, 2, 3, 1, 0, 1), (4, 5, 7, 6, 0, 1), (0, 1, 5, 4, 0, 2), (2, 6, 7, 3, 0, 2), (0, 4, 6, 2, 1, 2), (1, 3, 7, 5, 1, 2)]
    faces, fuv = [], []
    off = 0.0
    for a, b, cc, d, ua, va in quads:
        if va == la:
            ua, va = va, ua
        faces.append((a, b, cc, d))
        fuv.append([((c[i][ua] - lo[ua]) + off, (c[i][va] - lo[va])) for i in (a, b, cc, d)])
        off += (hi[ua] - lo[ua]) + 0.5                     # faces are separate islands
    return new_obj(name, c, faces, fuv, smooth_=False)


def beam(name, p0, p1, w, h, up=(0, 0, 1), roll=0.0):
    """A box of section w (sideways) x h (along `up`) from p0 to p1; texture u along the beam."""
    p0 = Vector(p0); p1 = Vector(p1)
    d = p1 - p0; ln = d.length
    ob = box(name, (0, -w / 2, -h / 2), (ln, w / 2, h / 2), long_axis=0)
    x = d.normalized(); u = Vector(up)
    y = u.cross(x)
    if y.length < 1e-4:
        y = Vector((0, 1, 0)).cross(x)
    y.normalize(); z = x.cross(y)
    M = Matrix((x, y, z)).transposed().to_4x4()
    ob.data.transform(Matrix.Translation(p0) @ M @ Matrix.Rotation(roll, 4, 'X'))
    return ob


def quad(name, p00, p10, p11, p01, uv=((0, 0), (1, 0), (1, 1), (0, 1))):
    return new_obj(name, [p00, p10, p11, p01], [(0, 1, 2, 3)], [list(uv)], smooth_=False)


def sphere(name, c, r, seg=8, rings=6, metric=True):
    r = (r, r, r) if np.isscalar(r) else r
    bm = bmesh.new()
    bm.loops.layers.uv.new('UVMap')
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0, calc_uvs=True)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    me.uv_layers[0].name = 'UVMap'
    if metric:
        uv = get_uv(ob); uv *= (2 * math.pi * max(r[0], r[1]), math.pi * r[2]); set_uv(ob, uv)
    me.transform(Matrix.Translation(c) @ Matrix.Diagonal((*r, 1)))
    for p in me.polygons:
        p.use_smooth = True
    return ob


def verts(ob):
    co = np.empty(len(ob.data.vertices) * 3, F32); ob.data.vertices.foreach_get('co', co)
    return co.reshape(-1, 3)


def get_uv(ob):
    a = np.empty(len(ob.data.loops) * 2, F32); ob.data.uv_layers['UVMap'].data.foreach_get('uv', a)
    return a.reshape(-1, 2)


def set_uv(ob, a):
    ob.data.uv_layers['UVMap'].data.foreach_set('uv', np.asarray(a, F32).ravel())


def xform(ob, M):
    ob.data.transform(M); ob.data.update()
    return ob


def join(objs, name):
    """Join meshes (bmesh, no operators / selection). Keeps the 'UVMap' layer."""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    for o in objs:
        me = o.data
        src = me.uv_layers.get('UVMap') or (me.uv_layers[0] if me.uv_layers else None)
        base = len(bm.verts)
        vs = [bm.verts.new(o.matrix_world @ v.co) for v in me.vertices]
        uv = None
        if src is not None:
            uv = np.empty(len(me.loops) * 2, F32); src.data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
        for p in me.polygons:
            try:
                f = bm.faces.new([vs[i] for i in p.vertices])
            except ValueError:
                continue
            f.smooth = p.use_smooth
            if uv is not None:
                for l, li in zip(f.loops, p.loop_indices):
                    l[uvl].uv = uv[li]
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def orient_out(ob, ref):
    """Flip each connected component so its faces look away from ref(centre) (a point or a function of the face centre)."""
    bm = bmesh.new(); bm.from_mesh(ob.data); bm.normal_update()
    seen = set()
    for f0 in bm.faces:
        if f0 in seen:
            continue
        comp = [f0]; seen.add(f0); st = [f0]
        while st:
            g = st.pop()
            for e in g.edges:
                for h in e.link_faces:
                    if h not in seen:
                        seen.add(h); comp.append(h); st.append(h)
        tot = 0.0
        for f in comp:
            c = f.calc_center_median()
            r = Vector(ref(c)) if callable(ref) else Vector(ref)
            tot += f.normal.dot(c - r) * f.calc_area()
        if tot < 0:
            bmesh.ops.reverse_faces(bm, faces=comp)
    bm.to_mesh(ob.data); bm.free()
    return ob


def recalc_out(ob):
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data); bm.free()
    return ob


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


# =============================================================================================== drape
class Drape:
    """Taut cloth over a quadruped body (model faces -Y, spine along Y). bvh: BVHTree of the body in unit space."""
    def __init__(self, body=None, barrel=None):
        if body is not None:
            dg = bpy.context.evaluated_depsgraph_get()
            self.bvh = BVHTree.FromObject(body, dg)
            co = verts(body); self.lo = co.min(0); self.hi = co.max(0)
        else:                                               # parametric barrel: dict(y0, y1, z, rx, rz)
            b = dict(y0=-0.6, y1=0.6, z=1.2, rx=0.32, rz=0.38); b.update(barrel or {})
            pts = [(0, y, b['z']) for y in np.linspace(b['y0'] - 0.3, b['y1'] + 0.3, 9)]
            o = tube('_barrel', pts, [b['rx'] * 0.7] + [b['rx']] * 7 + [b['rx'] * 0.7], nseg=20, squash=(1.0, b['rz'] / b['rx']), up=(0, 0, 1))
            self.bvh = BVHTree.FromObject(o, bpy.context.evaluated_depsgraph_get())
            co = verts(o); self.lo = co.min(0); self.hi = co.max(0)
            bpy.data.objects.remove(o, do_unlink=True)
        self.far = float(max(self.hi - self.lo)) * 2 + 2

    def spine(self, y, x=0.0):
        """(top z, belly z) of the body on the centre line at y, or None."""
        t, _, _, _ = self.bvh.ray_cast(Vector((x, y, self.hi[2] + 1)), Vector((0, 0, -1)))
        if t is None:
            return None
        b, _, _, _ = self.bvh.ray_cast(Vector((x, y, t.z - 0.02)), Vector((0, 0, -1)))
        # the first surface under the back is the inside of the back skin: walk down to the last exit above the ground
        low = t.z
        o = Vector((x, y, t.z - 1e-3))
        for _ in range(8):
            h, _, _, _ = self.bvh.ray_cast(o, Vector((0, 0, -1)))
            if h is None:
                break
            low = h.z; o = Vector((x, y, h.z - 1e-3))
        return t.z, low

    def profile(self, y, off, axis_z, max_ang=118):
        """Right-hand (x >= 0) taut profile at y: [(x, z)] from the spine to the widest point (upper convex hull)."""
        pts = []
        for th in np.radians(np.arange(0, max_ang, 2.5)):
            d = Vector((math.sin(th), 0, math.cos(th)))
            o = Vector((0, y, axis_z)) + d * self.far
            hit, n, _, _ = self.bvh.ray_cast(o, -d)
            if hit is not None and hit.x >= -1e-3:
                pts.append((hit.x + d.x * off, hit.z + d.z * off))
        if len(pts) < 3:
            return None
        pts.sort()
        hull = []
        for q in pts:
            while len(hull) >= 2 and (hull[-1][0] - hull[-2][0]) * (q[1] - hull[-2][1]) - (hull[-1][1] - hull[-2][1]) * (q[0] - hull[-2][0]) >= 0:
                hull.pop()
            hull.append(q)
        k = int(np.argmax([h[0] for h in hull]))
        hull = hull[:k + 1]
        if hull[0][0] > 1e-3:
            hull.insert(0, (0.0, hull[0][1]))
        return np.array(hull)

    def sheet(self, ys, off, hem, rows_top, rows_low, drop=None, smooth_n=2, axis_z=None):
        """One flank (x >= 0). Columns along ys: the hull, then a vertical drop to hem(y) (absolute z). `drop`: cloth
        length (metres) measured up from the hem that forms the lower `rows_low` rows (the image panel); the rest up
        to the spine gets `rows_top` rows. Returns P (ncol, nrow, 3), A arc length per vertex."""
        cols, arcs = [], []
        last = None
        for y in ys:
            az = axis_z
            if az is None:
                sp = self.spine(y)
                az = 0.5 * (sp[0] + sp[1]) if sp else (last if last is not None else 0.5 * (self.lo[2] + self.hi[2]))
            last = az
            h = self.profile(y, off, az)
            if h is None:
                h = np.array([(0.0, az + 0.3), (0.3, az)])
            z_h = hem(y)
            line = np.vstack([h, [h[-1][0], min(z_h, h[-1][1] - 0.02)]])
            seg = np.linalg.norm(line[1:] - line[:-1], axis=1)
            cum = np.concatenate([[0], np.cumsum(seg)])
            S = cum[-1]
            s0 = max(S - drop, 0.02) if drop else cum[-2]
            samp = np.concatenate([np.linspace(0, s0, rows_top, endpoint=False), np.linspace(s0, S, rows_low)])
            xz = np.stack([np.interp(samp, cum, line[:, 0]), np.interp(samp, cum, line[:, 1])], 1)
            cols.append(np.stack([xz[:, 0], np.full(len(samp), y), xz[:, 1]], 1)); arcs.append(samp)
        P = np.array(cols); A = np.array(arcs)
        for _ in range(smooth_n):                           # relax along the body: shoulder / thigh bulges do not print through
            Q = P.copy()
            Q[1:-1, :, 0] = 0.25 * P[:-2, :, 0] + 0.5 * P[1:-1, :, 0] + 0.25 * P[2:, :, 0]
            Q[1:-1, :, 2] = 0.25 * P[:-2, :, 2] + 0.5 * P[1:-1, :, 2] + 0.25 * P[2:, :, 2]
            P = Q
        return P, A

    def ring(self, centre, axis, off, nseg, rows, start_r=None):
        """A closed band around a limb / neck: centre(t) is the axis point at row t in 0..1."""
        P = np.zeros((nseg, rows, 3))
        sr = start_r or self.far
        a = Vector(axis).normalized()
        e1 = a.cross(Vector((0, 1, 0)))
        if e1.length < 1e-3:
            e1 = a.cross(Vector((1, 0, 0)))
        e1.normalize(); e2 = a.cross(e1)
        for j in range(rows):
            c = Vector(centre(j / (rows - 1)))
            rr = np.zeros(nseg)
            for i in range(nseg):
                th = 2 * math.pi * i / nseg
                d = e1 * math.cos(th) + e2 * math.sin(th)
                hit, n, _, _ = self.bvh.ray_cast(c + d * sr, -d)
                rr[i] = (hit - c).length if hit is not None else -1.0
            ok = rr > 0
            med = float(np.median(rr[ok])) if ok.any() else 0.15
            rr = np.where(ok, np.clip(rr, 0.6 * med, 1.35 * med), med) + off     # misses / rays that caught another limb
            for i in range(nseg):
                th = 2 * math.pi * i / nseg
                P[i, j] = c + (e1 * math.cos(th) + e2 * math.sin(th)) * float(rr[i])
        return P

    def project(self, o, d, off=0.02, miss=None):
        hit, n, _, _ = self.bvh.ray_cast(Vector(o), Vector(d))
        if hit is None:
            return None if miss is None else Vector(o) + Vector(d) * miss
        return hit - Vector(d) * off


def plate_grid(src, height, nu=11, nv=17, inset=3, cos=False):
    """A quad grid following the silhouette of art isolated on black: row j spans the solid extent of the image row.
    Returns (XY (nu, nv, 2) metres, x right / y up, centred in x, top at y = 0; UV (nu, nv, 2))."""
    solid = src.solid
    H, W = solid.shape
    rows = np.where(solid.any(1))[0]
    r_bot, r_top = rows.min(), rows.max()
    cols = np.where(solid.any(0))[0]
    cx = 0.5 * (cols.min() + cols.max())
    mpp = height / (r_top - r_bot)
    XY = np.zeros((nu, nv, 2)); UV = np.zeros((nu, nv, 2))
    for j in range(nv):
        t = j / (nv - 1)
        t = 0.5 - 0.5 * math.cos(math.pi * t) if cos else t          # round outlines: denser rows at the poles
        row = int(round(r_top - (r_top - r_bot) * (0.01 + 0.98 * t)))
        cs = np.where(solid[row])[0]
        if len(cs) < 2:
            cs = np.array([cx - 1, cx + 1])
        xl, xr = cs.min() + inset, cs.max() - inset
        if xr <= xl:
            xl, xr = cx - 0.5, cx + 0.5
        for i in range(nu):
            px = xl + (xr - xl) * i / (nu - 1)
            XY[i, j] = ((px - cx) * mpp, -(r_top - row) * mpp)
            UV[i, j] = ((px + 0.5) / W, (row + 0.5) / H)
    return XY, UV


# =============================================================================================== composer
class Kit:
    """Collects pieces (objects with authoring UVs + a source) and composes one mesh with one atlas."""
    def __init__(self, name):
        self.name = name
        self.items = []

    def add(self, ob, src, w=1.0, copies=None, mirror=False, double=False, jitter=0.06, smooth_=None, node=None, clean=0.0):
        """src: Src | tile name. w: texel density weight. copies: [4x4] extra instances (share texels), mirror: also
        instance mirrored in X (shares texels), double: add flipped back faces (thin cloth seen from both sides).
        clean: 0..1, how much of the siege weathering (siege_weather.py) this piece is spared (polished mirrors, crew
        figures with their own baked shading); finish() writes it to `self.clean` (S x S)."""
        if isinstance(src, str):
            src = tile(src)
        if smooth_ is not None:
            for p in ob.data.polygons:
                p.use_smooth = smooth_
        self.items.append(dict(ob=ob, src=src, w=w, copies=copies or [], mirror=mirror, double=double, jitter=jitter if src.tile else 0.0, node=node, clean=clean))
        return ob

    # -- islands of one piece: [(loop indices, metres-per-uv (su, sv))]
    @staticmethod
    def _islands(ob, src):
        me = ob.data
        nl = len(me.loops)
        uv = get_uv(ob)
        vi = np.empty(nl, np.int32); me.loops.foreach_get('vertex_index', vi)
        key = {}
        parent = list(range(len(me.polygons)))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]; a = parent[a]
            return a
        for p in me.polygons:
            for li in p.loop_indices:
                k = (int(vi[li]), round(float(uv[li, 0]), 5), round(float(uv[li, 1]), 5))
                q = key.setdefault(k, p.index)
                if q != p.index:
                    ra, rb = find(q), find(p.index)
                    if ra != rb:
                        parent[rb] = ra
        groups = {}
        for p in me.polygons:
            groups.setdefault(find(p.index), []).append(p)
        co = verts(ob)
        out = []
        for polys in groups.values():
            loops = np.array([li for p in polys for li in p.loop_indices], np.int64)
            if src.tile:
                su = sv = 1.0
            else:
                a = []; b = []
                for p in polys:
                    L_ = list(p.loop_indices)
                    for k in range(len(L_)):
                        i0, i1 = L_[k], L_[(k + 1) % len(L_)]
                        d = uv[i1] - uv[i0]
                        a.append((d[0] ** 2, d[1] ** 2)); b.append(float(((co[vi[i1]] - co[vi[i0]]) ** 2).sum()))
                a = np.array(a); b = np.array(b)
                try:
                    sol = np.linalg.lstsq(a, b, rcond=None)[0]
                except Exception:
                    sol = np.array([0.0, 0.0])
                su = math.sqrt(sol[0]) if sol[0] > 1e-10 else 0.0
                sv = math.sqrt(sol[1]) if sol[1] > 1e-10 else 0.0
                su = su or sv or 1.0; sv = sv or su
                r = su / sv
                if r > 4 or r < 0.25:                      # degenerate fit (a strip): fall back to the area ratio
                    a3 = sum(p.area for p in polys)
                    e = uv[loops]; auv = max(float(np.ptp(e[:, 0]) * np.ptp(e[:, 1])), 1e-9)
                    su = sv = math.sqrt(a3 / auv)
            out.append((loops, su, sv))
        return out

    def finish(self, tex=1024, texel=600.0, pad=3, metal_max=0.3):
        """-> one object per the trappings contract. texel: wanted texels per metre (weight 1); tex: atlas size cap."""
        recs = []
        for it in self.items:
            ob, src = it['ob'], it['src']
            uv = get_uv(ob)
            for loops, su, sv in self._islands(ob, src):
                e = uv[loops]
                lo = e.min(0); ext = np.maximum(e.max(0) - lo, 1e-6)
                recs.append(dict(it=it, loops=loops, lo=lo, ext=ext, m=(ext[0] * su, ext[1] * sv)))
        D = float(texel)
        sizes = [s for s in (128, 256, 512, 1024, 2048, 4096) if s <= tex]
        while True:
            lim = sizes[-1] - 2 * pad                        # a strip longer than the atlas is squeezed along its length only
            for r in recs:
                r['wi'] = min(lim, max(2, int(math.ceil(r['m'][0] * D * r['it']['w'])))); r['hi'] = min(lim, max(2, int(math.ceil(r['m'][1] * D * r['it']['w']))))
            pos = None
            for S in sizes:
                pos = self._pack(recs, S, pad)
                if pos is not None:
                    break
            if pos is not None:
                break
            D *= 0.92
        base = np.zeros((S, S, 3), F32); team = np.zeros((S, S), F32); nrm = np.zeros((S, S, 3), F32); nrm[..., :] = (0.5, 0.5, 1.0)
        rough = np.full((S, S), 0.7, F32); metal = np.zeros((S, S), F32); cov = np.zeros((S, S), bool); clean = np.zeros((S, S), F32)
        rng = np.random.default_rng(7)
        for r, (x0, y0) in zip(recs, pos):
            src = r['it']['src']
            W, H = r['wi'] + 2 * pad, r['hi'] + 2 * pad
            uu = r['lo'][0] + (np.arange(W) - pad + 0.5) / r['wi'] * r['ext'][0]
            vv = r['lo'][1] + (np.arange(H) - pad + 0.5) / r['hi'] * r['ext'][1]
            sh, sw = src.col.shape[:2]
            if src.tile:
                ju, jv = (rng.random(2) if r['it']['jitter'] else (0, 0))
                X = (uu / src.tile[0] + ju) * sw; Y = (vv / src.tile[1] + jv) * sh
                f = max(r['ext'][0] / src.tile[0] * sw / r['wi'], r['ext'][1] / src.tile[1] * sh / r['hi'])
            else:
                X = uu * sw; Y = vv * sh
                f = max(r['ext'][0] * sw / r['wi'], r['ext'][1] * sh / r['hi'])
            lvl = max(0, int(math.floor(math.log2(max(f, 1.0)))))
            col, tm, hh, rg, mt = src.mip(lvl)
            k = 2.0 ** lvl
            # recompute the scale from the actual mip size (odd sizes)
            Xs = X / sw * col.shape[1] - 0.5; Ys = Y / sh * col.shape[0] - 0.5
            XX, YY = np.meshgrid(Xs, Ys)
            wrap = bool(src.tile)
            c = bilinear(col, XX, YY, wrap)
            if r['it']['jitter']:
                c = np.clip(c * (1 + r['it']['jitter'] * (rng.random() * 2 - 1)), 0, 1)
            sl = (slice(y0, y0 + H), slice(x0, x0 + W))
            base[sl] = c
            team[sl] = bilinear(tm, XX, YY, wrap)
            rough[sl] = bilinear(rg, XX, YY, wrap); metal[sl] = bilinear(mt, XX, YY, wrap)
            h = bilinear(hh, XX, YY, wrap)
            if src.bump and H > 2 and W > 2:
                gy, gx = np.gradient(h)
                # slope = d(height metres) / d(metres): gradient per texel * texels per metre
                sx = gx * src.bump * (r['wi'] / max(r['m'][0], 1e-6)); sy = gy * src.bump * (r['hi'] / max(r['m'][1], 1e-6))
                n = np.stack([-sx, -sy, np.ones_like(sx)], -1); n /= np.linalg.norm(n, axis=2, keepdims=True)
                nrm[sl] = n * 0.5 + 0.5
            cov[sl] = True
            if r['it'].get('clean'):
                clean[sl] = r['it']['clean']
            r['rect'] = (x0 + pad, y0 + pad)
        # write the atlas UVs
        for it in self.items:
            it['new'] = get_uv(it['ob']).copy()
        for r in recs:
            a = r['it']['new']; l = r['loops']
            e = get_uv(r['it']['ob'])[l]
            a[l, 0] = (r['rect'][0] + (e[:, 0] - r['lo'][0]) / r['ext'][0] * r['wi']) / S
            a[l, 1] = (r['rect'][1] + (e[:, 1] - r['lo'][1]) / r['ext'][1] * r['hi']) / S
        groups = {}
        for it in self.items:
            ob = it['ob']
            set_uv(ob, it['new'])
            inst = [ob]
            for M in it['copies']:
                c = ob.copy(); c.data = ob.data.copy(); bpy.context.scene.collection.objects.link(c)
                c.data.transform(Matrix(M)); inst.append(c)
            if it['mirror']:
                for o in list(inst):
                    c = o.copy(); c.data = o.data.copy(); bpy.context.scene.collection.objects.link(c)
                    c.data.transform(Matrix.Diagonal((-1, 1, 1, 1))); c.data.flip_normals(); inst.append(c)
            if it['double']:
                for o in list(inst):
                    c = o.copy(); c.data = o.data.copy(); bpy.context.scene.collection.objects.link(c)
                    c.data.flip_normals(); inst.append(c)
            groups.setdefault(it['node'], []).extend(inst)
        imgs = {}
        for key, arr, nc in (('base', base, False), ('normal', nrm, True), ('team', team, True)):
            imgs[key] = self._image(f'{self.name}_{key}', arr, nc)
        mr = np.ones((S, S, 3), F32); mr[..., 1] = rough; mr[..., 2] = np.minimum(metal, metal_max)
        imgs['mr'] = self._image(f'{self.name}_mr', mr, True)
        m = bpy.data.materials.new(f'{self.name}_mat'); m.use_nodes = True
        nt = m.node_tree; p = nt.nodes['Principled BSDF']
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = imgs['base']
        nt.links.new(t.outputs['Color'], p.inputs['Base Color'])
        tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = imgs['normal']
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(tn.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
        tm_ = nt.nodes.new('ShaderNodeTexImage'); tm_.image = imgs['mr']
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(tm_.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], p.inputs['Roughness']); nt.links.new(sep.outputs['Blue'], p.inputs['Metallic'])
        has_team = bool(team.max() > 0.05)
        m['authored'] = 1; m['team_image'] = imgs['team'].name if has_team else ''
        self.team = team; self.images = imgs; self.clean = clean
        out = {}
        for node, objs in groups.items():
            ob = join(objs, self.name if node is None else node)
            me = ob.data; me.update()
            me.materials.append(m)
            ob['team_image'] = m['team_image']; ob['texel'] = D; ob['double_sided'] = 0; ob['atlas'] = S; ob['fill'] = float(cov.mean())
            uvn = get_uv(ob); vi = np.empty(len(me.loops), np.int32); me.loops.foreach_get('vertex_index', vi)
            tv = np.zeros(len(me.vertices), F32)
            px = np.clip((uvn * S).astype(int), 0, S - 1)
            tv[vi] = team[px[:, 1], px[:, 0]]
            me.attributes.new('_TEAM', 'FLOAT', 'POINT').data.foreach_set('value', tv)
            ob['team_frac'] = float((tv > 0.5).mean())
            out[node] = ob
        return out[None] if list(out) == [None] else out

    @staticmethod
    def _image(name, arr, non_color):
        if name in bpy.data.images:
            bpy.data.images.remove(bpy.data.images[name])
        h, w = arr.shape[:2]
        img = bpy.data.images.new(name, w, h, alpha=False)
        if non_color:
            img.colorspace_settings.name = 'Non-Color'
        if arr.ndim == 2:
            arr = np.stack([arr] * 3, -1)
        px = np.concatenate([arr, np.ones((h, w, 1), F32)], 2)
        img.pixels.foreach_set(px.astype(F32).ravel()); img.update(); img.pack()
        return img

    @staticmethod
    def _pack(recs, S, pad):
        """Guillotine packing (best short-side fit) of the padded rects into S x S; None if they do not fit."""
        order = sorted(range(len(recs)), key=lambda i: -max(recs[i]['wi'], recs[i]['hi']))
        pos = [None] * len(recs)
        free = [(0, 0, S, S)]
        for i in order:
            w, h = recs[i]['wi'] + 2 * pad, recs[i]['hi'] + 2 * pad
            best = None
            for k, (fx, fy, fw, fh) in enumerate(free):
                if w <= fw and h <= fh:
                    sc = min(fw - w, fh - h)
                    if best is None or sc < best[0]:
                        best = (sc, k)
            if best is None:
                return None
            fx, fy, fw, fh = free.pop(best[1])
            pos[i] = (fx, fy)
            if fw - w > fh - h:                              # split along the longer leftover
                free.append((fx + w, fy, fw - w, fh)); free.append((fx, fy + h, w, fh - h))
            else:
                free.append((fx, fy + h, fw, fh - h)); free.append((fx + w, fy, fw - w, h))
        return pos


def image_np(img):
    w, h = img.size
    a = np.empty(w * h * 4, F32); img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)
