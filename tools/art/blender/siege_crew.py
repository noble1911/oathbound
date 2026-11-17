"""TRELLIS crew figures as rigid pieces of an authored siege engine (docs/ART.md section 10.x).

The crew of an engine are ordinary part assets (`"part": true`, own prompt, Codex concept, TRELLIS 1024 mesh). This
module turns one into a low mesh with clean UVs and a baked albedo, then hands it to the engine's kit like any other
piece: its texels are copied into the engine atlas at the kit's texel density (no second material, no second draw).

  prepare(cid)   art-work/mesh/<cid>.glb -> welded, grounded, scaled to assets.json `height` (`fix_yaw` degrees
                 turns it to face -Y), voxel remesh + quadric collapse to `lod0`, box unwrap, Cycles emission bake
                 of the TRELLIS albedo at `crew_tex` (1024), `hue_map`, team key (`team_hue` / `team_sat`: magenta
                 cloth -> light grey + mask), optional `crew_lift` [gamma, gain]. Cached in
                 art-work/clean/<cid>_crew.npz (+ _crew_base.png for inspection); rebuilt when the mesh is newer or the asset entry changed.
  add(e, cid, M, node, lod, w)   instance the cached figure into siege_kit.Eng `e` with the 4x4 placement M (unit
                 space, the figure faces -Y before M). LOD1 = the LOD0 figure collapsed to `lod1` triangles, one flat
                 colour per face (see _lod1).
The bake takes the GPU through art_lib.bake_device (art-work/fx_gpu.lock; CPU when the lock is held).
"""
import json, math
import bpy
import bmesh
import numpy as np
from mathutils import Matrix

import art_lib as L
import trappings_lib as T

F32 = np.float32


def _cache(cid):
    return L.WORK / 'clean' / f'{cid}_crew.npz'


def prepare(cid):
    a = L.assets()[cid]
    src = L.WORK / 'mesh' / f'{cid}.glb'
    out = _cache(cid)
    sig = json.dumps({k: a.get(k) for k in ('height', 'lod0', 'fix_yaw', 'crew_tex', 'hue_map', 'team_hue', 'team_sat', 'team_val', 'crew_lift')}, sort_keys=True)
    if out.exists() and out.stat().st_mtime > src.stat().st_mtime:
        d = np.load(out)
        if 'sig' in d.files and str(d['sig']) == sig:
            return {k: d[k] for k in d.files}
    import cleanup as C
    sc = bpy.context.scene
    eng0 = sc.render.engine
    high = C.load_high(cid)
    if a.get('fix_yaw'):
        L.rotate_z(high, math.radians(a['fix_yaw']))
    L.ground_and_scale(high, a['height'], centre='feet')
    voxel = min(0.02, max(0.006, a['height'] / 450))
    low = C.low_of(high, f'_{cid}_low', a.get('lod0', 1800), voxel)
    low.data.uv_layers.new(name='UVMap')
    tex = a.get('crew_tex', 1024)
    C.unwrap_box(low, 0.004, scale=tex)
    img = L.new_image(f'_{cid}_bake', tex)
    tmp = bpy.data.materials.new('_crew_bake'); tmp.use_nodes = True
    low.data.materials.append(tmp)
    sc.render.engine = 'CYCLES'; sc.cycles.samples = 2
    hmat = high.data.materials[0]
    with L.bake_device(f'siege crew {cid}'):
        old = C.emit_rewire(hmat, 'color')
        C.bake_to(high, low, img, 'EMIT', max(0.01, 0.012 * a['height']))
        C.emit_restore(hmat, old)
    sc.render.engine = eng0
    if a.get('hue_map'):
        C.apply_hue_map(img, a['hue_map'])
    C.TEAM_HUE = tuple(a.get('team_hue', C.TEAM_HUE)); C.TEAM_SAT = a.get('team_sat', C.TEAM_SAT); C.TEAM_VAL = a.get('team_val', C.TEAM_VAL)
    mask = C.team_mask(img)
    px = L.img_np(img)[..., :3].copy()
    if a.get('crew_lift'):
        g, k = a['crew_lift']
        px = np.clip(px ** g * k, 0, 1)
    img.filepath_raw = str(L.WORK / 'clean' / f'{cid}_crew_base.png'); img.file_format = 'PNG'; img.save()
    me = low.data
    co = np.empty(len(me.vertices) * 3, F32); me.vertices.foreach_get('co', co)
    me.calc_loop_triangles()
    tri = np.empty(len(me.loop_triangles) * 3, np.int32); me.loop_triangles.foreach_get('loops', tri)
    vi = np.empty(len(me.loops), np.int32); me.loops.foreach_get('vertex_index', vi)
    uv = T.get_uv(low)
    d = dict(co=co.reshape(-1, 3), tri_loops=tri.reshape(-1, 3), loop_vert=vi, uv=uv, col=px.astype(F32), team=mask.astype(F32), sig=np.array(sig))
    np.savez_compressed(out, **d)
    print(f'[crew] {cid}: {len(d["tri_loops"])} tris, team {float((mask > 0.5).mean()) * 100:.1f}% of the bake')
    for o in (low, high):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.images.remove(img); bpy.data.materials.remove(tmp)
    return d


_SRC = {}


def _src(cid, d, lod=False):
    """LOD1 samples one texel per face: a blurred copy (the dominant colour around the point, not a fold or a seam)."""
    k = (cid, lod)
    if k not in _SRC:
        col = d['col']; tm = d['team']
        if lod:
            col = np.stack([T.blur(col[..., i], 11) for i in range(3)], -1); tm = T.blur(tm, 11)
        _SRC[k] = T.Src(col, tm, col.mean(2), 0.78, 0.0, None, 0.0 if lod else 0.0015, None, f'crew_{cid}{"_1" if lod else ""}')
    return _SRC[k]


def _mesh(cid, d):
    """One object per triangle (loop UVs kept: UV seams stay seams)."""
    co = d['co']; tl = d['tri_loops']; vi = d['loop_vert']; uv = d['uv']
    faces = [tuple(int(vi[l]) for l in t) for t in tl]
    uvs = [[tuple(map(float, uv[l])) for l in t] for t in tl]
    return T.new_obj(f'crew_{cid}', co, faces, uvs, smooth_=True)


def _lod1(cid, d, hi):
    """LOD1 figure: the LOD0 shape voxel-remeshed (height / 70, coarser if needed) and collapsed to `lod1` triangles without UVs (the
    collapse stalls on the open shells and hundreds of UV seams of the baked figure), then one flat colour per face: every corner gets the LOD0 UV of the
    point nearest the face centre (a 30 cm figure on screen at LOD1 distance)."""
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    a = L.assets()[cid]
    co = d['co']; tl = d['tri_loops']; vi = d['loop_vert']; uv = d['uv']
    lo = T.new_obj(f'crew1_{cid}', co, [tuple(int(vi[l]) for l in t) for t in tl], None, smooth_=True)
    tgt = a.get('lod1', 300)
    keep = lo.data.copy()
    for div in (70, 50, 38):                                 # watertight remesh so the collapse can reach the budget
        rm = lo.modifiers.new('rm', 'REMESH'); rm.mode = 'VOXEL'; rm.voxel_size = a['height'] / div
        L.apply_mods(lo); L.remove_floaters(lo, 0.01)
        sm = lo.modifiers.new('sm', 'SMOOTH'); sm.factor = 0.6; sm.iterations = 3      # no voxel stairs -> no spikes after the collapse
        L.apply_mods(lo)
        for _ in range(4):
            n = T.tris(lo)
            if n <= tgt * 1.05:
                break
            m = lo.modifiers.new('dec', 'DECIMATE'); m.decimate_type = 'COLLAPSE'; m.ratio = tgt / n
            m.use_collapse_triangulate = True
            L.apply_mods(lo)
        if T.tris(lo) <= tgt * 1.15:
            break
        old = lo.data; lo.data = keep.copy(); bpy.data.meshes.remove(old)
    bpy.data.meshes.remove(keep)
    bvh = BVHTree.FromPolygons([tuple(map(float, v)) for v in co], [tuple(int(vi[l]) for l in t) for t in tl])
    me = lo.data
    out = np.zeros((len(me.loops), 2), F32)
    for p in me.polygons:
        c = p.center
        hit, _, fi, _ = bvh.find_nearest(c)
        if fi is None:
            continue
        t = tl[fi]; P = [Vector(co[vi[l]]) for l in t]
        # barycentric weights of the hit point
        v0, v1, v2 = P[1] - P[0], P[2] - P[0], hit - P[0]
        d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
        den = d00 * d11 - d01 * d01 or 1e-12
        b1 = (d11 * d20 - d01 * d21) / den; b2 = (d00 * d21 - d01 * d20) / den; b0 = 1 - b1 - b2
        u = uv[t[0]] * b0 + uv[t[1]] * b1 + uv[t[2]] * b2
        for li in p.loop_indices:
            out[li] = u
    for p in me.polygons:
        p.use_smooth = True
    if 'UVMap' not in me.uv_layers:
        me.uv_layers.new(name='UVMap')
    T.set_uv(lo, out)
    bpy.data.objects.remove(hi, do_unlink=True)
    return lo


def add(e, cid, M, node, lod=False, w=1.0):
    d = prepare(cid)
    ob = _mesh(cid, d)
    if lod:
        ob = _lod1(cid, d, ob)
    ob.data.transform(Matrix(M))
    return e.add(ob, _src(cid, d, lod), node, w=w, jitter=0, clean=0.8)


def landmarks(cid):
    """Rough landmarks of the prepared figure (figure space, faces -Y): the hands (front-most points between 45 and 75 %
    of the height) and the top."""
    d = prepare(cid)
    co = d['co']; H = co[:, 2].max()
    band = co[(co[:, 2] > 0.45 * H) & (co[:, 2] < 0.75 * H)]
    fr = band[band[:, 1] < np.percentile(band[:, 1], 4)]
    return dict(hands=fr.mean(0), top=H, xmin=float(co[:, 0].min()), xmax=float(co[:, 0].max()))
