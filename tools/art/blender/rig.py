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
COMMON = dict(idle='idle', walk='walk', run='run', attack_bow='bow', cast='cast', hit='hit',
              death_a='death_a', death_b='death_b', victory='victory')
CLIPSETS = {
    'sword': dict(attack_melee_a='swing_a', attack_melee_b='swing_b'),
    'spear': dict(attack_melee_a='thrust_a', attack_melee_b='thrust_b', idle='idle_spear', walk='walk_spear', run='run_spear'),
    'bow': dict(attack_melee_a='jab', attack_melee_b='cross'),
    'cast': dict(attack_melee_a='swing_a', attack_melee_b='swing_b'),
    'fist': dict(attack_melee_a='jab', attack_melee_b='cross'),
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
}
WEAPON_HOLD = {'weapon_bow': 'bow', 'weapon_tome': 'tome', 'weapon_shield_kite': 'shield', 'weapon_shield_round': 'shield', 'weapon_staff': 'staff'}


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
    # ---- legs
    for side, sg in (('L', 1), ('R', -1)):
        pts = []
        for zk in np.arange(0.06, 0.42, 0.01) * H:
            sl = co[np.abs(z - zk) < th]
            if len(sl) < 8:
                continue
            segs = segments(sl[:, 0], 0.01 * H)
            mine = [sg_ for sg_ in segs if (sg * (sg_[0] + sg_[1]) / 2) > 0.01 * H]
            if len(segs) >= 2 and mine:
                lo, hi = mine[0] if sg < 0 else mine[0]
                lo, hi = min(mine, key=lambda q: abs((q[0] + q[1]) / 2))
                m = (sl[:, 0] >= lo) & (sl[:, 0] <= hi)
                pts.append((zk, sl[m, 0].mean(), sl[m, 1].mean()))
        if len(pts) >= 5:
            P = np.array(pts)
            A = np.c_[P[:, 0], np.ones(len(P))]
            land[f'leg_{side}'] = dict(kx=np.linalg.lstsq(A, P[:, 1], rcond=None)[0].tolist(),
                                       ky=np.linalg.lstsq(A, P[:, 2], rcond=None)[0].tolist(), n=len(pts))
    # ---- torso depth centre per height
    def ycen(zk):
        sl = co[(np.abs(z - zk) < th * 2) & (np.abs(co[:, 0]) < 0.08 * H)]
        return float((sl[:, 1].min() + sl[:, 1].max()) / 2) if len(sl) > 4 else 0.0
    land['ycen'] = {round(f, 2): ycen(f * H) for f in np.arange(0.40, 0.99, 0.02)}
    foot = co[z < 0.04 * H]
    land['toe_y'] = float(foot[:, 1].min()) if len(foot) else -0.15 * s
    # crotch: lowest height where the body centre line is filled for 4 consecutive slices. Used only when it is
    # clearly lower than the mannequin's (short-legged bruisers); robes fill the centre from the floor -> ignored.
    filled = [(zk, bool((np.abs(co[np.abs(z - zk) < th][:, 0]) < 0.012 * H).any())) for zk in np.arange(0.06, 0.6, 0.01) * H]
    for i in range(len(filled) - 4):
        if all(f for _, f in filled[i:i + 4]):
            cz = filled[i][0] / H
            if 0.18 < cz < 0.43:
                land['crotch'] = float(filled[i][0])
            break
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
    if 'crotch' in land:
        hip = land['crotch'] + 0.05 * H
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
    """Bone-heat weights on a voxel proxy, transferred to every mesh in `meshes`."""
    src = meshes[0]
    proxy = src.copy(); proxy.data = src.data.copy(); proxy.name = f'{aid}_proxy'
    bpy.context.scene.collection.objects.link(proxy)
    proxy.data.materials.clear()
    ok = False
    # first try bone heat directly on the (already voxel-remeshed, watertight) LOD0; then coarser voxel proxies
    for vs in (None, H / 140, H / 100, H / 70):
        for m in list(proxy.modifiers):
            proxy.modifiers.remove(m)
        proxy.data = src.data.copy()
        if vs is not None:
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
    bpy.data.objects.remove(proxy, do_unlink=True)
    return ok


def weapon_objects(wid):
    p = L.WORK / 'blend' / f'{wid}_clean.blend'
    with bpy.data.libraries.load(str(p), link=False) as (src, dst):
        dst.objects = [wid, f'{wid}_lod1']
    out = []
    for o in dst.objects:
        bpy.context.scene.collection.objects.link(o)
        out.append(o)
    return out


def attach(rig, lib, ob, wid, side, s, name):
    hold = HOLDS[WEAPON_HOLD.get(wid, 'fist')]
    sg = 1 if side == 'L' else -1
    bn = f"{hold['bone']}.{side}"
    lb = lib.data.bones[bn]
    ax = Vector(hold['axis']); ax.x *= sg
    fc = Vector(hold['face']); fc.x *= sg
    zw = ax.normalized(); yw = -fc.normalized(); yw = (yw - zw * yw.dot(zw)).normalized(); xw = yw.cross(zw)
    W = Matrix((xw, yw, zw)).transposed().to_4x4()
    W.translation = lb.head_local + (lb.tail_local - lb.head_local) * hold['along'] + fc * hold['off']
    local = lb.matrix_local.inverted() @ W
    local.translation = local.translation * s
    tb = rig.data.bones[bn]
    world = rig.matrix_world @ tb.matrix_local @ local
    ob.name = name
    ob.parent = rig
    ob.parent_type = 'BONE'
    ob.parent_bone = bn
    bpy.context.view_layer.update()
    ob.matrix_world = world
    return bn


def main():
    aid = L.argv()[0]
    a = L.assets()[aid]
    bpy.ops.wm.open_mainfile(filepath=str(L.WORK / 'blend' / f'{aid}_clean.blend'))
    sc = bpy.context.scene
    sc.render.fps = 24
    lod0 = bpy.data.objects[aid]; lod1 = bpy.data.objects[f'{aid}_lod1']
    H = a['height']
    lib = load_lib()
    co = surface_points(lod0)
    rig, land = build_rig(aid, lib, co, H)
    s = land['s']
    print('[rig] landmarks', json.dumps({k: v for k, v in land.items() if k != 'ycen'})[:600])
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
    hs = s
    hoff = rig.data.bones['hips'].head_local - lib.data.bones['hips'].head_local * s
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
