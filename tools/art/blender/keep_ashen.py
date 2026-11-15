"""Ashen Covenant Keep: a necropolis of black basalt, rib-bone buttresses, skull-lined battlements, iron spires,
a gate that is a fanged skull's maw, and sickly green soul-fire. Loaded by keep_build.py (FACTION)."""
import math, random

import keep_kit as K
from keep_kit import TAU

DARK = (0.03, 0.03, 0.035)
SOUL = (0.14, 1.0, 0.08)            # soul-fire (kept saturated: the tone mapper whitens anything brighter)
SOUL_DIM = (0.08, 0.62, 0.05)
SOUL_CORE = (0.38, 1.0, 0.24)
SOUL_MID = (0.22, 1.0, 0.13)
BONE = (1.0, 0.98, 0.92)
BONE_OLD = (0.86, 0.82, 0.72)
IRON = (0.75, 0.78, 0.78)
BASALT = (1.0, 1.0, 1.0)
PLINTH = (0.85, 0.85, 0.85)


def slit(u=None, v=3.0, h=1.3, a=None, w=0.24):
    o = dict(v=v, w=w, h=h, depth=0.42)
    if a is not None:
        o['a'] = a
    else:
        o['u'] = u
    return o


def lancet(u=None, v=5.0, w=0.8, h=2.4, a=None, glow=SOUL, depth=0.3):
    o = dict(v=v, w=w, h=h, depth=depth, arch='pointed', back='glow', back_tint=glow)
    if a is not None:
        o['a'] = a
    else:
        o['u'] = u
    return o


def portcullis(k, x, y, z0, w, h, nv=7, nh=4, bar=0.08):
    if k.lod:
        nv, nh = 4, 2
    with k.piece('whole', anchor=(x, y, z0 + h * 0.4)):
        for i in range(nv):
            px = x + (i / (nv - 1) - 0.5) * (w - 0.25)
            k.box(px, y, z0 + h / 2 - 0.1, bar, bar, h + 0.2, 'metal', IRON, bottom=False)
        for j in range(nh):
            pz = z0 + 0.5 + j * (h - 0.6) / max(1, nh - 1)
            k.box(x, y, pz, w, bar * 0.8, bar * 1.3, 'metal', IRON, bottom=False)


def skull(k, x, y, z, s=0.26, yaw=0.0, tint=BONE):
    """A skull looking along local -Y (rotated by yaw): cranium, jaw, two dark sockets."""
    if k.gone((x, y, z)):
        return
    with k.at(x, y, z, yaw):
        with k.piece('whole', anchor=(0, 0, 0)):
            k.blob(0, 0, s * 0.95, s, s * 1.1, s * 0.95, 'accent', tint, detail=1 if k.lod else 2, smooth=True)
            if not k.lod:
                k.box(0, -s * 0.45, s * 0.12, s * 1.1, s * 0.9, s * 0.5, 'accent', (tint[0] * 0.85, tint[1] * 0.85, tint[2] * 0.85), bottom=False)
                for sx in (-1, 1):
                    k.box(sx * s * 0.42, -s * 1.0, s * 0.92, s * 0.42, s * 0.3, s * 0.42, 'plain', DARK, bottom=False)


def rib(k, x, y, yaw, out=2.3, h=7.4, r=0.38, lean=0.0, tint=BONE):
    """A giant rib rising out of the ground `out` metres from a wall face at (x, y) and curling in against it at
    height h. Local -Y (rotated by yaw) points away from the wall."""
    with k.at(x, y, 0, yaw):
        pts = [(lean * 0.0, -out * 0.80, -1.2), (lean * 0.1, -out * 1.0, 1.0), (lean * 0.3, -out * 0.98, h * 0.42),
               (lean * 0.6, -out * 0.72, h * 0.72), (lean * 0.85, -out * 0.36, h * 0.92), (lean, 0.05, h * 1.0), (lean, 0.25, h * 0.97)]
        rad = [r * 1.25, r * 1.1, r, r * 0.85, r * 0.68, r * 0.45, r * 0.2]
        if k.lod:
            pts, rad = pts[::2] + [pts[-1]] if len(pts) % 2 == 0 else pts[::2], rad[::2] + [rad[-1]] if len(rad) % 2 == 0 else rad[::2]
        k.sweep(pts, rad, seg=7, layer='accent', tint=tint, mode='solid')
        if not k.lod:
            # iron bands strapping the bone
            for i in (1, 3):
                p = pts[i]
                if k.gone(p):
                    continue
                d = (pts[i + 1][0] - pts[i - 1][0], pts[i + 1][1] - pts[i - 1][1], pts[i + 1][2] - pts[i - 1][2])
                n = math.sqrt(sum(c * c for c in d))
                d = tuple(c / n for c in d)
                k.sweep([tuple(p[j] - d[j] * 0.14 for j in range(3)), tuple(p[j] + d[j] * 0.14 for j in range(3))], [rad[i] * 1.22, rad[i] * 1.22], seg=7, layer='metal', tint=IRON, mode='whole')


def brazier(k, x, y, z, s=1.0, legs=True):
    """Iron bowl of soul-fire."""
    if k.gone((x, y, z + 0.3)):
        return
    with k.piece('whole', anchor=(x, y, z)):
        if legs:
            k.lathe(x, y, [(0.16 * s, z), (0.09 * s, z + 0.25 * s), (0.09 * s, z + 0.65 * s)], seg=6, layer='metal', tint=IRON, cap=False)
        k.lathe(x, y, [(0.1 * s, z + 0.62 * s), (0.4 * s, z + 0.85 * s), (0.46 * s, z + 1.02 * s), (0.36 * s, z + 1.0 * s)], seg=8, layer='metal', tint=IRON, cap=False)
        k.disc(x, y, z + 0.98 * s, 0.37 * s, 8, 'glow', SOUL_DIM)
    soulfire(k, x, y, z + 0.95 * s, 0.8 * s)


def soulfire(k, x, y, z, s=1.0, n=3):
    """Tongues of green soul-fire (unlit glow)."""
    if k.gone((x, y, z)):
        return
    r = random.Random(int(x * 17 + y * 31 + z * 7))
    with k.piece('whole', anchor=(x, y, z)):
        for i in range(1 if k.lod else n):
            a = r.random() * TAU
            d = 0.0 if i == 0 else 0.17 * s
            hh = s * (1.0 if i == 0 else 0.5 + r.random() * 0.35)
            ww = s * (0.28 if i == 0 else 0.19)
            cx, cy = x + math.cos(a) * d, y + math.sin(a) * d
            lean = (r.random() - 0.5) * 0.25 * s
            k.sweep([(cx, cy, z - 0.05 * s), (cx + lean * 0.3, cy, z + hh * 0.25), (cx + lean * 0.7, cy, z + hh * 0.6), (cx + lean, cy, z + hh)],
                    [ww * 0.5, ww, ww * 0.6, 0.01], seg=5, layer='glow', tint=SOUL_MID if i == 0 else SOUL, mode='whole', cap=False)


def ring_corbels(k, cx, cy, rs, r, z, n=8, drop=0.55):
    """Corbels under a tower parapet that fall with the tower (anchored on its axis)."""
    if k.lod or k.gone((cx, cy, z - 0.3)):
        return
    m = max(8, int(TAU * r / 0.75))
    with k.piece('whole', anchor=(cx, cy, z - 0.3)):
        for i in range(m):
            a = TAU * (i + 0.5) / m
            k.box(cx + math.cos(a) * (rs + r) / 2, cy + math.sin(a) * (rs + r) / 2, z - drop * 0.55, 0.3, r - rs + 0.12, drop * 0.75, 'trim', (0.9, 0.9, 0.9), yaw=a + math.pi / 2)


def spire(k, cx, cy, r, z, h, sides=8, courses=6, finial=True, flag=False):
    k.cone_roof(cx, cy, r, z, h, courses=courses, sides=sides, flare=0.30, lip=0.06, hollow=(0.14, 1.8))
    if finial:
        k.finial(cx, cy, z + h - 0.25, 0.8, tint=IRON)
    if flag:
        k.flag(cx, cy, z + h - 0.3, pole=2.2, size=1.0, yaw=0.5, style='tatter', tint=(0.3, 0.3, 0.3))


def pinnacle(k, x, y, z0, z1, w=0.7, hs=2.2):
    """Gothic pinnacle: a slim square shaft with a pointed iron cap."""
    k.block(x, y, w, w, z0, z1, 'trim', (1.0, 1.0, 1.0), top=None, cell=3.0)
    k.cone_roof(x, y, w * 0.78, z1, hs, courses=2, sides=4, flare=0.1, lip=0.05, hollow=None)


# ================================================================================================= the Keep
def ashen(k):
    lod = k.lod
    # ---- plinth
    k.frustum(0, 0, 17.9, 18.5, -1.8, 16.3, 16.7, 1.0, 'trim', PLINTH, top='floor')
    # ---- curtain walls
    HW = 6.4
    sl = [slit(u, 3.2) for u in (-3.6, -1.2, 1.2, 3.6)]
    k.block(0, -7.55, 16.0, 1.3, 0.0, HW)
    k.block(0, 7.55, 16.0, 1.3, 0.0, HW, openings={'+y': [slit(-3.3, 3.2), slit(3.3, 3.2)]})
    k.block(-7.35, 0, 1.3, 16.4, 0.0, HW, openings={'-x': sl})
    k.block(7.35, 0, 1.3, 16.4, 0.0, HW, openings={'+x': sl})
    runs = (((8.0, -4.9), (8.0, 4.9)), ((4.7, 8.2), (-4.7, 8.2)), ((-8.0, 4.9), (-8.0, -4.9)), ((-4.7, -8.2), (-3.4, -8.2)), ((3.4, -8.2), (4.7, -8.2)))
    for p0, p1 in runs:
        k.battlement(p0, p1, HW, 'spike', merlon=(0.7, 0.8, 0.42), gap=0.75, parapet=0.7)
        if not lod:
            # skulls staring out between the spikes
            L = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
            n = max(1, int((L + 0.75) / 1.45))
            ang = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
            for i in range(1, n):
                t = i / n
                ox, oy = math.sin(ang) * 0.1, -math.cos(ang) * 0.1
                if i % 2 == 0 or L < 3:
                    skull(k, p0[0] + (p1[0] - p0[0]) * t + ox, p0[1] + (p1[1] - p0[1]) * t + oy, HW + 0.7, 0.2, ang)
    # ---- rib buttresses clasping the side and back walls
    for t, ln in ((-3.3, -0.25), (0.0, 0.0), (3.3, 0.25)):
        rib(k, 8.0, t, math.pi / 2, lean=ln)
        rib(k, -8.0, t, -math.pi / 2, lean=-ln)
    for t in (-2.6, 2.6):
        rib(k, t, 8.2, math.pi, out=2.2, h=7.2, lean=-t * 0.08)
    # ---- corner towers: eight-sided basalt, iron spires
    for i, (sx, sy) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
        cx, cy = sx * 6.8, sy * 7.05
        out = math.degrees(math.atan2(sy, sx)) + 90
        k.lathe(cx, cy, [(2.95, -1.8), (2.45, 1.1), (2.34, 1.3)], seg=8, layer='trim', tint=PLINTH, cap=False, smooth=False)
        ops = [slit(a=out - 45, v=3.2), slit(a=out + 45, v=3.2), lancet(a=out, v=5.4, w=0.6, h=1.9), lancet(a=out - 90, v=6.6, w=0.5, h=1.5), lancet(a=out + 90, v=6.6, w=0.5, h=1.5)]
        k.cyl(cx, cy, 2.34, 2.2, 1.3, 9.6, seg=8, openings=ops, top='floor', smooth=False, hollow=(0.7, 3.0))
        if not lod:
            k.lathe(cx, cy, [(2.28, 4.55), (2.42, 4.62), (2.42, 4.78), (2.26, 4.85)], seg=8, layer='trim', mode='whole', cap=False, smooth=False)
        k.ring_battlement(cx, cy, 2.62, 9.6, n=8, style='spike', r_shaft=2.2, seg=8, merlon=(0.6, 0.8, 0.4), parapet=0.6, corbels=False)
        ring_corbels(k, cx, cy, 2.2, 2.62, 9.6)
        spire(k, cx, cy, 2.3, 10.2, 6.0 if sy < 0 else 5.2, sides=8, courses=7, flag=(sy > 0))
        if not lod:
            for d in (-45, 45):
                a = math.radians(out + d) - math.pi / 2
                skull(k, cx + math.cos(a) * 2.5, cy + math.sin(a) * 2.5, 10.2, 0.22, a + math.pi / 2)
    # ---- gatehouse: the skull's maw
    GF = -8.85                                   # front face
    gate = dict(u=0, v=0.25, w=3.1, h=4.3, depth=1.5, arch='pointed', back='wood', back_tint=(0.5, 0.5, 0.5))
    k.block(0, GF + 1.15, 6.6, 2.3, 0.0, 8.6, openings={'-y': [gate], '-x': [slit(0, 5.0)], '+x': [slit(0, 5.0)]}, hollow=(0.8, 2.6))
    portcullis(k, 0, GF + 0.45, 0.3, 3.1, 4.2)
    for p0, p1, kw in (((-3.3, GF), (3.3, GF), {}), ((3.3, GF), (3.3, GF + 2.3), {}), ((-3.3, GF + 2.3), (-3.3, GF), {}), ((3.3, GF + 2.3), (-3.3, GF + 2.3), dict(corbels=False, overhang=0.0))):
        k.battlement(p0, p1, 8.6, 'spike', merlon=(0.7, 0.8, 0.42), **kw)
    # the skull over the gate
    SY, SZ = GF + 0.15, 6.85
    SA = (0, GF + 1.0, 4.6)                       # the skull stands or falls with the gate arch
    if not k.gone(SA):
        with k.piece('whole', anchor=SA):
            k.blob(0, SY, SZ, 2.5, 1.4, 2.25, 'accent', BONE, detail=2 if lod else 3, smooth=True)
            for sx in (-1, 1):
                # cheekbones
                k.blob(sx * 1.6, SY - 0.85, 5.65, 0.62, 0.45, 0.42, 'accent', BONE_OLD, detail=1 if lod else 2, smooth=True)
        # brow ridge and cheekbones
        k.sweep([(-2.3, SY - 0.85, 6.7), (-1.2, SY - 1.3, 7.35), (0, SY - 1.38, 7.1), (1.2, SY - 1.3, 7.35), (2.3, SY - 0.85, 6.7)], [0.26, 0.36, 0.3, 0.36, 0.26], seg=6, layer='accent', tint=BONE_OLD, mode='keep')
        for sx in (-1, 1):
            # eye sockets: a dark hollow with soul-fire deep inside
            k.blob(sx * 1.05, SY - 1.13, 6.55, 0.62, 0.28, 0.55, 'plain', DARK, detail=2, smooth=True, mode='keep')
            k.blob(sx * 1.05, SY - 1.3, 6.5, 0.26, 0.14, 0.26, 'glow', SOUL_CORE, detail=1 if lod else 2, smooth=True, mode='keep')
            # horns
            k.sweep([(sx * 2.0, SY + 0.2, 7.9), (sx * 3.1, SY + 0.1, 8.5), (sx * 3.85, SY, 9.7), (sx * 3.75, SY - 0.15, 11.0), (sx * 3.3, SY - 0.3, 11.9)], [0.5, 0.44, 0.34, 0.2, 0.03], seg=7, layer='accent', tint=BONE_OLD, mode='keep')
            # jaw posts flanking the gate
            k.sweep([(sx * 2.25, GF - 0.25, 5.3), (sx * 2.15, GF - 0.42, 3.4), (sx * 1.95, GF - 0.38, 1.4), (sx * 1.9, GF - 0.3, -0.3)], [0.42, 0.36, 0.3, 0.3], seg=6, layer='accent', tint=BONE_OLD, mode='solid')
        k.blob(0, SY - 1.13, 5.75, 0.36, 0.16, 0.5, 'plain', DARK, detail=2, smooth=True, mode='keep')
    # upper jaw and fangs over the arch
    if not k.gone(SA):
        k.sweep([(-2.3, GF - 0.25, 5.2), (-1.2, GF - 0.5, 4.95), (0, GF - 0.58, 4.85), (1.2, GF - 0.5, 4.95), (2.3, GF - 0.25, 5.2)], [0.36, 0.4, 0.4, 0.4, 0.36], seg=6, layer='accent', tint=BONE, mode='keep')
        teeth = ((-1.42, 1.9, 0.2), (-0.95, 0.75, 0.15), (-0.5, 0.6, 0.14), (0, 0.5, 0.13), (0.5, 0.6, 0.14), (0.95, 0.75, 0.15), (1.42, 1.9, 0.2))
        for (tx, tl, tr) in (teeth[::3] if lod else teeth):
            ty = GF - 0.5 + abs(tx) * 0.1
            k.sweep([(tx, ty, 4.75), (tx, ty - 0.04, 4.75 - tl * 0.55), (tx * 0.97, ty, 4.75 - tl)], [tr, tr * 0.72, 0.02], seg=5, layer='accent', tint=BONE, mode='keep')
    for sx in (-1, 1):
        # lower fangs and braziers by the road
        if not lod:
            k.sweep([(sx * 1.48, GF - 0.42, -0.2), (sx * 1.46, GF - 0.46, 0.7), (sx * 1.42, GF - 0.4, 1.35)], [0.18, 0.13, 0.02], seg=5, layer='accent', tint=BONE, mode='whole')
        brazier(k, sx * 3.25, GF - 0.9, 0.0, 1.25)
        brazier(k, sx * 2.85, GF + 0.45, 8.62, 0.9, legs=False)
    k.extrude([(GF - 1.7, -0.4), (GF + 0.05, -0.4), (GF + 0.05, 0.27), (GF - 0.35, 0.27)], -2.0, 2.0, 'floor', (0.9, 0.9, 0.9), mode='keep')
    # ---- the sanctum (great hall of the dead)
    DX, DY, DH = 0.0, 1.2, 11.4
    tall = lambda u: lancet(u, 5.8, 0.7, 3.3)
    faces = {
        '-y': [tall(-2.5), tall(2.5), slit(-2.5, 2.6), slit(2.5, 2.6)],
        '+y': [tall(-2.5), tall(0), tall(2.5), slit(-1.25, 2.6), slit(1.25, 2.6)],
        '-x': [tall(-2.3), tall(0), tall(2.3)],
        '+x': [tall(-2.3), tall(0), tall(2.3)],
    }
    k.block(DX, DY, 8.4, 8.4, 0.0, DH, openings=faces, hollow=(1.1, 3.4))
    for sx in (-1, 1):
        for sy in (-1, 1):
            # clasping corner piers that rise into pinnacles
            k.block(DX + sx * 4.1, DY + sy * 4.1, 1.2, 1.2, 0.0, DH + 1.6, 'trim', (1.0, 1.0, 1.0), top=None, cell=2.4)
            k.cone_roof(DX + sx * 4.1, DY + sy * 4.1, 0.95, DH + 1.6, 3.0, courses=3, sides=4, flare=0.12, lip=0.06, hollow=None)
            if not lod:
                skull(k, DX + sx * 4.1 + sx * 0.0, DY + sy * 4.1 + sy * 0.72, DH + 0.2, 0.26, 0 if sy < 0 else math.pi)
    for (bx, by, bw, bd) in ((0, -4.27, 7.2, 0.16), (0, 4.27, 7.2, 0.16), (-4.27, 0, 0.16, 7.2), (4.27, 0, 0.16, 7.2)):
        k.box(DX + bx, DY + by, 4.9, bw, bd, 0.22, 'trim', mode='whole')
    c = 4.25
    for p0, p1 in (((DX - 3.5, DY - c), (DX + 3.5, DY - c)), ((DX + c, DY - 3.5), (DX + c, DY + 3.5)), ((DX + 3.5, DY + c), (DX - 3.5, DY + c)), ((DX - c, DY + 3.5), (DX - c, DY - 3.5))):
        k.battlement(p0, p1, DH, 'spike', merlon=(0.7, 0.85, 0.42), gap=0.7)
        if not lod:
            L = 7.0
            ang = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
            for i in (1, 3, 5):
                t = i / 6
                skull(k, p0[0] + (p1[0] - p0[0]) * t + math.sin(ang) * 0.38, p0[1] + (p1[1] - p0[1]) * t - math.cos(ang) * 0.38, DH + 0.72, 0.21, ang)
    # steep iron roof with gables front and back, a lantern tower and the great spire
    k.hip_roof(DX, DY, 8.0, 8.0, DH + 0.5, 3.6, ridge=0.0, courses=7, flare=0.2, hollow=(0.18, 2.4))
    LZ = DH + 2.6
    ops = [lancet(a=a, v=LZ + 0.55, w=0.62, h=1.6) for a in (0, 90, 180, 270)]
    k.cyl(DX, DY, 1.75, 1.65, LZ, LZ + 2.7, seg=8, openings=ops, top='floor', smooth=False, hollow=(0.4, 1.6), layer='trim', cell=1.6)
    k.ring_battlement(DX, DY, 1.95, LZ + 2.7, n=8, style='spike', r_shaft=1.65, seg=8, merlon=(0.42, 0.6, 0.3), parapet=0.3, corbels=False, drop=0.35)
    spire(k, DX, DY, 1.72, LZ + 3.0, 4.6, sides=8, courses=6, flag=True)
    if not lod:
        # iron crown of spikes around the lantern
        for i in range(8):
            a = TAU * (i + 0.5) / 8
            x, y = DX + math.cos(a) * 2.5, DY + math.sin(a) * 2.5
            if not k.gone((x, y, DH + 2.6)):
                k.sweep([(x, y, DH + 1.5), (x + math.cos(a) * 0.25, y + math.sin(a) * 0.25, DH + 2.6), (x + math.cos(a) * 0.1, y + math.sin(a) * 0.1, DH + 3.5)], [0.1, 0.07, 0.01], seg=4, layer='metal', tint=IRON, mode='whole')
    # soul-fire braziers on the four corners of the wall-walk and a great one in the forecourt
    for sx in (-1, 1):
        brazier(k, sx * 5.6, -5.2, 1.0, 1.1)
        brazier(k, sx * 5.4, 5.9, 1.0, 1.0)
    # sarcophagus in the forecourt
    if not lod:
        with k.piece('whole', anchor=(0, -4.6, 1.2)):
            k.block(0, -4.6, 1.2, 2.6, 1.0, 1.8, 'trim', (1.0, 1.0, 1.0), top='trim', mode='whole', cell=3)
            k.extrude([(-5.95, 1.8), (-3.25, 1.8), (-3.5, 2.05), (-5.7, 2.05)], -0.68, 0.68, 'accent', BONE_OLD)
        for (x, y) in ((-2.2, -5.0), (2.3, -4.2), (-5.6, 1.5), (5.7, -1.2), (5.5, 3.0), (-5.4, -2.6)):
            skull(k, x, y, 1.0, 0.24, x * 2.0, BONE_OLD)
    # ---- banners: tattered, on the tower fronts, the sanctum and the outer walls
    k.banner(DX, DY - 4.2, 10.6, 2.0, 5.2, 0.0, 'tatter')
    k.banner(DX + 4.2, DY - 1.15, 10.6, 1.3, 4.2, math.pi / 2, 'tatter')
    k.banner(DX - 4.2, DY + 1.15, 10.6, 1.3, 4.2, -math.pi / 2, 'tatter')
    k.banner(DX + 1.25, DY + 4.2, 4.7, 1.2, 3.2, math.pi, 'tatter')
    k.banner(DX - 1.25, DY + 4.2, 4.7, 1.2, 3.2, math.pi, 'tatter')
    k.banner(0, 8.2, 6.0, 1.6, 3.9, math.pi, 'tatter', off=0.4)
    k.banner(8.0, -1.65, 6.0, 1.2, 3.5, math.pi / 2, 'tatter', off=0.4)
    k.banner(-8.0, 1.65, 6.0, 1.2, 3.5, -math.pi / 2, 'tatter', off=0.4)
    for sx in (-1, 1):
        k.banner(sx * 6.8, -7.05 - 2.3, 8.9, 1.15, 3.8, 0.0, 'tatter', off=0.16)
    # ---- bones and broken stones heaped against the foundation
    r = random.Random(41)
    pts, sk = [], []
    for i in range(10 if lod else 26):
        a = r.random() * TAU
        d = 9.3 + r.random() * 0.9
        p = (max(-9.9, min(9.9, math.cos(a) * d * 1.3)), max(-10.1, min(10.1, math.sin(a) * d * 1.3)), -0.15)
        if abs(p[0]) < 3.2 and p[1] < -9:
            continue
        (sk if i % 3 == 0 else pts).append(p)
    k.rocks(pts, (0.3, 0.8), 'trim', (0.95, 0.95, 0.95), seed=42)
    if not lod:
        for (x, y, z) in sk:
            skull(k, x, y, 0.0, 0.3, r.random() * TAU, BONE_OLD)
            k.sweep([(x + 0.4, y + 0.3, 0.1), (x + 1.2, y + 0.6, 0.18)], [0.09, 0.07], seg=5, layer='accent', tint=BONE_OLD, mode='keep')


def ashen_tower(k):
    k.lathe(0, 0, [(2.0, -1.3), (1.62, 0.8), (1.55, 0.95)], seg=8, layer='trim', tint=PLINTH, cap=False, smooth=False)
    ops = [lancet(a=0, v=2.5, w=0.42, h=1.5), slit(a=90, v=2.7, h=1.2), slit(a=270, v=2.7, h=1.2),
           dict(a=180, v=0.3, w=0.9, h=1.9, depth=0.3, arch='pointed', back='wood', back_tint=(0.5, 0.5, 0.5))]
    k.cyl(0, 0, 1.55, 1.45, 0.95, 5.0, seg=8, openings=ops, top='floor', smooth=False, hollow=(0.5, 2.0))
    k.ring_battlement(0, 0, 1.88, 5.0, n=8, style='spike', r_shaft=1.45, seg=8, merlon=(0.5, 0.65, 0.34), parapet=0.6, corbels=False)
    ring_corbels(k, 0, 0, 1.45, 1.88, 5.0)
    # four ribs clasp the shaft
    for a in (45, 135, 225, 315):
        ar = math.radians(a)
        x, y = math.cos(ar) * 1.5, math.sin(ar) * 1.5
        rib(k, x, y, ar + math.pi / 2, out=0.75, h=4.7, r=0.17)
    # iron spire on four posts, a soul-fire beacon under it
    for a in (45, 135, 225, 315):
        ar = math.radians(a)
        k.box(math.cos(ar) * 1.2, math.sin(ar) * 1.2, 6.3, 0.14, 0.14, 1.5, 'metal', IRON, mode='whole', bottom=False, yaw=ar)
    k.cone_roof(0, 0, 1.75, 6.95, 2.6, courses=4, sides=8, flare=0.3, lip=0.06, hollow=(0.12, 1.2))
    k.finial(0, 0, 9.3, 0.6, tint=IRON)
    brazier(k, 0, 0, 5.05, 0.9, legs=False)
    if not k.lod:
        for a in (0, 90, 180, 270):
            ar = math.radians(a) - math.pi / 2
            skull(k, math.cos(ar) * 1.8, math.sin(ar) * 1.8, 5.62, 0.2, ar + math.pi / 2)
    k.banner(0, -1.52, 4.6, 0.85, 2.3, 0.0, 'tatter', off=0.2)
    k.rocks([(math.cos(a) * 2.1, math.sin(a) * 2.1, -0.1) for a in (0.4, 1.9, 3.3, 4.6, 5.5)], (0.2, 0.45), 'trim', (0.95, 0.95, 0.95), seed=6)


def ashen_damage(k, stage):
    n = (0, 26, 52, 84)[stage]
    k.rubble(n // 2, (-10.5, -10.6, 10.5, 10.6), seed=30 + stage, size=(0.25, 0.7))
    heaps = ((7.4, -8.4, 3.2, 1.2), (9.3, 0.8, 3.4, 1.4), (-6.5, 4.0, 3.5, 1.3), (0.5, -10.4, 2.6, 0.8))
    r = random.Random(60 + stage)
    for i, hp in enumerate(heaps[:stage + 1]):
        k.rubble(n // 4, None, seed=40 + stage * 5 + i, size=(0.3, 0.85), heap=hp)
        # bones in the rubble and green embers still burning
        if not k.lod:
            for j in range(3):
                a = r.random() * TAU
                x, y = hp[0] + math.cos(a) * hp[2] * 0.6, hp[1] + math.sin(a) * hp[2] * 0.5
                skull(k, x, y, 0.25, 0.26, a, BONE_OLD)
        soulfire(k, hp[0] + 0.3, hp[1] - 0.2, hp[3] * 0.7, 0.8 + 0.25 * stage)
    if stage >= 2:
        z = k.damage_cut(0.0, 1.2) - 3.6
        k.rubble(n // 3, None, seed=70 + stage, size=(0.35, 0.9), heap=(0.0, 1.2, 3.6, 1.6), z=z)
        soulfire(k, 0.4, 1.0, max(0.0, z) + 1.3, 1.6)
        soulfire(k, -1.6, 2.2, max(0.0, z) + 0.9, 1.0, n=2)


FACTION = dict(
    build=ashen, tower=ashen_tower, damage=ashen_damage, height=17.0,
    weather=dict(dirt=(0.72, 0.68, 0.60), moss=(0.80, 0.95, 0.74), moss_amt=0.22, cap=(0.5, 0.5, 0.5), rim=(0.75, 0.75, 0.75),
                 inner=(0.6, 0.6, 0.6), floor=(0.5, 0.5, 0.5), soot=0.3, ao=0.85),
    cuts=[None,
          dict(frac=0.90, dips=((6.8, -7.05, 4.2, 7.0), (0.5, 1.5, 4.5, 3.4))),
          dict(frac=0.66, dips=((8.0, 0.8, 4.6, 6.2), (-6.8, 7.05, 4.0, 5.0), (0, -8, 3.4, 2.0))),
          dict(frac=0.34, amp=0.10, dips=((5.5, -6.0, 6.0, 4.4), (-6.0, 3.0, 5.0, 3.6), (0, 2, 4.0, 1.5), (-6.8, -7.05, 2.6, -4.5), (-4.0, 5.2, 3.0, -5.0), (6.8, 7.05, 2.4, -2.5), (0, -8.2, 3.0, -4.0)))],
)
