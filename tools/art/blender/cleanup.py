"""Stage 3 (cleanup): raw TRELLIS GLB -> oriented, grounded, scaled, decimated LOD0/LOD1 with baked textures.

blender -b --factory-startup --python tools/art/blender/cleanup.py -- <id> [--yaw DEG]

In : art-work/mesh/<id>.glb  (TRELLIS.2 output, ~150k tris, 1024 atlas basecolor + MR)
Out: art-work/blend/<id>_clean.blend with objects  <id> (LOD0), <id>_lod1  and, for static kinds
     (prop / structure without a special builder / weapon), art-work/clean/<id>.glb + <id>_lod1.glb.

Steps: join -> drop floaters (<0.2 % of faces) -> yaw-align (min-area footprint rectangle; for humanoids the
A-pose arm span is the X axis) -> feet/base to z=0 at the footprint centre -> scale to the roster height ->
quadric-collapse decimate to the LOD budgets -> Smart-UV unwrap -> Cycles bake from the high mesh
(basecolour via emission, tangent-space normal, roughness/metal packed G/B) at 1024 (LOD1 uses 512 copies)
-> team-cloth segmentation (royal blue -> neutral grey + `_TEAM` vertex attribute + mask image).
"""
import math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np
from mathutils import Matrix, Vector

import art_lib as L

TEAM_HUE = (0.49, 0.74)   # HSV hue window for the prompt's "vivid royal blue" cloth (TRELLIS can drift it to teal)
TEAM_SAT = 0.32
TEAM_VAL = 0.10


def emit_rewire(mat, source):
    """Temporarily route a channel of the high-poly material into an Emission output for baking."""
    nt = mat.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    old = [(l.from_socket) for l in out.inputs['Surface'].links]
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    em = nt.nodes.new('ShaderNodeEmission'); em.name = '_bake_emit'
    if source == 'color':
        s = bsdf.inputs['Base Color']
        if s.is_linked:
            nt.links.new(s.links[0].from_socket, em.inputs['Color'])
        else:
            em.inputs['Color'].default_value = s.default_value
    else:
        key = {'rough': 'Roughness', 'metal': 'Metallic'}[source]
        s = bsdf.inputs[key]
        if s.is_linked:
            nt.links.new(s.links[0].from_socket, em.inputs['Color'])
        else:
            v = s.default_value
            em.inputs['Color'].default_value = (v, v, v, 1)
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return old


def emit_restore(mat, old):
    nt = mat.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    em = nt.nodes.get('_bake_emit')
    if em:
        nt.nodes.remove(em)
    if old:
        nt.links.new(old[0], out.inputs['Surface'])


def bake_to(high, low, img, btype, extrusion):
    mat = low.data.materials[0]
    nt = mat.node_tree
    for n in nt.nodes:
        n.select = False
    tn = nt.nodes.get('_bake_target') or nt.nodes.new('ShaderNodeTexImage')
    tn.name = '_bake_target'; tn.image = img; tn.select = True; nt.nodes.active = tn
    L.select_only(low, high)
    high.select_set(True); low.select_set(True)
    bpy.context.view_layer.objects.active = low
    sc = bpy.context.scene
    sc.render.bake.use_selected_to_active = True
    sc.render.bake.cage_extrusion = extrusion
    sc.render.bake.max_ray_distance = extrusion * 3
    sc.render.bake.margin = 6
    sc.render.bake.margin_type = 'EXTEND'
    if btype == 'NORMAL':
        sc.render.bake.normal_space = 'TANGENT'
        bpy.ops.object.bake(type='NORMAL')
    else:
        bpy.ops.object.bake(type='EMIT')


def team_mask(base_img):
    """Classify royal-blue team cloth in the baked basecolour; neutralise it to grey; return mask (h,w)."""
    px = L.img_np(base_img)
    rgb = px[:, :, :3]
    mx = rgb.max(2); mn = rgb.min(2); d = mx - mn + 1e-6
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) / 6.0
    s = d / (mx + 1e-6)
    hard = (h > TEAM_HUE[0]) & (h < TEAM_HUE[1]) & (s > TEAM_SAT) & (mx > TEAM_VAL)
    m = hard.astype(np.float32)
    # 3x3 open (remove speckle) then soft 5x5 blur
    def box(a, k):
        p = k // 2
        a2 = np.pad(a, p, mode='edge')
        c = np.cumsum(np.cumsum(a2, 0), 1)
        c = np.pad(c, ((1, 0), (1, 0)))
        return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)
    m = (box(m, 3) > 0.55).astype(np.float32)
    m = np.clip(box(m, 3) * 1.4, 0, 1)
    grey = np.clip(mx * 0.92 + 0.06, 0, 1)
    neutral = np.stack([grey] * 3, -1)
    rgb2 = rgb * (1 - m[..., None]) + neutral * m[..., None]
    px[:, :, :3] = rgb2
    L.np_img(base_img, px)
    return m


def vertex_team(ob, mask):
    """Average the mask over each vertex's loop UVs -> point float attribute `_TEAM`."""
    me = ob.data
    hh, ww = mask.shape
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    vi = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get('vertex_index', vi)
    x = np.clip((uv[:, 0] * ww).astype(int), 0, ww - 1)
    y = np.clip((uv[:, 1] * hh).astype(int), 0, hh - 1)
    val = mask[y, x]
    acc = np.zeros(len(me.vertices), np.float32); cnt = np.zeros(len(me.vertices), np.float32)
    np.add.at(acc, vi, val); np.add.at(cnt, vi, 1)
    t = acc / np.maximum(cnt, 1)
    if '_TEAM' in me.attributes:
        me.attributes.remove(me.attributes['_TEAM'])
    a = me.attributes.new('_TEAM', 'FLOAT', 'POINT')
    a.data.foreach_set('value', t)
    return float((t > 0.5).mean())


def decimate(ob, target):
    n = L.tris(ob)
    if n > target:
        m = ob.modifiers.new('dec', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = target / n * 0.985
        m.use_collapse_triangulate = True
        L.apply_mods(ob)
    return L.tris(ob)


def unwrap(ob, margin=0.004):
    L.select_only(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    try:
        bpy.ops.uv.pack_islands(rotate=True, margin=margin)
    except Exception:
        pass
    bpy.ops.object.mode_set(mode='OBJECT')


def prep_high(ob):
    L.select_only(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    for p in ob.data.polygons:
        p.use_smooth = True


def orient_weapon(ob, a):
    """Long axis -> +Z with the 'head' (wider end: blade guard side / axe head / spear tip) up, grip at origin.
    Grip: 'guard' = just below the widest slice (swords, lances); 'low' = 18 % from the narrow end (axes,
    staves); 'center' = middle (bows, tomes, shields)."""
    co = L.verts_np(ob)
    c = co.mean(0)
    u, s, vt = np.linalg.svd(co - c, full_matrices=False)
    ax = Vector(vt[0].tolist())
    rot = ax.rotation_difference(Vector((0, 0, 1))).to_matrix().to_4x4()
    ob.data.transform(rot @ Matrix.Translation(-Vector(c.tolist())))
    co = L.verts_np(ob)
    z = co[:, 2]; lo, hi = z.min(), z.max(); n = 40
    widths = []
    for k in range(n):
        sl = co[(z >= lo + (hi - lo) * k / n) & (z < lo + (hi - lo) * (k + 1) / n)]
        widths.append(0 if len(sl) < 3 else max(np.ptp(sl[:, 0]), np.ptp(sl[:, 1])))
    widths = np.array(widths)
    grip = a.get('grip', 'center')
    kmax = int(widths.argmax())
    # head up: polearms/axes have their widest slice (head) at the top; swords have it (the guard) low
    if (grip == 'low' and kmax < n / 2) or (grip == 'guard' and kmax >= n / 2):
        ob.data.transform(Matrix.Rotation(math.pi, 4, 'X'))
        widths = widths[::-1]; kmax = n - 1 - kmax
    if grip == 'guard':
        gz = (kmax - 1.5) / n          # just below the guard
        if a['id'] in ('weapon_sword', 'weapon_sword_lord'):
            gz = max(0.0, (kmax - 2.0) / n)
    elif grip == 'low':
        gz = a.get('grip_at', 0.18)
    else:
        gz = 0.5
    co = L.verts_np(ob); z = co[:, 2]; lo, hi = z.min(), z.max()
    s = a['length'] / (hi - lo)
    gzz = lo + gz * (hi - lo)
    ob.data.transform(Matrix.Diagonal((s, s, s, 1)) @ Matrix.Translation((-co[:, 0].mean(), -co[:, 1].mean(), -gzz)))
    ob.data.update()


LIFT = False
NO_REMESH = False      # vegetation: decimate the TRELLIS mesh directly first (voxel remesh shreds thin leaves + trunks)


def make_lod(high, name, budget, tex, height, use_team, voxel, save_mask=False, src=None):
    """Voxel-remesh (watertight, so quadric collapse reaches any budget) -> decimate -> unwrap -> bake from
    the TRELLIS high mesh -> material. `src` = start from an existing LOD instead of the high mesh."""
    sc = bpy.context.scene
    base_ob = src or high
    low = base_ob.copy(); low.data = base_ob.data.copy(); low.name = name; low.data.name = name
    low.modifiers.clear()
    sc.collection.objects.link(low)
    low.data.materials.clear()
    for k in list(low.data.uv_layers):
        low.data.uv_layers.remove(k)
    for an in ('custom_normal', 'sharp_edge', 'sharp_face', '_TEAM'):
        if an in low.data.attributes:
            low.data.attributes.remove(low.data.attributes[an])
    keep = low.data.copy()
    for attempt in range(4):
        # many tiny disconnected blobs (leaf clumps) stop quadric collapse early: coarsen the voxels and retry
        if src is None and not (NO_REMESH and attempt == 0):
            rm = low.modifiers.new('rm', 'REMESH'); rm.mode = 'VOXEL'; rm.voxel_size = voxel * (1.6 ** attempt)
            L.apply_mods(low)
            L.remove_floaters(low, 0.001)
        for k in range(3):
            n = decimate(low, budget)
            if n <= budget:
                break
        if n <= budget * 1.05 or src is not None or attempt == 3:
            break
        old_me = low.data; low.data = keep.copy(); bpy.data.meshes.remove(old_me)
    bpy.data.meshes.remove(keep)
    for p in low.data.polygons:
        p.use_smooth = True
    low.data.uv_layers.new(name='UVMap')
    unwrap(low, 0.006 if tex <= 512 else 0.004)
    base = L.new_image(f'{name}_base', tex)
    nrm = L.new_image(f'{name}_normal', tex, non_color=True)
    rough = L.new_image(f'{name}_rough_tmp', tex, non_color=True)
    metal = L.new_image(f'{name}_metal_tmp', tex, non_color=True)
    tmp = bpy.data.materials.new('_bake'); tmp.use_nodes = True
    low.data.materials.append(tmp)
    ext = max(0.01, 0.012 * height)
    hmat = high.data.materials[0]
    for img, what in ((base, 'color'), (rough, 'rough'), (metal, 'metal')):
        old = emit_rewire(hmat, what)
        bake_to(high, low, img, 'EMIT', ext)
        emit_restore(hmat, old)
    bake_to(high, low, nrm, 'NORMAL', ext)
    # pack MR at half size: G = roughness, B = metallic (glTF metallicRoughness layout)
    mr = L.new_image(f'{name}_mr', tex // 2, non_color=True)
    r_np = L.img_np(rough); m_np = L.img_np(metal)
    # TRELLIS paints stone/cloth with mid metalness; keep metal only where it is clearly metal (iron, steel, gold)
    mt = np.clip((m_np[:, :, 0] - 0.5) / 0.3, 0, 1); mt = mt * mt * (3 - 2 * mt)
    pk = np.ones_like(r_np); pk[:, :, 1] = r_np[:, :, 0]; pk[:, :, 2] = mt
    big = L.new_image('_mr_big', tex, non_color=True); L.np_img(big, pk)
    big.scale(tex // 2, tex // 2); L.np_img(mr, L.img_np(big)); bpy.data.images.remove(big)
    bpy.data.images.remove(rough); bpy.data.images.remove(metal)
    tf = 0.0
    if LIFT:
        # squads must read at RTS distance: lift dark TRELLIS albedo toward mid-grey (gamma 0.8, gain 1.1)
        px = L.img_np(base); px[..., :3] = np.clip(px[..., :3] ** 0.8 * 1.1, 0, 1); L.np_img(base, px)
    if use_team:
        mask = team_mask(base)
        tf = vertex_team(low, mask)
        if save_mask:
            mimg = L.new_image(f'{name}_team', mask.shape[0], non_color=True)
            mm = np.ones(mask.shape + (4,), np.float32); mm[..., 0] = mask; mm[..., 1] = mask; mm[..., 2] = mask
            L.np_img(mimg, mm)
            mimg.scale(256, 256)
            (L.WORK / 'clean').mkdir(parents=True, exist_ok=True)
            mimg.filepath_raw = str(L.WORK / 'clean' / f'{name}_team.png'); mimg.file_format = 'PNG'
            mimg.save()
    low.data.materials.clear()
    mat = L.build_material(f'{name}_mat', base, nrm, mr)
    if NO_REMESH:
        mat.use_backface_culling = False      # leaves are open sheets -> glTF doubleSided
    low.data.materials.append(mat)
    bpy.data.materials.remove(tmp)
    for img in (base, nrm, mr):
        img.pack()
    return low, L.tris(low), tf


def main():
    args = L.argv()
    aid = args[0]
    yaw_override = float(args[args.index('--yaw') + 1]) if '--yaw' in args else None
    a = L.assets()[aid]
    kind = a['kind']
    src = L.WORK / 'mesh' / f'{aid}.glb'
    L.clear()
    L.use_gpu()
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 2
    objs = L.import_glb(src)
    high = L.join_meshes(objs, f'{aid}_high')
    # the glTF importer splits vertices along UV seams: weld first so components are real surface pieces
    import bmesh
    bm = bmesh.new(); bm.from_mesh(high.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(high.data); bm.free()
    ncomp, nkill, dead = L.remove_floaters(high, 0.002)
    prep_high(high)
    print(f'[cleanup] {aid}: {L.tris(high)} tris, {ncomp} components, dropped {nkill} floaters ({dead} faces)')

    if kind == 'weapon':
        orient_weapon(high, a)
        height = a['length']
    else:
        co = L.verts_np(high)
        if yaw_override is not None:
            yaw = math.radians(yaw_override)
        elif kind == 'humanoid' or a.get('clipset'):
            # use the upper body (arms in A-pose) for the footprint rectangle
            z = co[:, 2]; zl, zh = z.min(), z.max()
            band = co[(z > zl + 0.45 * (zh - zl)) & (z < zl + 0.85 * (zh - zl))]
            yaw = L.best_yaw(band[:, :2], prefer_wide_x=True)
        elif kind in ('quadruped', 'mounted') or aid == 'dragon':
            # body length along Y: use the part below the wings (legs, body, tail) for the rectangle
            z = co[:, 2]; zl, zh = z.min(), z.max()
            body = co[z < zl + 0.45 * (zh - zl)]
            yaw = L.best_yaw(body[:, :2], prefer_wide_x=True) + math.pi / 2
            L.rotate_z(high, yaw)
            # the head end is the higher end: it must face -Y
            c2 = L.verts_np(high); y = c2[:, 1]; ln = y.max() - y.min()
            front = c2[y < y.min() + 0.2 * ln][:, 2].max(); back = c2[y > y.max() - 0.2 * ln][:, 2].max()
            if back > front:
                L.rotate_z(high, math.pi); yaw += math.pi
            yaw_done = True
        else:
            yaw = L.best_yaw(co[:, :2], prefer_wide_x=False)
        if not locals().get('yaw_done'):
            L.rotate_z(high, yaw)
        print(f"[cleanup] yaw {(math.degrees(yaw) + 180) % 360 - 180:.1f} deg")
        L.ground_and_scale(high, a['height'], length=a.get('length'), centre='feet' if (kind == 'humanoid' or a.get('clipset')) else 'bbox')
        if a.get('fit_xy'):
            # non-uniform footprint fit (bridge: span along Y = three.js Z), height scales with the span
            c3 = L.verts_np(high)
            if np.ptp(c3[:, 0]) > np.ptp(c3[:, 1]):
                L.rotate_z(high, math.pi / 2); c3 = L.verts_np(high)
            w, l = a['fit_xy']
            sx, sy = w / np.ptp(c3[:, 0]), l / np.ptp(c3[:, 1])
            high.data.transform(Matrix.Diagonal((sx, sy, sy, 1))); high.data.update()
            height = float(np.ptp(L.verts_np(high)[:, 2]))
        height = a['height']

    # ---- LOD0
    use_team = kind not in ('prop', 'weapon') or 'shield' in aid or bool(a.get('team'))
    # texture memory budget: 1024 for heroes / large / structures, 512 for squad units and props, 256 weapons
    global LIFT, NO_REMESH
    NO_REMESH = bool(a.get('no_remesh'))
    LIFT = bool(a.get('squad') or (a.get('part') and kind == 'humanoid'))
    tex = 512 if (a.get('squad') or kind in ('prop',)) else 1024
    if kind == 'weapon':
        tex = 256
    # triangle budgets in assets.json include the held weapons
    wl = [L.assets()[w] for w, _ in a.get('weapons', [])]
    b0 = a['lod0'] - sum(w['lod0'] for w in wl)
    b1 = a['lod1'] - sum(w['lod1'] for w in wl)
    voxel = max(np.ptp(L.verts_np(high), 0)) / a.get('voxel_div', 300)
    low, n0, tf = make_lod(high, aid, b0, tex, height, use_team, voxel, save_mask=True)
    # LOD1: decimate LOD0 (keeps thin walls); if that degenerates (furry meshes collapse into fans: too few
    # vertices per triangle) or misses the budget, rebuild from the high mesh via a coarser remesh
    l1, n1, _ = make_lod(high, f'{aid}_lod1', b1, max(256, tex // 2), height, use_team, voxel, src=low)
    nv = len(l1.data.vertices)
    if n1 > b1 * 1.05 or n1 > 2.3 * nv:
        print(f'[cleanup] {aid}: LOD1 from LOD0 degenerate ({n1} tris / {nv} verts) -> remesh path')
        old = l1; old.name = '_old_lod1'
        l1, n1, _ = make_lod(high, f'{aid}_lod1', b1, max(256, tex // 2), height, use_team, voxel * 2.5)
        bpy.data.objects.remove(old, do_unlink=True)
    for o in (low, l1):
        o['team_frac'] = tf
    print(f'[cleanup] {aid}: LOD0 {n0} tris, LOD1 {n1} tris, team cloth {tf * 100:.1f}% of verts')

    bpy.data.objects.remove(high, do_unlink=True)
    for m in list(bpy.data.materials):
        if m.users == 0:
            bpy.data.materials.remove(m)
    (L.WORK / 'blend').mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(L.WORK / 'blend' / f'{aid}_clean.blend'), compress=True)
    (L.WORK / 'clean').mkdir(parents=True, exist_ok=True)
    if kind in ('prop', 'weapon'):
        # props are final here (static, origin at base centre); weapons only feed rig.py
        dst = L.OUT if kind == 'prop' else L.WORK / 'clean'
        dst.mkdir(parents=True, exist_ok=True)
        low.name = aid
        L.export_glb(dst / f'{aid}.glb', [low])
        L.export_glb(dst / f'{aid}_lod1.glb', [l1])
        import json
        (L.WORK / 'clean' / f'{aid}.json').write_text(json.dumps(dict(id=aid, height=height, tris_lod0=n0, tris_lod1=n1,
                                                                          team_frac=tf), indent=1))
    print('[cleanup] done', aid)


if __name__ == '__main__':
    main()
