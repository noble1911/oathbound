"""Stage 4 (rig + animate humanoids): fit the shared skeleton to a cleaned AI mesh, skin it via a voxel proxy,
attach weapons to bones, retarget the CC0 clip library, export LOD0/LOD1 GLBs.

blender -b --factory-startup --python tools/art/blender/rig.py -- <id>

In : art-work/blend/<id>_clean.blend, art-work/blend/anim_lib.blend, art-work/blend/<weapon>_clean.blend
Out: public/models/v2/<id>.glb, <id>_lod1.glb, art-work/blend/<id>_rig.blend, art-work/clean/<id>.json (facts)

Skeleton fitting: joints come from the mesh (arm/leg centre lines found by slicing the A-pose silhouette,
torso depth centre for the spine); every bone's rest frame is the library frame rotated rigidly onto the
new bone direction, so retargeting with the 'absolute' rule (copy armature-space orientation) is exact.
Weights: bone-heat automatic weights on a watertight voxel-remesh proxy, transferred to each LOD
(nearest-face interpolated), limited to 4 influences, normalised.
"""
import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np
from mathutils import Matrix, Vector

import art_lib as L
import retarget as R

LIB_TOP = 1.83         # Quaternius mannequin height (m)
FINAL_CLIPS = ['idle', 'walk', 'run', 'attack_melee_a', 'attack_melee_b', 'attack_bow', 'cast', 'hit',
               'death_a', 'death_b', 'victory']
COMMON = dict(idle='idle', walk='walk', run='run_up', attack_bow='bow', cast='cast', hit='hit',
              death_a='death_a', death_b='death_b', victory='victory_b')
CLIPSETS = {
    'sword': dict(attack_melee_a='swing_a', attack_melee_b='swing_b', run='run_sword_up'),
    # one-handed spear / lance: the carry is kept through hit and cast and released as the unit falls
    'spear': dict(attack_melee_a='lunge_a', attack_melee_b='lunge_b', idle='idle_spear', walk='walk_spear', run='run_spear_up',
                  hit='hit_spear', cast='cast_spear', death_a='death_a_spear', death_b='death_b_spear'),
    # two-handed pike: carried and thrust in both hands
    'pike': dict(attack_melee_a='pike_a', attack_melee_b='pike_b', idle='idle_pike', walk='walk_pike', run='run_pike',
                 hit='hit_pike', cast='pike_b', attack_bow='pike_a', death_a='death_a_pike', death_b='death_b_pike', victory='victory_pike'),
    # ranged units alternate attack / attack2 per soldier, so BOTH must be a shot / a cast (attack2 used to be
    # a punch for archers and an empty-handed sword chop for casters)
    'bow': dict(attack_bow='bow_a', attack_melee_a='bow_b', attack_melee_b='cross'),
    'cast': dict(attack_melee_a='cast_b', attack_melee_b='cast_b'),
    # staff carried upright in the fist (hold 'fist'), raised to cast, thrust head-first to strike
    'staff': dict(idle='idle_staff', walk='walk_staff', run='run_staff', hit='hit_staff', cast='cast_staff', attack_bow='cast_staff',
                  attack_melee_a='staff_strike', attack_melee_b='staff_strike', death_a='death_a_staff', death_b='death_b_staff',
                  victory='victory_staff'),
    'fist': dict(attack_melee_a='jab', attack_melee_b='cross'),
    # two-handed great axe: port-arms carry, overhead chop, horizontal cleave, heavier walk / jog timing
    'greataxe': dict(attack_melee_a='chop2h', attack_melee_b='cleave2h', idle='idle_axe', walk='walk_axe', run='run_axe',
                     victory='victory_axe', hit='hit_axe', cast='cast_axe', attack_bow='chop2h',
                     death_a='death_a_axe', death_b='death_b_axe'),
}
LOOPS = {'idle', 'walk', 'run', 'victory'}
# weapon holds, in the library T-pose armature space for the left side (x mirrored for the right):
# axis = weapon +Z (head / blade / top), face = weapon -Y (the concept's camera-facing side)
HOLDS = {
    'fist':   dict(bone='hand', along=0.45, axis=(0, -1, 0), face=(0, 0, 1), off=0.0),
    'bow':    dict(bone='hand', along=0.45, axis=(0, 0, 1), face=(1, 0, 0), off=0.0),
    'tome':   dict(bone='hand', along=0.55, axis=(0, -1, 0), face=(0, 0, -1), off=0.03),
    'shield': dict(bone='forearm', along=0.55, axis=(-1, 0, 0), face=(0, 0, 1), off=0.07),
    # staves run along the forearm toward the elbow, so they stand upright when the arm hangs
    'staff':  dict(bone='hand', along=0.4, axis=(-1, 0, 0), face=(0, -1, 0), off=0.04),
    # two-handed axe: the right hand sits 0.3 m further up the shaft so the left hand has room below it
    'greataxe': dict(bone='hand', along=0.45, axis=(0, -1, 0), face=(0, 0, 1), off=0.0, shift=-0.30),
    # hangs from the fist along the arm (away from the elbow): below the hand when the arm hangs
    'lantern': dict(bone='hand', along=0.5, axis=(1, 0, 0), face=(0, -1, 0), off=0.0),
    # carried on the back (a standard strapped to the upper spine): upright in every clip, both hands free
    'back': dict(bone='spine3', central=True, along=0.5, axis=(0, 0, 1), face=(0, -1, 0), off=-0.2),
}
WEAPON_HOLD = {'weapon_axe_great': 'greataxe', 'weapon_bow': 'bow', 'weapon_tome': 'tome', 'weapon_shield_kite': 'shield', 'weapon_shield_round': 'shield', 'weapon_staff': 'staff'}


def load_lib():
    p = L.WORK / 'blend' / 'anim_lib.blend'
    with bpy.data.libraries.load(str(p), link=False) as (src, dst):
        dst.objects = ['LibRig']
        dst.actions = [n for n in src.actions if n.startswith('lib_')]
    lib = bpy.data.objects['LibRig']
    bpy.context.scene.collection.objects.link(lib)
    for a in bpy.data.actions:
        if a.name.startswith('lib_'):
            a.use_fake_user = True
    return lib


def segments(vals, gap):
    """Split sorted 1-D values into runs separated by > gap; returns list of (lo, hi)."""
    if len(vals) == 0:
        return []
    v = np.sort(vals)
    cut = np.nonzero(np.diff(v) > gap)[0]
    starts = np.r_[0, cut + 1]; ends = np.r_[cut, len(v) - 1]
    return [(v[s], v[e]) for s, e in zip(starts, ends)]


def surface_points(ob, n=200000, seed=7):
    """Area-weighted random points on the mesh surface (dense, so slices are reliable on a 6k-tri mesh)."""
    me = ob.data
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    idx = np.empty(nt * 3, np.int32); me.loop_triangles.foreach_get('vertices', idx)
    v = L.verts_np(ob)
    tri = v[idx.reshape(-1, 3)]
    area = np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
    rng = np.random.default_rng(seed)
    pick = rng.choice(nt, n, p=area / area.sum())
    r1 = np.sqrt(rng.random(n)); r2 = rng.random(n)
    t = tri[pick]
    return (1 - r1)[:, None] * t[:, 0] + (r1 * (1 - r2))[:, None] * t[:, 1] + (r1 * r2)[:, None] * t[:, 2]


def fit_landmarks(co, H):
    s = H / LIB_TOP
    z = co[:, 2]
    th = 0.006 * H
    land = {'s': s}
    # ---- arms: outermost separated segment per slice, both sides
    for side, sg in (('L', 1), ('R', -1)):
        # walk down from the shoulder; follow the outermost separated segment while it stays continuous
        # (stops at the fist, before the legs/skirt can be mistaken for an arm)
        pts = []
        miss = 0
        for zk in np.arange(0.78, 0.28, -0.01) * H:
            sl = co[np.abs(z - zk) < th]
            sl = sl[sg * sl[:, 0] > -0.02 * H]
            segs = segments(sg * sl[:, 0], 0.015 * H) if len(sl) >= 8 else []
            if len(segs) >= 2 and segs[0][0] < 0.05 * H:
                lo, hi = segs[-1]
                m = (sg * sl[:, 0] >= lo) & (sg * sl[:, 0] <= hi)
                cx = sl[m, 0].mean()
                if pts and abs(cx - pts[-1][1]) > 0.035 * H:
                    if len(pts) >= 4:
                        break
                    pts = []
                pts.append((zk, cx, sl[m, 1].mean(), lo))
                miss = 0
            elif pts:
                miss += 1
                if miss > 2 and len(pts) >= 4:
                    break
        if len(pts) >= 6:
            P = np.array(pts)
            A = np.c_[P[:, 0], np.ones(len(P))]
            kx = np.linalg.lstsq(A, P[:, 1], rcond=None)[0]
            ky = np.linalg.lstsq(A, P[:, 2], rcond=None)[0]
            z_tip = P[:, 0].min() - 0.01 * H
            land[f'arm_{side}'] = dict(kx=kx.tolist(), ky=ky.tolist(), z_tip=float(z_tip), n=len(pts))
        else:
            # arms touch the body: hand = outermost cluster below the shoulder
            m = (sg * co[:, 0] > 0) & (z < 0.75 * H) & (z > 0.3 * H)
            ext = (sg * co[m, 0]).max()
            hm = m & (sg * co[:, 0] > ext - 0.06 * H)
            c = co[hm].mean(0)
            land[f'arm_{side}'] = dict(hand=c.tolist(), n=0)
    # crotch: lowest height where the body centre line is filled for 4 consecutive slices. Used only when it is
    # clearly lower than the mannequin's (short-legged bruisers); robes fill the centre from the floor -> ignored.
    filled = [(zk, bool((np.abs(co[np.abs(z - zk) < th][:, 0]) < 0.012 * H).any())) for zk in np.arange(0.06, 0.6, 0.01) * H]
    for i in range(len(filled) - 4):
        if all(f for _, f in filled[i:i + 4]):
            cz = filled[i][0] / H
            if 0.18 < cz < 0.43:
                land['crotch'] = float(filled[i][0])
            break
    # ---- legs: per side, the segment nearest the centre line, followed upward from the ankle while it stays
    # continuous. Only slices BELOW the crotch count: above it there is no leg, and the nearest off-centre
    # segment is a hanging fist or forearm (that put the golem's hip joints 1.2 m outside the body and slanted
    # its thigh bones 40 deg, which the 'absolute' retarget then turned into legs splayed 40 deg in every clip).
    z_top = (land['crotch'] - 0.015 * H) if 'crotch' in land else 0.42 * H
    for side, sg in (('L', 1), ('R', -1)):
        pts = []
        for zk in np.arange(0.08, 0.42, 0.01) * H:
            if zk > z_top:
                break
            sl = co[np.abs(z - zk) < th]
            if len(sl) < 8:
                continue
            segs = segments(sl[:, 0], 0.01 * H)
            mine = [sg_ for sg_ in segs if (sg * (sg_[0] + sg_[1]) / 2) > 0.01 * H]
            if len(segs) >= 2 and mine:
                lo, hi = min(mine, key=lambda q: abs((q[0] + q[1]) / 2))
                m = (sl[:, 0] >= lo) & (sl[:, 0] <= hi)
                cx = sl[m, 0].mean()
                if pts and abs(cx - pts[-1][1]) > 0.03 * H:
                    break                                   # jumped to another body part
                pts.append((zk, cx, (sl[m, 1].min() + sl[m, 1].max()) / 2))
        if len(pts) >= 8:
            P = np.array(pts)
            A = np.c_[P[:, 0], np.ones(len(P))]
            kx = np.linalg.lstsq(A, P[:, 1], rcond=None)[0]
            ky = np.linalg.lstsq(A, P[:, 2], rcond=None)[0]
            # a leg in an A-pose is within ~20 deg of vertical; anything else is a bad fit (robes, props)
            if abs(kx[0]) < 0.36 and abs(ky[0]) < 0.36:
                land[f'leg_{side}'] = dict(kx=kx.tolist(), ky=ky.tolist(), n=len(pts))
    # ---- torso depth centre per height
    def ycen(zk):
        sl = co[(np.abs(z - zk) < th * 2) & (np.abs(co[:, 0]) < 0.08 * H)]
        return float((sl[:, 1].min() + sl[:, 1].max()) / 2) if len(sl) > 4 else 0.0
    land['ycen'] = {round(f, 2): ycen(f * H) for f in np.arange(0.40, 0.99, 0.02)}
    foot = co[z < 0.04 * H]
    land['toe_y'] = float(foot[:, 1].min()) if len(foot) else -0.15 * s
    return land


def build_rig(aid, lib, co, H):
    land = fit_landmarks(co, H)
    s = land['s']
    rest = {b.name: (b.head_local.copy(), b.tail_local.copy(), b.matrix_local.to_3x3().copy(),
                     b.parent.name if b.parent else None) for b in lib.data.bones}
    P = {n: h * s for n, (h, t, m, p) in rest.items()}          # scaled heads
    T = {n: t * s for n, (h, t, m, p) in rest.items()}          # scaled tails (leaves)

    def yc(zz):
        keys = sorted(land['ycen'])
        f = min(keys, key=lambda k: abs(k - zz / H))
        return land['ycen'][f]
    for n in ('hips', 'spine1', 'spine2', 'spine3', 'neck', 'head'):
        P[n].y = yc(P[n].z)
    T['head'] = Vector((0, P['head'].y, H * 0.985))
    hip_frac = L.assets()[aid].get('hip')
    if hip_frac or 'crotch' in land:
        # `hip` (fraction of the height) overrides the detected crotch: under a long armoured skirt the detector
        # finds the hem, which gave the Warden 22 cm thighs and a waddle
        hip = hip_frac * H if hip_frac else land['crotch'] + 0.05 * H
        ank = P['foot.L'].z
        P['hips'].z = hip - 0.01 * H
        for sd in 'LR':
            P[f'thigh.{sd}'].z = hip
            P[f'shin.{sd}'].z = ank + (hip - ank) * 0.48
    for side, sg in (('L', 1), ('R', -1)):
        arm = land[f'arm_{side}']
        zs = P[f'upper_arm.{side}'].z
        if arm['n']:
            kx, ky = arm['kx'], arm['ky']
            line = lambda zz: Vector((kx[0] * zz + kx[1], ky[0] * zz + ky[1], zz))
            sh = line(zs)
            sh.x = sg * min(abs(sh.x), abs(P[f'upper_arm.{side}'].x) * 1.6)
            tip = line(arm['z_tip'])
        else:
            sh = P[f'upper_arm.{side}'].copy(); sh.y = yc(zs)
            tip = Vector(arm['hand']) + (Vector(arm['hand']) - sh).normalized() * 0.06 * H
        d = (tip - sh)
        Ltot = d.length
        u = d.normalized()
        # library proportions shoulder->elbow->wrist->fingertip = 0.274 : 0.273 : 0.22
        P[f'upper_arm.{side}'] = sh
        P[f'forearm.{side}'] = sh + u * Ltot * 0.274 / 0.767 + Vector((0, 0.01 * H, 0))
        P[f'hand.{side}'] = sh + u * Ltot * 0.547 / 0.767
        T[f'hand.{side}'] = sh + u * Ltot * 0.70 / 0.767
        P[f'shoulder.{side}'].y = yc(P[f'shoulder.{side}'].z)
        leg = land.get(f'leg_{side}')
        if leg:
            fx = lambda zz: Vector((leg['kx'][0] * zz + leg['kx'][1], leg['ky'][0] * zz + leg['ky'][1], zz))
            hip = fx(P[f'thigh.{side}'].z); hip.y = P['hips'].y
            P[f'thigh.{side}'] = hip
            P[f'shin.{side}'] = fx(P[f'shin.{side}'].z) + Vector((0, -0.01 * H, 0))
            P[f'foot.{side}'] = fx(P[f'foot.{side}'].z)
        else:
            for b in ('thigh', 'shin', 'foot'):
                P[f'{b}.{side}'].y = P['hips'].y
        dy = land['toe_y'] - T[f'toe.{side}'].y
        P[f'toe.{side}'] = Vector((P[f'foot.{side}'].x, P[f'toe.{side}'].y + dy * 0.6, P[f'toe.{side}'].z))
        T[f'toe.{side}'] = Vector((P[f'foot.{side}'].x, land['toe_y'], P[f'toe.{side}'].z))
    children = {}
    for n, (h, t, m, p) in rest.items():
        if p:
            children.setdefault(p, []).append(n)
    main_child = {'hips': 'spine1', 'spine1': 'spine2', 'spine2': 'spine3', 'spine3': 'neck', 'neck': 'head',
                  'root': None}
    for side in 'LR':
        main_child.update({f'shoulder.{side}': f'upper_arm.{side}', f'upper_arm.{side}': f'forearm.{side}',
                           f'forearm.{side}': f'hand.{side}', f'thigh.{side}': f'shin.{side}',
                           f'shin.{side}': f'foot.{side}', f'foot.{side}': f'toe.{side}'})
    data = bpy.data.armatures.new(f'{aid}_rig')
    rig = bpy.data.objects.new(f'{aid}_rig', data)
    bpy.context.scene.collection.objects.link(rig)
    L.select_only(rig)
    bpy.ops.object.mode_set(mode='EDIT')
    frames = {}
    for n, (h, t, m, p) in rest.items():
        c = main_child.get(n)
        head = P[n]
        tail = P[c] if c else T[n]
        if n == 'root':
            tail = head + (t - h) * s
        lib_dir = (t - h).normalized()
        new_dir = (tail - head).normalized()
        Rb = lib_dir.rotation_difference(new_dir).to_matrix()
        M = (Rb @ m).to_4x4(); M.translation = head
        eb = data.edit_bones.new(n)
        eb.head = head; eb.tail = head + new_dir * 0.1
        eb.matrix = M
        eb.length = max(0.01, (tail - head).length)
        frames[n] = Rb
    for n, (h, t, m, p) in rest.items():
        if p:
            data.edit_bones[n].parent = data.edit_bones[p]
    bpy.ops.object.mode_set(mode='OBJECT')
    data.bones['root'].use_deform = False
    return rig, land


def skin(aid, rig, meshes, H):
    """Bone-heat weights on a voxel proxy, transferred to every mesh in `meshes`.
    Rigid parts (cleanup.py `parts` with a `bone`: point attribute `_PART` = index + 1 into the object's
    `part_bones`) are left out of the proxy and weighted 100 % to their bone afterwards (howdah, crew, shields).
    assets.json `skin: "solid"`: bone heat on a SOLID voxel hull first (the elephant: the plain voxel proxy of a
    thin TRELLIS shell left whole legs unweighted)."""
    import bmesh
    src = meshes[0]
    proxy = src.copy(); proxy.data = src.data.copy(); proxy.name = f'{aid}_proxy'
    bpy.context.scene.collection.objects.link(proxy)
    proxy.data.materials.clear()
    part_bones = list(src.get('part_bones', []))
    if part_bones and '_PART' in proxy.data.attributes:
        pv = np.empty(len(proxy.data.vertices), np.float32); proxy.data.attributes['_PART'].data.foreach_get('value', pv)
        bm = bmesh.new(); bm.from_mesh(proxy.data); bm.verts.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if pv[v.index] > 0.5], context='VERTS')
        bm.to_mesh(proxy.data); bm.free()
    body = proxy.data.copy()
    ok = False
    solid = L.assets().get(aid, {}).get('skin') == 'solid'
    # first try bone heat directly on the (already voxel-remeshed, watertight) LOD0; then coarser voxel proxies
    for vs in ((('solid', H / 130), ('solid', H / 95), ('solid', H / 70)) if solid else ()) + (None, H / 140, H / 100, H / 70):
        for m in list(proxy.modifiers):
            proxy.modifiers.remove(m)
        old = proxy.data; proxy.data = body.copy()
        if old.users == 0:
            bpy.data.meshes.remove(old)
        if isinstance(vs, tuple):
            import cleanup as CL
            old = proxy.data; proxy.data = CL.solid_mesh(proxy, vs[1]); bpy.data.meshes.remove(old)
            vs = vs[1]
        elif vs is not None:
            rm = proxy.modifiers.new('rm', 'REMESH'); rm.mode = 'VOXEL'; rm.voxel_size = vs; rm.use_smooth_shade = True
            L.apply_mods(proxy)
        if L.tris(proxy) > 40000:
            dm = proxy.modifiers.new('d', 'DECIMATE'); dm.ratio = 40000 / L.tris(proxy)
            L.apply_mods(proxy)
        proxy.vertex_groups.clear()
        L.select_only(proxy, rig)
        proxy.select_set(True); rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.parent_set(type='ARMATURE_AUTO')
        n = len(proxy.data.vertices)
        w = np.zeros(n)
        for v in proxy.data.vertices:
            w[v.index] = sum(g.weight for g in v.groups)
        bad = float((w < 1e-4).mean())
        print(f'[rig] weights on {"LOD0" if vs is None else f"voxel {vs * 100:.1f} cm proxy"}: {n} verts, unweighted {bad * 100:.2f}%')
        if bad < 0.01:
            ok = True
            break
    for ob in meshes:
        ob.vertex_groups.clear()
        for b in rig.data.bones:
            if b.use_deform:
                ob.vertex_groups.new(name=b.name)
        dt = ob.modifiers.new('dt', 'DATA_TRANSFER')
        dt.object = proxy
        dt.use_vert_data = True
        dt.data_types_verts = {'VGROUP_WEIGHTS'}
        dt.vert_mapping = 'POLYINTERP_NEAREST'
        dt.layers_vgroup_select_src = 'ALL'
        dt.layers_vgroup_select_dst = 'NAME'
        L.select_only(ob)
        bpy.ops.object.modifier_apply(modifier='dt')
        bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
        mw = ob.matrix_world.copy()
        ob.parent = rig
        ob.matrix_world = mw
        am = ob.modifiers.new('Armature', 'ARMATURE'); am.object = rig
        if part_bones and '_PART' in ob.data.attributes:
            pv = np.empty(len(ob.data.vertices), np.float32); ob.data.attributes['_PART'].data.foreach_get('value', pv)
            ob.data.attributes.remove(ob.data.attributes['_PART'])
            for i, bn in enumerate(part_bones):
                idx = [int(k) for k in np.nonzero(np.round(pv) == i + 1)[0]]
                if not idx:
                    continue
                if bn not in ob.vertex_groups:
                    raise RuntimeError(f'{aid}: part bone {bn!r} is not a deform bone of the rig')
                for g in ob.vertex_groups:
                    g.remove(idx)
                ob.vertex_groups[bn].add(idx, 1.0, 'REPLACE')
                print(f'[rig] {ob.name}: {len(idx)} rigid vertices -> {bn}')
    bpy.data.objects.remove(proxy, do_unlink=True)
    return ok


def ground_fix(rig, body, act, death=False):
    """Keep a retargeted clip on the ground. The clips are FK copies of a mannequin's joint angles, so a
    character with other proportions misses the floor: long feet (the golem's are 0.8 x its leg) stab 40 cm into
    it at toe-off, thick torsos sink when the body lies down. Per frame: (a) un-pitch a foot whose toes go under
    the floor, pivoting at the ankle; (b) lift the hips by whatever the lowest body vertex still lacks."""
    sc = bpy.context.scene
    R.set_action(rig, act)
    B = rig.data.bones
    g_tip = {sd: min(B[f'toe.{sd}'].tail_local.z, B[f'toe.{sd}'].head_local.z) for sd in 'LR'}
    f0, f1 = act.frame_range
    names = {g.index: g.name for g in body.vertex_groups}
    keep = ('hips', 'spine', 'neck', 'head', 'thigh', 'shin')
    core = np.array([v.index for v in body.data.vertices
                     if v.groups and names[max(v.groups, key=lambda g: g.weight).group].startswith(keep)], int)
    worst_toe, worst_body = 0.0, 0.0
    for f in range(int(f0), int(f1) + 1):
        sc.frame_set(f)
        if not death:
            for sd in 'LR':
                foot = rig.pose.bones[f'foot.{sd}']; toe = rig.pose.bones[f'toe.{sd}']
                ankle = foot.head.copy()
                pts = [toe.head.copy(), toe.tail.copy()]
                low = min(p.z for p in pts) - g_tip[sd]
                if low >= -0.004:
                    continue
                worst_toe = min(worst_toe, low)
                d = pts[1] - ankle; d.z = 0
                if d.length < 1e-4:
                    continue
                axis = Vector((0, 0, 1)).cross(d.normalized())      # +angle about it lowers the toes
                lo_a, hi_a = -1.4, 0.0
                def lowest(a):
                    rm = Matrix.Rotation(a, 3, axis)
                    return min((ankle + rm @ (p - ankle)).z for p in pts) - g_tip[sd]
                if lowest(lo_a) < 0:
                    ang = lo_a
                else:
                    for _ in range(18):
                        mid = (lo_a + hi_a) / 2
                        if lowest(mid) < 0:
                            hi_a = mid
                        else:
                            lo_a = mid
                    ang = lo_a
                M = Matrix.Translation(ankle) @ Matrix.Rotation(ang, 4, axis) @ Matrix.Translation(-ankle)
                foot.matrix = M @ foot.matrix
                bpy.context.view_layer.update()
                foot.keyframe_insert('rotation_quaternion', frame=f, group=foot.name)
        bpy.context.view_layer.update()
        oe = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
        me = oe.to_mesh()
        co = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get('co', co)
        oe.to_mesh_clear()
        zz = co.reshape(-1, 3)[:, 2]
        zmin = float(zz.min())
        if death:
            # lying down: rest the torso and legs on the floor; arms may dig in up to half of what they lack
            # (lifting by the lowest fist left the golem's corpse hovering 70 cm up on its knuckles)
            zmin = min(float(zz[core].min()), 0.5 * zmin)
        if zmin < -0.004:
            worst_body = min(worst_body, zmin)
            hips = rig.pose.bones['hips']
            m = hips.matrix.copy(); m.translation.z -= zmin
            hips.matrix = m
            bpy.context.view_layer.update()
            hips.keyframe_insert('location', frame=f, group='hips')
            hips.keyframe_insert('rotation_quaternion', frame=f, group='hips')
    # keep quaternion signs continuous after the edits (the VAT samples between keys)
    for bn in ('foot.L', 'foot.R', 'hips'):
        pb = rig.pose.bones[bn]
        last = None
        for f in range(int(f0), int(f1) + 1):
            sc.frame_set(f)
            q = pb.rotation_quaternion.copy()
            if last is not None and last.dot(q) < 0:
                q.negate()
                pb.rotation_quaternion = q
                pb.keyframe_insert('rotation_quaternion', frame=f, group=bn)
            last = q
    R.set_action(rig, None)
    return worst_toe, worst_body


def weapon_objects(wid):
    p = L.WORK / 'blend' / f'{wid}_clean.blend'
    with bpy.data.libraries.load(str(p), link=False) as (src, dst):
        dst.objects = [wid, f'{wid}_lod1']
    out = []
    for o in dst.objects:
        bpy.context.scene.collection.objects.link(o)
        out.append(o)
    return out


def hold_world(rig, lib, hold, side, s):
    """(bone name, world matrix) of a weapon-frame object held as `hold` on `side`, in the rest pose."""
    sg = 1 if side == 'L' else -1
    bn = hold['bone'] if hold.get('central') else f"{hold['bone']}.{side}"
    lb = lib.data.bones[bn]
    ax = Vector(hold['axis']); ax.x *= sg
    fc = Vector(hold['face']); fc.x *= sg
    zw = ax.normalized(); yw = -fc.normalized(); yw = (yw - zw * yw.dot(zw)).normalized(); xw = yw.cross(zw)
    W = Matrix((xw, yw, zw)).transposed().to_4x4()
    W.translation = lb.head_local + (lb.tail_local - lb.head_local) * hold['along'] + fc * hold['off']
    local = lb.matrix_local.inverted() @ W
    local.translation = local.translation * s
    if hold.get('shift'):
        local = local @ Matrix.Translation((0, 0, hold['shift']))        # along the weapon's own axis, in metres
    tb = rig.data.bones[bn]
    return bn, rig.matrix_world @ tb.matrix_local @ local


def attach(rig, lib, ob, wid, side, s, name):
    hold = HOLDS[WEAPON_HOLD.get(wid) or L.assets().get(wid, {}).get('hold', 'fist')]     # assets.json `hold` for new weapons
    bn, world = hold_world(rig, lib, hold, side, s)
    ob.name = name
    ob.parent = rig
    ob.parent_type = 'BONE'
    ob.parent_bone = bn
    bpy.context.view_layer.update()
    ob.matrix_world = world
    return bn


def main():
    aid = L.argv()[0]
    L.webp_quality(aid)                          # assets.json `webp_q`
    a = L.assets()[aid]
    bpy.ops.wm.open_mainfile(filepath=str(L.WORK / 'blend' / f'{aid}_clean.blend'))
    sc = bpy.context.scene
    sc.render.fps = 24
    lod0 = bpy.data.objects[aid]; lod1 = bpy.data.objects[f'{aid}_lod1']
    H = a['height']
    if a.get('clipset') == 'staff':
        WEAPON_HOLD['weapon_staff'] = 'fist'        # the 'staff' clipset grips the shaft in the fist (thumb = staff axis)
    lib = load_lib()
    co = surface_points(lod0)
    rig, land = build_rig(aid, lib, co, H)
    s = land['s']
    print('[rig] landmarks', json.dumps({k: v for k, v in land.items() if k != 'ycen'})[:600])
    # `parts` with a `hold` (team-tinted shields / banners merged into the unit mesh): where a weapon would sit.
    # cleanup.py places the piece with this matrix on the next run (first run: by `pos`).
    holds = {}
    for p in a.get('parts', []):
        if p.get('hold'):
            bn, world = hold_world(rig, lib, dict(HOLDS[p['hold']], **p.get('hold_adjust', {})), p.get('side', 'L'), s)
            holds[p['name']] = [list(r) for r in world]
            if p.get('bone') != bn:
                print(f"[rig] WARNING {aid}: part {p['name']} hold bone is {bn} but `bone` is {p.get('bone')}")
    if holds:
        hf = L.WORK / 'clean' / f'{aid}_holds.json'
        old = hf.read_text() if hf.exists() else ''
        new = json.dumps(holds)
        hf.write_text(new)
        print(f'[rig] {aid}: hold matrices {"unchanged" if old == new else "CHANGED -> rebuild from cleanup"}')
    ok = skin(aid, rig, [lod0, lod1], H)
    # weapons
    wnodes = []
    for wid, side in a.get('weapons', []):
        w0, w1 = weapon_objects(wid)
        bn = attach(rig, lib, w0, wid, side, s, f'{wid}_{side}')
        attach(rig, lib, w1, wid, side, s, f'{wid}_{side}_lod1')
        wnodes.append(dict(id=wid, node=f'{wid}_{side}', bone=bn))
    # clips
    mapping = dict(COMMON, **CLIPSETS[a.get('clipset', 'sword')])
    mapping.update(a.get('clips', {}))          # per-asset overrides, e.g. {"run": "jog"}
    # hips travel scales with LEG length, not body height: short-legged units (golem, skirted squads) otherwise
    # bob too far and sink below the ground in the death clips
    hs = rig.data.bones['hips'].head_local.z / lib.data.bones['hips'].head_local.z
    hoff = rig.data.bones['hips'].head_local - lib.data.bones['hips'].head_local * hs
    bones = [b.name for b in rig.data.bones]
    clips = {}
    rigid_wrist = None
    if a.get('clipset') == 'fist':
        # giant fists (golem): lock the wrists so the fist stays in line with the forearm
        rel = {s_: rig.data.bones[f'forearm.{s_}'].matrix_local.to_3x3().inverted() @ rig.data.bones[f'hand.{s_}'].matrix_local.to_3x3() for s_ in 'LR'}
        def rigid_wrist(f, rot, tgt):
            for s_ in 'LR':
                if f'forearm.{s_}' in rot:
                    rot[f'hand.{s_}'] = (rot[f'forearm.{s_}'] @ rel[s_]).normalized()
    for final in FINAL_CLIPS:
        src = bpy.data.actions[f'lib_{mapping[final]}']
        nf = int(src.get('frames', src.frame_range[1] + 1))
        act = R.bake(rig, final, [dict(arm=lib, action=src, map={b: b for b in bones}, start=0, end=nf - 1)],
                     rule='absolute', hips_scale=hs, hips_offset=hoff, extra=rigid_wrist)
        clips[final] = dict(frames=nf, duration=round((nf - 1) / sc.render.fps, 4), loop=final in LOOPS,
                            source=mapping[final])
    for final in FINAL_CLIPS:
        wt, wb = ground_fix(rig, lod1, bpy.data.actions[final], death=final.startswith('death'))
        if wt < -0.02 or wb < -0.02:
            print(f'[rig] ground fix {final}: toes were {-wt * 100:.0f} cm, body {-wb * 100:.0f} cm under the floor')
    R.set_action(rig, bpy.data.actions['idle'])
    # drop the library before export so only the unit's clips are exported
    bpy.data.objects.remove(lib, do_unlink=True)
    for act in list(bpy.data.actions):
        if act.name.startswith('lib_'):
            bpy.data.actions.remove(act)
    for act in bpy.data.actions:
        act.use_fake_user = True
    rig.name = 'rig'; rig.data.name = 'rig'
    L.OUT.mkdir(parents=True, exist_ok=True)
    w0s = [bpy.data.objects[w['node']] for w in wnodes]
    w1s = [bpy.data.objects[w['node'] + '_lod1'] for w in wnodes]
    dst = L.WORK / 'clean' if a.get('part') else L.OUT    # rider parts only feed creature.py
    L.export_glb(dst / f'{aid}.glb', [rig, lod0] + w0s, anims=True)
    if not a.get('squad') or a.get('part'):
        L.export_glb(dst / f'{aid}_lod1.glb', [rig, lod1] + w1s, anims=True)   # squads: vat.py writes the crowd LOD1
    bpy.ops.wm.save_as_mainfile(filepath=str(L.WORK / 'blend' / f'{aid}_rig.blend'), compress=True)
    facts = dict(id=aid, height=H, tris_lod0=L.tris(lod0) + sum(L.tris(w) for w in w0s),
                 tris_lod1=L.tris(lod1) + sum(L.tris(w) for w in w1s), weapons=wnodes, clips=clips,
                 weights_ok=ok, team_frac=lod0.get('team_frac', 0), bones=bones, scale_vs_mannequin=s)
    (L.WORK / 'clean').mkdir(parents=True, exist_ok=True)
    (L.WORK / 'clean' / f'{aid}.json').write_text(json.dumps(facts, indent=1))
    print('[rig] done', aid, facts['tris_lod0'], facts['tris_lod1'])


if __name__ == '__main__':
    main()
