"""Stage 3 (cleanup): raw TRELLIS GLB -> oriented, grounded, scaled, decimated LOD0/LOD1 with baked textures.

blender -b --factory-startup --python tools/art/blender/cleanup.py -- <id> [--yaw DEG]
blender -b --factory-startup --python tools/art/blender/cleanup.py -- <id> --regrade     (re-apply assets.json `grade`
                                                         to the saved bake, no GPU re-bake)

In : art-work/mesh/<id>.glb  (TRELLIS.2 output, ~150k tris, 1024 atlas basecolor + MR)
Out: art-work/blend/<id>_clean.blend with objects  <id> (LOD0), <id>_lod1  and, for static kinds
     (prop / structure without a special builder / weapon), art-work/clean/<id>.glb + <id>_lod1.glb.

Steps: join -> drop floaters (<0.2 % of faces) -> yaw-align (min-area footprint rectangle; for humanoids the
A-pose arm span is the X axis) -> feet/base to z=0 at the footprint centre -> scale to the roster height ->
quadric-collapse decimate to the LOD budgets -> Smart-UV unwrap -> Cycles bake from the high mesh
(basecolour via emission, tangent-space normal, roughness/metal packed G/B) at 1024 (LOD1 uses 512 copies)
-> team-cloth segmentation (royal blue -> neutral grey + `_TEAM` vertex attribute + mask image).
"""
import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy, bmesh
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
    hue_ok = (h > TEAM_HUE[0]) & (h < TEAM_HUE[1])
    if TEAM_HUE[1] > 1.0:                          # a window that wraps through red (magenta-keyed factions: TRELLIS drifts magenta to crimson)
        hue_ok |= h < TEAM_HUE[1] - 1.0
    hard = hue_ok & (s > TEAM_SAT) & (mx > TEAM_VAL)
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


def solid_mesh(high, vox):
    """A closed, SOLID stand-in for a TRELLIS mesh, as mesh data. TRELLIS surfaces are thin open shells (fur
    tufts, kilts, hollow limbs): Blender's voxel remesh keeps them as double-walled sheets, and at crowd-LOD
    triangle counts those collapse into shards with whole limbs missing (the berserker). Here the surface is
    voxelised, the outside is flood-filled from the grid border and everything else is kept -- limbs and torso
    come out filled -- then the blocky hull is re-meshed smooth."""
    me = high.data
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    idx = np.empty(nt * 3, np.int32); me.loop_triangles.foreach_get('vertices', idx)
    tri = L.verts_np(high)[idx.reshape(-1, 3)]
    area = np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
    rng = np.random.default_rng(11)
    n = 800000
    pick = rng.choice(nt, n, p=area / area.sum())
    r1 = np.sqrt(rng.random(n)); r2 = rng.random(n)
    t = tri[pick]
    pts = (1 - r1)[:, None] * t[:, 0] + (r1 * (1 - r2))[:, None] * t[:, 1] + (r1 * r2)[:, None] * t[:, 2]
    lo = pts.min(0) - 3 * vox
    dim = np.ceil((pts.max(0) - lo) / vox).astype(int) + 4
    occ = np.zeros(dim, bool)
    ijk = ((pts - lo) / vox).astype(int)
    occ[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True

    def dil(a):
        b = a.copy()
        b[1:] |= a[:-1]; b[:-1] |= a[1:]
        b[:, 1:] |= a[:, :-1]; b[:, :-1] |= a[:, 1:]
        b[:, :, 1:] |= a[:, :, :-1]; b[:, :, :-1] |= a[:, :, 1:]
        return b
    wall = dil(occ)                                    # close pin-holes in the surface
    out = np.zeros(dim, bool)
    out[0] = out[-1] = True; out[:, 0] = out[:, -1] = True; out[:, :, 0] = out[:, :, -1] = True
    out &= ~wall
    while True:
        nxt = dil(out) & ~wall
        if nxt.sum() == out.sum():
            break
        out = nxt
    solid = ~out
    solid = ~dil(~solid) | occ                         # take the closing layer back off, never the surface itself
    verts, faces = [], []
    quads = {0: ((0, 0), (1, 0), (1, 1), (0, 1))}
    for ax in range(3):
        for sgn in (1, -1):
            nb = np.zeros_like(solid)
            src = [slice(None)] * 3; dst = [slice(None)] * 3
            if sgn > 0:
                src[ax] = slice(1, None); dst[ax] = slice(None, -1)
            else:
                src[ax] = slice(None, -1); dst[ax] = slice(1, None)
            nb[tuple(dst)] = solid[tuple(src)]
            c = np.argwhere(solid & ~nb)
            if not len(c):
                continue
            o1, o2 = [a for a in range(3) if a != ax]
            for (a, b) in quads[0]:
                v = c.copy()
                v[:, ax] += 1 if sgn > 0 else 0
                v[:, o1] += a; v[:, o2] += b
                verts.append(v)
            faces.append(len(c))
    # verts list is grouped per direction as 4 corner arrays; build quads with shared vertices
    allv = []; quad_idx = []; base = 0; k = 0
    for cnt in faces:
        corners = verts[k:k + 4]; k += 4
        allv.extend(corners)
        ids = [base + i * cnt + np.arange(cnt) for i in range(4)]
        quad_idx.append(np.stack(ids, 1)); base += 4 * cnt
    allv = np.concatenate(allv); quad_idx = np.concatenate(quad_idx)
    key = (allv[:, 0].astype(np.int64) * (dim[1] + 2) + allv[:, 1]) * (dim[2] + 2) + allv[:, 2]
    uniq, first, inv = np.unique(key, return_index=True, return_inverse=True)
    vco = allv[first] * vox + lo
    mesh = bpy.data.meshes.new('_solid')
    mesh.from_pydata(vco.tolist(), [], inv[quad_idx].tolist())
    mesh.update()
    ob = bpy.data.objects.new('_solid', mesh)
    bpy.context.scene.collection.objects.link(ob)
    L.select_only(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    rm = ob.modifiers.new('rm', 'REMESH'); rm.mode = 'VOXEL'; rm.voxel_size = vox * 0.8; rm.use_smooth_shade = True
    sm = ob.modifiers.new('sm', 'SMOOTH'); sm.factor = 0.6; sm.iterations = 4
    L.apply_mods(ob)
    out_me = ob.data
    bpy.data.objects.remove(ob, do_unlink=True)
    return out_me


def orient_scale(high, a, yaw_override=None):
    """Yaw-align (per kind), ground at the footprint centre and scale to the roster height."""
    aid = a['id']; kind = a['kind']
    co = L.verts_np(high)
    yaw_done = False
    if yaw_override is not None:
        yaw = math.radians(yaw_override)
    elif a.get('align') is False:
        yaw = 0.0
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
    if not yaw_done:
        L.rotate_z(high, yaw)
    if a.get('fix_yaw'):                                  # assets.json `fix_yaw` (degrees): added after the automatic alignment
        L.rotate_z(high, math.radians(a['fix_yaw']))
    print(f"[cleanup] {aid}: yaw {(math.degrees(yaw) + 180) % 360 - 180:.1f} deg")
    L.ground_and_scale(high, a['height'], length=a.get('length'), centre='feet' if (kind == 'humanoid' or a.get('clipset')) else 'bbox')
    if a.get('fit_xy'):
        # non-uniform footprint fit (bridge: span along Y = three.js Z), height scales with the span
        c3 = L.verts_np(high)
        if np.ptp(c3[:, 0]) > np.ptp(c3[:, 1]):
            L.rotate_z(high, math.pi / 2); c3 = L.verts_np(high)
        w, l = a['fit_xy']
        sx, sy = w / np.ptp(c3[:, 0]), l / np.ptp(c3[:, 1])
        high.data.transform(Matrix.Diagonal((sx, sy, sy, 1))); high.data.update()
    if a.get('feet_span'):
        # quadrupeds whose rig joints are authored in metres (creatures.json): scale so the fore and hind feet
        # stand `feet_span` apart and the fore feet at y = `fore_y`, whatever the howdah / horns do to the height
        H = a['height']
        co = L.verts_np(high)
        low = co[co[:, 2] < 0.04 * H]
        ym = 0.5 * (low[:, 1].min() + low[:, 1].max())
        f, h = low[low[:, 1] < ym][:, 1].mean(), low[low[:, 1] >= ym][:, 1].mean()
        k = a['feet_span'] / (h - f)
        high.data.transform(Matrix.Diagonal((k, k, k, 1)))
        co = L.verts_np(high); low = co[co[:, 2] < 0.04 * H * k]
        f = low[low[:, 1] < 0.5 * (low[:, 1].min() + low[:, 1].max())][:, 1].mean()
        xm = 0.5 * (low[:, 0].min() + low[:, 0].max())
        high.data.transform(Matrix.Translation((-xm, a.get('fore_y', -0.45) - f, 0)))
        high.data.update()
        print(f'[cleanup] {aid}: feet-span scale {k:.3f}')


def load_high(aid):
    """art-work/mesh/<id>.glb -> one welded, floater-free, smooth-shaded object (still in TRELLIS space)."""
    import bmesh
    objs = L.import_glb(L.WORK / 'mesh' / f'{aid}.glb')
    high = L.join_meshes(objs, f'{aid}_high')
    # the glTF importer splits vertices along UV seams: weld first so components are real surface pieces
    bm = bmesh.new(); bm.from_mesh(high.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(high.data); bm.free()
    ncomp, nkill, dead = L.remove_floaters(high, 0.002)
    prep_high(high)
    print(f'[cleanup] {aid}: {L.tris(high)} tris, {ncomp} components, dropped {nkill} floaters ({dead} faces)')
    return high


LIFT = False
HUE_MAP = None
METAL_TRUST = True   # False for meshes of the 1024 texture flow (see trellis_metal); assets.json `metal_trust` overrides


def trellis_metal(m):
    """Baked TRELLIS metalness -> the metal we ship. The 512 flow paints stone / cloth with mid metalness, so only
    clearly metallic texels (> 0.5..0.8) are kept. The 1024 texture flow's metal channel is NOT usable: it is 0.6-1.0
    on cloth, skin and metal alike (the Archmage's robes came out fully metallic = black in the engine, which has no
    environment map), so for those meshes metal is 0 -- what v2's 512 bakes effectively were (mean 0.02)."""
    mt = np.clip((m - 0.5) / 0.3, 0, 1); mt = mt * mt * (3 - 2 * mt)
    frac = float((mt > 0.5).mean())
    if not METAL_TRUST:
        print(f'[cleanup] metal channel ignored (1024 texture flow; {frac * 100:.0f}% of texels read as metal)', flush=True)
        return np.zeros_like(mt)
    return mt


METAL_MAX = 1.0      # assets.json `metal_max`: heroes keep their MR map in the engine, and with no environment map full metal renders black (gold-heavy Sun Caliphate heroes)
MASK_SIZE = 256        # team mask file size (tex_cfg: 1024 for the hero tier)
UNSHARP = None
NO_REMESH = False      # vegetation: decimate the TRELLIS mesh directly first (voxel remesh shreds thin leaves + trunks)


def make_lod(high, name, budget, tex, height, use_team, voxel, save_mask=False, src=None, solid=False, box=False):
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
    if solid:
        old_me = low.data; low.data = solid_mesh(high, voxel); bpy.data.meshes.remove(old_me)
        src = low                                        # skip the remesh loop below: just decimate
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
    if box:                                              # LOD0: box projection (remodel v3); LOD1 keeps smart project
        unwrap_box(low, 0.006 if tex <= 512 else 0.003, scale=max(1024, tex))
    else:
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
    mt = trellis_metal(m_np[:, :, 0])
    pk = np.ones_like(r_np); pk[:, :, 1] = r_np[:, :, 0]; pk[:, :, 2] = mt * METAL_MAX
    big = L.new_image('_mr_big', tex, non_color=True); L.np_img(big, pk)
    big.scale(tex // 2, tex // 2); L.np_img(mr, L.img_np(big)); bpy.data.images.remove(big)
    bpy.data.images.remove(rough); bpy.data.images.remove(metal)
    tf = 0.0
    if LIFT:
        # squads must read at RTS distance: lift dark TRELLIS albedo toward mid-grey (gamma 0.8, gain 1.1)
        px = L.img_np(base); px[..., :3] = np.clip(px[..., :3] ** 0.8 * 1.1, 0, 1); L.np_img(base, px)
    if HUE_MAP:
        apply_hue_map(base, HUE_MAP)                     # (TRELLIS returns the Ashen Covenant's green soul-fire as cyan)
    if box:
        unsharp(base, UNSHARP)
    if use_team:
        mask = team_mask(base)
        tf = vertex_team(low, mask)
        if save_mask:
            mimg = L.new_image(f'{name}_team', mask.shape[0], non_color=True)
            mm = np.ones(mask.shape + (4,), np.float32); mm[..., 0] = mask; mm[..., 1] = mask; mm[..., 2] = mask
            L.np_img(mimg, mm)
            mimg.scale(MASK_SIZE, MASK_SIZE)
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


def grade(a, low):
    """Albedo / team-mask grading of the LOD0 bake, driven by assets.json `grade` (all optional):
      lift [gamma, gain]   brighten a dark TRELLIS bake (wyvern, dragon read near-black in the engine)
      sat  factor          saturation
      fur  {to, val, sat, team, zmin, grey, region}  bright unsaturated non-metal texels (white fur) -> colour `to`,
           keeping the fur's shading; above zmin (fraction of the height: the mantle, not the boot trim) the
           pelt instead becomes a neutral grey with team mask `team`, so the unit shows its colour from behind
      mask_open k          drop team-mask blobs narrower than ~k texels (blue-white shadow speckle on white
           coats showed as team-coloured static on the horses)
    Only LOD0 is graded: crowd atlases and every shipped texture are baked from LOD0."""
    g = a.get('grade')
    if not g:
        return None
    aid = a['id']; H = a['height']
    base = bpy.data.images[f'{aid}_base']
    px = L.img_np(base); h, w = px.shape[:2]
    rgb = px[..., :3].copy()
    mpath = L.WORK / 'clean' / f'{aid}_team.png'
    mask = L.load_gray(mpath, w, h) if mpath.exists() else np.zeros((h, w), np.float32)
    f32 = np.float32
    if g.get('mask_open'):
        k = int(g['mask_open'])
        core = L.box_blur((mask > 0.5).astype(f32), k) > 0.55
        mask = mask * (L.box_blur(core.astype(f32), k + 2) > 0.02)
    if 'fur' in g:
        f = g['fur']
        mr = bpy.data.images.get(f'{aid}_mr')
        metal = np.zeros((h, w), f32)
        if mr is not None:
            m = L.img_np(mr)[:, :, 2]
            metal = np.kron(m, np.ones((h // m.shape[0], w // m.shape[1]), f32))
        mx = rgb.max(2); mn = rgb.min(2); sat = (mx - mn) / (mx + 1e-6)
        sel = (mx > f.get('val', 0.5)) & (sat < f.get('sat', 0.25)) & (mask < 0.3) & (metal < 0.3)
        if f.get('region'):
            # `region` {ymin (m, +y = the unit's back), zmin, zmax (fractions of the height)}: only that part of the
            # body, e.g. the back of a mantle, so a unit with no team cloth behind shows its colour to the RTS camera
            R = f['region']; co = L.verts_np(low)
            yy = L.raster_attr(low, co[:, 1], w, h); zz = L.raster_attr(low, co[:, 2] / H, w, h)
            sel &= (yy >= R.get('ymin', -1e9)) & (zz >= R.get('zmin', -1e9)) & (zz <= R.get('zmax', 1e9))
        sel = L.box_blur(sel.astype(f32), 3) > 0.4
        if sel.any():
            lum = rgb.mean(2); ref = float(np.median(lum[sel]))
            shade = np.clip(lum / ref, 0.45, 1.3)
            soft = L.box_blur(sel.astype(f32), 3)[..., None]
            rgb = rgb * (1 - soft) + np.array(f['to'], f32) * shade[..., None] * soft
            if f.get('team'):
                z = L.raster_attr(low, L.verts_np(low)[:, 2] / H, w, h)
                hi = L.box_blur((sel & (z >= f.get('zmin', 0.5))).astype(f32), 3)
                rgb = rgb * (1 - hi[..., None]) + np.clip(f.get('grey', 0.6) * shade, 0, 1)[..., None] * hi[..., None]
                mask = np.maximum(mask, f['team'] * hi)
            print(f"[cleanup] grade fur: {sel.mean() * 100:.1f}% of the atlas recoloured")
    if 'lift' in g:
        gamma, gain = g['lift']
        rgb = np.clip(rgb ** gamma * gain, 0, 1)
    if 'sat' in g:
        l = rgb.mean(2, keepdims=True)
        rgb = np.clip(l + (rgb - l) * g['sat'], 0, 1)
    px[..., :3] = rgb
    L.np_img(base, px); base.pack()
    b1 = bpy.data.images.get(f'{aid}_lod1_base')
    if b1 is not None and tier(a) == 'hero' and ('lift' in g or 'sat' in g):
        # the low tier draws a hero's LOD1 (own atlas): same lift / saturation there
        p1 = L.img_np(b1); c1 = p1[..., :3]
        if 'lift' in g:
            c1 = np.clip(c1 ** g['lift'][0] * g['lift'][1], 0, 1)
        if 'sat' in g:
            l1 = c1.mean(2, keepdims=True); c1 = np.clip(l1 + (c1 - l1) * g['sat'], 0, 1)
        p1[..., :3] = c1; L.np_img(b1, p1); b1.pack()
    L.save_gray(mask, mpath, MASK_SIZE, MASK_SIZE)
    tf = L.set_team_attr(low, mask)
    low['team_frac'] = tf
    print(f'[cleanup] grade {aid}: albedo mean {rgb.reshape(-1, 3).mean(0).round(3)}, team cloth {tf * 100:.1f}% of verts')
    return tf


def regrade(aid):
    """Grade from the untouched bake: the first call keeps `<id>_clean.orig.blend` + `<id>_team.orig.png`."""
    import shutil
    global MASK_SIZE
    a = L.assets()[aid]
    MASK_SIZE = tex_cfg(a)['mask']
    blend = L.WORK / 'blend' / f'{aid}_clean.blend'; orig = L.WORK / 'blend' / f'{aid}_clean.orig.blend'
    mask = L.WORK / 'clean' / f'{aid}_team.png'; morig = L.WORK / 'clean' / f'{aid}_team.orig.png'
    if not orig.exists():
        shutil.copyfile(blend, orig)
        if mask.exists():
            shutil.copyfile(mask, morig)
    bpy.ops.wm.open_mainfile(filepath=str(orig))
    if morig.exists():
        shutil.copyfile(morig, mask)
    grade(a, bpy.data.objects[aid])
    bpy.ops.wm.save_as_mainfile(filepath=str(blend), compress=True)


# =============================================================================================== remodel v3
# The War Elephant A/B test (docs/ART.md section 10): what blurred the v2 models was mostly the unwrap (smart
# project shreds a bumpy TRELLIS surface into thousands of crumbs), the 512 TRELLIS run and the 1024 atlas.
def tier(a):
    """`hero` (Lords, large units, heroes and their rider / mount parts) | `squad` | `weapon` | `prop`.
    assets.json `tier` overrides; a `part` belongs to the squad tier unless it says otherwise."""
    if a.get('tier'):
        return a['tier']
    if a['kind'] in ('weapon', 'prop'):
        return a['kind']
    return 'squad' if (a.get('squad') or a.get('part')) else 'hero'


def tex_cfg(a):
    """Texture sizes and sharpening per tier; assets.json `tex`, `tex_lod1`, `mask`, `unsharp` override."""
    t = tier(a)
    d = dict(hero=dict(tex=2048, tex_lod1=512, mask=1024, unsharp=[2, 0.6]),
             squad=dict(tex=512, tex_lod1=256, mask=256, unsharp=[1, 0.35]),
             prop=dict(tex=512, tex_lod1=256, mask=256, unsharp=[1, 0.35]),
             weapon=dict(tex=256, tex_lod1=256, mask=256, unsharp=None))[t]
    if a.get('tex') and 'unsharp' not in a:
        d['unsharp'] = [2, 0.6] if a['tex'] >= 2048 else [1.5, 0.5] if a['tex'] >= 1024 else d['unsharp']
    for k in d:
        if k in a:
            d[k] = a[k]
    return d


def box_unwrap(ob, smooth=10):
    """Planar projection along the dominant axis of a SMOOTHED normal field: a few hundred large islands at a
    uniform texel density instead of smart-project's thousands of crumbs on a bumpy TRELLIS surface."""
    import bmesh
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table()
    N = np.array([f.normal[:] for f in bm.faces], np.float32)
    A = np.array([f.calc_area() for f in bm.faces], np.float32)
    pairs = np.array([(e.link_faces[0].index, e.link_faces[1].index) for e in bm.edges if len(e.link_faces) == 2], np.int64).reshape(-1, 2)
    S = N * A[:, None]
    for _ in range(smooth):
        acc = S.copy()
        np.add.at(acc, pairs[:, 0], S[pairs[:, 1]]); np.add.at(acc, pairs[:, 1], S[pairs[:, 0]])
        S = acc / (np.linalg.norm(acc, axis=1, keepdims=True) + 1e-12) * A[:, None]
    D = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], np.float32)
    lab = (S @ D.T).argmax(1)
    for _ in range(6):                                  # majority filter: remove speckle between regions
        cnt = np.zeros((len(N), 6), np.float32)
        np.add.at(cnt, (pairs[:, 0], lab[pairs[:, 1]]), 1); np.add.at(cnt, (pairs[:, 1], lab[pairs[:, 0]]), 1)
        cnt[np.arange(len(N)), lab] += 0.5
        lab = cnt.argmax(1)
    bad = (N * D[lab]).sum(1) < 0.2                     # a face seen edge-on / from behind: use its own axis
    lab[bad] = (N[bad] @ D.T).argmax(1)
    uvl = bm.loops.layers.uv.verify()
    AX = {0: (1, 2, 1), 1: (1, 2, -1), 2: (0, 2, -1), 3: (0, 2, 1), 4: (0, 1, 1), 5: (0, 1, -1)}
    for f in bm.faces:
        a, b, sg = AX[int(lab[f.index])]
        for l in f.loops:
            co = l.vert.co
            l[uvl].uv = (co[a] * sg * 0.05 + 0.5 + 0.37 * int(lab[f.index]), co[b] * 0.05 + 0.5)
    bm.to_mesh(me); bm.free()
    return np.bincount(lab, minlength=6).tolist(), int(bad.sum())


def overlap_faces(ob, scale=2048):
    """Polygons whose box-projected UVs land on texels another polygon already covers (folds inside an island)."""
    me = ob.data
    me.calc_loop_triangles()
    uv = np.empty(len(me.loops) * 2, np.float32); me.uv_layers.active.data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
    nt = len(me.loop_triangles)
    tl = np.empty(nt * 3, np.int32); me.loop_triangles.foreach_get('loops', tl); tl = tl.reshape(-1, 3)
    tp = np.empty(nt, np.int32); me.loop_triangles.foreach_get('polygon_index', tp)
    lo = uv.min(0); P = (uv - lo) * scale
    W, H = (np.ceil(P.max(0)).astype(int) + 2)
    cnt = np.zeros((H, W), np.int16)
    cover = []
    for t in tl:
        p = P[t]
        x0, y0 = np.floor(p.min(0)).astype(int); x1, y1 = np.ceil(p.max(0)).astype(int) + 1
        d = (p[1, 1] - p[2, 1]) * (p[0, 0] - p[2, 0]) + (p[2, 0] - p[1, 0]) * (p[0, 1] - p[2, 1])
        if abs(d) < 1e-9:
            cover.append(None); continue
        xs, ys = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        a = ((p[1, 1] - p[2, 1]) * (xs - p[2, 0]) + (p[2, 0] - p[1, 0]) * (ys - p[2, 1])) / d
        b = ((p[2, 1] - p[0, 1]) * (xs - p[2, 0]) + (p[0, 0] - p[2, 0]) * (ys - p[2, 1])) / d
        yy, xx = np.nonzero((a > 0.03) & (b > 0.03) & (a + b < 0.97))
        idx = (yy + y0, xx + x0)
        cnt[idx] += 1
        cover.append(idx)
    bad = set()
    for i, idx in enumerate(cover):
        if idx is not None and len(idx[0]) and (cnt[idx] > 1).any():
            bad.add(int(tp[i]))
    return bad


def unwrap_box(ob, margin=0.003, pack=True, scale=2048):
    """Box projection, pack (so separate islands stop sharing texels), then only the polygons that still
    overlap -- folds inside one island -- are smart-projected. Uniform texel density. `pack` = final pack into
    0..1 (a unit of several parts packs once after joining instead)."""
    labels, edge_on = box_unwrap(ob)
    L.select_only(ob)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_mode(type='FACE')
    bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=False, margin=0.003, scale=True)
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    bad = overlap_faces(ob, scale)
    sel = np.zeros(len(ob.data.polygons), bool); sel[list(bad)] = True
    ob.data.polygons.foreach_set('select', sel)
    bpy.ops.object.mode_set(mode='EDIT')
    if bad:
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.average_islands_scale()
    if pack:
        pack_uv(margin)
    elif bad:                                            # the re-projected remnants must not sit on the box islands
        bpy.ops.uv.pack_islands(rotate=False, margin=0.003, scale=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    print(f'[cleanup] {ob.name}: box unwrap, labels {labels}, {edge_on} edge-on faces, {len(bad)} of {len(sel)} polygons overlapped -> smart-projected')


def pack_uv(margin, merge=False, rotate=True):
    """Edit mode, everything selected. `merge`: islands that overlap stay stacked (the instances of authored
    parts -- mirrored flanks, repeated tassels, flipped cloth backs -- keep sharing their texels)."""
    try:
        bpy.ops.uv.pack_islands(rotate=rotate, margin=margin, scale=True, shape_method='CONCAVE', margin_method='FRACTION', merge_overlap=merge)
    except TypeError:
        bpy.ops.uv.pack_islands(rotate=True, margin=margin)


def blur3(a, r):
    for _ in range(3):
        a = L.box_blur(a, 2 * r + 1)
    return a


def unsharp(base, us, keep=None):
    """Light unsharp mask on the albedo ([radius px, amount]); `keep` [h, w] = texels to leave alone (authored art)."""
    if not us:
        return
    px = L.img_np(base); rgb = px[..., :3]
    r = max(1, int(round(us[0])))
    soft = np.stack([blur3(rgb[..., i], r) for i in range(3)], -1)
    out = np.clip(rgb + us[1] * (rgb - soft), 0, 1)
    if keep is not None:
        out = out * (1 - keep[..., None]) + rgb * keep[..., None]
    px[..., :3] = out; L.np_img(base, px)


def apply_hue_map(base, hm):
    """assets.json `hue_map` [[lo, hi, to], ...]: saturated texels with a hue in lo..hi move to hue `to`."""
    px = L.img_np(base); rgb = px[..., :3]
    mx = rgb.max(2); mn = rgb.min(2); d = mx - mn + 1e-6
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) / 6.0
    s = d / (mx + 1e-6)
    for lo, hi, to in hm:
        k = np.clip((s - 0.18) / 0.12, 0, 1) * ((h > lo) & (h < hi))
        h6 = to * 6.0; c = mx * s; x = c * (1 - abs(h6 % 2 - 1)); m0 = mx - c
        tri = [(c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x)][int(h6) % 6]
        new = np.stack([np.zeros_like(mx) + t + m0 for t in tri], -1)
        rgb[...] = rgb * (1 - k[..., None]) + new * k[..., None]
    L.np_img(base, px)


# ---- units assembled from parts ---------------------------------------------------------------------------
def place(ob, inst):
    s = inst.get('scale', 1.0)
    if inst.get('matrix'):                              # `hold` parts: the weapon-frame -> unit-space matrix rig.py wrote
        ob.data.transform(Matrix(inst['matrix']) @ Matrix.Diagonal((s, s, s, 1)))
        ob.data.update()
        return
    ob.data.transform(Matrix.Translation(inst.get('pos', (0, 0, 0))) @ Matrix.Rotation(math.radians(inst.get('yaw', 0)), 4, 'Z') @ Matrix.Diagonal((s, s, s, 1)))
    ob.data.update()


def dup(ob, name):
    c = ob.copy(); c.data = ob.data.copy(); c.name = name; c.data.name = name
    bpy.context.scene.collection.objects.link(c)
    return c


def strip_low(low):
    low.data.materials.clear()
    for k in list(low.data.uv_layers):
        low.data.uv_layers.remove(k)
    for an in ('custom_normal', 'sharp_edge', 'sharp_face', '_TEAM'):
        if an in low.data.attributes:
            low.data.attributes.remove(low.data.attributes[an])


def low_of(high, name, budget, voxel, direct=False):
    """LOD0 of one TRELLIS part: voxel remesh (watertight, ~1 cm) -> quadric collapse; `direct` tries the
    collapse without the remesh first (keeps thin detail, but open TRELLIS shells often stall above the budget)."""
    low = dup(high, name)
    strip_low(low)
    keep = low.data.copy()
    for attempt in range(0 if direct else 1, 5):
        if attempt > 0:
            rm = low.modifiers.new('rm', 'REMESH'); rm.mode = 'VOXEL'; rm.voxel_size = voxel * (1.6 ** (attempt - 1))
            L.apply_mods(low); L.remove_floaters(low, 0.001)
        for k in range(3):
            n = decimate(low, budget)
            if n <= budget:
                break
        nv = len(low.data.vertices)
        print(f'[cleanup] {name}: attempt {attempt} ({"direct" if attempt == 0 else f"voxel {voxel * 1.6 ** (attempt - 1) * 100:.1f} cm"}) -> {n} tris (budget {budget})')
        if (n <= budget * 1.05 and n < 2.3 * nv) or attempt == 4:
            break
        old = low.data; low.data = keep.copy(); bpy.data.meshes.remove(old)
    bpy.data.meshes.remove(keep)
    for p in low.data.polygons:
        p.use_smooth = True
    return low


def set_attr(me, name, domain, value):
    if name in me.attributes:
        me.attributes.remove(me.attributes[name])
    n = len(me.vertices) if domain == 'POINT' else len(me.polygons)
    me.attributes.new(name, 'FLOAT', domain).data.foreach_set('value', np.full(n, value, np.float32))


def get_attr(me, name, domain='POINT'):
    n = len(me.vertices) if domain == 'POINT' else len(me.polygons)
    v = np.zeros(n, np.float32)
    if name in me.attributes:
        me.attributes[name].data.foreach_get('value', v)
    return v


def rewire_extra(mat, what):
    """Bake passes that only authored parts answer: `team` = their own team mask, `auth` = 1 (marks their texels)."""
    nt = mat.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    old = [l.from_socket for l in out.inputs['Surface'].links]
    em = nt.nodes.new('ShaderNodeEmission'); em.name = '_bake_emit'
    v = 0.0
    if what == 'auth':
        v = 1.0 if mat.get('authored') else 0.0
    elif mat.get('team_image') and mat['team_image'] in bpy.data.images:
        t = nt.nodes.new('ShaderNodeTexImage'); t.name = '_bake_team'; t.image = bpy.data.images[mat['team_image']]
        nt.links.new(t.outputs['Color'], em.inputs['Color']); v = None
    if v is not None:
        em.inputs['Color'].default_value = (v, v, v, 1)
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return old


def restore_extra(mat, old):
    t = mat.node_tree.nodes.get('_bake_team')
    if t:
        mat.node_tree.nodes.remove(t)
    emit_restore(mat, old)


def front_only(ob):
    """Authored thin cloth carries flipped back faces (the lining) in the same place as the front faces. Remove the
    second face of every coincident pair (the kit appends the backs after the fronts) -> faces removed."""
    bm = bmesh.new(); bm.from_mesh(ob.data); bm.faces.ensure_lookup_table()
    seen = {}; dead = []
    for f in bm.faces:
        k = tuple(sorted((round(v.co.x, 4), round(v.co.y, 4), round(v.co.z, 4)) for v in f.verts))
        if k in seen:
            dead.append(f)
        else:
            seen[k] = f
    n = len(dead)
    if n:
        bmesh.ops.delete(bm, geom=dead, context='FACES')
        bm.to_mesh(ob.data)
    bm.free()
    return n


def bake_unit(highs, low, tex, ext, authored, copies=None):
    """Bake basecolour / roughness / metal / tangent normal (+ the authored parts' team mask and coverage) from
    every high object onto the joined low mesh. Returns (base, normal, mr, auth_team [h,w] | None, auth [h,w] | None)."""
    sc = bpy.context.scene
    mk = lambda n, nc=True: L.new_image(n, tex, non_color=nc)
    base = mk(f'{low.name}_base', False); nrm = mk(f'{low.name}_normal')
    rough = mk('_r'); metal = mk('_m')
    mats = list({m.name: m for h in highs for m in h.data.materials if m}.values())
    slots = [m for m in low.data.materials]

    def bake(img, btype):
        for tmp in slots:
            nt = tmp.node_tree
            for n in nt.nodes:
                n.select = False
            tn = nt.nodes.get('_bake_target') or nt.nodes.new('ShaderNodeTexImage')
            tn.name = '_bake_target'; tn.image = img; tn.select = True; nt.nodes.active = tn
        L.select_only(low, *highs)
        for h in highs:
            h.select_set(True)
        low.select_set(True); bpy.context.view_layer.objects.active = low
        b = sc.render.bake
        b.use_selected_to_active = True; b.cage_extrusion = ext; b.max_ray_distance = ext * 3
        b.margin = 8 if tex >= 1024 else 6; b.margin_type = 'EXTEND'
        if btype == 'NORMAL':
            b.normal_space = 'TANGENT'; bpy.ops.object.bake(type='NORMAL')
        else:
            bpy.ops.object.bake(type='EMIT')
    for img, what in ((base, 'color'), (rough, 'rough'), (metal, 'metal')):
        olds = [emit_rewire(m, what) for m in mats]
        bake(img, 'EMIT')
        for m, o in zip(mats, olds):
            emit_restore(m, o)
    bake(nrm, 'NORMAL')
    a_team = a_cov = None
    if authored:
        res = []
        for what in ('team', 'auth'):
            img = mk(f'_{what}')
            olds = [rewire_extra(m, what) for m in mats]
            bake(img, 'EMIT')
            for m, o in zip(mats, olds):
                restore_extra(m, o)
            res.append(L.img_np(img)[:, :, 0].copy()); bpy.data.images.remove(img)
        a_team, a_cov = res
        a_cov = (a_cov > 0.5).astype(np.float32)
    if copies:
        # LOD0: an authored piece is its own low mesh, so its texels are COPIED from its authoring UVs (`UVsrc`)
        # into the packed atlas by a self-bake (no rays: a ray cannot tell a cloth face from the flipped lining
        # face lying in the same place, and nearby parts bleed into each other)
        a_team = np.zeros((tex, tex), np.float32); a_cov = np.zeros((tex, tex), np.float32)
        b = sc.render.bake
        for ob, mat in copies:
            ob.data.materials.clear(); ob.data.materials.append(mat)
            ob.data.uv_layers['UVMap'].active = True; ob.data.uv_layers['UVsrc'].active_render = True
            nt = mat.node_tree
            tn = nt.nodes.new('ShaderNodeTexImage'); tn.name = '_copy_target'
            tmp = L.new_image('_copy', tex, non_color=True, alpha=True); tn.image = tmp
            for n in nt.nodes:
                n.select = False
            tn.select = True; nt.nodes.active = tn
            L.select_only(ob)

            def copy(what):
                out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
                if what in ('color', 'rough', 'metal'):
                    old = emit_rewire(mat, what)
                elif what == 'normal':
                    old = [l.from_socket for l in out.inputs['Surface'].links]
                    em = nt.nodes.new('ShaderNodeEmission'); em.name = '_bake_emit'
                    nm = next((n for n in nt.nodes if n.type == 'NORMAL_MAP' and n.inputs['Color'].is_linked), None)
                    if nm:
                        nt.links.new(nm.inputs['Color'].links[0].from_socket, em.inputs['Color'])
                    else:
                        em.inputs['Color'].default_value = (0.5, 0.5, 1, 1)
                    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
                else:
                    old = rewire_extra(mat, what)            # 'team' | 'auth' (= 1 on every copied texel, margin included)
                tmp.colorspace_settings.name = 'sRGB' if what == 'color' else 'Non-Color'
                b.use_selected_to_active = False; b.margin = 3; b.margin_type = 'EXTEND'; b.use_clear = True
                bpy.ops.object.bake(type='EMIT')
                (restore_extra if what in ('team', 'auth') else emit_restore)(mat, old)
                return L.img_np(tmp).copy()
            mat['authored'] = 1
            m = copy('auth')[..., 0] > 0.5
            for img, what in ((base, 'color'), (rough, 'rough'), (metal, 'metal'), (nrm, 'normal')):
                px = copy(what); dst = L.img_np(img)
                dst[..., :3] = np.where(m[..., None], px[..., :3], dst[..., :3]); dst[..., 3] = 1; L.np_img(img, dst)
            px = copy('team')
            a_team = np.where(m, px[..., 0], a_team); a_cov = np.maximum(a_cov, m.astype(np.float32))
            nt.nodes.remove(tn); bpy.data.images.remove(tmp)
            bpy.data.objects.remove(ob, do_unlink=True)
    # pack MR at half size: G = roughness, B = metallic. TRELLIS paints stone / cloth with mid metalness: keep metal
    # only where it is clearly metal; authored parts say exactly what they mean
    mr = mk(f'{low.name}_mr'); mr.scale(tex // 2, tex // 2)
    r_np = L.img_np(rough); m_np = L.img_np(metal)
    mt = trellis_metal(m_np[:, :, 0])
    if a_cov is not None:
        mt = mt * (1 - a_cov) + m_np[:, :, 0] * a_cov
    pk = np.ones_like(r_np); pk[:, :, 1] = r_np[:, :, 0]; pk[:, :, 2] = mt * METAL_MAX
    big = mk('_mr_big'); L.np_img(big, pk)
    big.scale(tex // 2, tex // 2); L.np_img(mr, L.img_np(big)); bpy.data.images.remove(big)
    bpy.data.images.remove(rough); bpy.data.images.remove(metal)
    return base, nrm, mr, a_team, a_cov


def finish_unit(a, low, base, nrm, mr, a_team, a_cov, name, cfg, save_mask):
    """Albedo post-processing (hue map, lift, unsharp), team key, materials. Authored texels (`a_cov`) keep their
    flat art untouched and bring their own team mask."""
    orig = L.img_np(base)[..., :3].copy() if a_cov is not None else None
    if LIFT:
        px = L.img_np(base); px[..., :3] = np.clip(px[..., :3] ** 0.8 * 1.1, 0, 1); L.np_img(base, px)
    if HUE_MAP:
        apply_hue_map(base, HUE_MAP)
    unsharp(base, cfg['unsharp'] if base.size[0] >= 1024 else ([1, 0.35] if cfg['unsharp'] else None))
    mask = team_mask(base)
    if a_cov is not None:
        px = L.img_np(base)
        px[..., :3] = px[..., :3] * (1 - a_cov[..., None]) + orig * a_cov[..., None]
        L.np_img(base, px)
        mask = mask * (1 - a_cov) + np.clip(a_team, 0, 1) * a_cov
    tf = vertex_team(low, mask)
    if save_mask:
        (L.WORK / 'clean').mkdir(parents=True, exist_ok=True)
        L.save_gray(mask, L.WORK / 'clean' / f'{name}_team.png', cfg['mask'], cfg['mask'])
    mat = L.build_material(f'{name}_mat', base, nrm, mr)
    mat.use_backface_culling = True                       # glTF doubleSided = false: closed remeshed bodies
    two = len(low.data.materials) > 1
    low.data.materials.clear(); low.data.materials.append(mat)
    if two:                                               # `cloth_material` parts: their own double-sided primitive `<id>_cloth`
        low.data.materials.append(L.double_sided(mat, f'{name}_cloth'))
    nd = L.dup_flip(low)                                  # `two_sided` parts: back faces as geometry (no extra draw)
    if nd:
        print(f'[cleanup] {name}: {nd} two-sided faces duplicated + flipped')
    for img in (base, nrm, mr):
        img.pack()
    return tf


def unit_main(aid, a, yaw_override):
    """Hero tier: the unit's own TRELLIS mesh (the body) + assets.json `parts` -> one LOD0 / LOD1, one atlas.

    parts: [{ name, id: <part asset id> | builder: <trappings builder> + args, height (overrides the part asset's),
              pos [x,y,z] / yaw / scale  or  instances: [{pos, yaw, scale}],   (Blender metres, unit faces -Y)
              bone: <bone the piece follows rigidly> (omitted: skinned with the body),
              lod0 (triangles per instance), uv_boost (texel density x), direct (decimate without remesh),
              two_sided (thin single-sheet cloth: its faces are duplicated + flipped after the bake; authored
              parts ask for it with ob['double_sided']), cloth_material (a LARGE cloth piece instead goes into a
              second, double-sided material `<id>_cloth`: +1 draw), voxel_div }]"""
    import trappings_hook as TH
    A = L.assets()
    cfg = tex_cfg(a)
    H = a['height']
    wl = [A[w] for w, _ in a.get('weapons', [])]
    plist = a.get('parts', [])
    pieces = []                                           # (name, spec, high, authored)
    bones = []                                            # rigid bones; `_PART` = index + 1
    body = None
    if a.get('body', True):
        body = load_high(aid)
        orient_scale(body, dict(a, height=a.get('body_height', H)), yaw_override)   # `body_height`: the animal without its howdah
        pieces.append((aid, dict(lod0=0, direct=a.get('direct', False), voxel_div=a.get('voxel_div')), body, False))
    ctx = dict(id=aid, unit=aid, asset=a, body=body, height=H, parts={})
    for p in plist:
        name = p.get('name') or p.get('id') or p['builder']
        if p.get('builder'):
            src = TH.build(p['builder'], p.get('args', {}), ctx)
            authored = True
        else:
            pa = dict(A[p['id']])
            for k in ('height', 'align', 'fix_yaw'):
                if k in p:
                    pa[k] = p[k]
            src = load_high(p['id'])
            orient_scale(src, pa)
            authored = False
            p = dict(p); p.setdefault('lod0', pa.get('lod0', 2000))
        insts = p.get('instances') or [dict(pos=p.get('pos', (0, 0, 0)), yaw=p.get('yaw', 0), scale=p.get('scale', 1.0))]
        if p.get('hold'):
            # a hand-held authored piece (shield, banner) that must take the team tint: merged into the unit mesh, but
            # placed exactly where rig.py would hold it as a weapon. rig.py writes the matrices on its first run
            # (art-work/clean/<id>_holds.json), so a unit with `hold` parts is built twice (run.mjs does that).
            hf = L.WORK / 'clean' / f'{aid}_holds.json'
            hm = json.loads(hf.read_text()).get(name) if hf.exists() else None
            if hm:
                insts = [dict(matrix=hm, scale=p.get('scale', 1.0))]
            else:
                print(f'[cleanup] {aid}: no hold matrix for {name} yet (first pass): placed by pos; rebuild after the rig stage', flush=True)
        for i, inst in enumerate(insts):
            print(f'[cleanup] {aid}: placing {name} #{i}', inst, flush=True)
            ob = src if i == len(insts) - 1 else dup(src, f'{name}{i}_high')
            place(ob, inst)
            ob.name = f'{name}{i}_high' if len(insts) > 1 else f'{name}_high'
            pieces.append((f'{name}{i}' if len(insts) > 1 else name, p, ob, authored))
        ctx['parts'][name] = src
    if body is not None:
        # the body gets what the unit budget leaves: minus the held weapons, the TRELLIS parts' budgets and the
        # authored parts' real triangle counts
        used = sum(L.tris(h) if au else sp['lod0'] for _, sp, h, au in pieces[1:])
        pieces[0][1]['lod0'] = a['lod0'] - sum(w['lod0'] for w in wl) - used
        print(f"[cleanup] {aid}: body budget {pieces[0][1]['lod0']} of {a['lod0']} triangles (parts {used})")
    lows = []
    tmp = bpy.data.materials.new('_bake'); tmp.use_nodes = True
    tmp_ds = bpy.data.materials.new('_bake_ds'); tmp_ds.use_nodes = True
    any_ds = any(sp.get('cloth_material') for _, sp, h, _ in pieces)
    for name, sp, high, authored in pieces:
        if authored:
            lo = dup(high, f'{name}_low')
            lo.data.materials.clear()
            uvl = lo.data.uv_layers.active
            for k in [k for k in lo.data.uv_layers if k != uvl]:
                lo.data.uv_layers.remove(k)
            lo.data.uv_layers[0].name = 'UVMap'
            lo.data.uv_layers.new(name='UVsrc')           # a copy of the authoring UVs (the atlas copy reads through it)
            lo.data.uv_layers['UVMap'].active = True
            for m in high.data.materials:
                m['authored'] = 1
                if high.get('team_image'):
                    m['team_image'] = high['team_image']
        else:
            dim = float(max(np.ptp(L.verts_np(high), 0)))
            vox = dim / sp['voxel_div'] if sp.get('voxel_div') else float(np.clip(dim / 450, 0.006, 0.02))
            lo = low_of(high, f'{name}_low', sp['lod0'], vox, sp.get('direct', False))
            lo.data.uv_layers.new(name='UVMap')
            unwrap_box(lo, pack=False)
            lo.data.uv_layers.new(name='UVsrc'); lo.data.uv_layers['UVMap'].active = True
        bone = sp.get('bone')
        if bone and bone not in bones:
            bones.append(bone)
        set_attr(lo.data, '_PART', 'POINT', bones.index(bone) + 1 if bone else 0)
        set_attr(lo.data, '_UVK', 'FACE', sp.get('uv_boost', 1.0))
        set_attr(lo.data, '_PIECE', 'FACE', float(len(lows)))
        ds = bool(sp.get('cloth_material'))
        set_attr(lo.data, '_DS', 'FACE', 1.0 if (not ds and (sp.get('two_sided') or sp.get('double_sided') or high.get('double_sided'))) else 0.0)
        lo.data.materials.append(tmp)
        if any_ds:
            lo.data.materials.append(tmp_ds)
            lo.data.polygons.foreach_set('material_index', np.full(len(lo.data.polygons), 1 if ds else 0, np.int32))
        lo['authored'] = authored
        lows.append(lo)
    highs = [h for _, _, h, _ in pieces]
    any_auth = any(au for *_, au in pieces)
    lows1 = [dup(lo, lo.name + '1') for lo in lows]       # LOD1 starts from the per-part LOD0s

    def join(objs, name):
        L.select_only(*objs); bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        ob = bpy.context.view_layer.objects.active; ob.name = name; ob.data.name = name
        return ob
    low = join(lows, aid)
    low['part_bones'] = bones
    def layout(low, tex):
        """Block-scale every piece to one texel density, pack once (stacked instances stay stacked), and return
        the self-bake copy objects of the authored pieces [(object, source material)]."""
        # one texel density over the whole unit: every part's layout is scaled as a BLOCK (x uv_boost: crew seen up
        # close) and laid beside the others, so nothing overlaps except the exact instances inside authored parts;
        # the single pack then keeps those stacked (`merge`), i.e. they go on sharing texels as authored
        me = low.data
        me.uv_layers['UVMap'].active = True
        nl = len(me.loops)
        uv = np.empty(nl * 2, np.float32); me.uv_layers.active.data.foreach_get('uv', uv); uv = uv.reshape(-1, 2).astype(np.float64)
        me.calc_loop_triangles()
        nt = len(me.loop_triangles)
        tl = np.empty(nt * 3, np.int32); me.loop_triangles.foreach_get('loops', tl); tl = tl.reshape(-1, 3)
        tp = np.empty(nt, np.int32); me.loop_triangles.foreach_get('polygon_index', tp)
        ta = np.empty(nt, np.float32); me.loop_triangles.foreach_get('area', ta)
        e1 = uv[tl[:, 1]] - uv[tl[:, 0]]; e2 = uv[tl[:, 2]] - uv[tl[:, 0]]
        tu = 0.5 * np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0])
        fk = get_attr(me, '_UVK', 'FACE')
        fp = get_attr(me, '_PIECE', 'FACE').astype(np.int32)
        lt = np.empty(len(me.polygons), np.int32); me.polygons.foreach_get('loop_total', lt)
        lp = np.repeat(fp, lt)                               # piece index per loop
        cursor = 0.0
        for i in range(int(fp.max()) + 1):
            tsel = fp[tp] == i; lsel = lp == i
            if not lsel.any():
                continue
            dens = math.sqrt(max(float(tu[tsel].sum()), 1e-12) / max(float(ta[tsel].sum()), 1e-12))   # uv units per metre
            k = float(fk[fp == i][0]) / dens
            q = uv[lsel] * k
            q[:, 0] += cursor - q[:, 0].min(); q[:, 1] -= q[:, 1].min()
            cursor = q[:, 0].max() + 0.5
            uv[lsel] = q
        me.uv_layers.active.data.foreach_set('uv', uv.astype(np.float32).ravel())
        me.attributes.remove(me.attributes['_UVK'])
        me.uv_layers['UVMap'].active = True
        L.select_only(low)
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.uv.select_all(action='SELECT')
        # authored islands are not rotated: their tangent normal maps are copied texel for texel
        pack_uv(0.0012 if tex >= 2048 else 0.003, merge=any_auth, rotate=not any_auth)
        bpy.ops.object.mode_set(mode='OBJECT')
        copies = []
        for i, (pname, sp, high, authored) in enumerate(pieces):
            if not authored:
                continue
            ob = dup(low, f'_copy_{pname}')
            bm = bmesh.new(); bm.from_mesh(ob.data)
            lay = bm.faces.layers.float.get('_PIECE')
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if int(round(f[lay])) != i], context='FACES')
            bm.to_mesh(ob.data); bm.free()
            copies.append((ob, high.data.materials[0]))
        me.attributes.remove(me.attributes['_PIECE'])
        me.uv_layers.remove(me.uv_layers['UVsrc'])
        return copies
    copies = layout(low, cfg['tex'])
    ray_highs = [h for _, _, h, au in pieces if not au] if copies else highs
    ext = a.get('cage', max(0.01, min(0.03, 0.012 * H)))
    with L.bake_device(f'cleanup {aid}'):
        base, nrm, mr, a_team, a_cov = bake_unit(ray_highs, low, cfg['tex'], ext, False if copies else any_auth, copies)
        tf = finish_unit(a, low, base, nrm, mr, a_team, a_cov, aid, cfg, True)
        # ---- LOD1: every part re-meshed coarsely (authored sheets: collapsed directly), re-unwrapped, baked from the highs
        # Authored pieces cannot be collapsed 8x (boxes and sheets fall apart into shards): their LOD1 is a voxel hull
        # like everything else. Thin cloth first loses its lining faces and gets a slab towards the body; pieces
        # skinned with the body (caparison, bands) are fused into the body's hull, rigid ones get their own.
        highs1 = list(highs)
        b1 = a['lod1'] - sum(w['lod1'] for w in wl)
        auth_tris = sum(L.tris(o) for o in lows1 if o['authored'])
        keep_auth = any_auth and auth_tris <= 0.75 * b1   # a generous LOD1 keeps the authored pieces as they are (exact texel copy again)
        if not keep_auth:
            for o in lows1:
                if 'UVsrc' in o.data.uv_layers:
                    o.data.uv_layers.remove(o.data.uv_layers['UVsrc'])
        if any_auth and not keep_auth:
            body1 = next((o for o in lows1 if not o['authored'] and not get_attr(o.data, '_PART').max() > 0), None)
            fuse = []
            for k, o in enumerate(list(lows1)):
                if not o['authored']:
                    continue
                hf = dup(highs[k], highs[k].name + '_front'); front_only(hf); highs1[k] = hf
                front_only(o)
                rigid = float(get_attr(o.data, '_PART').max()) > 0
                sm = o.modifiers.new('s', 'SOLIDIFY'); sm.thickness = 0.09 if not rigid else 0.03; sm.offset = -1
                L.apply_mods(o)
                o['authored'] = False
                if not rigid and body1 is not None:
                    fuse.append(o)
            if fuse:
                for o in fuse:
                    lows1.remove(o)
                keepd = dict(body1.items())
                body1 = join([body1] + fuse, body1.name)
                for kk, vv in keepd.items():
                    body1[kk] = vv
        t0 = [L.tris(o) for o in lows1]
        if keep_auth:
            b1 -= auth_tris; t0 = [0 if o['authored'] else t for o, t in zip(lows1, t0)]
        for o, t in zip(lows1, t0):
            if keep_auth and o['authored']:
                print(f'[cleanup] {o.name}: LOD1 keeps the authored piece ({L.tris(o)} tris)')
                continue
            pidx = float(get_attr(o.data, '_PIECE', 'FACE')[0]) if len(o.data.polygons) else 0.0
            uvk = float(get_attr(o.data, '_UVK', 'FACE')[0]) if len(o.data.polygons) and '_UVK' in o.data.attributes else 1.0
            pv = get_attr(o.data, '_PART')
            part = float(pv.max()) if len(pv) else 0.0
            dsv = get_attr(o.data, '_DS', 'FACE')
            two = float(dsv.max()) if len(dsv) else 0.0
            mi = o.data.polygons[0].material_index if len(o.data.polygons) else 0
            budget = max(40, int(b1 * t / sum(t0)))
            keep = o.data.copy()
            dim = float(max(np.ptp(L.verts_np(o), 0)))
            for attempt in range(5):                         # coarser voxels until the collapse reaches the budget
                if not o['authored']:
                    rm = o.modifiers.new('rm', 'REMESH'); rm.mode = 'VOXEL'
                    rm.voxel_size = dim / (a.get('lod1_voxel_div') or (150 if a['lod1'] <= 4000 else 260)) * (1.5 ** attempt)   # a generous LOD1 (the low tier's hero mesh) keeps thin membranes
                    L.apply_mods(o); L.remove_floaters(o, 0.001)
                for k in range(3):
                    n = decimate(o, budget)
                if n <= budget * 1.08 or o['authored'] or attempt == 4:
                    break
                old = o.data; o.data = keep.copy(); bpy.data.meshes.remove(old)
            bpy.data.meshes.remove(keep)
            print(f'[cleanup] {o.name}: LOD1 piece {n} tris (budget {budget}, attempt {attempt})')
            set_attr(o.data, '_PART', 'POINT', part)
            set_attr(o.data, '_DS', 'FACE', two)
            o.data.materials.clear(); o.data.materials.append(tmp)
            if any_ds:
                o.data.materials.append(tmp_ds)
                o.data.polygons.foreach_set('material_index', np.full(len(o.data.polygons), mi, np.int32))
            for p in o.data.polygons:
                p.use_smooth = True
            if keep_auth:                                    # its own smart unwrap; the unit layout packs it with the authored pieces
                for k in list(o.data.uv_layers):
                    o.data.uv_layers.remove(k)
                o.data.uv_layers.new(name='UVMap'); unwrap(o, 0.006)
                o.data.uv_layers.new(name='UVsrc'); o.data.uv_layers['UVMap'].active = True
                set_attr(o.data, '_PIECE', 'FACE', pidx); set_attr(o.data, '_UVK', 'FACE', uvk)
        l1 = join(lows1, f'{aid}_lod1')
        l1['part_bones'] = bones
        if keep_auth:
            copies1 = layout(l1, cfg['tex_lod1'])
            b1i, n1i, m1i, t1, c1 = bake_unit(ray_highs, l1, cfg['tex_lod1'], ext, False, copies1)
        else:
            for k in list(l1.data.uv_layers):
                l1.data.uv_layers.remove(k)
            if '_UVK' in l1.data.attributes:
                l1.data.attributes.remove(l1.data.attributes['_UVK'])
            if '_PIECE' in l1.data.attributes:
                l1.data.attributes.remove(l1.data.attributes['_PIECE'])
            l1.data.uv_layers.new(name='UVMap')
            unwrap(l1, 0.006)
            b1i, n1i, m1i, t1, c1 = bake_unit(highs1, l1, cfg['tex_lod1'], ext, any_auth)
        for h in highs1:
            if h not in highs:
                bpy.data.objects.remove(h, do_unlink=True)
        finish_unit(a, l1, b1i, n1i, m1i, t1, c1, f'{aid}_lod1', dict(cfg, mask=max(128, cfg['tex_lod1'] // 2)), True)   # LOD1 has its own atlas -> its own mask
        n1 = L.tris(l1)
    n0 = L.tris(low)
    for o in (low, l1):
        o['team_frac'] = tf
    print(f'[cleanup] {aid}: LOD0 {n0} tris, LOD1 {n1} tris, atlas {cfg["tex"]} / {cfg["tex_lod1"]}, team cloth {tf * 100:.1f}% of verts, rigid bones {bones}')
    for h in highs:
        bpy.data.objects.remove(h, do_unlink=True)
    for m in list(bpy.data.materials):
        if m.users == 0:
            bpy.data.materials.remove(m)
    for i in list(bpy.data.images):
        if i.users == 0:
            bpy.data.images.remove(i)
    (L.WORK / 'blend').mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(L.WORK / 'blend' / f'{aid}_clean.blend'), compress=True)
    for stale in (L.WORK / 'blend' / f'{aid}_clean.orig.blend', L.WORK / 'clean' / f'{aid}_team.orig.png'):
        if stale.exists():
            stale.unlink()
    if a.get('grade'):
        regrade(aid)
    print('[cleanup] done', aid)


def main():
    args = L.argv()
    aid = args[0]
    if '--regrade' in args:
        regrade(aid)
        print('[cleanup] regraded', aid)
        return
    yaw_override = float(args[args.index('--yaw') + 1]) if '--yaw' in args else None
    a = L.assets()[aid]
    global TEAM_HUE, TEAM_SAT, TEAM_VAL, HUE_MAP, METAL_MAX, METAL_TRUST
    rj = L.WORK / 'mesh' / f'{aid}.glb.run.json'
    METAL_TRUST = a.get('metal_trust', not (rj.exists() and json.loads(rj.read_text()).get('res', 512) >= 1024))
    TEAM_VAL = a.get('team_val', TEAM_VAL)
    METAL_MAX = a.get('metal_max', 1.0)
    HUE_MAP = a.get('hue_map')
    TEAM_SAT = a.get('team_sat', TEAM_SAT)
    TEAM_HUE = tuple(a.get('team_hue', TEAM_HUE))      # per-asset team-cloth key (the new factions key on magenta)
    kind = a['kind']
    src = L.WORK / 'mesh' / f'{aid}.glb'
    L.clear()
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 2
    global LIFT, NO_REMESH, MASK_SIZE, UNSHARP
    cfg = tex_cfg(a)
    MASK_SIZE = cfg['mask']
    UNSHARP = cfg['unsharp']
    if tier(a) == 'hero':
        LIFT = False
        unit_main(aid, a, yaw_override)
        return
    lock = L.bake_device(f'cleanup {aid}'); lock.__enter__()
    import atexit; atexit.register(lock.__exit__)
    high = load_high(aid)

    if kind == 'weapon':
        orient_weapon(high, a)
        height = a['length']
    else:
        orient_scale(high, a, yaw_override)
        height = a['height']

    # ---- LOD0
    use_team = kind not in ('prop', 'weapon') or 'shield' in aid or bool(a.get('team'))
    # texture memory budget: 1024 for heroes / large / structures, 512 for squad units and props, 256 weapons
    NO_REMESH = bool(a.get('no_remesh'))
    LIFT = bool(a.get('squad') or (a.get('part') and kind == 'humanoid'))
    tex = cfg['tex']
    # triangle budgets in assets.json include the held weapons
    wl = [L.assets()[w] for w, _ in a.get('weapons', [])]
    b0 = a['lod0'] - sum(w['lod0'] for w in wl)
    b1 = a['lod1'] - sum(w['lod1'] for w in wl)
    voxel = max(np.ptp(L.verts_np(high), 0)) / a.get('voxel_div', 300)
    low, n0, tf = make_lod(high, aid, b0, tex, height, use_team, voxel, save_mask=True, box=not NO_REMESH)
    # LOD1: decimate LOD0 (keeps thin walls); if that degenerates (furry meshes collapse into fans: too few
    # vertices per triangle) or misses the budget, rebuild from the high mesh via a coarser remesh
    if a.get('lod1_voxel_div'):
        # furry / spiky meshes: collapsing LOD0 or a fine remesh leaves shards; a filled voxel hull stays solid
        l1, n1, _ = make_lod(high, f'{aid}_lod1', b1, max(256, cfg['tex_lod1']), height, use_team,
                             max(np.ptp(L.verts_np(high), 0)) / a['lod1_voxel_div'], solid=True)
    else:
        l1, n1, _ = make_lod(high, f'{aid}_lod1', b1, max(256, cfg['tex_lod1']), height, use_team, voxel, src=low)
    nv = len(l1.data.vertices)
    if not a.get('lod1_voxel_div') and (n1 > b1 * 1.05 or n1 > 2.3 * nv):
        print(f'[cleanup] {aid}: LOD1 from LOD0 degenerate ({n1} tris / {nv} verts) -> remesh path')
        old = l1; old.name = '_old_lod1'
        l1, n1, _ = make_lod(high, f'{aid}_lod1', b1, max(256, cfg['tex_lod1']), height, use_team, voxel * 2.5)
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
    for stale in (L.WORK / 'blend' / f'{aid}_clean.orig.blend', L.WORK / 'clean' / f'{aid}_team.orig.png'):
        if stale.exists():
            stale.unlink()
    if a.get('grade') and kind not in ('prop', 'weapon'):
        regrade(aid)
        print('[cleanup] done', aid)
        return
    if kind in ('prop', 'weapon'):
        # props are final here (static, origin at base centre); weapons only feed rig.py
        dst = L.OUT if kind == 'prop' else L.WORK / 'clean'
        dst.mkdir(parents=True, exist_ok=True)
        low.name = aid
        L.export_glb(dst / f'{aid}.glb', [low])
        L.export_glb(dst / f'{aid}_lod1.glb', [l1])
        (L.WORK / 'clean' / f'{aid}.json').write_text(json.dumps(dict(id=aid, height=height, tris_lod0=n0, tris_lod1=n1,
                                                                          team_frac=tf), indent=1))
    print('[cleanup] done', aid)


if __name__ == '__main__':
    main()
