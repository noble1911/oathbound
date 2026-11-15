"""Faction Keeps and arrow towers, built from real geometry (keep_kit.py) with tiling materials.

blender -b --factory-startup --python tools/art/blender/keep_build.py -- [kingdom,ashen,caliphate] [--noao] [--lod 0] [--stages 0,2] [--no-towers]

Out: public/models/v2/keep_<faction>.glb (+ _lod1.glb): root -> stage0 (intact) .. stage3 (ruin), show exactly one;
     public/models/v2/arrow_tower_<faction>.glb (+ _lod1.glb): one mesh;
     art-work/clean/<id>.json (facts for manifest.mjs).
Blender frame: Z up, the gate faces -Y (glTF: +Z). Footprint 18.2 x 18.9 m like the old Keep (the sim's siege
constants are measured from it), walls and towers to ~16 m, spires and flags above.
Textures: tools/art/keep_tex.py (the GLBs carry geometry, vertex colours and two untextured materials only).
"""
import json, math, random, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy

import art_lib as L
import keep_kit as K
from keep_kit import Kit, cut_surface, TAU

DARK = (0.03, 0.03, 0.035)
GOLD = (0.95, 0.72, 0.25)


def slit(u=None, v=3.0, h=1.3, a=None, w=0.24):
    o = dict(v=v, w=w, h=h, depth=0.42)
    if a is not None:
        o['a'] = a
    else:
        o['u'] = u
    return o


def window(u=None, v=5.0, w=0.75, h=1.6, glow=None, arch='pointed', a=None, depth=0.3):
    o = dict(v=v, w=w, h=h, depth=depth, arch=arch, back='glow' if glow else 'plain', back_tint=glow or DARK)
    if a is not None:
        o['a'] = a
    else:
        o['u'] = u
    return o


def buttress(k, x, y, yaw, w=0.95, out=1.3, h=5.2, z0=-1.5, layer='trim', tint=(0.86, 0.86, 0.86)):
    """Sloped buttress standing against a wall face at (x, y); local -Y (rotated by yaw) points away from the wall."""
    with k.at(x, y, 0, yaw):
        k.extrude([(0.05, z0), (-out, z0), (-out, h * 0.3), (-out * 0.55, h * 0.62), (-out * 0.5, h * 0.9), (0.05, h)], -w / 2, w / 2, layer, tint)


def portcullis(k, x, y, z0, w, h, layer='metal', tint=(0.7, 0.7, 0.72), nv=7, nh=4, bar=0.07):
    """Iron grille in the XZ plane at (x, y), sill z0."""
    if k.lod:
        nv, nh = 4, 2
    with k.piece('whole', anchor=(x, y, z0 + h * 0.4)):
        for i in range(nv):
            px = x + (i / (nv - 1) - 0.5) * (w - 0.25)
            k.box(px, y, z0 + h / 2 - 0.1, bar, bar, h + 0.2, layer, tint, bottom=False)
            if not k.lod:
                k.extrude([(px - bar * 0.9, z0 - 0.0), (px + bar * 0.9, z0 - 0.0), (px, z0 - 0.28)], y - bar / 2, y + bar / 2, layer, tint, axis='y')
        for j in range(nh):
            pz = z0 + 0.5 + j * (h - 0.6) / max(1, nh - 1)
            k.box(x, y, pz, w, bar * 0.8, bar * 1.3, layer, tint, bottom=False)


def torch(k, x, y, z, tint, s=1.0):
    """Wall torch on a face looking -Y: iron bracket, cup and a flame."""
    if k.gone((x, y, z)):
        return
    with k.piece('whole', anchor=(x, y, z)):
        k.box(x, y - 0.16, z - 0.12, 0.07, 0.36, 0.07, 'metal', (0.6, 0.6, 0.62))
        k.lathe(x, y - 0.32, [(0.05, z - 0.2), (0.15, z + 0.02), (0.13, z + 0.06)], seg=6, layer='metal', tint=(0.6, 0.6, 0.62), cap=False)
    k.flame(x, y - 0.32, z + 0.05, 0.55 * s, tint, n=2)


def shield(k, x, y, z, yaw, s=0.6):
    """Heater shield in the team colour hung on a wall (top centre at x, y, z; facing local -Y)."""
    if k.gone((x, y, z)):
        return
    with k.at(x, y, z, yaw):
        with k.piece('whole', anchor=(0, 0, 0)):
            w = s
            pts = [(-w / 2, 0), (w / 2, 0), (w / 2, -w * 0.55), (0, -w * 1.2), (-w / 2, -w * 0.55)]
            # banner texture window: the emblem on the team field
            def uv(px, pz):
                return (0.5 + px / w * 0.56, 1 - (0.40 + (-pz / (w * 1.2) - 0.5) * 0.42))
            c = (0.0, -w * 0.5)
            for i in range(5):
                a, b = pts[i], pts[(i + 1) % 5]
                f = k.face([(c[0], -0.05, c[1]), (a[0], -0.03, a[1]), (b[0], -0.03, b[1])], K.CLOTH, K.WHITE, False, uvs=[uv(*c), uv(*a), uv(*b)], out=(0, -1, 0))
                if f:
                    for lp in f.loops:
                        lp[k.col] = (0.0, 1.0, 1.0, 1.0)
                k.face([(a[0], -0.03, a[1]), (b[0], -0.03, b[1]), (b[0], 0.0, b[1]), (a[0], 0.0, a[1])], 'metal', (0.6, 0.6, 0.62), out=((a[0] + b[0]) / 2 - c[0], 0, (a[1] + b[1]) / 2 - c[1]))


def barrel(k, x, y, z, s=1.0):
    k.lathe(x, y, [(0.3 * s, z), (0.38 * s, z + 0.45 * s), (0.3 * s, z + 0.9 * s)], seg=8, layer='wood', tint=(0.85, 0.8, 0.75), mode='whole')


# ================================================================================================= Oathsworn Kingdom
def kingdom(k):
    WARM = (1.0, 0.72, 0.36)
    PLINTH = (0.80, 0.80, 0.80)
    # ---- plinth: battered, sunk into the ground
    k.frustum(0, 0, 17.9, 18.5, -1.8, 16.3, 16.7, 1.2, 'trim', PLINTH, top='floor')
    # ---- curtain walls
    HW = 6.6
    sl = [slit(u, 3.3) for u in (-3.6, -1.2, 1.2, 3.6)]
    k.block(0, -7.55, 16.0, 1.3, 0.0, HW, openings={})
    k.block(0, 7.55, 16.0, 1.3, 0.0, HW, openings={'+y': [slit(-3.2, 3.3), slit(3.2, 3.3)]})
    k.block(-7.35, 0, 1.3, 16.4, 0.0, HW, openings={'-x': sl})
    k.block(7.35, 0, 1.3, 16.4, 0.0, HW, openings={'+x': sl})
    k.battlement((8.0, -4.8), (8.0, 4.8), HW, 'cap')
    k.battlement((4.5, 8.2), (-4.5, 8.2), HW, 'cap')
    k.battlement((-8.0, 4.8), (-8.0, -4.8), HW, 'cap')
    for sx in (-1, 1):
        k.battlement((sx * 3.3, -8.2), (sx * 4.6, -8.2), HW, 'cap') if sx > 0 else k.battlement((-4.6, -8.2), (-3.3, -8.2), HW, 'cap')
    # buttresses on the side and back walls
    for t in (-2.4, 2.4):
        buttress(k, 8.0, t, math.pi / 2)
        buttress(k, -8.0, t, -math.pi / 2)
        buttress(k, t * 1.1, 8.2, math.pi)
    # ---- corner towers
    for i, (sx, sy) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
        cx, cy = sx * 6.75, sy * 7.0
        out = math.degrees(math.atan2(sy, sx)) + 90        # kit angle (0 = -Y) of the outward diagonal
        k.lathe(cx, cy, [(3.0, -1.8), (2.52, 1.3), (2.42, 1.5)], seg=18, layer='trim', tint=PLINTH, cap=False)
        ops = [slit(a=out + d, v=v) for d, v in ((-48, 3.4), (48, 3.4), (0, 5.6), (-80, 7.0), (80, 7.0))]
        k.cyl(cx, cy, 2.42, 2.3, 1.5, 9.4, seg=18, openings=ops, top='floor', hollow=(0.75, 3.0))
        if not k.lod:
            k.lathe(cx, cy, [(2.35, 6.42), (2.5, 6.5), (2.5, 6.66), (2.33, 6.74)], seg=18, layer='trim', mode='whole', cap=False)
        k.ring_battlement(cx, cy, 2.72, 9.4, n=10, style='square', r_shaft=2.3, seg=18)
        k.cone_roof(cx, cy, 2.36, 10.1, 4.4, seg=18, courses=8)
        top = k.finial(cx, cy, 14.45, 0.9)
        if sy < 0:
            k.flag(cx, cy, 14.6, pole=2.3, size=0.9, yaw=0.5)
    # ---- gatehouse
    gate = dict(u=0, v=0.25, w=3.0, h=4.7, depth=1.5, arch='round', back='wood', back_tint=(0.5, 0.48, 0.45))
    k.block(0, -7.95, 6.6, 2.4, 0.0, 8.6, openings={'-y': [gate, window(0, 6.0, 0.8, 1.5, WARM), slit(-2.2, 6.1, 1.2), slit(2.2, 6.1, 1.2)],
                                                    '-x': [slit(0, 5.2)], '+x': [slit(0, 5.2)]}, hollow=(0.8, 2.6))
    portcullis(k, 0, -8.7, 0.3, 3.0, 4.6)
    for sx in (-1, 1):
        k.block(sx * 3.0, -9.22, 0.9, 0.36, -1.5, 7.9, 'trim', (0.9, 0.9, 0.9), top='trim', cell=2.0)
        if not k.lod:
            k.extrude([(-9.42, 7.9), (-9.04, 7.9), (-9.04, 8.35)], sx * 3.0 - 0.45, sx * 3.0 + 0.45, 'trim', (0.9, 0.9, 0.9), mode='whole')
        k.banner(sx * 1.98, -9.15, 8.05, 0.95, 3.5, 0.0, 'swallow', off=0.14)
        k.flag(sx * 2.9, -8.75, 9.3, pole=2.4, size=0.85, yaw=0.5)
    k.battlement((-3.3, -9.15), (3.3, -9.15), 8.6, 'cap')
    k.battlement((3.3, -9.15), (3.3, -6.75), 8.6, 'cap')
    k.battlement((-3.3, -6.75), (-3.3, -9.15), 8.6, 'cap')
    k.battlement((3.3, -6.75), (-3.3, -6.75), 8.6, 'cap', corbels=False, overhang=0.0)
    for sx in (-1, 1):
        torch(k, sx * 1.95, -9.15, 3.3, (1.0, 0.62, 0.22))
    if not k.lod:
        for x in (-2.55, -1.5, 1.5, 2.55):
            shield(k, x, -9.46, 9.0, 0.0, 0.62)
    # roofed fighting platform over the gate (timber posts, slate hip roof)
    for sx in (-1, 1):
        for y in (-8.75, -7.15):
            if not k.gone((sx * 2.75, y, 10.9)):
                k.box(sx * 2.75, y, 9.75, 0.16, 0.16, 2.3, 'wood', (0.8, 0.75, 0.7), mode='whole', bottom=False)
    if not k.gone((0, -7.95, 11.4)):
        with k.piece('whole', anchor=(0, -7.95, 10.9)):
            k.box(0, -7.95, 10.92, 6.0, 2.1, 0.12, 'wood', (0.6, 0.57, 0.52))
    k.hip_roof(0, -7.95, 6.5, 2.7, 10.98, 1.7, ridge=3.9, courses=4, hollow=(0.15, 1.2))
    # string course under the gatehouse windows
    k.box(0, -9.19, 5.5, 6.7, 0.14, 0.2, 'trim', mode='whole')
    # ramp up to the gate
    k.extrude([(-10.9, -0.4), (-9.1, -0.4), (-9.1, 0.27), (-9.5, 0.27)], -2.0, 2.0, 'floor', (0.9, 0.9, 0.9), mode='keep')
    # ---- the great tower (donjon)
    DX, DY, DH = 0.0, 1.2, 12.0
    lit = lambda u, v: window(u, v, 0.8, 1.7, WARM)
    faces = {
        '-y': [lit(-2.4, 8.4), lit(2.4, 8.4), slit(-2.4, 4.2), slit(2.4, 4.2)],
        '+y': [lit(-2.4, 8.4), lit(2.4, 8.4), slit(-2.4, 4.2), slit(2.4, 4.2)],
        '-x': [lit(-1.6, 8.4), lit(1.6, 8.4), lit(-1.6, 4.4), lit(1.6, 4.4)],
        '+x': [lit(-1.6, 8.4), lit(1.6, 8.4), lit(-1.6, 4.4), lit(1.6, 4.4)],
    }
    k.block(DX, DY, 8.4, 8.4, 0.0, DH, openings=faces, hollow=(1.1, 3.4))
    for sx in (-1, 1):
        for sy in (-1, 1):
            k.block(DX + sx * 4.05, DY + sy * 4.05, 1.25, 1.25, 0.0, DH, 'wall', (0.93, 0.93, 0.93), top=None, cell=2.2)
    for (bx, by, bw, bd) in ((0, -4.27, 7.4, 0.16), (0, 4.27, 7.4, 0.16), (-4.27, 0, 0.16, 7.4), (4.27, 0, 0.16, 7.4)):
        k.box(DX + bx, DY + by, 7.2, bw, bd, 0.22, 'trim', mode='whole')
    c = 4.68
    k.battlement((DX - c, DY - c), (DX + c, DY - c), DH, 'cap')
    k.battlement((DX + c, DY - c), (DX + c, DY + c), DH, 'cap')
    k.battlement((DX + c, DY + c), (DX - c, DY + c), DH, 'cap')
    k.battlement((DX - c, DY + c), (DX - c, DY - c), DH, 'cap')
    # bartizans on the corners
    for sx in (-1, 1):
        for sy in (-1, 1):
            bx, by = DX + sx * 4.75, DY + sy * 4.75
            out = math.degrees(math.atan2(sy, sx)) + 90
            k.lathe(bx, by, [(0.12, 9.3), (0.5, 10.0), (0.98, 10.8)], seg=10, layer='trim', cap=False)
            k.cyl(bx, by, 0.98, 0.98, 10.8, 13.7, seg=10, openings=[slit(a=out, v=11.9, h=1.0, w=0.2)], top='floor', cell=1.6, hollow=(0.3, 1.4))
            k.cone_roof(bx, by, 1.12, 13.7, 2.5, seg=10, courses=5)
            k.finial(bx, by, 16.15, 0.6)
    # the slate roof
    k.hip_roof(DX, DY, 8.3, 8.3, DH + 0.55, 4.6, ridge=2.6, courses=10)
    ridge_z = DH + 0.55 + 4.6
    k.box(DX, DY, ridge_z + 0.05, 2.9, 0.16, 0.2, 'metal', (0.55, 0.55, 0.6), mode='whole')
    for sx in (-1, 1):
        k.finial(DX + sx * 1.35, DY, ridge_z + 0.1, 0.85)
    k.flag(DX, DY, ridge_z, pole=3.2, size=1.5, yaw=0.5)
    # dormers front and back
    for sy in (-1, 1):
        with k.at(DX, DY + sy * 2.75, 0, 0 if sy < 0 else math.pi):
            if not k.gone((0, 0, 14.6)):
                with k.piece('whole', anchor=(0, 0, 14.0)):
                    k.block(0, 0.2, 1.3, 1.4, 13.4, 14.5, 'accent', (0.9, 0.9, 0.9), openings={'-y': [window(0, 13.6, 0.5, 0.75, WARM, depth=0.15)]}, top=None, mode='whole', cell=3)
                    k.extrude([(-0.85, 14.45), (0.85, 14.45), (0, 15.35)], -0.6, 1.2, 'roof', axis='y')
    for sx in (-1, 1):
        with k.at(DX + sx * 2.75, DY, 0, sx * math.pi / 2):
            if not k.gone((0, 0, 14.6)):
                with k.piece('whole', anchor=(0, 0, 14.0)):
                    k.block(0, 0.2, 1.2, 1.4, 13.4, 14.4, 'accent', (0.9, 0.9, 0.9), openings={'-y': [window(0, 13.55, 0.45, 0.7, WARM, depth=0.15)]}, top=None, mode='whole', cell=3)
                    k.extrude([(-0.8, 14.35), (0.8, 14.35), (0, 15.2)], -0.6, 1.2, 'roof', axis='y')
    # chimney
    k.block(DX + 2.7, DY + 2.4, 0.9, 0.9, 13.5, 17.4, 'wall', (0.85, 0.85, 0.85), top='trim', cell=2.5, hollow=(0.22, 1.2))
    k.box(DX + 2.7, DY + 2.4, 17.45, 1.1, 1.1, 0.16, 'trim', mode='whole')
    # big banners on the great tower, smaller ones on the outer walls (seen from the planning camera behind)
    k.banner(DX, DY - 4.2, 11.2, 2.1, 5.6, 0.0, 'swallow')
    k.banner(DX, DY + 4.2, 11.2, 2.1, 5.6, math.pi, 'swallow')
    k.banner(DX + 4.2, DY, 11.4, 1.5, 2.6, math.pi / 2, 'swallow')
    k.banner(DX - 4.2, DY, 11.4, 1.5, 2.6, -math.pi / 2, 'swallow')
    k.banner(0, 8.2, 6.0, 1.5, 3.8, math.pi, 'swallow', off=0.4)
    k.banner(8.0, 0, 6.0, 1.3, 3.6, math.pi / 2, 'swallow', off=0.4)
    k.banner(-8.0, 0, 6.0, 1.3, 3.6, -math.pi / 2, 'swallow', off=0.4)
    # ---- courtyard life (LOD0 only)
    if not k.lod:
        z = 1.2
        # well
        k.cyl(-2.4, -4.6, 0.75, 0.75, z, z + 0.8, seg=10, layer='trim', top='plain', top_tint=DARK, mode='whole', cell=2)
        for sx in (-1, 1):
            k.box(-2.4 + sx * 0.7, -4.6, z + 1.3, 0.1, 0.1, 1.9, 'wood', mode='whole')
        with k.piece('whole', anchor=(-2.4, -4.6, z + 2.0)):
            k.extrude([(-5.35, z + 2.1), (-3.85, z + 2.1), (-4.6, z + 2.65)], -3.3, -1.5, 'roof')
        # crates, barrels, a lean-to against the east wall
        for (x, y, s) in ((2.6, -4.4, 0.8), (3.3, -4.9, 0.6), (2.5, -5.3, 0.55), (-5.6, 3.6, 0.7), (-5.5, 2.7, 0.55)):
            k.box(x, y, z + s / 2, s, s, s, 'wood', (0.9, 0.85, 0.8), mode='whole', yaw=x * 3)
        for (x, y) in ((3.6, -3.9), (-5.2, -2.2), (-5.7, -1.6), (5.4, 4.8)):
            barrel(k, x, y, z)
        with k.piece('whole', anchor=(5.6, 0.5, z + 1.0)):
            k.extrude([(-1.6, z + 2.9), (1.6 + 1.0, z + 2.9), (1.6 + 1.0, z + 3.0), (-1.6, z + 3.0)], 4.5, 6.7, 'wood', (0.7, 0.7, 0.7))
            with k.at(0, 0, 0):
                k.face([(4.45, -1.7, z + 2.55), (6.7, -1.7, z + 3.3), (6.7, 2.7, z + 3.3), (4.45, 2.7, z + 2.55)], 'roof', out=(0, 0, 1))
            for y in (-1.5, 2.5):
                k.box(4.6, y, z + 1.3, 0.14, 0.14, 2.6, 'wood')
        # stair up to the back wall-walk
        with k.piece('whole', anchor=(-3.5, 6.4, 3.0)):
            for i in range(9):
                k.box(-5.6 + i * 0.5, 6.45, z + (i + 1) * 0.3, 0.5, 0.9, (i + 1) * 0.6, 'trim', (0.85, 0.85, 0.85), bottom=False)
    # ---- foundation stones
    r = random.Random(21)
    pts = []
    for i in range(10 if k.lod else 30):
        a = r.random() * TAU
        d = 9.2 + r.random() * 0.9
        pts.append((max(-9.9, min(9.9, math.cos(a) * d * 1.3)), max(-10.1, min(10.1, math.sin(a) * d * 1.3)), -0.15))
    k.rocks(pts, (0.3, 0.8), 'trim', (0.95, 0.95, 0.92), seed=22)


def kingdom_tower(k):
    PL = (0.80, 0.80, 0.80)
    k.lathe(0, 0, [(2.0, -1.3), (1.66, 0.8), (1.6, 0.95)], seg=14, layer='trim', tint=PL, cap=False)
    ops = [slit(a=a, v=2.7, h=1.2) for a in (0, 90, 270)] + [dict(a=180, v=0.3, w=0.9, h=1.9, depth=0.3, arch='round', back='wood', back_tint=(0.5, 0.48, 0.45))]
    k.cyl(0, 0, 1.6, 1.5, 0.95, 5.0, seg=14, openings=ops, top='floor', hollow=(0.5, 2.0))
    k.ring_battlement(0, 0, 1.92, 5.0, n=8, r_shaft=1.5, seg=14, merlon=(0.62, 0.7, 0.36), parapet=0.65)
    k.cone_roof(0, 0, 1.56, 5.6, 2.7, seg=14, courses=6)
    k.finial(0, 0, 8.25, 0.6)
    k.banner(0, -1.62, 4.55, 0.85, 2.3, 0.0, 'swallow', off=0.2)
    r = random.Random(5)
    k.rocks([(math.cos(a) * 2.1, math.sin(a) * 2.1, -0.1) for a in (0.4, 1.9, 3.3, 4.6, 5.5)], (0.2, 0.45), 'trim', (0.75, 0.75, 0.72), seed=6)


def kingdom_damage(k, stage):
    n = (0, 26, 50, 80)[stage]
    k.rubble(n // 2, (-10.5, -10.6, 10.5, 10.6), seed=30 + stage, size=(0.25, 0.7))
    heaps = ((7.2, -8.6, 3.2, 1.2), (9.3, 0.8, 3.4, 1.4), (0.5, -10.2, 3.0, 1.0), (-6.5, 4.0, 3.5, 1.3))
    if stage >= 2:
        # the fallen floors inside the great tower
        k.rubble(n // 3, None, seed=70 + stage, size=(0.35, 0.9), heap=(0.0, 1.2, 3.6, 1.6), z=k.damage_cut(0.0, 1.2) - 3.6)
    for i, hp in enumerate(heaps[:stage + 1]):
        k.rubble(n // 4, None, seed=40 + stage * 5 + i, size=(0.3, 0.85), heap=hp)


FACTIONS = {
    'kingdom': dict(
        build=kingdom, tower=kingdom_tower, damage=kingdom_damage, height=17.2,
        weather=dict(dirt=(0.66, 0.58, 0.47), moss=(0.74, 0.86, 0.60), moss_amt=0.55, cap=(0.34, 0.32, 0.30)),
        cuts=[None,
              dict(frac=0.90, dips=((6.75, -7.0, 4.2, 6.5), (0.5, 1.5, 4.5, 3.2))),
              dict(frac=0.66, dips=((8.0, 0.8, 4.6, 6.2), (-6.75, 7.0, 4.0, 5.0), (0, -8, 3.6, 3.2))),
              dict(frac=0.34, amp=0.10, dips=((5.5, -6.0, 6.0, 4.4), (-6.0, 3.0, 5.0, 3.6), (0, 2, 4.0, 1.5), (-6.75, -7.0, 2.6, -4.5), (-4.0, 5.2, 3.0, -5.0), (6.75, 7.0, 2.4, -2.5)))],
    ),
}


for _f in ('ashen', 'caliphate'):
    try:
        FACTIONS[_f] = __import__(f'keep_{_f}').FACTION
    except ImportError:
        pass


def materials():
    out = []
    for name in ('keep', 'cloth'):
        m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        m.use_nodes = True
        p = m.node_tree.nodes['Principled BSDF']
        p.inputs['Roughness'].default_value = 0.9
        if not any(n.type == 'VERTEX_COLOR' for n in m.node_tree.nodes):
            vc = m.node_tree.nodes.new('ShaderNodeVertexColor')
            vc.layer_name = 'Color'
            m.node_tree.links.new(vc.outputs['Color'], p.inputs['Base Color'])
        out.append(m)
    return out


def export(path, objs):
    L.export_glb(path, objs, extra=dict(export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_active_vertex_color_when_no_material=True, export_materials='EXPORT'))


def main():
    args = L.argv()
    names = [a for a in args if not a.startswith('--')]
    ids = names[0].split(',') if names else list(FACTIONS)
    opt = lambda key, d: args[args.index(key) + 1] if key in args else d
    ao = '--noao' not in args
    lods = [int(x) for x in opt('--lod', '0,1').split(',')]
    stages = [int(x) for x in opt('--stages', '0,1,2,3').split(',')]
    L.clear()
    mats = materials()
    for fid in ids:
        F = FACTIONS[fid]
        H = F['height']
        facts = {}
        for lod in lods:
            name = f'keep_{fid}' + ('_lod1' if lod else '')
            root = bpy.data.objects.new(name, None)
            bpy.context.scene.collection.objects.link(root)
            kids, tris = [], []
            for s in range(4):
                if s not in stages:
                    # placeholder so the node contract holds in partial test builds
                    k = Kit(0, 1, seed=1, ao=False)
                    k.box(0, 0, 0.5, 1, 1, 1)
                else:
                    c = F['cuts'][s]
                    cut = cut_surface(H, c['frac'], 100 + s * 7, c.get('dips', ()), amp=c.get('amp', 0.07)) if c else None
                    k = Kit(s, lod, seed=7, cut=cut, height=H, weather=F['weather'], ao=ao)
                    F['build'](k)
                    if s:
                        k.damage_cut = cut
                        k.cut = None                    # rubble is not cut
                        F['damage'](k, s)
                        k.cut = cut
                ob, n = k.finalize(f'stage{s}', mats)
                ob.parent = root
                kids.append(ob)
                tris.append(n)
                print(f'[keep] {name} stage{s}: {n} tris', flush=True)
            export(L.OUT / f'{name}.glb', [root] + kids)
            facts[name] = tris
            for o in [root] + kids:
                me = o.data
                bpy.data.objects.remove(o, do_unlink=True)
                if me:
                    bpy.data.meshes.remove(me)
        if len(lods) == 2 and len(stages) == 4:
            (L.WORK / 'clean' / f'keep_{fid}.json').write_text(json.dumps(dict(id=f'keep_{fid}', height=16, stage_tris=facts), indent=1))
        if '--no-towers' in args:
            continue
        tt = {}
        for lod in lods:
            name = f'arrow_tower_{fid}' + ('_lod1' if lod else '')
            k = Kit(0, lod, seed=9, height=8, weather=F['weather'], ao=ao)
            F['tower'](k)
            ob, n = k.finalize(name, mats)
            export(L.OUT / f'{name}.glb', [ob])
            tt[lod] = n
            print(f'[keep] {name}: {n} tris', flush=True)
            me = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            bpy.data.meshes.remove(me)
        if len(lods) == 2:
            (L.WORK / 'clean' / f'arrow_tower_{fid}.json').write_text(json.dumps(dict(id=f'arrow_tower_{fid}', height=7.06, tris_lod0=tt[0], tris_lod1=tt[1]), indent=1))


if __name__ == '__main__':
    main()
