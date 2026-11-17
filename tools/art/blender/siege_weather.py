"""Weathering pass for the authored siege engines (docs/ART.md section 10.x), CPU only.

siege_kit.Eng.finish() calls weather(eng, nodes) after the kit has composed the atlas. The engine in its rest pose
is baked with Cycles on the CPU into the kit's own atlas layout:
  ambient occlusion (the engine + the ground), world position, world normal, and a Bevel-node pass that gives
  (a) an edge mask and (b) rounded edges as a tangent normal map (the beams are plain boxes: no chamfer geometry).
Those maps drive the grading of the basecolour / roughness / normal images in numpy: contact darkening and crevice
dirt, mud splashed up from the ground, sun-bleached tops and dark undersides, worn pale edges on timber and bright
edges on iron, rust (verdigris on Ashen bronze) on the fittings and streaks of it on the timber below them, and the
soul-fire's green light on what surrounds it (albedo only: the renderer has no emissive). Sun Caliphate: desert dust
instead of mud, a warm tarnish on the brass instead of rust. Kit pieces added with `clean` (the polished mirror, TRELLIS
crew with their own baked shading) keep their albedo / roughness / metal, darkened only by a light occlusion.
Instances that share texels (mirrored / repeated pieces, flipped cloth backs) are baked once, from the original.
`SIEGE_NOWEATHER=1` skips the pass (fast geometry iterations).
"""
import math
import time
import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector, kdtree

import trappings_lib as T

F32 = np.float32


def _px(img):
    w, h = img.size
    a = np.empty(w * h * 4, F32); img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)


def _set(img, arr):
    h, w = arr.shape[:2]
    px = np.concatenate([arr.astype(F32), np.ones((h, w, 1), F32)], 2)
    img.pixels.foreach_set(px.ravel()); img.update(); img.pack()


def _split(obs, S):
    """-> (target object: every texel once, occluder object: the other instances) in world space."""
    seen_uv = {}; seen_pos = set()
    tg, oc = [], []
    for name, ob in obs.items():
        me = ob.data
        M = ob.matrix_world.copy()
        uv = T.get_uv(ob)
        co = np.array([M @ v.co for v in me.vertices])
        keep = []
        for p in me.polygons:
            cu = uv[list(p.loop_indices)].mean(0)
            key = (int(round(cu[0] * S * 4)), int(round(cu[1] * S * 4)))
            k3 = tuple(np.round(co[list(p.vertices)].mean(0), 4))
            if key not in seen_uv:
                seen_uv[key] = 1; seen_pos.add(k3); keep.append(0)
            elif k3 in seen_pos:
                keep.append(2)                               # the flipped back face of thin cloth: coincident, dropped
            else:
                keep.append(1)
        for want, lst in ((0, tg), (1, oc)):
            if want not in keep:
                continue
            bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table()
            bm.transform(M)
            bmesh.ops.delete(bm, geom=[f for f, k in zip(bm.faces, keep) if k != want], context='FACES')
            m2 = bpy.data.meshes.new(f'_w{want}_{name}'); bm.to_mesh(m2); bm.free()
            o2 = bpy.data.objects.new(m2.name, m2); bpy.context.scene.collection.objects.link(o2)
            lst.append(o2)
    tgt = T.join(tg, '_w_target')
    occ = T.join(oc, '_w_occ') if oc else None
    return tgt, occ


def _mat(kind, radius):
    m = bpy.data.materials.new(f'_w_{kind}'); m.use_nodes = True
    nt = m.node_tree
    out = nt.nodes['Material Output']; p = nt.nodes['Principled BSDF']
    if kind == 'plain':
        return m
    if kind == 'bevel':
        bv = nt.nodes.new('ShaderNodeBevel'); bv.samples = 8; bv.inputs['Radius'].default_value = radius
        nt.links.new(bv.outputs['Normal'], p.inputs['Normal'])
        return m
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    if kind == 'pos':                                        # (position + 20) / 40
        a = nt.nodes.new('ShaderNodeVectorMath'); a.operation = 'ADD'; a.inputs[1].default_value = (20, 20, 20)
        s = nt.nodes.new('ShaderNodeVectorMath'); s.operation = 'SCALE'; s.inputs['Scale'].default_value = 1 / 40
        nt.links.new(geo.outputs['Position'], a.inputs[0]); nt.links.new(a.outputs['Vector'], s.inputs[0])
        nt.links.new(s.outputs['Vector'], em.inputs['Color'])
    elif kind == 'edge':                                     # 1 - bevelled normal . true normal
        bv = nt.nodes.new('ShaderNodeBevel'); bv.samples = 8; bv.inputs['Radius'].default_value = radius
        d = nt.nodes.new('ShaderNodeVectorMath'); d.operation = 'DOT_PRODUCT'
        nt.links.new(bv.outputs['Normal'], d.inputs[0]); nt.links.new(geo.outputs['True Normal'], d.inputs[1])
        sub = nt.nodes.new('ShaderNodeMath'); sub.operation = 'SUBTRACT'; sub.inputs[0].default_value = 1.0
        nt.links.new(d.outputs['Value'], sub.inputs[1])
        nt.links.new(sub.outputs['Value'], em.inputs['Color'])
    return m


def _bake(tgt, S, name, btype, mat, samples, **kw):
    sc = bpy.context.scene
    img = bpy.data.images.new(f'_w_{name}', S, S, alpha=False, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    tgt.data.materials.clear(); tgt.data.materials.append(mat)
    nt = mat.node_tree
    for n in nt.nodes:
        n.select = False
    node = nt.nodes.new('ShaderNodeTexImage'); node.image = img; node.select = True; nt.nodes.active = node
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    tgt.select_set(True); bpy.context.view_layer.objects.active = tgt
    sc.cycles.samples = samples
    b = sc.render.bake
    b.use_selected_to_active = False; b.margin = max(2, S // 340); b.margin_type = 'EXTEND'; b.use_clear = True; b.target = 'IMAGE_TEXTURES'
    bpy.ops.object.bake(type=btype, **kw)
    a = _px(img)[..., :3].copy()
    nt.nodes.remove(node); bpy.data.images.remove(img)
    return a


def _sm(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def weather(e, obs):
    t0 = time.time()
    kit = e.kit; imgs = kit.images
    S = imgs['base'].size[0]
    sc = bpy.context.scene
    bpy.context.view_layer.update()
    tgt, occ = _split(obs, S)
    hid = [(o, o.hide_render) for o in obs.values()]
    for o in obs.values():
        o.hide_render = True
    gm = bpy.data.meshes.new('_w_ground'); gm.from_pydata([(-30, -30, 0), (30, -30, 0), (30, 30, 0), (-30, 30, 0)], [], [(0, 1, 2, 3)])
    ground = bpy.data.objects.new('_w_ground', gm); sc.collection.objects.link(ground)
    eng0 = sc.render.engine
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
    try:
        sc.cycles.use_denoising = False
    except Exception:
        pass
    if sc.world is None:
        sc.world = bpy.data.worlds.new('_w_world')
    sc.world.light_settings.distance = 1.1 * e.k
    rad = 0.014 * e.k
    mats = {k: _mat(k, rad) for k in ('plain', 'bevel', 'pos', 'edge')}
    ao = _bake(tgt, S, 'ao', 'AO', mats['plain'], 48 if S > 1024 else 96)[..., 0]
    pos = _bake(tgt, S, 'pos', 'EMIT', mats['pos'], 1)
    nrm = _bake(tgt, S, 'nrm', 'NORMAL', mats['plain'], 1, normal_space='OBJECT') * 2 - 1
    edge = _bake(tgt, S, 'edge', 'EMIT', mats['edge'], 6)[..., 0]
    bev = _bake(tgt, S, 'bev', 'NORMAL', mats['bevel'], 6, normal_space='TANGENT')
    cov = pos.sum(2) > 1e-4
    pos = pos * 40 - 20
    for o in (tgt, occ, ground):
        if o is not None:
            bpy.data.objects.remove(o, do_unlink=True)
    for m in mats.values():
        bpy.data.materials.remove(m)
    for o, h in hid:
        o.hide_render = h
    sc.render.engine = eng0

    base = _px(imgs['base'])[..., :3].copy()
    base0 = base.copy()
    mr = _px(imgs['mr'])[..., :3].copy()
    det = _px(imgs['normal'])[..., :3].copy()
    rough = mr[..., 1]; metal = mr[..., 2]
    team = kit.team
    ashen = e.faction == 'ashen'
    cal = e.faction == 'caliphate'
    clean = getattr(kit, 'clean', None)
    if clean is None:
        clean = np.zeros((S, S), F32)
    mr0 = mr.copy()
    z = pos[..., 2]; nz = nrm[..., 2]
    ismetal = metal > 0.2
    cloth = team > 0.3
    green = (base[..., 1] > base[..., 0] * 1.35) & (base[..., 1] > 0.5)          # the soul-fire itself
    # noise: fine fbm in UV space + a coarse field in world space (continuous across islands)
    n1 = T.fbm(S, 1.3, 11); n2 = T.fbm(S, 0.8, 12); n3 = T.fbm(S, 1.8, 13)
    w3 = 0.5 + 0.25 * (np.sin(pos[..., 0] * 5.1 + pos[..., 2] * 3.3 + 1.0) + np.sin(pos[..., 1] * 4.3 - pos[..., 2] * 2.7))
    w3 = np.clip(0.6 * w3 + 0.4 * n3, 0, 1)

    def lerp(a, b, k):
        return a * (1 - k[..., None]) + np.array(b, F32) * k[..., None] if not isinstance(b, np.ndarray) else a * (1 - k[..., None]) + b * k[..., None]

    # 1. ambient occlusion (weaker on team cloth so the team colour stays readable)
    aoc = 0.38 + 0.62 * np.clip(ao, 0, 1) ** 1.1
    k_ao = np.where(cloth, 0.5, 0.8)
    base *= (1 - k_ao + k_ao * aoc)[..., None]
    cav = 1 - np.clip(ao, 0, 1)
    # 2. crevice dirt
    dirt = (0.11, 0.105, 0.10) if ashen else (0.24, 0.19, 0.13) if cal else (0.20, 0.16, 0.11)
    k = _sm(cav, 0.22, 0.7) * (0.45 + 0.55 * n1) * np.where(cloth, 0.3, 0.75)
    base = lerp(base, dirt, k); rough = np.clip(rough + 0.15 * k, 0, 1)
    # 3. mud / ash thrown up from the ground
    mud = (0.17, 0.165, 0.16) if ashen else (0.48, 0.40, 0.29) if cal else (0.27, 0.215, 0.15)
    hgt = 0.95 * e.k
    k = np.clip(1 - z / hgt, 0, 1) ** 1.6 * (0.35 + 0.9 * w3) * np.where(cloth, 0.3, 1.0)
    k = np.clip(k, 0, 0.8)
    base = lerp(base, mud, k * (0.42 if cal else 0.8)); rough = np.clip(rough + 0.2 * k, 0, 1); metal = metal * (1 - 0.8 * k)
    # 4. tops bleached by the sun and dusted, undersides darker
    up = _sm(nz, 0.5, 0.95) * (~ismetal) * (~cloth) * (0.5 + 0.5 * n2)
    lum = base.mean(2, keepdims=True)
    base = lerp(base, np.clip((base * 0.55 + lum * 0.45) * 1.16 + 0.02, 0, 1), up * (0.3 if ashen else 0.25 if cal else 0.55))
    base *= (1 - 0.12 * _sm(-nz, 0.3, 0.9))[..., None]
    # 5. large-scale tone variation so no two beams read the same
    base *= (0.96 + 0.2 * w3)[..., None]
    if ashen:                                                # old bone: brown mottling, darker in the pores
        bone = (~ismetal) & (~cloth) & (base.min(2) > 0.42) & (base[..., 0] > base[..., 2] * 1.08)
        k = bone * np.clip(0.25 + 0.75 * _sm(n2 * 0.6 + w3 * 0.4, 0.3, 0.75), 0, 1)
        base = lerp(base, base * np.array((0.72, 0.64, 0.52), F32), k * 0.7)
        base *= (1 - 0.25 * bone * _sm(n1, 0.55, 0.85))[..., None]
    # 6. iron: rust (verdigris on bronze) in the cavities and in blotches; timber below it gets streaks
    rust = np.array((0.22, 0.45, 0.37) if ashen else (0.30, 0.21, 0.11) if cal else (0.36, 0.17, 0.08), F32)
    k = np.clip(_sm(n2, 0.52, 0.8) * 0.7 + _sm(cav, 0.15, 0.6) * 0.6, 0, 0.85) * ismetal
    base = lerp(base, rust * (0.8 + 0.4 * n1[..., None]), k * (0.38 if ashen else 0.4 if cal else 0.75))
    rough = np.clip(rough + 0.3 * k, 0, 1); metal = metal * (1 - 0.7 * k)
    stain = np.zeros((S, S), F32)
    ys, xs = np.nonzero(ismetal & cov)
    if len(ys) > 50:
        st = max(1, int(math.sqrt(len(ys) / 60000)))
        sel = (ys % st == 0) & (xs % st == 0)
        mp = pos[ys[sel], xs[sel]].astype(float)
        kd = kdtree.KDTree(len(mp))
        ZS = 0.4                                             # squash z: the influence runs down (and up) the timber
        for i, p in enumerate(mp):
            kd.insert((p[0], p[1], p[2] * ZS), i)
        kd.balance()
        h = 2 if S > 512 else 1
        sub = (~ismetal & cov & ~cloth)[::h, ::h]
        yy, xx = np.nonzero(sub)
        pp = pos[::h, ::h][yy, xx].astype(float)
        out = np.zeros(len(yy), F32)
        R = 0.065 * e.k
        for i in range(len(yy)):
            p = pp[i]
            co, idx, d = kd.find((p[0], p[1], p[2] * ZS))
            if d < R:
                below = min(1.0, max(0.0, (mp[idx][2] - p[2]) / (0.03 * e.k) + 0.6))
                out[i] = (1 - d / R) ** 1.5 * below
        s2 = np.zeros(sub.shape, F32); s2[yy, xx] = out
        stain = np.repeat(np.repeat(s2, h, 0), h, 1)[:S, :S] * (0.35 + 0.65 * n1)
    base = lerp(base, base * (rust * 1.1 + 0.42), np.clip(stain, 0, 1) * (0.3 if cal else 0.55))
    # 7. worn edges: pale timber, bright metal
    ed = _sm(edge, 0.015, 0.16) * _sm(n1 * 0.6 + w3 * 0.4, 0.25, 0.6) * (~cloth) * (z > 0.02)
    wood_e = np.clip((base * 0.6 + lum * 0.4) * 1.45 + 0.05, 0, 1)
    base = np.where(ismetal[..., None], lerp(base, np.clip(base * 1.7 + 0.08, 0, 1), ed * 0.8), lerp(base, wood_e, ed * 0.7))
    rough = np.where(ismetal, np.clip(rough - 0.2 * ed, 0.2, 1), rough)
    # 8. soul-fire light
    for c, R in e.fires:
        Lv = np.array(c, F32)[None, None] - pos
        d = np.linalg.norm(Lv, axis=2) + 1e-4
        nl = np.clip((nrm * Lv).sum(2) / d * 0.75 + 0.25, 0, 1)
        k = np.clip(1 - d / R, 0, 1) ** 1.5 * nl * (~green) * cov
        base = base * (1 - 0.25 * k[..., None]) + np.array((0.30, 1.0, 0.42), F32) * (0.5 * k[..., None])
    # exposure: the engine lights art albedo darkly (the TRELLIS models it replaces were lifted to a median
    # luminance of 0.25-0.29), so the timber is brought to the same level after all the darkening above
    body = cov & ~cloth & ~green & (clean < 0.5)
    med = float(np.median(base[body].mean(1))) if body.any() else 0.3
    gain = min(2.0, max(1.0, (0.25 if ashen else 0.23 if cal else 0.29) / max(med, 1e-3)))
    base = np.where(cloth[..., None], base, 1 - (1 - np.clip(base * gain, 0, 1.4) / 1.4) ** 1.4 if False else np.clip(base * gain, 0, 1))
    rough = np.where(ismetal | cloth, rough, np.clip(rough * 0.82, 0.3, 1))
    base = np.where(green[..., None], np.clip(base0 * 1.12 + 0.06, 0, 1), base)     # the flames themselves stay bright
    # spared pieces: their own albedo under a light occlusion
    kc = clean[..., None]
    base = base * (1 - kc) + base0 * (0.72 + 0.28 * aoc[..., None]) * kc
    rough = rough * (1 - clean) + mr0[..., 1] * clean; metal = metal * (1 - clean) + mr0[..., 2] * clean
    base = np.clip(base, 0, 1)
    # normal map: rounded edges (bevel bake) combined with the kit's detail normals
    bcov = bev.sum(2) > 1e-4
    a = np.where((bcov & (clean < 0.5))[..., None], bev * 2 - 1, (0, 0, 1)); b = det * 2 - 1
    n = np.stack([a[..., 0] + b[..., 0], a[..., 1] + b[..., 1], a[..., 2] * b[..., 2]], -1)
    n /= np.linalg.norm(n, axis=2, keepdims=True) + 1e-9
    _set(imgs['base'], base)
    mr[..., 1] = rough; mr[..., 2] = metal
    _set(imgs['mr'], mr)
    if S >= 2048:                                            # metal / roughness carry no fine detail: half size
        imgs['mr'].scale(S // 2, S // 2); imgs['mr'].pack()
    _set(imgs['normal'], n * 0.5 + 0.5)
    print(f'[siege] exposure gain {gain:.2f} (median luminance {med:.3f})')
    print(f'[siege] weather {kit.name}: {S} px, ao mean {float(ao[cov].mean()):.2f}, rust stain {float((stain > 0.1).mean()) * 100:.1f}%, '
          f'edge {float((ed > 0.2).mean()) * 100:.1f}%, {time.time() - t0:.0f}s')
