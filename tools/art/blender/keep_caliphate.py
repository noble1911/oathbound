"""Sun Caliphate Keep and arrow tower (see keep_build.py, which imports FACTION from here).

A sandstone fortress-palace: battered walls with stepped merlons and tiled blind arcades, square corner towers under
small turquoise domes, a tall iwan gate framed in star tilework between two slender minarets, and a palace block
carrying the great teal dome on a windowed drum. Blender frame: Z up, the gate faces -Y.
"""
import math, random

import keep_kit as K
from keep_kit import TAU

DARK = (0.03, 0.03, 0.035)
GOLD = (1.0, 0.80, 0.34)
WARM = (0.95, 0.58, 0.22)
SAND = (1.0, 1.0, 1.0)
PAVE = (0.9, 0.88, 0.84)
MER = (0.7, 0.8, 0.4)          # merlon w, h, d


def slit(u=None, v=3.0, h=1.2, a=None, w=0.22):
    o = dict(v=v, w=w, h=h, depth=0.4)
    if a is not None:
        o['a'] = a
    else:
        o['u'] = u
    return o


LIT = [True]


def window(u=None, v=5.0, w=0.8, h=1.7, glow=WARM, arch='keel', a=None, depth=0.3, bars=True):
    if not LIT[0]:
        glow = None
    o = dict(v=v, w=w, h=h, depth=depth, arch=arch, back='glow' if glow else 'plain', back_tint=glow or DARK, bars=bars)
    if a is not None:
        o['a'] = a
    else:
        o['u'] = u
    return o


def blind(u, v, w=1.5, h=3.0, back='accent', tint=(0.92, 0.92, 0.92), depth=0.22):
    """Blind arch: a shallow keel-arched niche with a tiled (or dressed stone) back."""
    return dict(u=u, v=v, w=w, h=h, depth=depth, arch='keel', back=back, back_tint=tint)


def crown(k, cx, cy, hw, hd, z, overhang=0.14, merlon=MER, gap=0.5, parapet=0.6):
    """Stepped battlement around a rectangle (half extents hw, hd) at height z."""
    c = [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)]
    for i in range(4):
        a, b = c[i], c[(i + 1) % 4]
        k.battlement((cx + a[0], cy + a[1]), (cx + b[0], cy + b[1]), z, 'step', overhang=overhang, corbels=False, merlon=merlon, gap=gap, parapet=parapet, thick=0.4)


def band(k, p0, p1, z, h=0.5, proud=0.07, layer='accent', tint=(1.0, 1.0, 1.0), seg=5.0):
    """Tile frieze on a wall face along p0 -> p1 (outside on the right), bottom at z."""
    length, ctx = k.run(p0, p1)
    with ctx:
        n = max(1, int(math.ceil(length / seg)))
        for i in range(n):
            x0, x1 = length * i / n, length * (i + 1) / n
            if k.gone(((x0 + x1) / 2, 0, z + h / 2), 1.7) or k.gone((x0, 0.3, z), 1.2) or k.gone((x1, 0.3, z), 1.2):
                continue
            k.box((x0 + x1) / 2, -proud / 2 + 0.02, z + h / 2, x1 - x0, proud + 0.04, h, layer, tint, mode='whole')


def lattice(k, x, y, z0, w, h):
    """Wooden gate lattice with brass studs, in the XZ plane at (x, y)."""
    nv, nh = (4, 3) if k.lod else (7, 6)
    wood = (0.95, 0.85, 0.75)
    with k.piece('whole', anchor=(x, y, z0 + h * 0.4)):
        for i in range(nv):
            px = x + (i / (nv - 1) - 0.5) * (w - 0.3)
            k.box(px, y, z0 + h / 2, 0.13, 0.1, h, 'wood', wood, bottom=False)
        for j in range(nh):
            pz = z0 + 0.35 + j * (h - 0.7) / max(1, nh - 1)
            k.box(x, y - 0.02, pz, w, 0.09, 0.13, 'wood', wood, bottom=False)
            if not k.lod:
                for i in range(nv):
                    px = x + (i / (nv - 1) - 0.5) * (w - 0.3)
                    k.box(px, y - 0.08, pz, 0.09, 0.05, 0.09, 'metal', GOLD, bottom=False)


def brazier(k, x, y, z, s=1.0):
    """Brass fire bowl on a sandstone pedestal."""
    if k.gone((x, y, z + 0.5)):
        return
    lit = k.stage < 3
    with k.piece('whole', anchor=(x, y, z + 0.3)):
        k.block(x, y, 0.7 * s, 0.7 * s, z, z + 0.9 * s, 'trim', (0.95, 0.95, 0.95), top='trim', mode='whole', cell=3)
        k.lathe(x, y, [(0.12 * s, z + 0.9 * s), (0.2 * s, z + 1.05 * s), (0.5 * s, z + 1.35 * s), (0.46 * s, z + 1.42 * s)], seg=8, layer='metal', tint=GOLD, cap=False)
        k.disc(x, y, z + 1.36 * s, 0.44 * s, 8, 'plain', (0.1, 0.05, 0.03))
    if lit:
        k.flame(x, y, z + 1.36 * s, 0.85 * s, (0.9, 0.36, 0.07), n=3)


def minaret(k, x, y, z0, z1, r=0.34, tint=SAND):
    """Slender engaged tower with a tiled collar and a small dome."""
    k.lathe(x, y, [(r * 1.25, z0), (r, z0 + 0.6), (r * 0.92, z1 - 0.9)], seg=8, layer='trim', tint=tint, cap=False, hollow=(0.15, 0.8))
    k.lathe(x, y, [(r * 0.95, z1 - 0.9), (r * 1.0, z1 - 0.85), (r * 1.0, z1 - 0.45), (r * 0.95, z1 - 0.4)], seg=8, layer='accent', mode='whole', cap=False)
    k.lathe(x, y, [(r * 0.95, z1 - 0.4), (r * 1.45, z1 - 0.15), (r * 1.45, z1), (r * 0.9, z1)], seg=8, layer='trim', tint=tint, mode='whole', cap=False)
    if not k.gone((x, y, z1 + 0.3)):
        top = k.dome(x, y, r * 1.05, z1, seg=8, rings=4, point=0.4, bulge=0.08, mode='whole', hollow=None)
        k.finial(x, y, top - 0.05, 0.45, GOLD)


def awning(k, x, y, z, w, d, yaw=0.0):
    """Team-coloured cloth awning on four poles; local -Y is the low front edge."""
    if k.lod or k.stage >= 2 or k.gone((x, y, z)):
        return
    with k.at(x, y, 0, yaw):
        with k.piece('whole', anchor=(0, 0, z - 1.5)):
            base = z - 2.6
            for sx in (-1, 1):
                k.sweep([(sx * w / 2, -d / 2, base), (sx * w / 2, -d / 2, z - 0.5)], [0.05, 0.04], seg=5, layer='wood', tint=(0.9, 0.8, 0.7), cap=False)
                k.sweep([(sx * w / 2, d / 2, base), (sx * w / 2, d / 2, z)], [0.05, 0.04], seg=5, layer='wood', tint=(0.9, 0.8, 0.7), cap=False)
            nx, ny = 4, 3

            def P(i, j):
                u, v = i / nx, j / ny
                sag = 0.22 * math.sin(u * math.pi) * math.sin(v * math.pi)
                return ((u - 0.5) * w, (v - 0.5) * d, z - 0.5 * (1 - v) - sag), (u, 1 - (0.60 + 0.24 * v))
            for i in range(nx):
                for j in range(ny):
                    q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)]
                    f = k.face([a[0] for a in q], K.CLOTH, K.WHITE, True, uvs=[a[1] for a in q], out=(0, 0, 1))
                    if f:
                        for lp in f.loops:
                            lp[k.col] = (0.12, 1.0, 1.0, 1.0)


def pot(k, x, y, z, s=1.0, tint=(0.25, 0.75, 0.75)):
    k.lathe(x, y, [(0.16 * s, z), (0.34 * s, z + 0.35 * s), (0.3 * s, z + 0.6 * s), (0.18 * s, z + 0.75 * s), (0.24 * s, z + 0.85 * s)], seg=8, layer='plain', tint=tint, mode='whole', cap=False)


# ================================================================================================= the Keep
def ban(k, x, y, z, w, h, yaw, style='point', off=0.12):
    """Banner, only where the wall behind its bar still stands."""
    if k.gone((x, y, z), 1.5):
        return
    k.banner(x, y, z, w, h, yaw, style, off=off)


def build(k):
    LIT[0] = k.stage < 3
    HW = 6.8                      # curtain wall-walk
    # ---- paved, battered plinth
    k.frustum(0, 0, 18.0, 18.6, -1.8, 16.5, 16.9, 1.0, 'trim', (0.86, 0.86, 0.86), top='floor')
    # ---- curtain walls: battered, a tiled blind arcade outside, frieze under the parapet
    arc_side = [blind(u, 1.7) for u in (-3.0, 0.0, 3.0)]
    arc_back = [blind(-2.6, 1.7), blind(2.6, 1.7), blind(0, 1.4, 2.2, 4.0, 'wood', (0.6, 0.55, 0.5), 0.5)]
    k.block(0, -7.45, 16.0, 1.5, 0.0, HW, openings={}, taper=0.12)
    k.block(0, 7.45, 16.0, 1.5, 0.0, HW, openings={'+y': arc_back}, taper=0.12)
    k.block(-7.25, 0, 1.5, 16.4, 0.0, HW, openings={'-x': arc_side}, taper=0.12)
    k.block(7.25, 0, 1.5, 16.4, 0.0, HW, openings={'+x': arc_side}, taper=0.12)
    bs = dict(overhang=0.14, corbels=False, merlon=MER, gap=0.5, parapet=0.6, thick=0.4)
    k.battlement((7.88, -5.3), (7.88, 5.3), HW, 'step', **bs)
    k.battlement((5.0, 8.08), (-5.0, 8.08), HW, 'step', **bs)
    k.battlement((-7.88, 5.3), (-7.88, -5.3), HW, 'step', **bs)
    band(k, (7.9, -5.2), (7.9, 5.2), 5.5)
    band(k, (5.0, 8.1), (-5.0, 8.1), 5.5)
    band(k, (-7.9, 5.2), (-7.9, -5.2), 5.5)
    # pilaster strips between the arches
    if not k.lod:
        for t in (-1.5, 1.5):
            for sx in (-1, 1):
                k.block(sx * 8.02, t, 0.22, 0.5, -1.2, 5.5, 'trim', (0.95, 0.95, 0.95), top='trim', cell=3, mode='solid')
            k.block(t * 0.87, 8.22, 0.5, 0.22, -1.2, 5.5, 'trim', (0.95, 0.95, 0.95), top='trim', cell=3, mode='solid')
    # ---- square corner towers under small teal domes
    TH = 10.2
    for (sx, sy) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        cx, cy = sx * 7.05, sy * 7.3
        fy = '-y' if sy < 0 else '+y'
        fx = '-x' if sx < 0 else '+x'
        ops = {fy: [window(0, 7.3, 0.7, 1.5), slit(0, 3.6)], fx: [window(0, 7.3, 0.7, 1.5), slit(0, 3.6)]}
        k.frustum(cx, cy, 4.9, 4.9, -1.8, 4.2, 4.2, 1.3, 'trim', (0.86, 0.86, 0.86))
        k.block(cx, cy, 4.1, 4.1, 1.3, TH, openings=ops, taper=0.2, hollow=(0.8, 3.0))
        h = 4.1 / 2 - 0.2
        crown(k, cx, cy, h, h, TH)
        # frieze under the crown
        for i, (a, b) in enumerate((((-h, -h), (h, -h)), ((h, -h), (h, h)), ((h, h), (-h, h)), ((-h, h), (-h, -h)))):
            band(k, (cx + a[0] * 1.02, cy + a[1] * 1.02), (cx + b[0] * 1.02, cy + b[1] * 1.02), 9.0, proud=0.06)
        # drum and dome
        k.cyl(cx, cy, 1.38, 1.34, TH, TH + 0.75, seg=12, layer='trim', top=None, cell=2, hollow=(0.3, 0.6))
        k.lathe(cx, cy, [(1.34, TH + 0.75), (1.52, TH + 0.83), (1.52, TH + 0.95), (1.36, TH + 0.95)], seg=12, layer='trim', mode='whole', cap=False)
        top = k.dome(cx, cy, 1.4, TH + 0.95, seg=14, rings=6, point=0.36, bulge=0.07, hollow=(0.2, 1.4))
        k.finial(cx, cy, top - 0.08, 0.8, GOLD)
    # ---- the iwan gate (pishtaq) between two minarets
    GH = 10.6
    gate = dict(u=0, v=0.3, w=3.7, h=6.9, depth=1.5, arch='keel', back='wood', back_tint=(0.55, 0.5, 0.45))
    k.block(0, -7.95, 7.0, 2.4, 0.0, GH, 'wall', openings={'-y': [gate], '-x': [slit(0, 6.0)], '+x': [slit(0, 6.0)],
                                                           '+y': [window(-1.9, 7.6, 0.7, 1.5), window(1.9, 7.6, 0.7, 1.5)]}, hollow=(0.8, 2.8))
    lattice(k, 0, -8.6, 0.35, 3.6, 4.4)
    # tile frame around the arch: jamb strips, a lintel band and a field above the arch
    for sx in (-1, 1):
        if not k.gone((sx * 2.2, -9.2, 4.0)):
            k.box(sx * 2.22, -9.2, 4.0, 0.5, 0.12, 7.0, 'accent', mode='solid')
        if not k.gone((sx * 2.2, -9.2, 8.6)):
            k.box(sx * 1.24, -9.2, 8.0, 2.47, 0.12, 1.0, 'accent', mode='solid')
    # a brass sun over the arch
    if not k.gone((0, -9.3, 9.3)):
        with k.piece('whole', anchor=(0, -9.2, 9.3)):
            n = 6 if k.lod else 12
            # a cobalt roundel behind the sun
            m = 8 if k.lod else 16
            for i in range(m):
                a0, a1 = TAU * i / m, TAU * (i + 1) / m
                k.face([(0, -9.24, 9.3), (math.cos(a0) * 1.08, -9.24, 9.3 + math.sin(a0) * 1.08), (math.cos(a1) * 1.08, -9.24, 9.3 + math.sin(a1) * 1.08)], 'plain', (0.06, 0.17, 0.36), out=(0, -1, 0))
            for i in range(n):
                a0, a1, am = TAU * i / n, TAU * (i + 1) / n, TAU * (i + 0.5) / n
                r0, r1 = 0.5, 0.95
                k.face([(0, -9.3, 9.3), (math.cos(a0) * r0, -9.3, 9.3 + math.sin(a0) * r0), (math.cos(a1) * r0, -9.3, 9.3 + math.sin(a1) * r0)], 'metal', GOLD, out=(0, -1, 0))
                k.face([(math.cos(a0) * r0, -9.28, 9.3 + math.sin(a0) * r0), (math.cos(am) * r1, -9.28, 9.3 + math.sin(am) * r1), (math.cos(a1) * r0, -9.28, 9.3 + math.sin(a1) * r0)], 'metal', GOLD, out=(0, -1, 0))
    band(k, (-3.5, -9.17), (3.5, -9.17), 9.9, h=0.5, proud=0.06)
    crown(k, 0, -7.95, 3.5, 1.2, GH, merlon=(0.72, 0.85, 0.4))
    for sx in (-1, 1):
        minaret(k, sx * 3.72, -9.02, -1.2, 13.4)
        ban(k, sx * 2.92, -9.15, 9.3, 0.82, 4.4, 0.0, 'point', 0.14)
        brazier(k, sx * 2.9, -10.15, -0.1)
    # steps up to the gate
    for i, (yy, zz) in enumerate(((-10.75, -0.05), (-10.2, 0.1), (-9.65, 0.25))):
        k.box(0, (yy - 9.1) / 2, zz - 0.3, 4.6, abs(yy + 9.1), 0.6, 'floor', PAVE, mode='keep')
    # ---- the palace block and the great dome
    PX, PY, PH = 0.0, 1.0, 9.4
    lit = lambda u, v, w=0.85, h=1.8: window(u, v, w, h)
    faces = {
        '-y': [lit(-2.9, 5.6), lit(2.9, 5.6), blind(0, 1.4, 2.4, 5.2, 'accent')],
        '+y': [lit(-2.9, 5.6), lit(0, 5.6), lit(2.9, 5.6), slit(-1.45, 2.4), slit(1.45, 2.4)],
        '-x': [lit(-2.9, 5.6), lit(0, 5.6), lit(2.9, 5.6), slit(-1.45, 2.4), slit(1.45, 2.4)],
        '+x': [lit(-2.9, 5.6), lit(0, 5.6), lit(2.9, 5.6), slit(-1.45, 2.4), slit(1.45, 2.4)],
    }
    k.block(PX, PY, 9.0, 9.0, 0.0, PH, openings=faces, hollow=(1.0, 3.2))
    crown(k, PX, PY, 4.5, 4.5, PH)
    for (a, b) in (((-4.52, -4.52), (4.52, -4.52)), ((4.52, -4.52), (4.52, 4.52)), ((4.52, 4.52), (-4.52, 4.52)), ((-4.52, 4.52), (-4.52, -4.52))):
        band(k, (PX + a[0], PY + a[1]), (PX + b[0], PY + b[1]), 8.0, proud=0.06, seg=4.6)
    # corner kiosks on the palace roof
    for sx in (-1, 1):
        for sy in (-1, 1):
            kx, ky = PX + sx * 3.55, PY + sy * 3.55
            if k.lod:
                k.cyl(kx, ky, 0.7, 0.7, PH, PH + 1.5, seg=8, layer='trim', top=None, cell=3, hollow=(0.2, 0.8))
            else:
                for i in range(4):
                    a = TAU * (i + 0.5) / 4
                    if not k.gone((kx, ky, PH + 1.0)):
                        k.sweep([(kx + math.cos(a) * 0.62, ky + math.sin(a) * 0.62, PH), (kx + math.cos(a) * 0.62, ky + math.sin(a) * 0.62, PH + 1.5)], [0.1, 0.085], seg=6, layer='trim', mode='whole', cap=False)
            k.lathe(kx, ky, [(0.72, PH + 1.5), (1.0, PH + 1.58), (1.0, PH + 1.72), (0.8, PH + 1.72)], seg=10, layer='trim', mode='whole')
            top = k.dome(kx, ky, 0.84, PH + 1.72, seg=10, rings=5, point=0.38, bulge=0.07, hollow=(0.15, 0.8))
            k.finial(kx, ky, top - 0.06, 0.5, GOLD)
    # drum: eight lit arches, a tile collar, a cornice
    DR, DZ = 3.5, 12.1
    ops = [window(a=22.5 + 45 * i, v=PH + 0.75, w=0.8, h=1.35) for i in range(8)]
    k.cyl(PX, PY, DR + 0.08, DR, PH, DZ - 0.5, seg=24, layer='trim', openings=ops, top=None, cell=1.4, hollow=(0.6, 2.2))
    k.lathe(PX, PY, [(DR + 0.04, DZ - 0.5), (DR + 0.04, DZ)], seg=24, layer='accent', cap=False, hollow=(0.5, 1.0))
    k.lathe(PX, PY, [(DR + 0.04, DZ), (DR + 0.3, DZ + 0.08), (DR + 0.3, DZ + 0.24), (DR + 0.12, DZ + 0.3)], seg=24, layer='trim', cap=False, hollow=(0.4, 0.5))
    top = k.dome(PX, PY, DR + 0.16, DZ + 0.28, seg=28, rings=12, point=0.30, bulge=0.07, hollow=(0.3, 3.0), height=4.7)
    # gilded ribs and the great finial
    if not k.lod:
        for i in range(8):
            a = TAU * i / 8
            path, rad = [], []
            for j in range(9):
                t = j / 8
                ang = t * math.pi / 2
                s = math.sin(ang)
                rr = (DR + 0.21) * math.cos(ang) * (1 + 0.07 * math.sin(ang * 2))
                zz = DZ + 0.28 + 4.7 * (s * 0.7 + 0.3 * s ** 3)
                path.append((PX + math.cos(a) * rr, PY + math.sin(a) * rr, zz + 0.01))
                rad.append(0.07 * (1 - 0.5 * t))
            if not k.gone((PX + math.cos(a) * DR * 0.7, PY + math.sin(a) * DR * 0.7, DZ + 3.2)):
                k.sweep(path, rad, seg=4, layer='metal', tint=GOLD, mode='whole', cap=False)
    k.finial(PX, PY, top - 0.1, 1.7, GOLD)
    if not k.gone((PX, PY, top + 2.0)):
        with k.piece('whole', anchor=(PX, PY, top)):
            # crescent on the finial
            n = 8
            for i in range(n):
                a0, a1 = math.radians(-60 + 300 * i / n), math.radians(-60 + 300 * (i + 1) / n)
                w0 = 0.05 + 0.09 * math.sin(math.pi * i / n)
                w1 = 0.05 + 0.09 * math.sin(math.pi * (i + 1) / n)
                R = 0.42
                zc = top + 2.55
                q = [(math.sin(a0) * R, 0, zc - math.cos(a0) * R), (math.sin(a1) * R, 0, zc - math.cos(a1) * R),
                     (math.sin(a1) * (R - w1), 0, zc - math.cos(a1) * (R - w1) + w1 * 0.3), (math.sin(a0) * (R - w0), 0, zc - math.cos(a0) * (R - w0) + w0 * 0.3)]
                for o in (-1, 1):
                    k.face([(PX + p[0], PY + o * 0.03, p[2]) for p in q], 'metal', GOLD, out=(0, o, 0))
    # ---- banners (team cloth, the sun)
    ban(k, PX, PY + 4.5, 8.9, 2.0, 5.2, math.pi, 'point')
    ban(k, PX + 4.5, PY, 8.9, 1.5, 3.0, math.pi / 2, 'point')
    ban(k, PX - 4.5, PY, 8.9, 1.5, 3.0, -math.pi / 2, 'point')
    for sx in (-1, 1):
        ban(k, sx * 7.05, -9.38, 6.6, 1.2, 4.0, 0.0, 'point', 0.2)
        ban(k, sx * 7.05, 9.38, 6.6, 1.2, 4.0, math.pi, 'point', 0.2)
        ban(k, sx * 9.13, 7.3, 6.6, 1.2, 4.0, sx * math.pi / 2, 'point', 0.2)
    # ---- courtyard life
    if not k.lod:
        z = 1.0
        awning(k, -3.6, -5.2, z + 3.4, 2.6, 2.2, 0.0)
        awning(k, 3.6, -5.2, z + 3.4, 2.6, 2.2, 0.0)
        awning(k, -5.55, 2.2, z + 3.2, 3.0, 1.5, -math.pi / 2)
        for (x, y, s) in ((-1.4, -4.5, 1.0), (1.4, -4.5, 1.0), (5.5, -1.0, 1.2), (5.6, 3.2, 0.9), (-5.5, -2.0, 1.0), (5.3, 4.2, 0.7)):
            pot(k, x, y, z, s, (0.2, 0.7, 0.7) if s > 0.95 else (0.85, 0.5, 0.3))
        # a small tiled pool in the east court
        with k.piece('whole', anchor=(5.55, 1.2, z)):
            k.block(5.55, 1.2, 1.5, 2.6, z, z + 0.35, 'trim', top='roof', top_tint=(0.75, 0.95, 1.0), mode='whole', cell=3)
        # stair to the back wall-walk
        with k.piece('whole', anchor=(-3.0, 6.3, 2.5)):
            for i in range(9):
                k.box(-5.6 + i * 0.5, 6.25, z + (i + 1) * 0.31, 0.5, 0.9, (i + 1) * 0.62, 'trim', (0.88, 0.88, 0.88), bottom=False)
    # ---- foundation stones
    r = random.Random(41)
    pts = []
    for i in range(8 if k.lod else 24):
        a = r.random() * TAU
        d = 9.3 + r.random() * 0.8
        pts.append((max(-9.9, min(9.9, math.cos(a) * d * 1.3)), max(-10.1, min(10.1, math.sin(a) * d * 1.3)), -0.15))
    k.rocks(pts, (0.2, 0.55), 'wall', (0.9, 0.88, 0.84), seed=42)


def tower(k):
    k.frustum(0, 0, 4.0, 4.0, -1.3, 3.3, 3.3, 0.9, 'trim', (0.86, 0.86, 0.86))
    door = dict(u=0, v=0.3, w=0.9, h=2.0, depth=0.3, arch='keel', back='wood', back_tint=(0.55, 0.5, 0.45))
    k.block(0, 0, 3.2, 3.2, 0.9, 5.6, openings={'-y': [slit(0, 2.6)], '+y': [door], '-x': [slit(0, 2.6)], '+x': [slit(0, 2.6)]}, taper=0.16, hollow=(0.5, 2.0), cell=1.1)
    h = 1.6 - 0.16
    for (a, b) in (((-h, -h), (h, -h)), ((h, -h), (h, h)), ((h, h), (-h, h)), ((-h, h), (-h, -h))):
        band(k, (a[0] * 1.03, a[1] * 1.03), (b[0] * 1.03, b[1] * 1.03), 4.5, proud=0.06)
    crown(k, 0, 0, h + 0.04, h + 0.04, 5.6, overhang=0.2, merlon=(0.6, 0.7, 0.36), gap=0.42, parapet=0.55)
    # kiosk: four columns under a small dome
    for i in range(4):
        a = TAU * (i + 0.5) / 4
        k.sweep([(math.cos(a) * 0.78, math.sin(a) * 0.78, 5.6), (math.cos(a) * 0.78, math.sin(a) * 0.78, 7.25)], [0.11, 0.09], seg=6, layer='trim', mode='whole', cap=False)
    k.lathe(0, 0, [(0.9, 7.25), (1.18, 7.33), (1.18, 7.47), (0.98, 7.47)], seg=12, layer='trim', mode='whole')
    top = k.dome(0, 0, 1.02, 7.47, seg=12, rings=6, point=0.36, bulge=0.07, hollow=(0.15, 0.8))
    k.finial(0, 0, top - 0.06, 0.55, GOLD)
    ban(k, 0, -1.72, 4.4, 0.9, 2.5, 0.0, 'point', 0.18)
    k.rocks([(math.cos(a) * 2.2, math.sin(a) * 2.2, -0.1) for a in (0.4, 1.9, 3.3, 4.6, 5.5)], (0.2, 0.45), 'trim', (0.92, 0.9, 0.86), seed=8)


def damage(k, stage):
    tint = (0.78, 0.74, 0.68)
    n = (0, 26, 50, 80)[stage]
    k.rubble(n // 2, (-10.5, -10.6, 10.5, 10.6), seed=130 + stage, size=(0.25, 0.7), tint=tint)
    heaps = ((-7.6, -8.8, 3.2, 1.2), (-9.4, 0.5, 3.4, 1.4), (0.5, -10.3, 3.0, 1.0), (6.8, 5.0, 3.5, 1.3))
    for i, hp in enumerate(heaps[:stage + 1]):
        k.rubble(n // 4, None, seed=140 + stage * 5 + i, size=(0.3, 0.85), heap=hp, tint=tint)
    if stage >= 2:
        k.rubble(n // 3, None, seed=170 + stage, size=(0.35, 0.9), heap=(0.0, 1.0, 3.6, 1.6), z=k.damage_cut(0.0, 1.0) - 3.4, tint=tint)


FACTION = dict(
    build=build, tower=tower, damage=damage, height=17.0,
    weather=dict(dirt=(0.80, 0.70, 0.56), moss=(0.92, 0.90, 0.78), moss_amt=0.18, dirt_h=1.5,
                 cap=(0.50, 0.45, 0.38), rim=(0.74, 0.70, 0.64), inner=(0.56, 0.52, 0.46), floor=(0.48, 0.44, 0.38), soot=0.32),
    cuts=[None,
          dict(frac=0.90, dips=((-7.05, -7.3, 4.0, 6.0), (1.6, 2.0, 3.6, 3.6))),
          dict(frac=0.64, dips=((-8.0, 0.6, 4.6, 5.6), (7.05, 7.3, 3.8, 4.4), (0.5, -8.0, 3.4, 3.0), (1.5, 2.5, 5.0, 4.2))),
          dict(frac=0.33, amp=0.10, dips=((-5.5, -6.0, 6.0, 4.0), (6.0, 3.0, 5.0, 3.4), (0, 2, 4.0, 1.4), (7.05, -7.3, 2.7, -4.6), (-3.6, 4.6, 3.0, -4.8), (-7.05, 7.3, 2.6, -2.6)))],
)
