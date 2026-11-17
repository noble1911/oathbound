"""Authored siege engines (docs/ART.md section 10): ballista, trebuchet (Kingdom), corpse catapult (Ashen Covenant)
as real geometry on the trappings kit -- heavy timbers with end grain, iron straps with bolts, wheels, lashings,
torsion skeins, flat-art heraldry, team pennants -- with one atlas per engine shared by all of its rigid nodes;
siege_weather.py then bakes occlusion, grime, rust and edge wear into that atlas. siege.py drives this
(assets.json `authored: true`).

build(aid, lod) -> dict(nodes={name: object}, parent={name: parent name | None}, anim=fn(node name, clip, n, key),
                        lens={clip: frames}, fire_frame, kit)
Unit space: metres, +Z up, the engine shoots towards -Y, ground z = 0. Every node object has its origin at its pivot.
Nodes (the renderer plays the GLB clips by node name and addresses none of them itself):
  ballista        : body, bolt, arm_l, arm_r (bow arms, spring forward on `fire`, drawn back on `reload`),
                    string_l, string_r (children of the arms)
  trebuchet /
  corpse_catapult : frame, arm (pivot at the axle), weight (counterweight, hinged on the short arm, stays plumb),
                    rope (sling, pivot at the arm tip), stone
Sizes follow the renderer's archetypes (src/render/crowd/archetypes.ts) and the sim radii: the ballista's bolt lies
at `muzzle` 1.15 m; the trebuchet is 3.2 m wide (sim radius 1.4 m) with the arm tip at 5.9 m in the ready pose, the corpse catapult
is the same engine at 5/6.
"""
import math
import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

import trappings_lib as T
import trappings as TR

FPS = 24
WOODS = {'oak', 'wood_dark', 'wood_grey'}


def _variant(base, name, tint, **kw):
    if name not in T.SRC:
        T.SRC[name] = T.tile(base).variant(tint=tint, name=name, **kw)
        if base in WOODS:
            WOODS.add(name)
    return name


def _endgrain(wood):
    """End-grain tile for a wood tile source: growth rings with a few radial checks, in the wood's own colour."""
    key = f'end_{wood}'
    if key not in T.SRC:
        w = T.tile(wood); n = 256
        v, u = np.mgrid[0:n, 0:n].astype(np.float32) / n - 0.5
        wob = T.fbm(n, 1.6, 3)
        r = np.sqrt((u * 1.1 + 0.06) ** 2 + (v - 0.04) ** 2)
        ring = 0.5 + 0.5 * np.sin(r * 2 * math.pi * 38 + 7 * wob)
        ang = np.arctan2(v - 0.04, u * 1.1 + 0.06)
        chk = T.smooth(np.cos(ang * 5 + 1.3), 0.985, 1.0) * T.smooth(r, 0.05, 0.3)
        mean = w.col.mean((0, 1))
        col = mean[None, None] * (0.74 + 0.2 * ring[..., None]) * (1 - 0.5 * chk[..., None]) * 0.92
        T.SRC[key] = T.Src(np.clip(col, 0, 1), None, np.clip(ring * 0.6 + 0.4 - chk, 0, 1), 0.82, 0.0, 0.5, 0.003, name=key)
    return T.SRC[key]


class Eng:
    def __init__(self, name, faction, lod, scale=1.0):
        self.kit = T.Kit(name); self.lod = lod; self.k = scale
        self.look = dict(TR.LOOK[faction]); self.faction = faction
        self.look['iron'] = 'iron' if faction == 'kingdom' else 'bronze'
        # seasoned, darker timber than the kit's fresh oak (the engines stand in the field)
        self.look['wood'] = _variant('oak', 'siege_oak', (0.9, 0.86, 0.86)) if faction == 'kingdom' else _variant('wood_dark', 'siege_dark', (0.98, 0.93, 0.95))
        self.seg = 6 if lod else 10
        self._bn = 0
        self.fires = []                                       # [(centre, radius)] soul-fire light painted into the albedo

    def add(self, ob, src, node, w=1.0, **kw):
        if self.k != 1.0:
            ob.data.transform(Matrix.Scale(self.k, 4))
        return self.kit.add(ob, src, w=w, node=node, **kw)

    def rivet(self, c, n, node, r=0.017):
        """A bolt head: a low dome at c, pointing along n."""
        if self.lod:
            return
        ob = T.lathe('rivet', [(r, 0.0), (r * 0.72, r * 0.5), (0.0, r * 0.72)], nseg=4)
        ob.data.transform(Matrix.Translation(Vector(c)) @ Vector((0, 0, 1)).rotation_difference(Vector(n).normalized()).to_matrix().to_4x4())
        self.add(ob, self.look['iron'], node, w=0.5, jitter=0)

    def beam(self, p0, p1, w, h, node, src=None, up=(0, 0, 1), bands=(), band_len=0.12, wt=1.0, caps=True):
        """A timber: grain along its length, end-grain caps, iron straps (`bands`: fractions of the length) with bolts."""
        src = src or self.look['wood']
        ob = T.beam('beam', p0, p1, w, h, up=up)
        p0 = Vector(p0); p1 = Vector(p1)
        x = (p1 - p0).normalized(); y = Vector(up).cross(x)
        if y.length < 1e-4:
            y = Vector((0, 1, 0)).cross(x)
        y.normalize(); z = x.cross(y)
        if caps and not self.lod and isinstance(src, str) and src in WOODS:
            bm = bmesh.new(); bm.from_mesh(ob.data); bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[bm.faces[4], bm.faces[5]], context='FACES_ONLY')
            bm.to_mesh(ob.data); bm.free()
            eg = _endgrain(src)
            cs = ((-1, -1), (1, -1), (1, 1), (-1, 1))
            for pe, sg in ((p0, -1), (p1, 1)):
                q = [pe + y * (a * w / 2) + z * (b * h / 2) for a, b in cs]
                uv = [(0.25 + a * w / 2, 0.25 + b * h / 2) for a, b in cs]
                if sg < 0:
                    q = q[::-1]; uv = uv[::-1]
                self.add(T.quad('endgrain', *q, uv=uv), eg, node, w=wt, jitter=0)
        self.add(ob, src, node, w=wt)
        for f in bands:                                       # iron straps around the beam, a bolt on three faces
            c = p0.lerp(p1, f); d = x * band_len / 2
            self.add(T.beam('strap', c - d, c + d, w + 0.03, h + 0.03, up=up), self.look['iron'], node, w=0.8)
            for n_, off in ((y, w / 2 + 0.015), (-y, w / 2 + 0.015), (z, h / 2 + 0.015)):
                self.rivet(c + n_ * off, n_, node)

    def plate(self, c, n, u, sx, sy, node, th=0.018):
        """An iron fitting: a flat plate centred at c, facing n, sx along u, with corner bolts."""
        n = Vector(n).normalized(); u = Vector(u).normalized(); v = n.cross(u)
        c = Vector(c)
        ob = T.box('plate', (-sx / 2, -sy / 2, 0), (sx / 2, sy / 2, th))
        M = Matrix((u, v, n)).transposed().to_4x4(); M.translation = c
        ob.data.transform(M)
        self.add(ob, self.look['iron'], node, w=0.8)
        for a in (-1, 1):
            for b in (-1, 1):
                self.rivet(c + u * (a * (sx / 2 - 0.04)) + v * (b * (sy / 2 - 0.04)) + n * th, n, node)

    def bone(self, p0, p1, r, node, wt=1.0):
        """A long bone: a slightly bowed shaft with knobbed ends; radius, bow, knobs and tint vary per bone."""
        self._bn += 1
        rng = np.random.default_rng(100 + self._bn)
        p0 = np.array(p0, float); p1 = np.array(p1, float)
        d = p1 - p0; ln = float(np.linalg.norm(d))
        side = np.cross(d, rng.normal(size=3)); side /= np.linalg.norm(side) + 1e-9
        bow = side * ln * rng.uniform(0.008, 0.03)
        rr = r * rng.uniform(0.88, 1.14)
        k0, k1 = rng.uniform(1.4, 1.9, 2)
        ts = [0, 0.025, 0.07, 0.15, 0.32, 0.5, 0.68, 0.85, 0.93, 0.975, 1.0]
        rs = [0.8, k0, k0 * 1.02, 1.02, 0.9, 0.86, 0.9, 1.02, k1 * 1.02, k1, 0.8]
        if self.lod:
            ts = [0, 0.06, 0.16, 0.84, 0.94, 1.0]; rs = [0.9, k0, 1.0, 1.0, k1, 0.9]
        nm, tint = [('bone_aged', (0.86, 0.83, 0.76)), ('bone_pale', (0.97, 0.96, 0.92)), ('bone_dark', (0.7, 0.64, 0.55)), ('bone_aged', (0.86, 0.83, 0.76))][self._bn % 4]
        src = _variant('bone', nm, tint)
        pts = [p0 + d * t + bow * math.sin(math.pi * t) for t in ts]
        self.add(T.tube('bone', pts, [rr * x for x in rs], nseg=5 if self.lod else 8, squash=(1.0, rng.uniform(0.82, 1.0))), src, node, w=wt, jitter=0.12)
        if not self.lod and r >= 0.1:                         # condyles on the big bones
            for pe, kk in ((p0 + d * 0.035, k0), (p1 - d * 0.035, k1)):
                for sgn in (1, -1):
                    self.add(T.sphere('condyle', pe + side * sgn * rr * 0.62, rr * kk * 0.66, seg=6, rings=4), src, node, w=0.7, jitter=0.1)

    def lash(self, c, d, r, node, length=0.16):
        """Rope lashing (sinew on the Ashen engine): turns of cord around a member at c along direction d."""
        if self.lod:
            return
        c = Vector(c); d = Vector(d).normalized() * length / 2
        src = 'rope' if self.faction != 'ashen' else _variant('rope', 'sinew', (0.86, 0.58, 0.5), rough=0.7)
        pts = [c - d, c - d * 0.5, c, c + d * 0.5, c + d]
        self.add(T.tube('lash', pts, [r * 0.95, r * 1.07, r * 1.02, r * 1.07, r * 0.95], nseg=8, cap=False), src, node, w=0.8, jitter=0)

    def wheel(self, c, r, w, node, spokes=8, lite=False):
        """lite: LOD1 with a 6-sided rim and a 4-sided hub (the sun mirror's triangle budget)."""
        c = Vector(c)
        wood, iron = self.look['wood'], self.look['iron']
        rim = [(r - 0.12, -w / 2), (r - 0.012, -w / 2), (r - 0.012, w / 2), (r - 0.12, w / 2), (r - 0.12, -w / 2)]
        seg = (6 if lite else 8) if self.lod else 18
        self.add(T.lathe('rim', rim, nseg=seg, centre=c, axis='X'), wood, node, w=0.9)
        if not self.lod:
            self.add(T.lathe('tyre', [(r - 0.012, -w / 2 - 0.008), (r, -w / 2 - 0.008), (r, w / 2 + 0.008), (r - 0.012, w / 2 + 0.008)], nseg=seg, centre=c, axis='X'), iron, node, w=0.8)
        self.add(T.lathe('hub', [(0.0, -w / 2 - 0.05), (0.07, -w / 2 - 0.05), (0.1, -w / 2), (0.1, w / 2), (0.07, w / 2 + 0.05), (0.0, w / 2 + 0.05)], nseg=(4 if lite else 5) if self.lod else 10, centre=c, axis='X'), iron, node, w=0.8)
        n = 4 if self.lod else spokes
        sx = 1 if c.x >= 0 else -1
        for i in range(n):
            a = 2 * math.pi * i / n
            d = Vector((0, math.cos(a), math.sin(a)))
            self.add(T.beam('spoke', c + d * 0.08, c + d * (r - 0.11), 0.06, 0.06, up=(1, 0, 0)), wood, node, w=0.7)
            a2 = a + math.pi / n                                # tyre nails between the spokes
            d2 = Vector((0, math.cos(a2), math.sin(a2)))
            self.rivet(c + d2 * (r - 0.06) + Vector((sx * (w / 2 + 0.001), 0, 0)), (sx, 0, 0), node, r=0.014)

    def merge(self, kit, M, node):
        """Take the pieces of another kit (a trappings builder) transformed by M."""
        for it in kit.items:
            it['ob'].data.transform(Matrix.Scale(self.k, 4) @ M)
            it['copies'] = [Matrix.Scale(self.k, 4) @ M @ Matrix(c) @ M.inverted() @ Matrix.Scale(1 / self.k, 4) for c in it['copies']]
            it['node'] = node
            self.kit.items.append(it)

    def finish(self, pivots, parent, tex, texel):
        import os
        if os.environ.get('SIEGE_COUNT'):                     # triangles per piece name (budget work)
            cnt = {}
            for it in self.kit.items:
                k = it['ob'].name.split('.')[0]
                n = T.tris(it['ob']) * (1 + len(it['copies'])) * (2 if it['mirror'] else 1) * (2 if it['double'] else 1)
                cnt[k] = cnt.get(k, 0) + n
            print('[siege] tris by piece', 'LOD1' if self.lod else 'LOD0', sorted(cnt.items(), key=lambda x: -x[1]))
        obs = self.kit.finish(tex=tex, texel=texel)
        if not isinstance(obs, dict):
            obs = {None: obs}
        world = {name: Vector(pivots.get(name, (0, 0, 0))) * self.k for name in obs}
        for name, ob in obs.items():
            ob.data.transform(Matrix.Translation(-world[name]))
            pn = parent.get(name)
            if pn:
                ob.parent = obs[pn]                              # no parent inverse: local = offset between the pivots
            ob.location = world[name] - (world[pn] if pn else Vector((0, 0, 0)))
        if not os.environ.get('SIEGE_NOWEATHER'):
            import siege_weather
            siege_weather.weather(self, obs)
        return obs


def _skull_src():
    s = T.flat('skull_front', rough=0.6, bump=0.01)
    if 'skull_bg' not in T.SRC:
        col = s.col.copy()
        mean = col[s.solid].mean(0) * 0.55 if s.solid.any() else np.array((0.5, 0.45, 0.35))
        col[~s.solid] = mean
        T.SRC['skull_bg'] = T.Src(col, None, s.h, 0.6, 0.0, None, 0.01, s.solid, 'skull_bg')
    return T.SRC['skull_bg']


def _skull(e, c, r, face, node):
    """A skull: a sphere with the flat skull art projected from the front; `face` = the way it looks."""
    ob = T.sphere('skull', (0, 0, 0), (r * 0.82, r, r * 1.05), seg=6 if e.lod else 8, rings=4 if e.lod else 6, metric=False)
    co = T.verts(ob)
    vi = np.empty(len(ob.data.loops), np.int32); ob.data.loops.foreach_get('vertex_index', vi)
    uv = np.stack([0.5 + co[vi, 0] / (r * 0.82) * 0.36, 0.5 + co[vi, 2] / (r * 1.05) * 0.42], 1)
    T.set_uv(ob, uv)
    f = Vector(face).normalized()
    rot = Vector((0, -1, 0)).rotation_difference(f).to_matrix().to_4x4()
    ob.data.transform(Matrix.Translation(c) @ rot)
    e.add(ob, _skull_src(), node, w=1.0)


def _pennant(e, pos, node, pole=0.9, size=(0.7, 0.3), tail='swallow'):
    k = TR.pennant(dict(pole=pole, size=size, tail=tail, faction=e.faction), {})
    e.merge(k, Matrix.Translation(pos), node)


def _hanging(e, top_centre, w, h, node, art, tatter=0.0, yaw=0.0, seed=5):
    """A small gonfalon hanging from a bar, both sides. art: flat art name, or a tile name (plain team cloth).
    yaw 0 = in the XZ plane facing -Y."""
    P, UV = TR._cloth_grid(w, h, 5 if e.lod else 7, 5 if e.lod else 9, 0.04, 'point', tatter, seed=seed)
    tile = art.startswith('cloth')
    if tile:
        UV = UV * (w, h)
    cl = T.grid_mesh('gonfalon', P, UV)
    T.orient_out(cl, (0, 5, 0))
    bar = T.tube('bar', [(-w / 2 - 0.05, 0, 0.01), (w / 2 + 0.05, 0, 0.01)], 0.02, nseg=5)
    M = Matrix.Translation(top_centre) @ Matrix.Rotation(yaw, 4, 'Z')
    cl.data.transform(M); bar.data.transform(M)
    e.add(cl, art if tile else T.flat(art, rough=0.85, metal_gold=0.25, bump=0.004), node, w=1.0, double=True, jitter=0)
    e.add(bar, e.look['wood'], node, w=0.6)


# =============================================================================================== ballista
def ballista(lod):
    e = Eng('ballista', 'kingdom', lod, 0.85)                 # 2.5 m across the bow: the sim's 1.1 m radius
    wood, iron = e.look['wood'], e.look['iron']
    B = 'body'
    ZS = 1.21                                                 # stock centre; the bolt lies 0.14 above it: 1.15 m in the engine
    # carriage
    for sx in (1, -1):
        e.beam((sx * 0.48, -1.25, 0.52), (sx * 0.48, 1.3, 0.52), 0.17, 0.19, B, bands=(0.08, 0.92))
        for sy in (-0.82, 0.86):
            e.wheel((sx * 0.75, sy, 0.38), 0.38, 0.12, B)
    for y in (-0.82, 0.86):
        e.add(T.tube('axle', [(-0.88, y, 0.38), (0.88, y, 0.38)], 0.04, nseg=e.seg // 2 + 1), iron, B, w=0.6)
        e.beam((-0.48, y, 0.45), (0.48, y, 0.45), 0.18, 0.15, B)
    e.beam((-0.48, 0.0, 0.52), (0.48, 0.0, 0.52), 0.14, 0.14, B)
    # trestles carrying the stock, lashed at the feet
    for y in (-0.95, 0.75):
        for sx in (1, -1):
            a = Vector((sx * 0.46, y, 0.6)); b = Vector((sx * 0.09, y, ZS - 0.06))
            e.beam(a, b, 0.13, 0.13, B, up=(0, 1, 0))
            e.lash(a.lerp(b, 0.1), b - a, 0.105, B, length=0.12)
        e.beam((-0.3, y, 0.86), (0.3, y, 0.86), 0.09, 0.1, B)
    for sx in (1, -1):                                        # diagonal braces along the carriage
        e.beam((sx * 0.46, -0.25, 0.62), (sx * 0.1, 0.6, ZS - 0.08), 0.09, 0.09, B, up=(1, 0, 0))
    # stock (slider) with a bolt trough, iron bands
    e.beam((0, -1.5, ZS), (0, 1.38, ZS), 0.24, 0.19, B, bands=(0.06, 0.3, 0.55, 0.8), band_len=0.09)
    for sx in (1, -1):                                        # trough rails either side of the bolt
        e.beam((sx * 0.055, -1.45, ZS + 0.115), (sx * 0.055, 0.62, ZS + 0.115), 0.04, 0.045, B, src='wood_dark')
    e.beam((0, -1.45, ZS + 0.098), (0, 0.62, ZS + 0.098), 0.07, 0.012, B, src='wood_dark', caps=False)
    # torsion frame: two cross beams, four uprights, a rope skein with iron washers either side of the stock
    for z in (ZS - 0.23, ZS + 0.23):
        e.beam((-0.56, -1.2, z), (0.56, -1.2, z), 0.24, 0.09, B, bands=(0.07, 0.93), band_len=0.1)
    for x in (-0.5, -0.17, 0.17, 0.5):
        e.beam((x, -1.2, ZS - 0.185), (x, -1.2, ZS + 0.185), 0.22, 0.07, B, up=(1, 0, 0), caps=False)
    for sx in (1, -1):
        cx = sx * 0.335
        e.add(T.tube('skein', [(cx, -1.2, ZS - 0.3), (cx, -1.2, ZS - 0.1), (cx, -1.2, ZS + 0.1), (cx, -1.2, ZS + 0.3)], [0.085, 0.072, 0.072, 0.085], nseg=e.seg, cap=False), 'rope', B, w=1.0, jitter=0)
        for z, sg in ((ZS + 0.29, 1), (ZS - 0.29, -1)):
            e.add(T.lathe('washer', [(0.0, -0.02), (0.115, -0.02), (0.115, 0.02), (0.0, 0.02)], nseg=e.seg, centre=(cx, -1.2, z)), iron, B, w=0.8)
            e.add(T.tube('pin', [(cx - 0.13, -1.2, z + 0.035 * sg), (cx + 0.13, -1.2, z + 0.035 * sg)], 0.018, nseg=5), iron, B, w=0.5)
    # heraldic plate under the frame (flat art, team field)
    sh = TR.shield(dict(kind='kite', height=0.5, faction='kingdom', strap=False, nu=5 if lod else 7, nv=7 if lod else 9), {})
    e.merge(sh, Matrix.Translation((0, -1.36, ZS - 0.55)), B)
    # windlass at the back: cheeks, rope drum, ratchet, crank spokes, the draw rope to the trigger claw
    for sx in (1, -1):
        e.beam((sx * 0.2, 1.22, ZS - 0.07), (sx * 0.2, 1.22, ZS + 0.44), 0.08, 0.2, B, up=(0, 1, 0))
        hub = Vector((sx * 0.32, 1.22, ZS + 0.31))
        for i in range(2 if lod else 4):
            a = math.pi * i / (2 if lod else 4) + 0.3
            d = Vector((0, math.cos(a), math.sin(a))) * 0.27
            e.add(T.tube('crank', [hub - d, hub + d], 0.02, nseg=4), wood, B, w=0.6)
        e.add(T.lathe('boss', [(0.0, -0.025), (0.05, -0.025), (0.05, 0.025), (0.0, 0.025)], nseg=6, centre=hub, axis='X'), iron, B, w=0.6)
    e.add(T.tube('drum', [(-0.16, 1.22, ZS + 0.31), (0.16, 1.22, ZS + 0.31)], 0.09, nseg=e.seg), 'rope', B, w=0.9, jitter=0)
    e.add(T.tube('drum_axle', [(-0.34, 1.22, ZS + 0.31), (0.34, 1.22, ZS + 0.31)], 0.03, nseg=5), iron, B, w=0.5)
    if not lod:
        e.add(T.lathe('ratchet', [(0.0, -0.012), (0.13, -0.012), (0.13, 0.012), (0.0, 0.012)], nseg=8, centre=(0.255, 1.22, ZS + 0.31), axis='X'), iron, B, w=0.7)
        e.add(T.beam('pawl', (0.255, 1.08, ZS + 0.47), (0.255, 1.2, ZS + 0.44), 0.02, 0.03), iron, B, w=0.5)
        e.add(T.tube('drawrope', [(0, 1.16, ZS + 0.38), (0, 0.9, ZS + 0.2), (0, 0.66, ZS + 0.15)], 0.013, nseg=4, cap=False), 'rope', B, w=0.6, jitter=0)
    # trigger block and claw
    e.add(T.box('trigger', (-0.07, 0.5, ZS + 0.08), (0.07, 0.66, ZS + 0.19)), iron, B, w=0.8)
    _pennant(e, (0.2, 1.22, ZS + 0.44), B, pole=0.75, size=(0.6, 0.26))
    # bow arms (nodes) rooted in the skeins, iron bands and tip caps; strings from the tips to the nock
    nock = Vector((0, 0.5, ZS + 0.05))
    pivots = dict(body=(0, 0, 0), bolt=(0, -0.45, ZS + 0.14))
    parent = dict(body=None, bolt=None)
    info = {}
    for sx, nm in ((1, 'r'), (-1, 'l')):
        root = Vector((sx * 0.335, -1.2, ZS))
        pts = T.catmull([root, (sx * 0.72, -1.3, ZS), (sx * 1.12, -1.17, ZS), (sx * 1.44, -0.88, ZS)], 5 if lod else 9)
        rad = T.interp_r([0.1, 0.095, 0.078, 0.055], len(pts))
        e.add(T.tube('arm', pts, rad, nseg=5 if lod else 8, squash=(1.0, 1.25)), wood, f'arm_{nm}', w=1.0)
        for f in ((0.5,) if lod else (0.3, 0.55, 0.8)):
            i = int(f * (len(pts) - 1))
            e.add(T.tube('armband', [pts[i] - (pts[i + 1] - pts[i]) * 0.2, pts[i] + (pts[i + 1] - pts[i]) * 0.2], rad[i] * 1.18, nseg=5 if lod else 8, squash=(1.0, 1.25), cap=False), iron, f'arm_{nm}', w=0.8)
        tip = Vector(pts[-1])
        e.add(T.sphere('tipcap', tip, 0.075, seg=6, rings=4), iron, f'arm_{nm}', w=0.7)
        v0 = nock - tip
        ln = v0.length
        st = T.tube('string', [(0, 0, 0), (0, ln, 0)], 0.013, nseg=4, cap=False)
        a0 = math.atan2(-v0.x, v0.y)
        st.data.transform(Matrix.Translation(tip) @ Matrix.Rotation(a0, 4, 'Z'))
        e.add(st, 'rope', f'string_{nm}', w=0.7, jitter=0)
        pivots[f'arm_{nm}'] = tuple(root); pivots[f'string_{nm}'] = tuple(tip)
        parent[f'arm_{nm}'] = 'body'; parent[f'string_{nm}'] = f'arm_{nm}'
        info[nm] = dict(root=root, tip=tip, a0=a0, ln=ln, sx=sx)
    # bolt: shaft, flat steel head, three fletchings
    zb = ZS + 0.14
    e.add(T.tube('bolt', [(0, 0.5, zb), (0, -1.3, zb)], 0.024, nseg=5 if lod else 6), 'wood_grey', 'bolt', w=0.8)
    hd = T.lathe('bolthead', [(0.026, 0.0), (0.055, 0.05), (0.032, 0.14), (0.0, 0.32)], nseg=4 if lod else 6, axis='Y')
    hd.data.transform(Matrix.Translation((0, -1.3, zb)) @ Matrix.Diagonal((1, 1, 0.5, 1)))
    e.add(hd, 'steel', 'bolt', w=1.0)
    for a in (0.0, 2.1, 4.2):
        d = Vector((math.sin(a), 0, math.cos(a))) * 0.07
        f = T.quad('fletch', (0, 0.48, zb), (0, 0.2, zb), Vector((0, 0.25, zb)) + d, Vector((0, 0.5, zb)) + d, uv=((0, 0), (0.28, 0), (0.25, 0.07), (0, 0.07)))
        e.add(f, 'cloth_cream', 'bolt', w=0.6, double=True, jitter=0)
    nodes = e.finish(pivots, parent, tex=512 if lod else 2048, texel=260 if lod else 900)
    for nm in ('r', 'l'):                                    # strings: local +Y runs along the string (rotation + stretch)
        st = nodes[f'string_{nm}']; i = info[nm]
        st.data.transform(Matrix.Rotation(-i['a0'], 4, 'Z'))
        st.rotation_euler = (0, 0, i['a0'])
    PHI = 0.2

    def pose(nm, phi):
        """(arm rotation z, string rotation z, string scale y) for a release amount phi (0 drawn .. PHI released)."""
        i = info[nm]
        ang = -i['sx'] * phi
        tip = i['root'] + Matrix.Rotation(ang, 3, 'Z') @ (i['tip'] - i['root'])
        s = min(1.0, phi / PHI)
        tgt = nock.lerp(Vector((0, tip.y, tip.z)), s)
        v = tgt - tip
        return ang, math.atan2(-v.x, v.y) - ang, v.length / i['ln']

    def anim(name, clip, n, key, ob):
        if name == 'bolt':
            rb = ob.location.copy()
            if clip == 'fire':
                # the string drives it out over 3 frames; the renderer's projectile takes over at fireTime (frame 3)
                key(ob, 0, loc=rb, scale=(1, 1, 1)); key(ob, 1, loc=rb + Vector((0, -0.12, 0))); key(ob, 2, loc=rb + Vector((0, -0.7, 0)))
                key(ob, 3, loc=rb + Vector((0, -1.9, 0.02)), scale=(1, 1, 1)); key(ob, 4, loc=rb + Vector((0, -4.5, 0.1)), scale=(0, 0, 0)); key(ob, n - 1, loc=rb, scale=(0, 0, 0))
            elif clip == 'reload':
                key(ob, 0, loc=rb + Vector((0, 0.7, 0.05)), scale=(0, 0, 0)); key(ob, n * 0.25, loc=rb + Vector((0, 0.7, 0.05)), scale=(1, 1, 1))
                key(ob, n * 0.7, loc=rb + Vector((0, 0.08, 0)), scale=(1, 1, 1)); key(ob, n - 1, loc=rb, scale=(1, 1, 1))
            elif clip == 'death':
                key(ob, 0, loc=rb, scale=(1, 1, 1)); key(ob, 6, scale=(0, 0, 0)); key(ob, n - 1, loc=rb, scale=(0, 0, 0))
            else:
                key(ob, 0, loc=rb, scale=(1, 1, 1)); key(ob, n - 1, loc=rb, scale=(1, 1, 1))
            ob.location = rb; ob.scale = (1, 1, 1)
        elif name == 'body':
            Z = (0, 0, 0)
            if clip == 'fire':
                key(ob, 0, loc=Z, rot=Z); key(ob, 1, loc=(0, -0.03, 0), rot=(-0.02, 0, 0))
                key(ob, 4, loc=(0, 0.3, 0.03), rot=(0.12, 0, 0)); key(ob, 10, loc=(0, 0.2, 0), rot=(-0.02, 0, 0))
                key(ob, 20, loc=Z, rot=Z); key(ob, n - 1, loc=Z, rot=Z)
            elif clip == 'reload':
                key(ob, 0, loc=Z, rot=Z)
                for i in range(1, 7):
                    key(ob, n * i / 8, rot=(0.022 * (1 if i % 2 else -0.4), 0, 0.012 * (1 if i % 2 else -1)))
                key(ob, n - 1, loc=Z, rot=Z)
            elif clip == 'hit':                               # knocked back and twisted, rocks twice before it settles
                key(ob, 0, loc=Z, rot=Z); key(ob, 2, loc=(0.03, 0.14, 0.02), rot=(0.11, 0.13, 0.09)); key(ob, 5, loc=(0, 0.04, 0), rot=(-0.05, -0.06, -0.04))
                key(ob, 7, loc=(0, 0.02, 0), rot=(0.02, 0.025, 0.015)); key(ob, n - 1, loc=Z, rot=Z)
            elif clip == 'death':
                key(ob, 0, loc=Z, rot=Z); key(ob, 6, loc=(0.05, 0.1, 0.05), rot=(0.1, 0.2, 0.05))
                key(ob, 16, loc=(0.35, 0.05, -0.12), rot=(0.12, 0.95, 0.12)); key(ob, 20, loc=(0.37, 0.05, -0.1), rot=(0.12, 0.88, 0.12))
                key(ob, n - 1, loc=(0.38, 0.05, -0.12), rot=(0.12, 0.93, 0.12))
            else:
                key(ob, 0, loc=Z, rot=Z); key(ob, n - 1, loc=Z, rot=Z)
            ob.location = Z; ob.rotation_euler = Z
        else:
            nm = name[-1]
            if clip == 'fire':
                ks = [(0, 0.0), (1, PHI * 0.3), (3, PHI * 1.2), (6, PHI * 0.88), (9, PHI * 1.06), (13, PHI), (n - 1, PHI)]
            elif clip == 'reload':
                ks = [(0, PHI), (n * 0.1, PHI), (n * 0.3, PHI * 0.66), (n * 0.5, PHI * 0.33), (n * 0.72, 0.0), (n - 1, 0.0)]
            elif clip == 'hit':                               # the drawn arms shiver with the blow
                ks = [(0, 0.0), (2, PHI * 0.14), (4, 0.0), (6, PHI * 0.06), (n - 1, 0.0)]
            elif clip == 'death':                             # the string lets go as the engine keels over
                ks = [(0, 0.0), (4, 0.0), (7, PHI * 1.25), (11, PHI * 0.9), (16, PHI), (n - 1, PHI)]
            else:
                ks = [(0, 0.0), (n - 1, 0.0)]
            for f, phi in ks:
                ang, sa, ss = pose(nm, phi)
                if name.startswith('arm'):
                    key(ob, f, rot=(0, 0, ang))
                else:
                    key(ob, f, rot=(0, 0, sa), scale=(1, ss, 1))
            ang, sa, ss = pose(nm, 0.0)
            if name.startswith('arm'):
                ob.rotation_euler = (0, 0, 0)
            else:
                ob.rotation_euler = (0, 0, sa); ob.scale = (1, 1, 1)
    return dict(nodes=nodes, anim=anim, lens=dict(idle=48, fire=30, reload=48, hit=10, death=36), fire_frame=3, kit=e.kit,
                order=['body', 'bolt', 'arm_l', 'arm_r', 'string_l', 'string_r'], release=(0, -0.45 * e.k, (ZS + 0.14) * e.k))


# =============================================================================================== trebuchet / corpse catapult
def trebuchet(lod, faction='kingdom', scale=1.0, name='trebuchet'):
    e = Eng(name, faction, lod, scale)
    ashen = faction == 'ashen'
    wood, iron = e.look['wood'], e.look['iron']
    F = 'frame'
    PIV = Vector((0, 0, 3.3))
    # Ready pose: the long arm stands up and back at 35 deg with the loaded sling hanging from its tip (the tall
    # silhouette that reads as a trebuchet from the RTS camera, as the model it replaces); `fire` is the last 90 deg
    # of the throw, over the top.
    TH = math.radians(55)
    d_arm = Vector((0, math.sin(TH), math.cos(TH)))
    L1, L2 = 3.3, 1.25
    tip = PIV + d_arm * L1; short = PIV - d_arm * L2
    SX, SY = 1.08, 1.6                                        # skid offset, A-frame foot spread

    # base: skids, cross beams, wheels, trough
    for sx in (1, -1):
        e.beam((sx * SX, -2.1, 0.44), (sx * SX, 2.1, 0.44), 0.3, 0.32, F, bands=(0.05, 0.5, 0.95), band_len=0.16)
        for y in (-1.45, 1.45):
            e.wheel((sx * 1.33, y, 0.34), 0.34, 0.13, F, spokes=6)
    for y in (-1.9, 1.9):
        e.beam((-SX, y, 0.44), (SX, y, 0.44), 0.26, 0.26, F)
    for y in (-1.45, 1.45):
        e.add(T.tube('axle', [(-1.44, y, 0.34), (1.44, y, 0.34)], 0.045, nseg=5), iron, F, w=0.5)
    e.beam((0, 0.55, 0.55), (0, 2.4, 0.55), 0.56, 0.07, F, src='wood_dark')
    for sx in (1, -1):
        e.beam((sx * 0.3, 0.55, 0.62), (sx * 0.3, 2.4, 0.62), 0.07, 0.12, F)
    if not ashen:                                             # spare shot stacked on the trough
        rs_ = np.random.default_rng(8)
        for i, (x, y, z) in enumerate(((-0.13, 1.5, 0.76), (0.13, 1.55, 0.76), (0.0, 1.75, 0.76)) if not lod else ((0.0, 1.55, 0.78),)):
            e.add(T.sphere('shot', (x, y, z), tuple(rs_.uniform(0.17, 0.2, 3)), seg=6, rings=4), 'stone', F, w=0.7)
    if ashen:
        # a spine along each skid, ribs arching over the trough, skulls on the skid ends
        for sx in (1, -1):
            for y in np.linspace(-1.9, 1.9, 3 if lod else 9):
                e.add(T.sphere('vert', (sx * (SX + 0.17), y, 0.52), (0.09, 0.15, 0.13), seg=6, rings=4), 'bone', F, w=0.7)
            _skull(e, (sx * SX, -2.2, 0.5), 0.2, (sx * 0.25, -1, 0.1), F)
        for y in (() if lod else (0.7, 1.15, 1.6, 2.05)):
            for sx in (1, -1):
                pts = T.catmull([(sx * 0.33, y, 0.66), (sx * 0.62, y + 0.05, 1.02), (sx * 0.92, y + 0.02, 0.95), (sx * 1.02, y, 0.62)], 4 if lod else 8)
                e.add(T.tube('rib', pts, T.interp_r([0.05, 0.045, 0.04, 0.028], len(pts)), nseg=5), 'bone', F, w=0.8, jitter=0.1)
    # A-frames: two raking legs and a king post each side, a collar brace, iron shoes on the skids
    top = {}
    for sx in (1, -1):
        tp = Vector((sx * 0.78, 0, 3.42)); top[sx] = tp
        feet = [Vector((sx * SX, -SY, 0.6)), Vector((sx * SX, SY, 0.6))]
        for ft in feet:
            e.beam(ft, tp, 0.26, 0.28, F, up=(1, 0, 0), bands=() if ashen else (0.52,))
            e.lash(ft.lerp(tp, 0.045), tp - ft, 0.21, F, length=0.2)
            e.plate((sx * (SX + 0.15), ft.y, 0.5), (sx, 0, 0), (0, 1, 0), 0.42, 0.28, F)
            if ashen and not (lod and ft.y > 0):              # a great bone lashed along each leg (LOD1: the front legs only)
                off = Vector((sx * 0.21, 0, 0.02))
                e.bone(ft.lerp(tp, 0.08) + off, ft.lerp(tp, 0.9) + off, 0.1, F)
                for f in (0.25, 0.7):
                    e.lash(ft.lerp(tp, f) + off * 0.5, tp - ft, 0.26, F, length=0.12)
        kp0 = Vector((sx * SX, 0, 0.6))
        if ashen:
            e.bone(kp0, tp + Vector((0, 0, -0.14)), 0.11, F)
        else:
            e.beam(kp0, tp + Vector((0, 0, -0.14)), 0.22, 0.24, F, up=(0, 1, 0))
        a, b = feet[0].lerp(tp, 0.42), feet[1].lerp(tp, 0.42)
        if ashen:
            e.bone(a + Vector((sx * 0.03, -0.25, 0)), b + Vector((sx * 0.03, 0.25, 0)), 0.085, F)
        else:
            e.beam(a + Vector((0, -0.2, 0)), b + Vector((0, 0.2, 0)), 0.16, 0.2, F, bands=(0.5,))
        if not lod:
            e.lash(a, b - a, 0.2, F); e.lash(b, a - b, 0.2, F)
        e.add(T.box('bearing', (tp.x - 0.17, -0.24, 3.16), (tp.x + 0.17, 0.24, 3.58)), iron, F, w=0.9)
        for sy in (1, -1):
            e.rivet((tp.x + sx * 0.17, sy * 0.15, 3.48), (sx, 0, 0), F, r=0.026)
        e.lash(tp + Vector((0, 0, -0.34)), (0, 0, 1), 0.36, F, length=0.2)
        if ashen:
            _skull(e, tuple(tp + Vector((sx * 0.02, -0.3, 0.02))), 0.19, (sx * 0.2, -1, 0.05), F)
    e.add(T.tube('axle', [(-1.02, 0, 3.3), (1.02, 0, 3.3)], 0.085, nseg=e.seg), iron, F, w=0.7)
    # windlass at the back: posts, drum, handspikes, iron pawl plate
    for sx in (1, -1):
        e.beam((sx * 0.66, 2.0, 0.6), (sx * 0.66, 2.0, 1.34), 0.14, 0.2, F, up=(0, 1, 0))
        hub = Vector((sx * 0.8, 2.0, 1.1))
        for i in range(2 if lod else 3):
            a = math.pi * i / (2 if lod else 3) + 0.2
            d = Vector((0, math.cos(a), math.sin(a))) * 0.33
            e.add(T.tube('crank', [hub - d, hub + d], 0.024, nseg=4), wood, F, w=0.6)
        e.add(T.lathe('boss', [(0.0, -0.03), (0.07, -0.03), (0.07, 0.03), (0.0, 0.03)], nseg=6, centre=hub, axis='X'), iron, F, w=0.6)
    e.add(T.tube('drum', [(-0.59, 2.0, 1.1), (0.59, 2.0, 1.1)], 0.14, nseg=e.seg), 'rope', F, w=0.9, jitter=0)
    # heraldry: gonfalons on yards off the front legs, pennants on the frame tops, (Ashen) tattered team rags on the braces
    art = e.look['banner']
    for sx in (1, -1):
        lp = Vector((sx * SX, -SY, 0.6)).lerp(top[sx], 0.55)
        e.beam((lp.x, lp.y + 0.05, lp.z), (lp.x, -SY + 0.12, lp.z), 0.06, 0.06, F, caps=False)
        _hanging(e, (lp.x, -SY + 0.1, lp.z - 0.05), 0.46, 0.92, F, art, tatter=0.3 if ashen else 0.0)
        _pennant(e, tuple(top[sx] + Vector((0, 0, 0.16))), F, pole=1.05, size=(1.05, 0.46), tail='point' if ashen else 'swallow')
        if ashen and not lod:
            a, b = Vector((sx * SX, -SY, 0.6)).lerp(top[sx], 0.42), Vector((sx * SX, SY, 0.6)).lerp(top[sx], 0.42)
            for f, hh, sd in ((0.3, 0.75, 2), (0.68, 0.6, 3)):
                c = a.lerp(b, f)
                _hanging(e, (c.x + sx * 0.12, c.y, c.z - 0.08), 0.4, hh, F, 'cloth_team', tatter=0.5, yaw=math.pi / 2 * sx, seed=sd)
    # arm
    A = 'arm'
    if ashen:
        e.bone(short, tip, 0.17, A, wt=1.2)
        for f in (0.18, 0.34, 0.6, 0.86):
            e.lash(short.lerp(tip, f), d_arm, 0.2, A, length=0.22)
    else:
        e.beam(short, tip, 0.33, 0.38, A, up=(1, 0, 0), bands=(0.03, 0.2, 0.3, 0.44, 0.6, 0.78, 0.97), band_len=0.16, wt=1.1)
        for sx in (1, -1):                                    # iron cheek plates where the axle passes
            e.plate(PIV + Vector((sx * 0.15, 0, 0)), (sx, 0, 0), d_arm, 0.7, 0.3, A)
    e.add(T.tube('hook', [tip, tip + d_arm * 0.2, tip + d_arm * 0.3 + Vector((0, -0.12, 0.07))], [0.045, 0.04, 0.014], nseg=5), iron, A, w=0.7)
    # counterweight (hinged at the short end)
    W = 'weight'
    bz = short.z - 0.45
    for sx in (1, -1):
        e.add(T.beam('hanger', (sx * 0.2, short.y, short.z), (sx * 0.44, short.y, bz), 0.07, 0.035, up=(0, 1, 0)), iron, W, w=0.7)
    e.add(T.tube('pin', [(-0.3, short.y, short.z), (0.3, short.y, short.z)], 0.05, nseg=6), iron, W, w=0.6)
    if ashen:                                                 # a bronze cage of skulls with soul-fire inside
        r = 0.56
        nb = 6 if lod else 10
        for i in range(nb):
            a = 2 * math.pi * i / nb
            p = Vector((math.cos(a) * r, short.y + math.sin(a) * r, 0))
            e.add(T.tube('bar', [p + Vector((0, 0, bz)), p + Vector((0, 0, bz - 1.0))], 0.026, nseg=4, cap=False), iron, W, w=0.7)
        for z in ((bz, bz - 1.0) if lod else (bz, bz - 0.5, bz - 1.0)):
            ring = [(math.cos(a) * r, short.y + math.sin(a) * r, z) for a in np.linspace(0, 2 * math.pi, nb + 1)]
            e.add(T.tube('hoop', ring, 0.034, nseg=4, cap=False), iron, W, w=0.7)
        e.add(T.lathe('cagefloor', [(0.0, 0.0), (r, 0.03)], nseg=nb, centre=(0, short.y, bz - 1.02)), iron, W, w=0.5)
        sk = [(0.0, 0.0, -0.8, 0.0)] + [(0.3 * math.cos(a), 0.3 * math.sin(a), z, a) for z, off in ((-0.78, 0.0), (-0.46, 0.5)) for a in np.arange(off, off + 6.2, 2 * math.pi / (2 if lod else 5))]
        for (x, y, z, a) in sk:
            _skull(e, (x, short.y + y, bz + z), 0.2, (math.cos(a), math.sin(a), 0.15) if (x or y) else (0, -1, 0.15), W)
        fc = Vector((0, short.y, bz - 0.2))
        e.add(T.sphere('fire', fc, (0.34, 0.34, 0.2), seg=6, rings=4), 'soulfire', W, w=0.5)
        if not lod:                                           # tongues of flame licking up through the hoop
            for a in (0.4, 2.5, 4.6):
                p = fc + Vector((math.cos(a) * 0.14, math.sin(a) * 0.14, 0.1))
                e.add(T.lathe('flame', [(0.11, 0.0), (0.07, 0.16), (0.0, 0.42)], nseg=5, centre=p), 'soulfire', W, w=0.5)
        e.fires.append((tuple(fc * e.k), 1.25 * e.k))
    else:                                                     # an iron-banded plank box heaped with stones
        e.add(T.box('cwbox', (-0.52, short.y - 0.48, bz - 0.9), (0.52, short.y + 0.48, bz)), wood, W, w=1.0)
        for z in (bz - 0.77, bz - 0.45, bz - 0.13):
            e.add(T.box('cwband', (-0.538, short.y - 0.498, z - 0.05), (0.538, short.y + 0.498, z + 0.05)), iron, W, w=0.8)
            for sx in (1, -1):
                for yy in (-0.3, 0.0, 0.3):
                    e.rivet((sx * 0.538, short.y + yy, z), (sx, 0, 0), W)
                    e.rivet((yy * 1.1, short.y + sx * 0.498, z), (0, sx, 0), W)
        for sx in (1, -1):
            for sy in (1, -1):
                e.add(T.box('cwpost', (sx * 0.47 - 0.075, short.y + sy * 0.43 - 0.075, bz - 0.92), (sx * 0.47 + 0.075, short.y + sy * 0.43 + 0.075, bz + 0.03), long_axis=2), wood, W, w=0.8)
        rng = np.random.default_rng(3)
        for i in range(3 if lod else 7):
            c = (rng.uniform(-0.3, 0.3), short.y + rng.uniform(-0.28, 0.28), bz + rng.uniform(-0.02, 0.08))
            e.add(T.sphere('ballast', c, tuple(rng.uniform(0.13, 0.2, 3)), seg=6, rings=4), 'stone', W, w=0.7)
    # sling: two cords from the arm tip to the pouch lying on the trough, the stone in the pouch
    R = 'rope'
    pouch = tip + Vector((0, 0, -1.1))
    for sx in (1, -1):
        for sy in (1, -1):
            e.add(T.tube('cord', [tip, tip.lerp(pouch, 0.6) + Vector((sx * 0.1, sy * 0.1, 0)), pouch + Vector((sx * 0.2, sy * 0.22, 0.03))], 0.018, nseg=4, cap=False), 'rope', R, w=0.7, jitter=0)
    pg = np.zeros((5, 4, 3)); puv = np.zeros((5, 4, 2))
    for i in range(5):
        for j in range(4):
            u = i / 4 - 0.5; v = j / 3 - 0.5
            pg[i, j] = pouch + Vector((u * 0.46, v * 0.54, -0.17 * (1 - (2 * u) ** 2) * (1 - (2 * v) ** 2)))
            puv[i, j] = (u * 0.46, v * 0.54)
    e.add(T.grid_mesh('pouch', pg, puv), e.look['leather'], R, w=0.8, double=True, jitter=0)
    S = 'stone'
    sc_ = pouch + Vector((0, 0, 0.05))
    if ashen:
        _skull(e, tuple(sc_), 0.25, (0, -1, 0.3), S)
    else:
        e.add(T.sphere('stone', sc_, (0.22, 0.21, 0.2), seg=6 if lod else 8, rings=4 if lod else 6), 'stone', S, w=1.0)
    pivots = dict(frame=(0, 0, 0), arm=tuple(PIV), weight=tuple(short), rope=tuple(tip), stone=tuple(sc_))
    parent = dict(frame=None, arm='frame', weight='arm', rope='arm', stone='rope')
    nodes = e.finish(pivots, parent, tex=512 if lod else 2048, texel=150 if lod else 520)
    SW = math.radians(90)                                     # the tip travels over the top to 35 deg past vertical in front
    ARM_F = ((0, 0), (4, 0.06), (8, 0.3), (10, 0.5), (13, 0.9), (16, 1.08), (21, 0.97), (28, 1.02))
    # the sling's direction in the world (degrees from straight up, positive = back): hangs, lags behind the arm,
    # comes into line with it at the release (frame 10), whips over the front and settles hanging from the thrown arm
    ROPE_W = (180, 172, 118, 22, -80, -172, -196, -175)
    ROPE_F = tuple((f, math.radians(180 - 90 * a - w)) for (f, a), w in zip(ARM_F, ROPE_W))
    R_REL = ROPE_F[3][1]
    R_HANG = math.radians(270)                                # hanging plumb from the thrown arm
    # where the stone is when it leaves the sling (frame 10), for the facts / the renderer's `muzzle`
    Ma = Matrix.Translation(PIV) @ Matrix.Rotation(SW * 0.5, 4, 'X') @ Matrix.Translation(-PIV)
    rel = Ma @ (Matrix.Translation(tip) @ Matrix.Rotation(R_REL, 4, 'X') @ Matrix.Translation(-tip) @ sc_)
    top_z = (PIV.z + L1) * e.k

    def anim(name, clip, n, key, ob):
        Z = (0, 0, 0)
        if name == 'arm':
            if clip == 'fire':
                for f, a in ARM_F + ((n - 1, 1.0),):
                    key(ob, f, rot=(SW * a, 0, 0))
            elif clip == 'reload':
                for f, a in ((0, 1.0), (n * 0.15, 0.95), (n * 0.8, 0.03), (n - 1, 0.0)):
                    key(ob, f, rot=(SW * a, 0, 0))
            elif clip == 'hit':                               # the cocked arm jumps against its catch
                key(ob, 0, rot=Z); key(ob, 2, rot=(0.05, 0, 0.012)); key(ob, 5, rot=(-0.012, 0, 0)); key(ob, n - 1, rot=Z)
            elif clip == 'death':
                key(ob, 0, rot=Z); key(ob, 10, rot=(SW * 0.2, 0, 0.05)); key(ob, n - 1, rot=(SW * 0.45, 0.15, 0.3))
            else:
                key(ob, 0, rot=Z); key(ob, n - 1, rot=Z)
        elif name == 'weight':                                # counter-rotates so the box stays plumb, with a swing after the drop
            if clip == 'fire':
                for (f, a), sw in zip(ARM_F + ((n - 1, 1.0),), (0, 0.04, 0.14, 0.12, -0.1, -0.3, 0.22, -0.1, 0.0)):
                    key(ob, f, rot=(-SW * a + sw, 0, 0))
            elif clip == 'reload':
                for f, a in ((0, 1.0), (n * 0.15, 0.95), (n * 0.8, 0.03), (n - 1, 0.0)):
                    key(ob, f, rot=(-SW * a, 0, 0))
            elif clip == 'hit':                               # the hanging counterweight is the one part that really swings
                key(ob, 0, rot=Z); key(ob, 2, rot=(-0.05 + 0.16, 0.05, 0)); key(ob, 5, rot=(0.012 - 0.11, -0.03, 0)); key(ob, 7, rot=(0.05, 0.01, 0)); key(ob, n - 1, rot=Z)
            elif clip == 'idle':                              # a slow sway in the wind
                key(ob, 0, rot=Z); key(ob, n * 0.25, rot=(0.018, 0, 0)); key(ob, n * 0.75, rot=(-0.018, 0, 0)); key(ob, n - 1, rot=Z)
            elif clip == 'death':
                key(ob, 0, rot=Z); key(ob, 10, rot=(-SW * 0.2, 0, 0)); key(ob, n - 1, rot=(-SW * 0.45 + 0.4, 0, 0.5))
            else:
                key(ob, 0, rot=Z); key(ob, n - 1, rot=Z)
        elif name == 'rope':
            if clip == 'fire':
                for f, a in ROPE_F + ((n - 1, R_HANG),):
                    key(ob, f, rot=(a, 0, 0))
            elif clip == 'reload':
                # stays plumb while the arm is wound back (the same rotation as rest, one turn on), swinging a little
                for f, a, sw in ((0, 1.0, 0), (n * 0.15, 0.95, 0.08), (n * 0.45, 0.5, -0.06), (n * 0.8, 0.03, 0.04), (n - 1, 0.0, 0)):
                    key(ob, f, rot=(math.radians(360 - 90 * a) + sw, 0, 0))
            else:
                key(ob, 0, rot=Z); key(ob, n - 1, rot=Z)
        elif name == 'stone':
            O = (1, 1, 1); N = (0, 0, 0)
            if clip == 'fire':
                key(ob, 0, scale=O); key(ob, 9, scale=O); key(ob, 10, scale=N); key(ob, n - 1, scale=N)
            elif clip == 'reload':
                key(ob, 0, scale=N); key(ob, n * 0.86, scale=N); key(ob, n * 0.92, scale=O); key(ob, n - 1, scale=O)
            elif clip == 'death':
                key(ob, 0, scale=O); key(ob, 4, scale=N); key(ob, n - 1, scale=N)
            else:
                key(ob, 0, scale=O); key(ob, n - 1, scale=O)
            ob.scale = O
            return
        else:
            if clip == 'hit':                                 # the whole frame racks sideways and back, then rocks out
                key(ob, 0, loc=Z, rot=Z); key(ob, 2, loc=(0.04, 0.1, 0), rot=(0.05, 0.085, 0.05)); key(ob, 5, loc=(0, 0.03, 0), rot=(-0.022, -0.04, -0.02))
                key(ob, 7, loc=Z, rot=(0.008, 0.015, 0.008)); key(ob, n - 1, loc=Z, rot=Z)
            elif clip == 'fire':
                key(ob, 0, rot=Z); key(ob, 9, rot=(-0.03, 0, 0)); key(ob, 14, rot=(0.05, 0, 0)); key(ob, 21, rot=(-0.02, 0, 0)); key(ob, n - 1, rot=Z)
            elif clip == 'death':
                key(ob, 0, loc=Z, rot=Z); key(ob, 8, loc=(0, 0, -0.05), rot=(0.04, 0.12, 0.02))
                key(ob, 22, loc=(0.5, 0, -0.5), rot=(0.1, 0.62, 0.08)); key(ob, 27, loc=(0.5, 0, -0.45), rot=(0.1, 0.57, 0.08)); key(ob, n - 1, loc=(0.52, 0, -0.5), rot=(0.1, 0.6, 0.08))
            else:
                key(ob, 0, loc=Z, rot=Z); key(ob, n - 1, loc=Z, rot=Z)
            ob.location = Z
        ob.rotation_euler = Z
    return dict(nodes=nodes, anim=anim, lens=dict(idle=48, fire=40, reload=72, hit=10, death=36), fire_frame=10, kit=e.kit,
                order=['frame', 'arm', 'weight', 'rope', 'stone'], release=tuple(round(float(x) * e.k, 3) for x in rel), throw_top=round(top_z, 3))


# =============================================================================================== sun mirror
def _mirror_face_src(n=1024):
    """The polished front of the dish: rings of gold facets (centre disc, 12, 18, 24) with dark seams, every facet
    tilted a little differently (a gradient across it), a sky-to-ground reflection gradient and a painted hot spot --
    the renderer has no environment map, so the albedo itself has to read as a mirror. Image source, UV 0..1 over
    the disc."""
    key = 'mirror_face'
    if key in T.SRC:
        return T.SRC[key]
    rng = np.random.default_rng(17)
    v, u = np.mgrid[0:n, 0:n].astype(np.float32)
    u = (u + 0.5) / n - 0.5; v = (v + 0.5) / n - 0.5                      # row 0 = bottom: v up
    r = np.sqrt(u * u + v * v) / 0.5
    ang = np.arctan2(v, u)
    rings = [(0.0, 0.21, 1), (0.21, 0.48, 12), (0.48, 0.75, 18), (0.75, 1.2, 24)]
    shade = np.ones((n, n), np.float32); seamd = np.full((n, n), 9.0, np.float32)
    for i, (r0, r1, ns) in enumerate(rings):
        m = (r >= r0) & (r < r1)
        if ns == 1:
            t = rng.normal(size=2) * 0.5
            shade = np.where(m, 1.04 + 0.25 * (u * t[0] + v * t[1]), shade)
            seamd = np.where(m, np.abs(r1 - r) * 0.5, seamd)
            continue
        a = (ang / (2 * math.pi) + 0.5) * ns + (0.5 if i % 2 else 0.0)
        s = np.floor(a); fa = a - s; s = (s % ns).astype(np.int32)
        fr = (r - r0) / (r1 - r0)
        base_b = rng.uniform(0.8, 1.16, ns).astype(np.float32)
        tilt_a = rng.uniform(-0.24, 0.24, ns).astype(np.float32); tilt_r = rng.uniform(-0.2, 0.2, ns).astype(np.float32)
        sh = base_b[s] + tilt_a[s] * (fa - 0.5) * 2 + tilt_r[s] * (fr - 0.5) * 2
        shade = np.where(m, sh, shade)
        d_ang = np.minimum(fa, 1 - fa) * (2 * math.pi * r * 0.5 / ns)
        d_ring = np.minimum(np.abs(r - r0), np.abs(r1 - r)) * 0.5 if r1 < 1.1 else np.abs(r - r0) * 0.5
        seamd = np.where(m, np.minimum(d_ang, d_ring), seamd)
    seam = 1 - T.smooth(seamd, 0.0011, 0.003)
    refl = (0.6 + 0.58 * T.smooth(v + 0.12 * u, -0.5, 0.42)) * (1 - 0.22 * T.smooth(r, 0.62, 1.0))   # sky above, ground below, deeper towards the rim
    polish = 1 + 0.035 * np.sin(r * 260 + 6 * T.fbm(n, 1.4, 23))         # concentric burnishing
    k = np.clip(shade * refl * polish, 0, 1.6)
    dark = np.array((0.56, 0.34, 0.1), np.float32); gold = np.array((1.0, 0.82, 0.42), np.float32)
    hot = np.array((1.0, 0.97, 0.87), np.float32)
    t = np.clip((k - 0.6) / 0.6, 0, 1)[..., None]
    col = dark * (1 - t) + gold * t
    hs = np.exp(-((u + 0.11) ** 2 + (v - 0.14) ** 2) / 0.018) + 0.55 * np.exp(-((u - 0.2) ** 2 + (v - 0.3) ** 2) / 0.006)
    hs = np.clip(hs * (0.7 + 0.3 * shade), 0, 1)[..., None]
    col = col * (1 - 0.92 * hs) + hot * 0.92 * hs
    col = col * (1 - seam[..., None]) + np.array((0.30, 0.19, 0.07), np.float32) * seam[..., None]
    col = np.clip(col, 0, 1)
    h = 1 - seam
    rough = (0.16 + 0.4 * seam).astype(np.float32)
    T.SRC[key] = T.Src(col, None, h, rough, 1.0, None, 0.003, None, key)
    return T.SRC[key]


def _glow_src(key, inner, outer, n=256):
    """A radial gradient (image source, UV 0..1): the focus crystal and the fire flare."""
    if key not in T.SRC:
        v, u = np.mgrid[0:n, 0:n].astype(np.float32) / n - 0.5
        r = np.clip(np.sqrt(u * u + v * v) / 0.5, 0, 1)[..., None]
        col = np.array(inner, np.float32) * (1 - r) + np.array(outer, np.float32) * r
        T.SRC[key] = T.Src(np.clip(col, 0, 1), None, None, 0.25, 0.0, None, 0.0, None, key)
    return T.SRC[key]


def _terracotta():
    if 'terracotta' not in T.SRC:
        n = 256; a = T.fbm(n, 1.3, 61); b = T.fbm(n, 0.6, 62)
        col = np.array((0.66, 0.36, 0.22), np.float32)[None, None] * (0.82 + 0.3 * a[..., None]) * (1 - 0.18 * T.smooth(b, 0.6, 0.9)[..., None])
        T.SRC['terracotta'] = T.Src(np.clip(col, 0, 1), None, a, 0.85, 0.0, 0.5, 0.003, name='terracotta')
    return T.SRC['terracotta']


def _planar_uv(ob, f):
    """Per-loop UVs from the vertex positions: f(co (N, 3)) -> (N, 2)."""
    co = T.verts(ob)
    vi = np.empty(len(ob.data.loops), np.int32); ob.data.loops.foreach_get('vertex_index', vi)
    T.set_uv(ob, f(co)[vi])
    return ob


def _star(name, c, r_out, r_in, npts, th, axis='Y', rot=0.0):
    """A flat star plate of thickness th centred at c, in the XZ plane (facing -Y / +Y; axis 'Z': facing up,
    'X': facing sideways); metric planar UV."""
    pts = []
    for i in range(2 * npts):
        a = math.pi * i / npts + rot
        rr = r_out if i % 2 == 0 else r_in
        pts.append((rr * math.cos(a), rr * math.sin(a)))
    m = len(pts)
    verts = [(0, -th / 2, 0), (0, th / 2, 0)] + [(x, -th / 2, z) for x, z in pts] + [(x, th / 2, z) for x, z in pts]
    faces = []
    for i in range(m):
        j = (i + 1) % m
        faces.append((0, 2 + j, 2 + i)); faces.append((1, 2 + m + i, 2 + m + j))
        faces.append((2 + i, 2 + j, 2 + m + j, 2 + m + i))
    ob = T.new_obj(name, verts, faces, None, smooth_=False)
    _planar_uv(ob, lambda co: np.stack([co[:, 0] + (co[:, 1] > 0) * 2.0 * r_out + 1, co[:, 2]], 1))
    T.recalc_out(ob)
    if axis == 'Z':
        ob.data.transform(Matrix.Rotation(math.pi / 2, 4, 'X'))
    elif axis == 'X':
        ob.data.transform(Matrix.Rotation(math.pi / 2, 4, 'Z'))
    ob.data.transform(Matrix.Translation(c))
    return ob


def sun_mirror(lod):
    """Sun Caliphate: a polished, segmented gold mirror on a fork (yoke) that turns on a turntable on a desert wagon,
    a focus crystal held at the focal point by three struts, a sun crown on the rim, team pennants on the fork, team
    banners and a team band skirt on the wagon, two TRELLIS crew on the rear deck (a sun priest invoking, an engineer
    on the aiming tiller). Nodes: frame -> yoke (turntable + fork, yaws) -> mirror (dish, pivot at the trunnion,
    pitches) -> flare (the fire flash at the focal point, scale ~0 at rest). The dish faces -Y, tilted 22 deg up (its face
    reads from the high RTS camera)."""
    import siege_crew as SC
    e = Eng('sun_mirror', 'caliphate', lod)
    e.look['iron'] = 'brass'
    wood, brass, gold = e.look['wood'], 'brass', 'gold'
    Fr, Y, Mi, Fl = 'frame', 'yoke', 'mirror', 'flare'
    Bd = (lambda b: () if lod else b)                         # LOD1: no iron straps on the beams
    ZD = 0.78                                                 # deck top
    ZT = 0.98                                                 # turntable top (yoke pivot)
    PIV = Vector((0, 0, 2.2))                                 # trunnion
    R, FOC, TILT = 1.05, 1.25, math.radians(-22)              # dish radius, focal length, rest tilt (face up)
    RT = Matrix.Translation(PIV) @ Matrix.Rotation(TILT, 4, 'X')      # dish-local -> unit space
    # ---- frame: bed, deck, wheels, tongue, skirt, rails, jars, banners
    for sx in (1, -1):
        e.beam((sx * 0.7, -1.22, 0.62), (sx * 0.7, 1.36, 0.62), 0.16, 0.2, Fr, bands=Bd((0.06, 0.94)), band_len=0.1)
    for y in (-1.12, -0.35, 0.45, 1.27):
        e.beam((-0.7, y, 0.6), (0.7, y, 0.6), 0.14, 0.16, Fr)
    e.add(T.box('deck', (-0.79, -1.26, 0.72), (0.79, 1.41, ZD)), wood, Fr, w=0.55)
    for y in (-0.8, 0.92):
        e.add(T.tube('axle', [(-1.1, y, 0.42), (1.1, y, 0.42)], 0.04, nseg=e.seg // 2 + 1), brass, Fr, w=0.5)
        for sx in (1, -1):
            e.beam((sx * 0.7, y - 0.12, 0.48), (sx * 0.7, y + 0.12, 0.48), 0.14, 0.12, Fr, caps=False)
            e.wheel((sx * 0.99, y, 0.42), 0.42, 0.12, Fr, spokes=8, lite=True)
    # turntable drum (static part)
    e.add(T.lathe('drum', [(0.0, ZD), (0.58, ZD), (0.58, ZD + 0.03), (0.54, ZD + 0.05), (0.54, ZT - 0.07), (0.0, ZT - 0.07)], nseg=e.seg if lod else e.seg * 2), wood, Fr, w=0.7)
    e.add(T.lathe('drumband', [(0.555, ZD + 0.06), (0.565, ZD + 0.08), (0.565, ZD + 0.12), (0.555, ZD + 0.14)], nseg=e.seg if lod else e.seg * 2), gold, Fr, w=0.6)
    # tongue with a cross yoke (no team of draught animals: it rests on the ground)
    e.beam((0, -1.15, 0.6), (0, -1.9, 0.26), 0.12, 0.12, Fr, up=(0, 0, 1), bands=Bd((0.5,)))
    e.beam((-0.42, -1.86, 0.3), (0.42, -1.86, 0.3), 0.09, 0.09, Fr)
    for sx in () if lod else (1, -1):
        e.add(T.lathe('yokecap', [(0.0, 0.0), (0.06, 0.0), (0.07, 0.04), (0.03, 0.08), (0.0, 0.12)], nseg=6, centre=(sx * 0.42, -1.86, 0.3), axis='X'), gold, Fr, w=0.5, jitter=0)
    # team band skirt round the bed (magenta flat art -> team mask)
    bs = TR.band_src(e.look['band'], 0.26)
    zt_, zb_ = ZD - 0.005, ZD - 0.265
    for sx in (1, -1):
        q = T.quad('skirt', (sx * 0.805, -1.27, zb_), (sx * 0.805, 1.42, zb_), (sx * 0.805, 1.42, zt_), (sx * 0.805, -1.27, zt_), uv=((0, 0), (2.69, 0), (2.69, 0.26), (0, 0.26)))
        T.orient_out(q, (0, 0, ZD)); e.add(q, bs, Fr, w=1.0, double=True, jitter=0)
    for yy in (-1.275, 1.425):
        q = T.quad('skirt', (-0.81, yy, zb_), (0.81, yy, zb_), (0.81, yy, zt_), (-0.81, yy, zt_), uv=((0, 0), (1.62, 0), (1.62, 0.26), (0, 0.26)))
        T.orient_out(q, (0, 0, ZD)); e.add(q, bs, Fr, w=1.0, double=True, jitter=0)
    # gold rail round the rear deck (the crew platform)
    rail_z = ZD + 0.42
    for px, py in [] if lod else [(sx * 0.76, y) for sx in (1, -1) for y in (0.62, 1.38)] + [(0.0, 1.38)]:
        e.add(T.tube('railpost', [(px, py, ZD), (px, py, rail_z + 0.04)], 0.025, nseg=6), wood, Fr, w=0.5)
        e.add(T.sphere('railknob', (px, py, rail_z + 0.06), 0.04, seg=6, rings=4), gold, Fr, w=0.5, jitter=0)
    for sx in () if lod else (1, -1):
        e.add(T.tube('rail', [(sx * 0.76, 0.62, rail_z), (sx * 0.76, 1.38, rail_z)], 0.02, nseg=5), gold, Fr, w=0.5)
    if not lod:
        e.add(T.tube('rail', [(-0.76, 1.38, rail_z), (0.76, 1.38, rail_z)], 0.02, nseg=5), gold, Fr, w=0.5)
    # terracotta water jars at the front corners of the deck
    jar = [(0.0, 0.0), (0.07, 0.01), (0.15, 0.1), (0.17, 0.22), (0.12, 0.36), (0.06, 0.42), (0.065, 0.47), (0.08, 0.49), (0.0, 0.49)]
    for c in () if lod else ((0.55, -1.02, ZD), (-0.58, -0.98, ZD)):
        e.add(T.lathe('jar', jar, nseg=e.seg, centre=c), _terracotta(), Fr, w=0.7, clean=0.6)
    # rear banners: team cloth (magenta flat art) on poles at the rear corners, both sides
    for sx in (1, -1):
        bx = sx * 0.9
        e.add(T.tube('bannerpole', [(bx, 1.36, ZD - 0.2), (bx, 1.36, 3.28)], 0.028, nseg=6), wood, Fr, w=0.5)
        e.beam((sx * 0.7, 1.36, ZD - 0.12), (bx, 1.36, ZD - 0.12), 0.08, 0.08, Fr, caps=False)
        if not lod:
            e.add(T.lathe('bannerfinial', [(0.03, 0.0), (0.05, 0.03), (0.025, 0.07), (0.05, 0.13), (0.0, 0.26)], nseg=6, centre=(bx, 1.36, 3.28)), gold, Fr, w=0.6, jitter=0)
        _hanging(e, (bx, 1.38, 3.12), 0.52, 0.82, Fr, 'banner_mirror_sun', seed=7 + sx)
    # ---- yoke: turntable plate, crossbar, fork, bearings, braces, tiller, pennants
    e.add(T.lathe('plate', [(0.0, ZT - 0.07), (0.52, ZT - 0.07), (0.53, ZT - 0.03), (0.5, ZT), (0.0, ZT)], nseg=e.seg if lod else e.seg * 2), brass, Y, w=0.6)
    XF = R + 0.16
    e.beam((-XF - 0.08, 0, ZT + 0.06), (XF + 0.08, 0, ZT + 0.06), 0.22, 0.14, Y, bands=Bd((0.03, 0.3, 0.7, 0.97)), band_len=0.1)
    for sx in (1, -1):
        e.beam((sx * XF, 0, ZT), (sx * XF, 0, PIV.z + 0.2), 0.16, 0.17, Y, up=(0, 1, 0), bands=Bd((0.3, 0.62)))
        e.add(T.box('bearing', (sx * XF - 0.1, -0.12, PIV.z - 0.11), (sx * XF + 0.1, 0.12, PIV.z + 0.11)), brass, Y, w=0.8)
        e.rivet((sx * (XF + 0.1), 0.0, PIV.z), (sx, 0, 0), Y, r=0.03)
        e.add(T.lathe('forkcap', [(0.1, 0.0), (0.12, 0.03), (0.07, 0.07), (0.09, 0.13), (0.03, 0.2), (0.0, 0.24)] if not lod else [(0.11, 0.0), (0.08, 0.1), (0.0, 0.24)], nseg=8 if not lod else 5, centre=(sx * XF, 0, PIV.z + 0.2)), gold, Y, w=0.7, jitter=0)
        e.beam((sx * 0.5, 0, ZT + 0.12), (sx * XF, 0, ZT + 0.7), 0.1, 0.1, Y, up=(0, 1, 0))
        _pennant(e, (sx * XF, 0.0, PIV.z + 0.42), Y, pole=0.86, size=(0.78, 0.34))
    # ---- crew (TRELLIS 1024 figures, rigid on the frame)
    eng_at = Vector((0.42, 1.0, ZD)); pri_at = Vector((-0.34, 0.92, ZD))
    M_eng = Matrix.Translation(eng_at) @ Matrix.Rotation(math.radians(-6), 4, 'Z')
    import os
    if os.environ.get('SIEGE_NOCREW'):                        # fast geometry iterations without the crew bake
        hands = M_eng @ Vector((0.0, -0.3, 1.05))
    else:
        SC.add(e, 'sun_mirror_priest', Matrix.Translation(pri_at) @ Matrix.Rotation(math.radians(8), 4, 'Z'), Fr, lod, w=1.3)
        SC.add(e, 'sun_mirror_engineer', M_eng, Fr, lod, w=1.3)
        hands = M_eng @ Vector(SC.landmarks('sun_mirror_engineer')['hands'])
    # aiming tiller: from the turntable plate back to the engineer's grip
    t0 = Vector((0.2, 0.4, ZT + 0.02))
    e.beam(t0, hands + Vector((0, -0.06, -0.02)), 0.07, 0.07, Y, up=(0, 0, 1), bands=Bd((0.1,)))
    # ---- mirror: front facets, back shell with the engraved sun, rim, studs, pins, struts, focus crystal, sun crown
    nr = 5 if lod else 10; ns = 20 if lod else 40
    rs = np.linspace(0, R, nr)
    yf = lambda r: 0.15 - r * r / (4 * FOC)
    yb = lambda r: yf(r) + 0.07 + 0.06 * (1 - (r / R) ** 2)
    front = T.lathe('dish_front', [(float(r), -yf(r)) for r in rs], nseg=ns, axis='Y')
    T.orient_out(front, (0, 5, 0))
    _planar_uv(front, lambda co: np.stack([0.5 + co[:, 0] / (2 * R), 0.5 + co[:, 2] / (2 * R)], 1))
    front.data.transform(RT)
    e.add(front, _mirror_face_src(), Mi, w=1.25, clean=1.0)
    art = T.flat('mirror_back_sun', rough=0.45, metal_gold=0.3, bump=0.01)
    sol = art.solid; rows = np.where(sol.any(1))[0]; cols = np.where(sol.any(0))[0]
    H_, W_ = sol.shape
    u0, u1 = cols.min() / W_, (cols.max() + 1) / W_; v0, v1 = rows.min() / H_, (rows.max() + 1) / H_
    rsb = np.linspace(0, R, 4 if lod else 7)
    back = T.lathe('dish_back', [(float(r), -yb(r)) for r in rsb[::-1]], nseg=ns, axis='Y')
    T.orient_out(back, (0, -5, 0))
    ins = 0.985                                              # the rim tube covers the art's outer edge
    _planar_uv(back, lambda co: np.stack([u0 + (0.5 - co[:, 0] / (2 * R) * ins) * (u1 - u0), v0 + (0.5 + co[:, 2] / (2 * R) * ins) * (v1 - v0)], 1))
    back.data.transform(RT)
    e.add(back, art, Mi, w=1.15)
    ry = 0.5 * (yf(R) + yb(R))
    circ = [(R * math.cos(a), ry, R * math.sin(a)) for a in np.linspace(0, 2 * math.pi, ns + 1)]
    rim = T.tube('rim', circ, 0.055, nseg=4 if lod else 6, cap=False, squash=(1.0, 1.25), up=(0, 1, 0))
    rim.data.transform(RT); e.add(rim, gold, Mi, w=0.8)
    if not lod:
        nb = RT.to_3x3() @ Vector((0, 1, 0))
        for a in np.linspace(0, 2 * math.pi, 16, endpoint=False):
            c = RT @ Vector((R * 0.965 * math.cos(a), yb(R * 0.965) - 0.004, R * 0.965 * math.sin(a)))
            e.rivet(tuple(c), tuple(nb), Mi, r=0.022)
    for sx in (1, -1):
        pin = T.tube('pin', [(sx * (R - 0.02), ry, 0), (sx * (XF + 0.13), ry, 0)], 0.05, nseg=6 if lod else 8)
        pin.data.transform(RT); e.add(pin, brass, Mi, w=0.6)
        br = T.box('bracket', (sx * R - 0.09, ry - 0.07, -0.13), (sx * R + 0.09, ry + 0.07, 0.13))
        br.data.transform(RT); e.add(br, gold, Mi, w=0.6)
    yfoc = yf(0) - FOC
    for k in range(3):
        a = math.radians(90 + 120 * k)
        p0 = Vector((math.cos(a) * (R - 0.03), yf(R - 0.03) - 0.01, math.sin(a) * (R - 0.03)))
        p1 = Vector((math.cos(a) * 0.12, yfoc, math.sin(a) * 0.12))
        st = T.tube('strut', [p0, p0.lerp(p1, 0.5), p1], [0.024, 0.02, 0.018], nseg=5 if lod else 6)
        st.data.transform(RT); e.add(st, brass, Mi, w=0.5)
    ring = T.tube('focusring', [(0.12 * math.cos(a), yfoc, 0.12 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 7 if lod else 13)], 0.026, nseg=4 if lod else 6, cap=False, up=(0, 1, 0))
    ring.data.transform(RT); e.add(ring, gold, Mi, w=0.7)
    cry = T.lathe('crystal', [(0.0, -0.2), (0.085, -0.04), (0.085, 0.04), (0.0, 0.2)], nseg=6, axis='Y')
    _planar_uv(cry, lambda co: np.stack([0.5 + co[:, 0] / 0.5, 0.5 + (co[:, 2] + co[:, 1] * 0.5) / 0.5], 1))
    cry.data.transform(RT @ Matrix.Translation((0, yfoc, 0)))
    e.add(cry, _glow_src('crystal', (0.75, 1.0, 0.95), (0.05, 0.62, 0.58)), Mi, w=0.8, jitter=0, clean=1.0)
    crown_c = Vector((0, ry - 0.01, R + 0.36))
    post = T.tube('crownpost', [(0, ry, R + 0.03), (0, ry, R + 0.2)], 0.035, nseg=6)
    post.data.transform(RT); e.add(post, gold, Mi, w=0.6)
    for k, (ro, ri, th, npt) in enumerate(((0.3, 0.15, 0.03, 8 if lod else 12),) + (() if lod else ((0.13, 0.12, 0.06, 16),))):
        stp = _star('crown', crown_c, ro, ri, npt, th, rot=math.pi / 24 if k == 0 else 0.0)
        stp.data.transform(RT); e.add(stp, gold, Mi, w=0.9 if k == 0 else 0.7)
    # ---- flare: three crossed star plates at the focal point (scale ~0 at rest; flashes on `fire`)
    foc_w = RT @ Vector((0, yfoc, 0))
    fsrc = _glow_src('flare', (1.0, 0.98, 0.9), (1.0, 0.72, 0.22))
    for k, (ax, rot) in enumerate((('Z', math.pi / 8),) if lod else (('Y', 0.0), ('Z', math.pi / 8), ('X', math.pi / 8))):
        ro = 0.62 if k == 0 else 0.5
        fl = _star('flare_star', (0, 0, 0), ro, 0.17, 8, 0.01, rot=rot)
        _planar_uv(fl, lambda co, ro=ro: np.stack([0.5 + co[:, 0] / (2 * ro), 0.5 + co[:, 2] / (2 * ro)], 1))
        if ax == 'Z':
            fl.data.transform(Matrix.Rotation(math.pi / 2, 4, 'X'))
        elif ax == 'X':
            fl.data.transform(Matrix.Rotation(math.pi / 2, 4, 'Z'))
        fl.data.transform(Matrix.Translation(foc_w) @ Matrix.Rotation(TILT, 4, 'X'))
        e.add(fl, fsrc, Fl, w=0.3, jitter=0, clean=1.0)
    pivots = dict(frame=(0, 0, 0), yoke=(0, 0, ZT), mirror=tuple(PIV), flare=tuple(foc_w))
    parent = dict(frame=None, yoke='frame', mirror='yoke', flare='mirror')
    nodes = e.finish(pivots, parent, tex=512 if lod else 2048, texel=170 if lod else 700)
    nodes['flare'].scale = (1e-3,) * 3
    # clips (rotations relative to the rest pose; mirror pitch about X: negative = face further up)
    FIRE_F = 9
    AIM_P, AIM_Y = -0.065, 0.05

    def anim(name, clip, n, key, ob):
        Z = (0, 0, 0); N = (1e-3,) * 3
        if name == 'flare':
            rest = ob.location.copy()
            if clip == 'fire':
                for f, s_, rz in ((0, 1e-3, 0), (7, 1e-3, 0), (8, 0.55, 0.1), (FIRE_F, 1.25, 0.2), (11, 0.95, 0.3), (15, 1.1, 0.45), (19, 0.6, 0.55), (23, 1e-3, 0.65), (n - 1, 1e-3, 0.65)):
                    key(ob, f, scale=(s_,) * 3, rot=(0, rz, 0))
            else:
                key(ob, 0, scale=N, rot=Z); key(ob, n - 1, scale=N, rot=Z)
            ob.scale = N; ob.rotation_euler = Z; ob.location = rest
            return
        if name == 'mirror':
            rest = ob.location.copy()
            R0 = tuple(rest)
            def at(d):
                return tuple(rest + Vector(d))
            if clip == 'fire':                                # tilts up to aim, a shudder at the flash, holds the aim
                for f, p in ((0, 0.0), (4, AIM_P * 0.6), (7, AIM_P * 1.08), (FIRE_F, AIM_P * 1.02), (10, AIM_P * 0.9), (13, AIM_P * 1.05), (17, AIM_P * 0.98), (n - 1, AIM_P)):
                    key(ob, f, rot=(p, 0, 0))
            elif clip == 'reload':                            # eases back to its rest aim
                for f, p in ((0, AIM_P), (6, AIM_P), (n * 0.75, AIM_P * 0.06), (n - 1, 0.0)):
                    key(ob, f, rot=(p, 0, 0))
            elif clip == 'idle':
                for f, p in ((0, 0.0), (n * 0.25, -0.009), (n * 0.75, 0.009), (n - 1, 0.0)):
                    key(ob, f, rot=(p, 0, 0))
            elif clip == 'hit':
                key(ob, 0, rot=Z); key(ob, 2, rot=(0.05, 0, 0.025)); key(ob, 5, rot=(-0.025, 0, -0.012)); key(ob, 7, rot=(0.01, 0, 0.004)); key(ob, n - 1, rot=Z)
            elif clip == 'death':                             # the pins give: the dish pitches forward and drops on its face
                key(ob, 0, loc=R0, rot=Z); key(ob, 5, loc=at((0, 0, 0.02)), rot=(0.12, 0, 0.03))
                key(ob, 13, loc=at((0, -0.35, -0.45)), rot=(0.75, 0.05, 0.1)); key(ob, 19, loc=at((0.05, -0.9, -1.0)), rot=(1.24, 0.1, 0.16))
                key(ob, 23, loc=at((0.05, -0.87, -0.93)), rot=(1.14, 0.1, 0.15)); key(ob, 27, loc=at((0.05, -0.9, -0.98)), rot=(1.2, 0.1, 0.16))
                key(ob, n - 1, loc=at((0.05, -0.9, -0.98)), rot=(1.2, 0.1, 0.16))
            else:
                key(ob, 0, rot=Z); key(ob, n - 1, rot=Z)
            if clip != 'death':                               # every clip keys the location (else the export samples the death pose)
                key(ob, 0, loc=R0); key(ob, n - 1, loc=R0)
            ob.location = rest; ob.rotation_euler = Z
            return
        if name == 'yoke':
            rest = ob.location.copy()
            if clip == 'fire':                                # swivels onto the target
                for f, yv in ((0, 0.0), (5, AIM_Y * 0.8), (8, AIM_Y * 1.06), (FIRE_F, AIM_Y), (12, AIM_Y * 0.97), (n - 1, AIM_Y)):
                    key(ob, f, rot=(0, 0, yv))
            elif clip == 'reload':
                for f, yv in ((0, AIM_Y), (8, AIM_Y), (n * 0.8, AIM_Y * 0.05), (n - 1, 0.0)):
                    key(ob, f, rot=(0, 0, yv))
            elif clip == 'idle':
                for f, yv in ((0, 0.0), (n * 0.5, 0.008), (n - 1, 0.0)):
                    key(ob, f, rot=(0, 0, yv))
            elif clip == 'death':
                key(ob, 0, rot=Z); key(ob, 8, rot=(0.02, 0.04, 0.08)); key(ob, 18, rot=(0.05, 0.12, 0.22)); key(ob, n - 1, rot=(0.05, 0.12, 0.2))
            else:
                key(ob, 0, rot=Z); key(ob, n - 1, rot=Z)
            ob.location = rest; ob.rotation_euler = Z
            return
        # frame
        if clip == 'hit':                                     # jolted back and twisted, rocks once
            key(ob, 0, loc=Z, rot=Z); key(ob, 2, loc=(0.02, 0.09, 0.01), rot=(0.05, 0.06, 0.04)); key(ob, 5, loc=(0, 0.02, 0), rot=(-0.02, -0.025, -0.015))
            key(ob, 7, loc=Z, rot=(0.006, 0.008, 0.005)); key(ob, n - 1, loc=Z, rot=Z)
        elif clip == 'fire':                                  # a small kick at the flash
            key(ob, 0, loc=Z, rot=Z); key(ob, FIRE_F, loc=Z, rot=Z); key(ob, FIRE_F + 2, loc=(0, 0.03, 0), rot=(-0.012, 0, 0)); key(ob, FIRE_F + 7, loc=Z, rot=Z); key(ob, n - 1, loc=Z, rot=Z)
        elif clip == 'death':                                 # a wheel gives way: the wagon sags and leans
            key(ob, 0, loc=Z, rot=Z); key(ob, 10, loc=(0, 0, -0.03), rot=(0.02, 0.04, 0)); key(ob, 20, loc=(0.06, 0, -0.16), rot=(-0.04, 0.16, 0.03))
            key(ob, 24, loc=(0.06, 0, -0.14), rot=(-0.035, 0.14, 0.03)); key(ob, n - 1, loc=(0.06, 0, -0.16), rot=(-0.04, 0.16, 0.03))
        else:
            key(ob, 0, loc=Z, rot=Z); key(ob, n - 1, loc=Z, rot=Z)
        ob.location = Z; ob.rotation_euler = Z

    # the beam leaves the focal point; at fireTime the dish is pitched by ~AIM_P and the yoke yawed by ~AIM_Y
    aim = Matrix.Rotation(AIM_Y, 4, 'Z') @ Matrix.Translation(PIV) @ Matrix.Rotation(AIM_P * 1.02, 4, 'X') @ Matrix.Translation(-PIV)
    rel = aim @ foc_w
    return dict(nodes=nodes, anim=anim, lens=dict(idle=48, fire=30, reload=36, hit=10, death=36), fire_frame=FIRE_F, kit=e.kit,
                order=['frame', 'yoke', 'mirror', 'flare'], release=tuple(round(float(x), 3) for x in rel))


def build(aid, lod):
    if aid == 'ballista':
        return ballista(lod)
    if aid == 'sun_mirror':
        return sun_mirror(lod)
    if aid == 'corpse_catapult':
        return trebuchet(lod, 'ashen', scale=1.1 * 5.0 / 6.0, name='corpse_catapult')
    return trebuchet(lod, 'kingdom', scale=1.1, name=aid)       # the bulk of the model it replaces (3.2 m wide, the arm tip at 5.9 m)
