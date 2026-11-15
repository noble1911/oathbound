"""Architecture kit for the faction Keeps (tools/art/blender/keep_build.py): real geometry, tiling materials.

A `Kit` accumulates one mesh (one damage stage at one LOD). Everything is built from *pieces*; when the kit has
a cut surface (damage stages 1-3) every piece is either dropped as a whole (small parts above the surface) or
bisected by a tilted plane at the surface, the hole capped and its rim stepped down like broken masonry.

Materials: every face carries a texture layer (LAYERS). It is stored in the UV: u = local u + 8 * layer + 4, with
|local u| < 4 (the renderer samples texture arrays; `floor(u / 8)` is the layer; the small range keeps gltfpack's
16-bit UV grid at ~1 mm). Layer 8 is unlit glow. Cloth
(banners) is a second material slot with plain 0..1 UVs over the banner texture; its vertex colour red = sway weight.
Vertex colours of everything else = tint x baked ambient occlusion x weathering.
"""
import math, random
import bpy
import bmesh
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree

LAYERS = dict(wall=0, trim=1, roof=2, wood=3, metal=4, accent=5, floor=6, plain=7, glow=8)
TILE = [3.0, 2.0, 2.5, 2.0, 2.0, 2.0, 3.0, 1.0, 1.0]       # metres per texture repeat
CLOTH = 9
LAYER_STEP = 8.0
WHITE = (1.0, 1.0, 1.0)
TAU = math.tau


def lerp(a, b, t):
    return a + (b - a) * t


def lines(a, b, must, cell):
    """Grid lines from a to b through every `must` value, at most `cell` apart."""
    pts = sorted(set([a, b] + [m for m in must if a + 1e-4 < m < b - 1e-4]))
    out = []
    for p, q in zip(pts, pts[1:]):
        n = max(1, int(round((q - p) / cell)))
        out += [p + (q - p) * i / n for i in range(n)]
    out.append(b)
    return out


class Piece:
    def __init__(self, kit, mode, anchor, hollow=None):
        self.kit, self.mode, self.anchor, self.hollow = kit, mode, anchor, hollow
        self.faces = []
        self.cache = {}


class Kit:
    def __init__(self, stage=0, lod=0, seed=1, cut=None, height=16.0, weather=None, ao=True):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.col = self.bm.loops.layers.float_color.new('Color')
        self.fl = self.bm.faces.layers.int.new('layer')
        self.stage, self.lod, self.cut, self.height = stage, lod, cut, height
        self.rng = random.Random(seed)
        self.M = Matrix.Identity(4)
        self.stack = []
        self.cur = None
        self.weather = weather or {}
        self.ao = ao
        self.anchors = {}

    # ------------------------------------------------------------------------------------------ transforms / pieces
    def at(self, x=0.0, y=0.0, z=0.0, yaw=0.0, scale=1.0):
        kit = self

        class _At:
            def __enter__(s):
                kit.stack.append(kit.M.copy())
                kit.M = kit.M @ Matrix.Translation((x, y, z)) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Scale(scale, 4)

            def __exit__(s, *a):
                kit.M = kit.stack.pop()
        return _At()

    def piece(self, mode='solid', anchor=None, hollow=None):
        """mode: 'solid' = cut by the damage surface; 'whole' = dropped when its centre (or `anchor`, local) is above
        it; 'keep' = never cut (rubble). hollow = (wall thickness, depth): a cut shows a broken wall rim around a dark
        interior `depth` metres down (towers, halls, roofs) instead of a flat cap (solid masonry)."""
        kit = self

        class _P:
            def __enter__(s):
                s.prev = kit.cur
                kit.cur = Piece(kit, mode, None if anchor is None else kit.M @ Vector(anchor), hollow)
                return kit.cur

            def __exit__(s, *a):
                p = kit.cur
                kit.cur = s.prev
                kit._finish(p)
        return _P()

    def world(self, p):
        return self.M @ Vector(p)

    def cut_at(self, x, y):
        return self.cut(x, y) if self.cut else 1e9

    def gone(self, p, margin=0.0):
        """Is the local point p above the damage surface (so whatever hangs there should not be built)?"""
        w = self.world(p)
        return w.z > self.cut_at(w.x, w.y) - margin

    # ------------------------------------------------------------------------------------------ faces
    def face(self, pts, layer, tint=WHITE, smooth=False, uvs=None, out=None, uvshift=(0.0, 0.0)):
        own = self.cur is None
        if own:
            self.cur = Piece(self, 'whole', None)
        pc = self.cur
        loc = [Vector(p) for p in pts]
        # Newell normal (local)
        n = Vector((0, 0, 0))
        for i in range(len(loc)):
            a, b = loc[i], loc[(i + 1) % len(loc)]
            n += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
        if n.length < 1e-9:
            if own:
                self.cur = None
            return None
        if out is not None and n.dot(Vector(out)) < 0:
            loc.reverse()
            n = -n
            if uvs is not None:
                uvs = list(reversed(uvs))
        n.normalize()
        L = LAYERS[layer] if isinstance(layer, str) else layer
        if uvs is None:
            ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
            t = TILE[min(L, 8)]
            if az >= ax and az >= ay:
                uvs = [(p.x / t, p.y / t) for p in loc]
            elif ax >= ay:
                uvs = [(p.y / t, p.z / t) for p in loc]
            else:
                uvs = [(p.x / t, p.z / t) for p in loc]
            uvs = [(u + uvshift[0], v + uvshift[1]) for u, v in uvs]
        vs = []
        for p in loc:
            w = self.M @ p
            key = (round(w.x, 4), round(w.y, 4), round(w.z, 4))
            v = pc.cache.get(key)
            if v is None or not v.is_valid:
                v = self.bm.verts.new(w)
                pc.cache[key] = v
            vs.append(v)
        # drop repeated corners (collapsed quads: hip ridges, lathe poles)
        keep = [i for i in range(len(vs)) if vs[i] is not vs[i - 1]]
        vs = [vs[i] for i in keep]
        uvs = [uvs[i] for i in keep]
        if len(vs) < 3 or len(set(vs)) < len(vs):
            if own:
                self.cur = None
            return None
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            if own:
                self.cur = None
            return None
        f.smooth = smooth
        f[self.fl] = L
        if L == CLOTH:
            f.material_index = 1
            du = dv = 0.0
            base = 0.0
        else:
            du = round(sum(u for u, _ in uvs) / len(uvs))
            dv = round(sum(v for _, v in uvs) / len(uvs))
            base = LAYER_STEP * L + LAYER_STEP / 2
            if max(abs(u - du) for u, _ in uvs) > LAYER_STEP / 2 - 0.2:
                print(f'[kit] face spans too many texture repeats (layer {L}): split it')
        col = (tint[0], tint[1], tint[2], 1.0)
        for lp, (u, v) in zip(f.loops, uvs):
            lp[self.uv].uv = (u - du + base, v - dv)
            lp[self.col] = col
        pc.faces.append(f)
        if own:
            self.cur = None
            self._finish(pc)
        return f

    def _finish(self, pc):
        if self.cut is None or pc.mode == 'keep':
            return
        faces = [f for f in pc.faces if f.is_valid]
        if not faces:
            return
        verts = {v for f in faces for v in f.verts}
        zs = [v.co.z for v in verts]
        c = sum((v.co for v in verts), Vector()) / len(verts)
        a = pc.anchor or c
        h = self.cut(a.x, a.y)
        bm = self.bm
        if pc.mode == 'whole':
            if a.z > h:
                bmesh.ops.delete(bm, geom=list(verts), context='VERTS')
            return
        if max(zs) <= h:
            return
        if min(zs) >= h - 0.05:
            bmesh.ops.delete(bm, geom=list(verts), context='VERTS')
            return
        r = random.Random(int(c.x * 131 + c.y * 71 + c.z * 17) & 0xffff)
        ang = r.random() * TAU
        tilt = 0.12 + r.random() * 0.3
        n = Vector((math.cos(ang) * tilt, math.sin(ang) * tilt, 1.0)).normalized()
        edges = {e for f in faces for e in f.edges}
        res = bmesh.ops.bisect_plane(bm, geom=list(verts) + list(edges) + faces, dist=1e-4, plane_co=(c.x, c.y, h), plane_no=n, clear_outer=True, clear_inner=False)
        cv = [g for g in res['geom_cut'] if isinstance(g, bmesh.types.BMVert) and g.is_valid]
        if not cv:
            return
        bmesh.ops.remove_doubles(bm, verts=cv, dist=2e-3)
        cv = [v for v in cv if v.is_valid]
        cvs = set(cv)
        ce = [e for v in cv for e in v.link_edges if e.other_vert(v) in cvs and len(e.link_faces) == 1]
        ce = list(set(ce))
        zmin = min(zs)
        # broken rim: step the cut vertices down by whole courses
        for v in cv:
            s = noise.noise(Vector((v.co.x * 0.9, v.co.y * 0.9, v.co.z * 0.7 + self.stage * 3.1)))
            k = int((s * 0.5 + 0.5) * 3.99)
            v.co.z = max(zmin + 0.05, v.co.z - (0, 0.3, 0.75, 1.3)[k])
        if pc.hollow and ce:
            self._rim(ce, pc.hollow, zmin)
            return
        caps = []
        if ce:
            try:
                fr = bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=ce, normal=n)
                caps = [g for g in fr['geom'] if isinstance(g, bmesh.types.BMFace)]
            except Exception:
                caps = []
        dark = self.weather.get('cap', (0.30, 0.28, 0.26))
        t = TILE[0]
        for f in caps:
            f.normal_update()
            if f.normal.z < 0:
                f.normal_flip()
            f.smooth = False
            f[self.fl] = 0
            du = round(f.calc_center_median().x / t)
            dv = round(f.calc_center_median().y / t)
            for lp in f.loops:
                lp[self.uv].uv = (lp.vert.co.x / t - du + LAYER_STEP / 2, lp.vert.co.y / t - dv)
                lp[self.col] = (dark[0], dark[1], dark[2], 1.0)

    def _rim(self, edges, hollow, zmin):
        """Cap the cut loops of a hollow piece: a wall-thick rim, the inner wall face and a dark floor below."""
        t, depth = hollow
        adj = {}
        for e in edges:
            a, b = e.verts
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
        seen = set()
        loops = []
        for start in adj:
            if start in seen or len(adj[start]) != 2:
                continue
            loop = [start]
            seen.add(start)
            prev, cur = None, start
            ok = False
            while True:
                nxt = [x for x in adj[cur] if x is not prev]
                if len(adj[cur]) != 2 or not nxt:
                    break
                nx = nxt[0]
                if nx is start:
                    ok = True
                    break
                if nx in seen:
                    break
                loop.append(nx)
                seen.add(nx)
                prev, cur = cur, nx
            if ok and len(loop) >= 3:
                loops.append(loop)
        M, cur = self.M, self.cur
        self.M = Matrix.Identity(4)
        self.cur = Piece(self, 'keep', None)
        rim_t = self.weather.get('rim', (0.62, 0.60, 0.58))
        inner_t = self.weather.get('inner', (0.5, 0.48, 0.46))
        floor_t = self.weather.get('floor', (0.42, 0.40, 0.38))
        for loop in loops:
            n = len(loop)
            c = sum((v.co for v in loop), Vector()) / n
            P = [v.co.copy() for v in loop]
            # the layer of the wall this loop cuts through
            lay = 0
            for f in loop[0].link_faces:
                lay = f[self.fl]
                break
            if lay >= 7:
                lay = 0
            W = []
            for i in range(n):
                a, b, d = P[i - 1], P[i], P[(i + 1) % n]
                dirs = []
                for (p, q) in ((a, b), (b, d)):
                    e = Vector((q.x - p.x, q.y - p.y, 0))
                    if e.length < 1e-6:
                        continue
                    nn = Vector((-e.y, e.x, 0)).normalized()
                    mid = (p + q) / 2
                    if nn.dot(Vector((c.x - mid.x, c.y - mid.y, 0))) < 0:
                        nn = -nn
                    dirs.append(nn)
                if not dirs:
                    dirs = [Vector((c.x - b.x, c.y - b.y, 0)).normalized()]
                dv = sum(dirs, Vector())
                if dv.length < 1e-6:
                    dv = dirs[0]
                dv.normalize()
                k = t / max(0.6, dv.dot(dirs[0]))
                toc = math.hypot(c.x - b.x, c.y - b.y)
                k = min(k, toc * 0.7)
                W.append(Vector((b.x + dv.x * k, b.y + dv.y * k, b.z)))
            zf = max(zmin + 0.05, min(p.z for p in P) - depth)
            for i in range(n):
                j = (i + 1) % n
                self.face([P[i], P[j], W[j], W[i]], lay, rim_t, out=(0, 0, 1))
                wi, wj = W[i], W[j]
                mid = (wi + wj) / 2
                self.face([wi, wj, Vector((wj.x, wj.y, zf)), Vector((wi.x, wi.y, zf))], 0, inner_t, out=Vector((c.x - mid.x, c.y - mid.y, 0)))
                self.face([Vector((wi.x, wi.y, zf)), Vector((wj.x, wj.y, zf)), Vector((c.x, c.y, zf))], 0, floor_t, out=(0, 0, 1))
        self.M, self.cur = M, cur

    # ------------------------------------------------------------------------------------------ generic surfaces
    def panel(self, P, u0, u1, v0, v1, layer, tint=WHITE, openings=(), cell=1.25, smooth=False, uscale=1.0, reveal='trim', reveal_tint=(0.8, 0.8, 0.8), cell_u=None):
        """A gridded surface P(u, v, d) (d = metres inward) with rectangular niches.
        openings: dicts u, v (centre u, sill v), w, h, depth, back (layer), back_tint, arch ('' | 'round' | 'pointed' | 'keel').
        Returns the list of arch decorations to emit as their own piece (see `arches`)."""
        L = LAYERS[layer]
        t = TILE[L]
        if self.lod:
            cell *= 2.2
        ops = []
        for o in openings:
            w = o['w'] / uscale
            ops.append((o['u'] / uscale - w / 2, o['u'] / uscale + w / 2, o['v'], o['v'] + o['h'], o))
        ops = [o for o in ops if o[0] > u0 and o[1] < u1 and o[2] >= v0 and o[3] < v1]
        us = lines(u0, u1, [o[0] for o in ops] + [o[1] for o in ops], (cell_u or cell) / uscale)
        vs = lines(v0, v1, [o[2] for o in ops] + [o[3] for o in ops], cell)
        for i in range(len(us) - 1):
            for j in range(len(vs) - 1):
                ua, ub, va, vb = us[i], us[i + 1], vs[j], vs[j + 1]
                uc, vc = (ua + ub) / 2, (va + vb) / 2
                if any(o[0] < uc < o[1] and o[2] < vc < o[3] for o in ops):
                    continue
                out = Vector(P(uc, vc, 0)) - Vector(P(uc, vc, 0.2))
                self.face([P(ua, va, 0), P(ub, va, 0), P(ub, vb, 0), P(ua, vb, 0)], layer, tint, smooth,
                          uvs=[(ua * uscale / t, va / t), (ub * uscale / t, va / t), (ub * uscale / t, vb / t), (ua * uscale / t, vb / t)], out=out)
        deco = []
        for (ua, ub, va, vb, o) in ops:
            D = o.get('depth', 0.35)
            uc, vc = (ua + ub) / 2, (va + vb) / 2
            mid = Vector(P(uc, vc, D / 2))
            for (a, b) in (((ua, va), (ub, va)), ((ub, va), (ub, vb)), ((ub, vb), (ua, vb)), ((ua, vb), (ua, va))):
                q = [P(a[0], a[1], 0), P(b[0], b[1], 0), P(b[0], b[1], D), P(a[0], a[1], D)]
                ctr = sum((Vector(x) for x in q), Vector()) / 4
                self.face(q, reveal, reveal_tint, out=mid - ctr)
            out = Vector(P(uc, vc, 0)) - Vector(P(uc, vc, 0.2))
            bl = o.get('back', 'plain')
            self.face([P(ua, va, D), P(ub, va, D), P(ub, vb, D), P(ua, vb, D)], bl, o.get('back_tint', (0.03, 0.03, 0.035)), out=out,
                      uvs=None if bl not in ('glow',) else [(0, 0), (0.2, 0), (0.2, 0.2), (0, 0.2)])
            if o.get('arch'):
                deco.append((P, ua, ub, va, vb, o, layer, tint, uscale))
        return deco

    def arches(self, deco):
        """Arch heads for the niches of `panel` (wall-flush spandrels + the intrados), as loose 'whole' faces."""
        for (P, ua, ub, va, vb, o, layer, tint, uscale) in deco:
            kind = o['arch']
            w = (ub - ua)
            uc = (ua + ub) / 2
            wm = w * uscale
            n = 3 if self.lod else 6
            pts = []                                        # left half of the arch, from the springing up to the apex
            if kind == 'round':
                vs_ = vb - wm / 2
                for i in range(n + 1):
                    a = (i / n) * math.pi / 2
                    pts.append((uc - (w / 2) * math.cos(a), vs_ + (wm / 2) * math.sin(a)))
            else:
                k = 1.0 if kind == 'pointed' else 0.72      # 'keel': a flatter four-centred arch
                rise = wm * 0.866 * k
                vs_ = vb - rise
                for i in range(n + 1):
                    a = (i / n) * math.pi / 3
                    pts.append((ub - w * math.cos(a), vs_ + wm * math.sin(a) * k))
            D = o.get('depth', 0.35)
            mid = Vector(P(uc, (va + vb) / 2, D / 2))
            outv = Vector(P(uc, vb, 0)) - Vector(P(uc, vb, 0.2))
            with self.piece('whole', anchor=None):
                if o.get('back') == 'glow' and not self.lod and o.get('bars', True):
                    # leaded window: a mullion and a transom in front of the light
                    b = 0.035 / uscale
                    bar = (0.05, 0.045, 0.04)
                    vm = va + (vb - va) * 0.5
                    self.face([P(uc - b, va, D - 0.05), P(uc + b, va, D - 0.05), P(uc + b, vb, D - 0.05), P(uc - b, vb, D - 0.05)], 'metal', bar, out=outv)
                    self.face([P(ua, vm - 0.035, D - 0.05), P(ub, vm - 0.035, D - 0.05), P(ub, vm + 0.035, D - 0.05), P(ua, vm + 0.035, D - 0.05)], 'metal', bar, out=outv)
                for side in (0, 1):
                    def U(u):
                        return u if side == 0 else 2 * uc - u
                    corner = (U(ua), vb)
                    for i in range(n):
                        (u1, v1), (u2, v2) = pts[i], pts[i + 1]
                        self.face([P(corner[0], corner[1], -0.01), P(U(u1), v1, -0.01), P(U(u2), v2, -0.01)], layer, tint, out=outv,
                                  uvs=[(corner[0] * uscale / TILE[LAYERS[layer]], corner[1] / TILE[LAYERS[layer]]), (U(u1) * uscale / TILE[LAYERS[layer]], v1 / TILE[LAYERS[layer]]), (U(u2) * uscale / TILE[LAYERS[layer]], v2 / TILE[LAYERS[layer]])])
                        q = [P(U(u1), v1, 0), P(U(u2), v2, 0), P(U(u2), v2, D), P(U(u1), v1, D)]
                        ctr = sum((Vector(x) for x in q), Vector()) / 4
                        self.face(q, 'trim', (0.72, 0.72, 0.72), out=mid - ctr)

    # ------------------------------------------------------------------------------------------ solids
    def block(self, cx, cy, w, d, z0, z1, layer='wall', tint=WHITE, openings=None, top='floor', top_tint=WHITE, cell=1.25, mode='solid', bottom=False, taper=0.0, hollow=None):
        """Axis-aligned (local) box, sides gridded. openings: {'-y': [...], '+y': ..., '-x': ..., '+x': ...} (u from the
        face centre, seen from outside, left to right). `taper`: metres the footprint shrinks per side at the top."""
        openings = openings or {}
        deco = []
        H = z1 - z0

        def side(nx, ny):
            # outward normal (nx, ny); u axis runs to the right when seen from outside
            if ny:
                half, hd = w / 2, d / 2
                def P(u, v, dd, s=ny):
                    k = taper * (v - z0) / H
                    f = (half - k) / half if half else 1
                    return (cx - s * u * f, cy + s * (hd - k - dd), v)
                return P, half
            half, hd = d / 2, w / 2

            def P(u, v, dd, s=nx):
                k = taper * (v - z0) / H
                f = (half - k) / half if half else 1
                return (cx + s * (hd - k - dd), cy + s * u * f, v)
            return P, half
        with self.piece(mode, hollow=hollow):
            for key, (nx, ny) in (('-y', (0, -1)), ('+y', (0, 1)), ('-x', (-1, 0)), ('+x', (1, 0))):
                P, half = side(nx, ny)
                deco += self.panel(P, -half, half, z0, z1, layer, tint, openings.get(key, ()), cell)
            if top:
                hw, hd = w / 2 - taper, d / 2 - taper
                self.panel(lambda u, v, dd: (cx + u, cy + v, z1 - dd), -hw, hw, -hd, hd, top, top_tint, (), cell * 1.5)
            if bottom:
                self.face([(cx - w / 2, cy - d / 2, z0), (cx + w / 2, cy - d / 2, z0), (cx + w / 2, cy + d / 2, z0), (cx - w / 2, cy + d / 2, z0)], layer, tint, out=(0, 0, -1))
        self.arches(deco)

    def box(self, cx, cy, cz, w, d, h, layer='wall', tint=WHITE, mode='whole', yaw=0.0, pitch=0.0, roll=0.0, bottom=True, anchor=None):
        """Plain box centred at (cx, cy, cz); 12 triangles."""
        R = Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(pitch, 4, 'X') @ Matrix.Rotation(roll, 4, 'Y')
        c = Vector((cx, cy, cz))
        hx, hy, hz = w / 2, d / 2, h / 2
        P = [c + (R @ Vector((sx * hx, sy * hy, sz * hz))) for sz in (-1, 1) for sy in (-1, 1) for sx in (-1, 1)]
        quads = [(0, 1, 5, 4, (0, -1, 0)), (1, 3, 7, 5, (1, 0, 0)), (3, 2, 6, 7, (0, 1, 0)), (2, 0, 4, 6, (-1, 0, 0)), (4, 5, 7, 6, (0, 0, 1))]
        if bottom:
            quads.append((0, 2, 3, 1, (0, 0, -1)))

        def emit():
            for a, b, cc, dd, n in quads:
                self.face([P[a], P[b], P[cc], P[dd]], layer, tint, out=R @ Vector(n))
        if self.cur is None:
            with self.piece(mode, anchor=anchor):
                emit()
        else:
            emit()

    def frustum(self, cx, cy, w0, d0, z0, w1, d1, z1, layer='trim', tint=WHITE, top=None, cell=1.5, mode='solid'):
        """Battered plinth: rectangle (w0, d0) at z0 tapering to (w1, d1) at z1."""
        H = z1 - z0
        with self.piece(mode):
            for nx, ny in ((0, -1), (0, 1), (-1, 0), (1, 0)):
                def P(u, v, dd, nx=nx, ny=ny):
                    t = (v - z0) / H
                    hw, hd = lerp(w0, w1, t) / 2, lerp(d0, d1, t) / 2
                    if ny:
                        return (cx - ny * u * hw, cy + ny * (hd - dd), v)
                    return (cx + nx * (hw - dd), cy + nx * u * hd, v)
                self.panel(P, -1, 1, z0, z1, layer, tint, (), cell, uscale=(w0 if ny else d0) / 2)
            if top:
                self.panel(lambda u, v, dd: (cx + u, cy + v, z1), -w1 / 2, w1 / 2, -d1 / 2, d1 / 2, top, tint, (), cell * 1.5)

    def cyl(self, cx, cy, r0, r1, z0, z1, seg=16, layer='wall', tint=WHITE, openings=(), top='floor', top_tint=WHITE, mode='solid', cell=1.25, smooth=True, arc=None, bottom=False, hollow=None):
        """Round (or `seg`-sided) shaft, radius r0 at z0 -> r1 at z1. openings: 'a' = angle in degrees (0 = -Y front,
        counter-clockwise seen from above), plus v, w, h... `arc` = (a0, a1) degrees for a partial shaft."""
        if self.lod:
            seg = max(6, int(seg * 0.6))
        H = z1 - z0
        rm = (r0 + r1) / 2

        def P(u, v, dd):
            r = lerp(r0, r1, (v - z0) / H) - dd
            a = u - math.pi / 2
            return (cx + math.cos(a) * r, cy + math.sin(a) * r, v)
        ops = [dict(o, u=math.radians(o['a']) * rm) for o in openings]
        a0, a1 = (0.0, TAU) if arc is None else (math.radians(arc[0]), math.radians(arc[1]))
        deco = []
        with self.piece(mode, hollow=hollow):
            # wrap openings into [a0, a1)
            for o in ops:
                while o['u'] / rm < a0 + 0.02:
                    o['u'] += TAU * rm
                while o['u'] / rm > a1 - 0.02:
                    o['u'] -= TAU * rm
            deco = self.panel(P, a0, a1, z0, z1, layer, tint, ops, cell=cell, cell_u=(a1 - a0) * rm / seg * 0.999, smooth=smooth, uscale=rm)
            if top:
                self.disc(cx, cy, z1, r1, seg, top, top_tint)
            if bottom:
                self.disc(cx, cy, z0, r0, seg, layer, tint, up=False)
        self.arches(deco)

    def disc(self, cx, cy, z, r, seg, layer, tint=WHITE, up=True, r_in=0.0):
        n = max(6, int(seg * (0.6 if self.lod else 1)))
        rings = [r_in, r] if r_in > 0 or r < 1.6 or self.lod else [0.0, r * 0.55, r]
        for k in range(len(rings) - 1):
            ra, rb = rings[k], rings[k + 1]
            for i in range(n):
                a, b = TAU * i / n, TAU * (i + 1) / n
                q = [(cx + math.cos(a) * ra, cy + math.sin(a) * ra, z), (cx + math.cos(b) * ra, cy + math.sin(b) * ra, z),
                     (cx + math.cos(b) * rb, cy + math.sin(b) * rb, z), (cx + math.cos(a) * rb, cy + math.sin(a) * rb, z)]
                if ra == 0:
                    q = q[1:]
                self.face(q, layer, tint, out=(0, 0, 1 if up else -1))

    def lathe(self, cx, cy, profile, seg=16, layer='wall', tint=WHITE, mode='solid', smooth=True, vscale=1.0, cap=True, squash=1.0, hollow=None):
        """Surface of revolution: profile = [(r, z), ...] bottom to top. Closed with discs where r > 0 at the ends."""
        if self.lod:
            seg = max(6, int(seg * 0.6))
        t = TILE[LAYERS[layer]]

        def emit():
            dist = 0.0
            for k in range(len(profile) - 1):
                (ra, za), (rb, zb) = profile[k], profile[k + 1]
                dl = math.hypot(rb - ra, zb - za)
                rm = max(ra, rb, 0.2)
                for i in range(seg):
                    a, b = TAU * i / seg, TAU * (i + 1) / seg
                    q = [(cx + math.cos(a) * ra, cy + math.sin(a) * ra * squash, za), (cx + math.cos(b) * ra, cy + math.sin(b) * ra * squash, za),
                         (cx + math.cos(b) * rb, cy + math.sin(b) * rb * squash, zb), (cx + math.cos(a) * rb, cy + math.sin(a) * rb * squash, zb)]
                    uv = [(a * rm / t, dist / t * vscale), (b * rm / t, dist / t * vscale), (b * rm / t, (dist + dl) / t * vscale), (a * rm / t, (dist + dl) / t * vscale)]
                    if ra < 1e-4:
                        q, uv = q[1:], uv[1:]
                    elif rb < 1e-4:
                        q, uv = q[:3], uv[:3]
                    mid = ((ra + rb) / 2, (za + zb) / 2)
                    nr, nz = (zb - za), -(rb - ra)
                    am = (a + b) / 2
                    self.face(q, layer, tint, smooth, uvs=uv, out=(math.cos(am) * nr, math.sin(am) * nr, nz))
                dist += dl
            if cap:
                if profile[0][0] > 1e-3:
                    self.disc(cx, cy, profile[0][1], profile[0][0], seg, layer, tint, up=False)
                if profile[-1][0] > 1e-3:
                    self.disc(cx, cy, profile[-1][1], profile[-1][0], seg, layer, tint)
        if self.cur is None:
            with self.piece(mode, hollow=hollow):
                emit()
        else:
            emit()

    def extrude(self, profile, x0, x1, layer='wall', tint=WHITE, mode='solid', axis='x', caps=True):
        """Convex polygon profile [(a, z), ...] (counter-clockwise) extruded along local X (profile a = y) or Y (a = x)."""
        def pt(a, z, s):
            return (s, a, z) if axis == 'x' else (a, s, z)
        n = len(profile)
        c = (sum(p[0] for p in profile) / n, sum(p[1] for p in profile) / n)

        def emit():
            for i in range(n):
                (a0, z0), (a1, z1) = profile[i], profile[(i + 1) % n]
                m = ((a0 + a1) / 2 - c[0], (z0 + z1) / 2 - c[1])
                out = (0, m[0], m[1]) if axis == 'x' else (m[0], 0, m[1])
                self.face([pt(a0, z0, x0), pt(a1, z1, x0), pt(a1, z1, x1), pt(a0, z0, x1)], layer, tint, out=out)
            if caps:
                self.face([pt(a, z, x0) for a, z in profile], layer, tint, out=(-1, 0, 0) if axis == 'x' else (0, -1, 0))
                self.face([pt(a, z, x1) for a, z in profile], layer, tint, out=(1, 0, 0) if axis == 'x' else (0, 1, 0))
        if self.cur is None:
            with self.piece(mode):
                emit()
        else:
            emit()

    def sweep(self, path, radii, seg=6, layer='accent', tint=WHITE, mode='solid', smooth=True, cap=True):
        """Tube along a polyline (ribs, horns, tusks, poles)."""
        if self.lod:
            seg = max(4, seg - 2)
        pts = [Vector(p) for p in path]
        rings = []
        up = Vector((0, 0, 1))
        for i, p in enumerate(pts):
            d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            side = d.cross(up)
            if side.length < 1e-3:
                side = d.cross(Vector((1, 0, 0)))
            side.normalize()
            nrm = side.cross(d).normalized()
            rings.append([p + (side * math.cos(TAU * k / seg) + nrm * math.sin(TAU * k / seg)) * radii[i] for k in range(seg)])
        t = TILE[LAYERS[layer]]

        def emit():
            dist = 0.0
            for i in range(len(pts) - 1):
                dl = (pts[i + 1] - pts[i]).length
                for k in range(seg):
                    k2 = (k + 1) % seg
                    q = [rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]]
                    ctr = (q[0] + q[1] + q[2] + q[3]) / 4
                    r = max(radii[i], radii[i + 1], 0.05)
                    uv = [(k * TAU * r / seg / t, dist / t), ((k + 1) * TAU * r / seg / t, dist / t), ((k + 1) * TAU * r / seg / t, (dist + dl) / t), (k * TAU * r / seg / t, (dist + dl) / t)]
                    self.face(q, layer, tint, smooth, uvs=uv, out=ctr - (pts[i] + pts[i + 1]) / 2)
                dist += dl
            if cap:
                if radii[0] > 0.01:
                    self.face(rings[0], layer, tint, out=pts[0] - pts[1])
                if radii[-1] > 0.01:
                    self.face(rings[-1], layer, tint, out=pts[-1] - pts[-2])
        if self.cur is None:
            with self.piece(mode):
                emit()
        else:
            emit()

    def blob(self, cx, cy, cz, rx, ry, rz, layer='wall', tint=WHITE, detail=1, jitter=0.0, mode='keep', smooth=False, yaw=0.0, seed=None):
        """Icosphere-ish lump (rocks, skull craniums, finial balls)."""
        r = random.Random(seed if seed is not None else int(cx * 91 + cy * 57 + cz * 13))
        tmp = bmesh.new()
        bmesh.ops.create_icosphere(tmp, subdivisions=detail, radius=1.0)
        R = Matrix.Rotation(yaw, 3, 'Z')
        for v in tmp.verts:
            j = 1 + (r.random() - 0.5) * 2 * jitter
            v.co = Vector((cx, cy, cz)) + R @ Vector((v.co.x * rx * j, v.co.y * ry * j, v.co.z * rz * j))
        c = Vector((cx, cy, cz))

        def emit():
            for f in tmp.faces:
                self.face([v.co.copy() for v in f.verts], layer, tint, smooth, out=f.calc_center_median() - c)
        if self.cur is None:
            with self.piece(mode):
                emit()
        else:
            emit()
        tmp.free()

    # ------------------------------------------------------------------------------------------ roofs
    def cone_roof(self, cx, cy, r, z, h, seg=16, courses=6, layer='roof', tint=WHITE, lip=0.07, flare=0.18, mode='solid', sides=None, hollow=(0.14, 1.8)):
        """Stepped (coursed) conical / pyramidal roof with a flared eave. `sides`: polygon count for a faceted spire."""
        n = sides or (max(8, int(seg * 0.6)) if self.lod else seg)
        smooth = sides is None
        if self.lod:
            courses = max(2, courses // 2)
        t = TILE[LAYERS[layer]]
        rot = math.pi / n if sides else 0.0

        def prof(tt):                               # radius at height fraction tt (0 eave .. 1 apex): concave flare
            return r * (1 - tt) * (1 - flare * math.sin(math.pi * min(1, tt * 1.15)) * 0.6) + (flare * r * 0.25 * (1 - tt) ** 4)
        with self.piece(mode, hollow=hollow):
            for j in range(courses):
                ta, tb = j / courses, (j + 1) / courses
                ra, rb = prof(ta) + lip, prof(tb) if j < courses - 1 else 0.0
                if j:
                    # underside of this course's lip (keeps the roof one closed surface)
                    rp, zl = prof(ta), z + h * ta
                    for i in range(n):
                        a, b = TAU * i / n + rot, TAU * (i + 1) / n + rot
                        self.face([(cx + math.cos(a) * rp, cy + math.sin(a) * rp, zl), (cx + math.cos(b) * rp, cy + math.sin(b) * rp, zl),
                                   (cx + math.cos(b) * ra, cy + math.sin(b) * ra, zl), (cx + math.cos(a) * ra, cy + math.sin(a) * ra, zl)], layer, (0.4, 0.4, 0.4), out=(0, 0, -1))
                za, zb = z + h * ta, z + h * tb
                slant = math.hypot(ra - rb, zb - za)
                for i in range(n):
                    a, b = TAU * i / n + rot, TAU * (i + 1) / n + rot
                    q = [(cx + math.cos(a) * ra, cy + math.sin(a) * ra, za), (cx + math.cos(b) * ra, cy + math.sin(b) * ra, za),
                         (cx + math.cos(b) * rb, cy + math.sin(b) * rb, zb), (cx + math.cos(a) * rb, cy + math.sin(a) * rb, zb)]
                    d0 = h * ta * 1.15
                    uv = [(i * TAU * r / n / t, d0 / t), ((i + 1) * TAU * r / n / t, d0 / t), ((i + 1) * TAU * r / n / t, (d0 + slant) / t), (i * TAU * r / n / t, (d0 + slant) / t)]
                    if rb < 1e-4:
                        q, uv = q[:3], uv[:3]
                    am = (a + b) / 2
                    self.face(q, layer, tint, smooth, uvs=uv, out=(math.cos(am), math.sin(am), 0.6))
            # soffit
            self.disc(cx, cy, z, prof(0) + lip, n, 'wood', (0.5, 0.5, 0.5), up=False)

    def hip_roof(self, cx, cy, w, d, z, h, ridge=0.0, courses=8, layer='roof', tint=WHITE, lip=0.07, mode='solid', flare=0.12, hollow=(0.18, 2.4)):
        """Stepped hipped roof over a w x d rectangle; ridge of length `ridge` along X at the top (0 = pyramid)."""
        if self.lod:
            courses = max(3, courses // 2)
        t = TILE[LAYERS[layer]]

        def half(tt):
            k = (1 - tt) * (1 - flare * math.sin(math.pi * min(1, tt * 1.2)))
            return ridge / 2 + (w / 2 - ridge / 2) * k, (d / 2) * k
        with self.piece(mode, hollow=hollow):
            for j in range(courses):
                ta, tb = j / courses, (j + 1) / courses
                (xa, ya), (xb, yb) = half(ta), half(tb)
                if j:
                    zl = z + h * ta
                    inner = [(cx - xa, cy - ya, zl), (cx + xa, cy - ya, zl), (cx + xa, cy + ya, zl), (cx - xa, cy + ya, zl)]
                    outer = [(cx - xa - lip, cy - ya - lip, zl), (cx + xa + lip, cy - ya - lip, zl), (cx + xa + lip, cy + ya + lip, zl), (cx - xa - lip, cy + ya + lip, zl)]
                    for i in range(4):
                        self.face([inner[i], inner[(i + 1) % 4], outer[(i + 1) % 4], outer[i]], layer, (0.4, 0.4, 0.4), out=(0, 0, -1))
                xa += lip
                ya += lip
                za, zb = z + h * ta, z + h * tb
                ring_a = [(cx - xa, cy - ya, za), (cx + xa, cy - ya, za), (cx + xa, cy + ya, za), (cx - xa, cy + ya, za)]
                ring_b = [(cx - xb, cy - yb, zb), (cx + xb, cy - yb, zb), (cx + xb, cy + yb, zb), (cx - xb, cy + yb, zb)]
                outs = [(0, -1, 0.7), (1, 0, 0.7), (0, 1, 0.7), (-1, 0, 0.7)]
                for i in range(4):
                    i2 = (i + 1) % 4
                    A, B, C, D = ring_a[i], ring_a[i2], ring_b[i2], ring_b[i]
                    run = [xa, ya, xa, ya][i] * 2
                    runb = [xb, yb, xb, yb][i] * 2
                    slant = math.hypot(zb - za, [ya - yb, xa - xb, ya - yb, xa - xb][i])
                    d0 = h * ta * 1.2
                    uv = [(-run / 2 / t, d0 / t), (run / 2 / t, d0 / t), (runb / 2 / t, (d0 + slant) / t), (-runb / 2 / t, (d0 + slant) / t)]
                    # split wide courses so the vertex AO has something to hold on to
                    self.face([A, B, C, D], layer, tint, uvs=uv, out=outs[i])
            (xa, ya) = half(0)
            self.face([(cx - xa, cy - ya, z), (cx + xa, cy - ya, z), (cx + xa, cy + ya, z), (cx - xa, cy + ya, z)], 'wood', (0.5, 0.5, 0.5), out=(0, 0, -1))

    def dome(self, cx, cy, r, z, seg=20, rings=8, layer='roof', tint=WHITE, point=0.35, bulge=0.0, mode='solid', height=None, hollow=(0.25, 2.5)):
        """Dome: hemisphere drawn up into a point (`point`), optionally bulging past its base (`bulge`, onion)."""
        if self.lod:
            rings = max(4, rings // 2)
        H = height or r * (1 + point)
        prof = []
        for k in range(rings + 1):
            a = (k / rings) * math.pi / 2
            rr = r * math.cos(a) * (1 + bulge * math.sin(a * 2))
            # pull the upper part into a point
            s = math.sin(a)
            zz = z + H * (s * (1 - point) + point * s ** 3 if point else s)
            if k == rings:
                rr = 0.0
            prof.append((rr, zz))
        self.lathe(cx, cy, prof, seg=seg, layer=layer, tint=tint, mode=mode, hollow=hollow)
        return z + H

    def finial(self, cx, cy, z, s=1.0, tint=(0.95, 0.72, 0.25), layer='metal', flag=None):
        """Ball-and-spike finial (gold by default)."""
        with self.piece('whole', anchor=(cx, cy, z)):
            self.lathe(cx, cy, [(0.07 * s, z - 0.1 * s), (0.16 * s, z + 0.12 * s), (0.20 * s, z + 0.28 * s), (0.12 * s, z + 0.44 * s), (0.04 * s, z + 0.56 * s), (0.035 * s, z + 1.0 * s), (0.0, z + 1.35 * s)],
                       seg=6 if self.lod else 8, layer=layer, tint=tint, cap=False)
        return z + 1.35 * s

    # ------------------------------------------------------------------------------------------ battlements
    def run(self, p0, p1):
        """Local frame along the segment p0 -> p1: returns (length, context manager) with +X along it and -Y to the
        right-hand outside (walk p0 -> p1 with the outside on your right)."""
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        return math.hypot(dx, dy), self.at(p0[0], p0[1], 0, math.atan2(dy, dx))

    def battlement(self, p0, p1, z, style='square', layer='wall', tint=WHITE, overhang=0.28, parapet=0.75, merlon=(0.85, 0.85, 0.42), gap=0.7, corbels=True, thick=0.42, ends=(True, True), corbel_layer='trim', merlon_tint=None):
        """Machicolated parapet along p0 -> p1 (outside on the right): corbels, an overhanging parapet wall and merlons.
        style: 'square' | 'cap' (merlons with a coping) | 'step' (stepped, Caliphate) | 'spike' (pointed, Ashen)."""
        length, ctx = self.run(p0, p1)
        mt = merlon_tint or tint
        with ctx:
            y = -overhang                      # outer face of the parapet
            if corbels and not self.lod:
                n = max(1, int(length / 0.8))
                for i in range(n):
                    x = (i + 0.5) * length / n
                    if self.gone((x, y, z - 0.3)):
                        continue
                    self.extrude([(y + 0.02, z - 0.02), (y + 0.02, z - 0.3), (0.02, z - 0.62), (0.02, z - 0.02)], x - 0.16, x + 0.16, corbel_layer, (0.82, 0.82, 0.82), mode='whole')
            elif corbels:
                # LOD1: one sloped band instead of single corbels
                self.extrude([(y + 0.02, z - 0.02), (y + 0.02, z - 0.25), (0.02, z - 0.6), (0.02, z - 0.02)], 0, length, corbel_layer, (0.6, 0.6, 0.6), mode='solid', caps=False)
            # parapet wall (sits on the overhang)
            with self.piece('solid'):
                self.panel(lambda u, v, dd: (u, y + dd, v), 0, length, z - 0.04, z + parapet, layer, tint, (), 1.6)
                self.panel(lambda u, v, dd: (length - u, y + thick - dd, v), 0, length, z - 0.04, z + parapet, layer, tint, (), 1.6)
                self.panel(lambda u, v, dd: (u, y + v, z + parapet - dd), 0, length, 0, thick, 'trim', tint, (), 1.6)
                self.face([(0, y, z - 0.04), (length, y, z - 0.04), (length, y + thick, z - 0.04), (0, y + thick, z - 0.04)], layer, (0.6, 0.6, 0.6), out=(0, 0, -1))
                for xx, o in ((0, -1), (length, 1)):
                    self.face([(xx, y, z - 0.04), (xx, y + thick, z - 0.04), (xx, y + thick, z + parapet), (xx, y, z + parapet)], layer, tint, out=(o, 0, 0))
            mw, mh, md = merlon
            n = max(1, int((length + gap) / (mw + gap)))
            pitch = length / n
            zb = z + parapet
            for i in range(n):
                x = (i + 0.5) * pitch
                if self.gone((x, y, zb + 0.2)):
                    continue
                yc = y + md / 2
                w = min(mw, pitch - 0.35)
                with self.piece('whole', anchor=(x, yc, zb)):
                    if style == 'step':
                        self.box(x, yc, zb + mh * 0.25, w, md, mh * 0.5, layer, mt, bottom=False)
                        self.box(x, yc, zb + mh * 0.72, w * 0.56, md, mh * 0.45, layer, mt, bottom=False)
                        if not self.lod:
                            self.box(x, yc, zb + mh * 1.05, w * 0.22, md, mh * 0.25, layer, mt, bottom=False)
                    elif style == 'spike':
                        self.box(x, yc, zb + mh * 0.3, w, md, mh * 0.6, layer, mt, bottom=False)
                        self.extrude([(x - w / 2, zb + mh * 0.6), (x + w / 2, zb + mh * 0.6), (x, zb + mh * 1.45)], yc - md / 2, yc + md / 2, layer, mt, axis='y')
                    else:
                        self.box(x, yc, zb + mh / 2, w, md, mh, layer, mt, bottom=False)
                        if style == 'cap' and not self.lod:
                            self.extrude([(yc - md / 2 - 0.05, zb + mh), (yc + md / 2 + 0.05, zb + mh), (yc + md / 2 + 0.05, zb + mh + 0.07), (yc, zb + mh + 0.22), (yc - md / 2 - 0.05, zb + mh + 0.07)],
                                         x - w / 2 - 0.05, x + w / 2 + 0.05, 'trim', (0.92, 0.92, 0.92))

    def ring_battlement(self, cx, cy, r, z, n=10, style='square', layer='wall', tint=WHITE, parapet=0.7, merlon=(0.7, 0.8, 0.4), seg=16, corbels=True, drop=0.55, r_shaft=None):
        """Corbelled-out parapet ring on a round tower: flared corbel table, parapet drum, merlons."""
        rs = r_shaft if r_shaft is not None else r - 0.3
        with self.piece('solid', hollow=(0.4, 0.5)):
            self.lathe(cx, cy, [(rs, z - drop), (r, z - 0.08), (r, z + parapet)], seg=seg, layer=layer, tint=tint, cap=False)
            self.disc(cx, cy, z + parapet, r, seg, 'trim', tint, r_in=r - merlon[2] - 0.05)
        if corbels and not self.lod:
            m = max(8, int(TAU * r / 0.75))
            for i in range(m):
                a = TAU * (i + 0.5) / m
                x, y = cx + math.cos(a) * (rs + r) / 2, cy + math.sin(a) * (rs + r) / 2
                if self.gone((cx, cy, z - 0.3)):
                    continue
                # anchored on the tower axis, like the drum they carry (else a steep dip leaves a floating ring)
                self.box(x, y, z - drop * 0.55, 0.3, r - rs + 0.12, drop * 0.75, 'trim', (0.8, 0.8, 0.8), yaw=a + math.pi / 2, pitch=0.0, bottom=True, anchor=(cx, cy, z - 0.3))
        mw, mh, md = merlon
        zb = z + parapet
        for i in range(n):
            a = TAU * (i + 0.5) / n
            x, y = cx + math.cos(a) * (r - md / 2), cy + math.sin(a) * (r - md / 2)
            if self.gone((cx, cy, zb + 0.2)):
                continue
            with self.piece('whole', anchor=(cx, cy, zb)):
                if style == 'spike':
                    self.box(x, y, zb + mh * 0.3, mw, md, mh * 0.6, layer, tint, yaw=a + math.pi / 2, bottom=False)
                    with self.at(x, y, 0, a + math.pi / 2):
                        self.extrude([(-mw / 2, zb + mh * 0.6), (mw / 2, zb + mh * 0.6), (0, zb + mh * 1.45)], -md / 2, md / 2, layer, tint, axis='y')
                elif style == 'step':
                    self.box(x, y, zb + mh * 0.25, mw, md, mh * 0.5, layer, tint, yaw=a + math.pi / 2, bottom=False)
                    self.box(x, y, zb + mh * 0.72, mw * 0.56, md, mh * 0.45, layer, tint, yaw=a + math.pi / 2, bottom=False)
                else:
                    self.box(x, y, zb + mh / 2, mw, md, mh, layer, tint, yaw=a + math.pi / 2, bottom=False)

    # ------------------------------------------------------------------------------------------ cloth
    def banner(self, x, y, z, w, h, yaw=0.0, style='point', off=0.12, bar=True, uv=(0.0, 0.0, 1.0, 1.0), sway=1.0):
        """Hanging banner: top edge centred at (x, y, z), facing local -Y rotated by yaw, `off` metres off the wall.
        uv = (u0, v0, u1, v1) window of the banner texture (v0 = top)."""
        if self.gone((x, y, z - 0.3)):
            return
        nx, ny = (3, 5) if self.lod else (4, 9)
        with self.at(x, y, z, yaw):
            with self.piece('whole', anchor=(0, 0, 0)):
                def P(i, j):
                    u, v = i / nx, j / ny
                    px = (u - 0.5) * w
                    pz = -v * h
                    if j == ny:
                        if style == 'point':
                            pz += abs(u - 0.5) * 2 * h * 0.14
                        elif style == 'swallow':
                            pz += (1 - abs(u - 0.5) * 2) * h * 0.14
                        elif style == 'tatter':
                            pz += (0.0, 0.10, 0.03, 0.16, 0.0, 0.08)[i % 6] * h
                    # a slight belly so it is not a flat card
                    py = -off - 0.10 * math.sin(v * math.pi) * (0.6 + 0.4 * math.cos((u - 0.5) * math.pi)) - 0.04 * math.sin(u * math.pi * 3) * v
                    return (px, py, pz), (lerp(uv[0], uv[2], u), 1 - lerp(uv[1], uv[3], v)), v
                for i in range(nx):
                    for j in range(ny):
                        q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)]
                        f = self.face([a[0] for a in q], CLOTH, WHITE, True, uvs=[a[1] for a in q], out=(0, -1, 0))
                        if f:
                            for lp in f.loops:
                                # sway weight from the height below the bar (local z)
                                lz = (self.M.inverted() @ lp.vert.co).z
                                s = min(1.0, max(0.0, -lz / h)) * sway
                                lp[self.col] = (s, 1.0, 1.0, 1.0)
                if bar:
                    self.box(0, -off, 0.04, w + 0.3, 0.07, 0.07, 'wood', (0.5, 0.45, 0.4))
                    if not self.lod:
                        for sx in (-1, 1):
                            self.box(sx * (w / 2 + 0.1), -off / 2, 0.04, 0.06, off + 0.06, 0.06, 'metal', (0.7, 0.7, 0.7))

    def flag(self, x, y, z, pole=2.2, size=1.3, yaw=0.0, uv=(0.1, 0.12, 0.9, 0.62), tint=(0.5, 0.45, 0.4), style='swallow'):
        """Pennant on a pole standing at (x, y, z); the cloth flies along local +X (rotated by yaw)."""
        if self.gone((x, y, z)):
            return
        with self.at(x, y, z, yaw):
            with self.piece('whole', anchor=(0, 0, 0)):
                self.sweep([(0, 0, 0), (0, 0, pole)], [0.045, 0.03], seg=5, layer='wood', tint=tint, cap=False)
                if not self.lod:
                    self.blob(0, 0, pole + 0.06, 0.08, 0.08, 0.08, 'metal', (0.95, 0.72, 0.25), detail=1)
                nx, ny = (3, 2) if self.lod else (6, 3)
                L, Hh = size * 1.5, size * 0.8

                def P(i, j):
                    u, v = i / nx, j / ny
                    px = u * L
                    pz = pole - 0.05 - v * Hh - u * 0.12 * size
                    if i == nx and style == 'swallow':
                        px -= (1 - abs(v - 0.5) * 2) * L * 0.22
                    if style == 'tatter' and i == nx:
                        px -= (0.0, 0.25, 0.08, 0.3)[j % 4] * L
                    py = 0.12 * size * math.sin(u * math.pi * 2.2) * u
                    return (px, py, pz), (lerp(uv[0], uv[2], v), 1 - lerp(uv[1], uv[3], u)), u
                for i in range(nx):
                    for j in range(ny):
                        q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)]
                        f = self.face([a[0] for a in q], CLOTH, WHITE, True, uvs=[a[1] for a in q], out=(0, -1, 0))
                        if f:
                            for lp in f.loops:
                                lx = (self.M.inverted() @ lp.vert.co).x
                                lp[self.col] = (min(1.0, max(0.0, lx / L)) * 1.4, 1.0, 1.0, 1.0)

    # ------------------------------------------------------------------------------------------ details
    def flame(self, x, y, z, s=1.0, tint=(1.0, 0.55, 0.15), n=3):
        """A few glowing tongues (unlit emissive; the renderer blooms it)."""
        if self.gone((x, y, z)):
            return
        r = random.Random(int(x * 17 + y * 31 + z * 7))
        with self.piece('whole', anchor=(x, y, z)):
            for k in range(1 if self.lod else n):
                a = r.random() * TAU
                d = 0.0 if k == 0 else 0.16 * s
                hh = s * (1.0 if k == 0 else 0.55 + r.random() * 0.3)
                ww = s * (0.30 if k == 0 else 0.2)
                cx, cy = x + math.cos(a) * d, y + math.sin(a) * d
                # the renderer multiplies glow colours by ~1.5 and blooms them: keep the core saturated, not white
                hot = (min(1.0, tint[0] * 0.85 + 0.08), min(1.0, tint[1] * 0.85 + 0.08), min(1.0, tint[2] * 0.85 + 0.08))
                dim = (tint[0] * 0.6, tint[1] * 0.6, tint[2] * 0.6)
                self.lathe(cx, cy, [(0.0, z - 0.05 * s), (ww, z + hh * 0.22), (ww * 0.75, z + hh * 0.5), (ww * 0.3, z + hh * 0.8), (0.0, z + hh)], seg=5, layer='glow', tint=dim if k else hot, cap=False, smooth=True)

    def rocks(self, pts, size=(0.3, 0.8), layer='wall', tint=(0.8, 0.8, 0.8), seed=3, flat=0.6):
        r = random.Random(seed)
        for (x, y, z) in pts:
            s = lerp(size[0], size[1], r.random() ** 1.6)
            if r.random() < 0.45:
                self.box(x, y, z + s * 0.2, s * 1.5, s, s * 0.8, layer, tint, mode='keep', yaw=r.random() * 3, pitch=(r.random() - 0.5) * 0.9, roll=(r.random() - 0.5) * 0.9)
            else:
                self.blob(x, y, z + s * 0.15, s, s * (0.7 + r.random() * 0.5), s * flat, layer, tint, detail=0 if (self.lod or s < 0.5) else 1, jitter=0.22, yaw=r.random() * 3, seed=r.randrange(1 << 30))

    def rubble(self, n, rect, seed=5, size=(0.25, 0.75), tint=(0.62, 0.6, 0.58), layer='wall', heap=None, z=0.0):
        """Scatter n chunks in rect (x0, y0, x1, y1); with `heap` = (x, y, radius, height) they pile up there."""
        r = random.Random(seed)
        if self.lod:
            n = n // 2
        pts = []
        for _ in range(n):
            if heap:
                a, d = r.random() * TAU, math.sqrt(r.random()) * heap[2]
                x, y = heap[0] + math.cos(a) * d, heap[1] + math.sin(a) * d * 0.8
                pz = max(0.0, z) + max(0.0, (1 - d / heap[2])) * heap[3] * (0.5 + 0.5 * r.random())
            else:
                x, y, pz = lerp(rect[0], rect[2], r.random()), lerp(rect[1], rect[3], r.random()), max(0.0, z)
            pts.append((x, y, pz))
        self.rocks(pts, size, layer, tint, seed + 1)

    # ------------------------------------------------------------------------------------------ finish
    def finalize(self, name, mats):
        bm = self.bm
        bm.normal_update()
        bm.verts.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        w = self.weather
        tree = BVHTree.FromBMesh(bm) if self.ao else None
        dirs = []
        r = random.Random(4)
        N = 14 if self.lod else 18
        for i in range(N):                                # cosine-weighted hemisphere (+Z), stratified
            u, v = (i + r.random()) / N, r.random()
            rr, ph = math.sqrt(u), TAU * v
            dirs.append(Vector((rr * math.cos(ph), rr * math.sin(ph), math.sqrt(max(0.0, 1 - u)))))
        maxd = w.get('ao_dist', 3.2)
        strength = w.get('ao', 0.9)
        dirt = Vector(w.get('dirt', (0.62, 0.55, 0.45)))
        moss = Vector(w.get('moss', (0.72, 0.84, 0.62)))
        moss_amt = w.get('moss_amt', 0.5)
        soot = w.get('soot', 0.36)
        cache = {}
        for f in bm.faces:
            L = f[self.fl]
            if L == CLOTH or L == 8:
                continue
            for lp in f.loops:
                v = lp.vert
                n = v.normal if f.smooth else f.normal
                key = (v.index, round(n.x, 1), round(n.y, 1), round(n.z, 1))
                k = cache.get(key)
                if k is None:
                    co = v.co
                    occ = 0.0
                    if tree is not None:
                        up = Vector((0, 0, 1)) if abs(n.z) < 0.95 else Vector((1, 0, 0))
                        tx = n.cross(up).normalized()
                        ty = n.cross(tx)
                        # start a little inside the face (towards its centre) so shared corners do not self-shadow
                        org = co + n * 0.06 + (f.calc_center_median() - co) * 0.08
                        for d in dirs:
                            wd = tx * d.x + ty * d.y + n * d.z
                            hit, hn, _, dist = tree.ray_cast(org, wd, maxd)
                            t = None
                            if hit is not None and hn.dot(wd) < 0.05:
                                t = dist
                            if wd.z < -1e-3 and org.z > 0:           # the ground
                                tg = -org.z / wd.z
                                if tg < maxd and (t is None or tg < t):
                                    t = tg
                            if t is not None:
                                occ += (1 - t / maxd) ** 0.8
                        occ /= len(dirs)
                    ao = max(0.22, 1 - occ * strength)
                    # weathering: large blotches, damp and dirt towards the ground, soot under the break
                    nz = noise.noise(Vector((co.x * 0.33, co.y * 0.33, co.z * 0.2)))
                    nz2 = noise.noise(Vector((co.x * 1.3 + 9, co.y * 1.3, co.z * 0.5)))
                    val = 1 + 0.13 * nz + 0.06 * nz2
                    c = Vector((val, val, val))
                    g = max(0.0, 1 - max(0.0, co.z) / w.get('dirt_h', 1.8)) * (0.7 + 0.5 * nz2)
                    g = min(1.0, max(0.0, g))
                    c = c.lerp(Vector((c.x * dirt.x, c.y * dirt.y, c.z * dirt.z)), g * 0.8)
                    mz = max(0.0, 1 - max(0.0, co.z - 0.3) / 3.5) * max(0.0, nz * 1.6 + 0.25) * moss_amt
                    if n.z > 0.5:
                        mz += moss_amt * 0.25 * max(0.0, nz2 + 0.3)
                    mz = min(1.0, mz)
                    c = c.lerp(Vector((c.x * moss.x, c.y * moss.y, c.z * moss.z)), mz)
                    if self.cut is not None:
                        below = self.cut(co.x, co.y) - co.z
                        s = max(0.0, 1 - max(0.0, below) / 2.6) * soot * (0.7 + 0.6 * (nz2 * 0.5 + 0.5))
                        c *= (1 - min(0.85, s))
                    k = c * ao
                    cache[key] = k
                t = lp[self.col]
                lp[self.col] = (min(1.0, t[0] * k.x), min(1.0, t[1] * k.y), min(1.0, t[2] * k.z), 1.0)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for m in mats:
            me.materials.append(m)
        ca = me.color_attributes.get('Color')
        if ca is not None:
            me.color_attributes.active_color = ca
            me.color_attributes.render_color_index = list(me.color_attributes).index(ca)
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        me.calc_loop_triangles()
        return ob, len(me.loop_triangles)


def cut_surface(height, frac, seed, dips=(), amp=0.09, tilt=(0.10, 0.06)):
    """Damage surface z(x, y): frac * height, large + small noise, a tilt, and local `dips` (x, y, radius, depth)."""
    r = random.Random(seed)
    off = Vector((r.random() * 50, r.random() * 50, 0))

    def f(x, y):
        h = frac * height
        h += noise.noise(Vector((x * 0.16, y * 0.16, 0)) + off) * height * amp
        h += noise.noise(Vector((x * 0.55, y * 0.55, 3)) + off) * height * amp * 0.35
        h += (x * tilt[0] + y * tilt[1]) / 9.0 * height
        for (dx, dy, rad, dep) in dips:
            d = math.hypot(x - dx, y - dy) / rad
            if d < 1:
                h -= dep * (1 - d * d) ** 2          # dep < 0: a fragment left standing
        return max(0.6, h)
    return f
