"""Creature + mounted builder: procedural quadruped / winged skeleton fitted to a cleaned AI mesh, bone-heat skin,
procedural clips; for mounted units the rider (rigged humanoid part) is merged into the same armature, seated on
a saddle bone, so the unit is ONE skeleton, ONE set of clips and (for squads) one crowd mesh + VAT.

blender -b --factory-startup --python tools/art/blender/creature.py -- <unit id>
  dragon            : standalone creature (art-work/blend/dragon_clean.blend)
  cavalier/pegasus/wyvern : mount = assets[id].mount, rider = assets[id].rider (needs <rider>_rig.blend)

Mount bones are prefixed `m_`: m_root, m_body (pelvis->chest), m_neck, m_head, m_tail1/2, m_leg_{fl,fr,bl,br}_{1,2},
m_wing_{l,r}_{1,2}. Rider bones keep the humanoid names; the rider's `root` is parented to `m_body`.
Clips (24 fps source): idle, walk, run, attack_melee_a, attack_melee_b, attack_bow, cast, hit, death_a, death_b,
victory -- same names as the humanoids. Fliers flap in every clip and hover 0.4 m higher while moving.
"""
import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

import art_lib as L
import retarget as R
import rig as RG

FPS = 24
CLIPS = {'idle': 48, 'walk': 24, 'run': 16, 'attack_melee_a': 24, 'attack_melee_b': 24, 'attack_bow': 24, 'cast': 24,
         'hit': 10, 'death_a': 36, 'death_b': 36, 'victory': 48}
LOOPS = {'idle', 'walk', 'run', 'victory'}


# ----------------------------------------------------------------------------------------------- skeleton
def landmarks(co, winged, biped):
    z = co[:, 2]; H = z.max()
    y = co[:, 1]; L_ = y.max() - y.min()
    low = co[z < 0.22 * H]
    legs = {}
    if biped:
        for side, sg in (('l', 1), ('r', -1)):
            p = low[sg * low[:, 0] > 0]
            if len(p):
                legs[f'f{side}'] = p.mean(0)
    else:
        ymid = np.median(low[:, 1]) if len(low) else 0
        for fb, cond in (('f', low[:, 1] < ymid), ('b', low[:, 1] >= ymid)):
            for side, sg in (('l', 1), ('r', -1)):
                p = low[cond & (sg * low[:, 0] > 0)]
                if len(p):
                    legs[f'{fb}{side}'] = p.mean(0)
    # belly: lowest z whose slice spans most of the body length
    zb = 0.45 * H
    for zk in np.arange(0.15, 0.8, 0.02) * H:
        sl = co[np.abs(z - zk) < 0.01 * H]
        if len(sl) > 20 and np.ptp(sl[:, 1]) > 0.45 * L_:
            zb = zk; break
    leg_y = [v[1] for v in legs.values()] or [0.0]
    yf, yb = min(leg_y), max(leg_y)
    if biped:
        yf, yb = yf - 0.25 * L_, yb + 0.1 * L_
    body_core = co[(np.abs(co[:, 0]) < 0.15 * max(1e-3, np.ptp(co[:, 0]))) | (z < zb + 0.3 * H)]
    def top_at(yy):
        sl = co[(np.abs(co[:, 1] - yy) < 0.05 * L_) & (np.abs(co[:, 0]) < 0.25 * L_)]
        return sl[:, 2].max() if len(sl) else zb + 0.25 * H
    back_z = min(top_at((yf + yb) / 2), zb + 0.35 * H)
    head = co[co[:, 1] < y.min() + 0.08 * L_]
    tail = co[co[:, 1] > y.max() - 0.06 * L_]
    lm = dict(H=H, L=L_, zb=zb, yf=yf, yb=yb, back=back_z, legs=legs,
              head=head.mean(0) if len(head) else np.array([0, y.min(), 0.8 * H]),
              tail=tail.mean(0) if len(tail) else np.array([0, y.max(), 0.4 * H]))
    if winged:
        yc_ = (yf + yb) / 2
        band = co[(z > zb) & (z < back_z) & (np.abs(co[:, 1] - yc_) < 0.2 * L_)]
        bw = np.percentile(np.abs(band[:, 0]), 60) if len(band) > 20 else 0.2 * L_
        wl = co[co[:, 0] > bw * 1.4]; wr = co[co[:, 0] < -bw * 1.4]
        if len(wl) > 50 and len(wr) > 50:
            lm['wing'] = dict(bw=float(bw), l=wl[np.argmax(wl[:, 0])], r=wr[np.argmin(wr[:, 0])])
    return lm


def build_skeleton(name, co, winged, biped):
    lm = landmarks(co, winged, biped)
    H, zb = lm['H'], lm['zb']
    yc = (lm['yf'] + lm['yb']) / 2
    data = bpy.data.armatures.new(name); rig = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(rig)
    L.select_only(rig); bpy.ops.object.mode_set(mode='EDIT')
    def bone(n, h, t, parent=None):
        b = data.edit_bones.new(n); b.head = Vector(h); b.tail = Vector(t)
        if parent:
            b.parent = data.edit_bones[parent]
        return b
    body_z = (zb + lm['back']) / 2
    bone('m_root', (0, 0, 0), (0, -0.3 * H, 0))
    bone('m_body', (0, lm['yb'], body_z), (0, lm['yf'], body_z), 'm_root')
    hd = lm['head']
    neck_base = Vector((0, lm['yf'], lm['back']))
    head_base = neck_base.lerp(Vector(hd), 0.7)
    bone('m_neck', neck_base, head_base, 'm_body')
    bone('m_head', head_base, Vector(hd) + (Vector(hd) - head_base) * 0.3, 'm_neck')
    tl = lm['tail']
    tb = Vector((0, lm['yb'] + 0.05 * lm['L'], body_z + 0.1 * H))
    tm = tb.lerp(Vector(tl), 0.5)
    bone('m_tail1', tb, tm, 'm_body'); bone('m_tail2', tm, Vector(tl), 'm_tail1')
    for k, p in lm['legs'].items():
        top = Vector((p[0] * 0.9, p[1], zb + 0.05 * H)); knee = Vector((p[0], p[1], zb * 0.5)); foot = Vector((p[0], p[1], 0.02 * H))
        bone(f'm_leg_{k}_1', top, knee, 'm_body'); bone(f'm_leg_{k}_2', knee, foot, f'm_leg_{k}_1')
    if 'wing' in lm:
        w = lm['wing']
        for s, sg in (('l', 1), ('r', -1)):
            tip = Vector(w[s]); root = Vector((sg * w['bw'] * 0.8, lm['yf'] * 0.6 + yc * 0.4, lm['back']))
            mid = root.lerp(tip, 0.45)
            bone(f'm_wing_{s}_1', root, mid, 'm_body'); bone(f'm_wing_{s}_2', mid, tip, f'm_wing_{s}_1')
    for b in data.edit_bones:
        b.roll = 0
    bpy.ops.object.mode_set(mode='OBJECT')
    data.bones['m_root'].use_deform = False
    saddle = Vector((0, yc + 0.05 * lm['L'], lm['back']))
    return rig, lm, saddle


# ----------------------------------------------------------------------------------------------- motion
def rot_local(rig, bone, axis, ang):
    """Quaternion rotating `bone` by `ang` about an armature-space axis, expressed in its local frame."""
    r = rig.data.bones[bone].matrix_local.to_3x3()
    a = (r.inverted() @ Vector(axis)).normalized()
    return Quaternion(a, ang)


def mount_pose(rig, clip, t, n, flier, biped):
    """Local quaternions + root offset for the mount at frame t of n."""
    ph = 2 * math.pi * t / max(1, n)
    out = {}; off = Vector((0, 0, 0)); body_pitch = 0.0
    X = (1, 0, 0); Y = (0, 1, 0); Z = (0, 0, 1)
    def leg(k, a1, a2):
        if f'm_leg_{k}_1' in rig.pose.bones:
            out[f'm_leg_{k}_1'] = rot_local(rig, f'm_leg_{k}_1', X, a1)
            out[f'm_leg_{k}_2'] = rot_local(rig, f'm_leg_{k}_2', X, a2)
    moving = clip in ('walk', 'run')
    amp = {'walk': 0.35, 'run': 0.6}.get(clip, 0.0)
    if moving and not (flier and clip == 'run'):
        pairs = {'fl': 0, 'br': 0, 'fr': math.pi, 'bl': math.pi} if not biped else {'fl': 0, 'fr': math.pi}
        if clip == 'run' and not biped:
            pairs = {'fl': 0, 'fr': 0.4, 'bl': math.pi, 'br': math.pi + 0.4}
        for k, p0 in pairs.items():
            s = math.sin(ph + p0)
            leg(k, amp * s, -amp * 0.8 * max(0, -math.cos(ph + p0)))
        off.z = 0.04 * abs(math.sin(ph)) * (2 if clip == 'run' else 1)
        body_pitch = 0.04 * math.sin(2 * ph) if clip == 'run' else 0
    if flier:
        rate = {'idle': 2, 'walk': 2, 'run': 2, 'victory': 4}.get(clip, 2)
        flap = math.sin(ph * rate)
        big = 0.7 if clip in ('walk', 'run', 'victory') else 0.35
        for s, sg in (('l', 1), ('r', -1)):
            if f'm_wing_{s}_1' in rig.pose.bones:
                out[f'm_wing_{s}_1'] = rot_local(rig, f'm_wing_{s}_1', Y, -sg * big * flap)
                out[f'm_wing_{s}_2'] = rot_local(rig, f'm_wing_{s}_2', Y, -sg * big * 0.6 * math.sin(ph * rate - 0.6))
        if clip in ('walk', 'run'):
            off.z = 0.35 + 0.08 * math.sin(ph * rate)
            for k in ('fl', 'fr', 'bl', 'br'):
                leg(k, -0.5 if k[0] == 'f' else 0.6, 0.9 if k[0] == 'f' else -0.4)
    # breathing / head / tail life
    out['m_neck'] = rot_local(rig, 'm_neck', X, 0.05 * math.sin(ph))
    out['m_tail1'] = rot_local(rig, 'm_tail1', Z, 0.15 * math.sin(ph))
    out['m_tail2'] = rot_local(rig, 'm_tail2', Z, 0.2 * math.sin(ph - 0.8))
    u = t / max(1, n - 1)
    if clip.startswith('attack') or clip == 'cast':
        k = math.sin(math.pi * min(1, u * 1.4)) if u < 0.72 else 0
        if biped or flier:   # lunge/bite with the head
            out['m_neck'] = rot_local(rig, 'm_neck', X, -0.5 * k)
            out['m_head'] = rot_local(rig, 'm_head', X, 0.3 * k)
            body_pitch = 0.08 * k          # +X pitch dips the front (lunge)
        else:                # horse: rear up and strike with the forelegs
            body_pitch = -0.35 * k         # -X pitch lifts the front (rear up)
            leg('fl', -0.9 * k, 1.0 * k); leg('fr', -0.7 * k, 1.1 * k)
            out['m_neck'] = rot_local(rig, 'm_neck', X, -0.3 * k)
    if clip == 'hit':
        body_pitch = -0.08 * math.sin(math.pi * u); out['m_head'] = rot_local(rig, 'm_head', X, 0.3 * math.sin(math.pi * u))
    if clip == 'victory' and not flier:
        k = 0.5 - 0.5 * math.cos(2 * ph)
        body_pitch = -0.3 * k; leg('fl', -0.7 * k, 1.0 * k); leg('fr', -0.6 * k, 1.1 * k)
    roll = 0.0
    if clip.startswith('death'):
        e = min(1, u * 1.6); e = e * e * (3 - 2 * e)
        roll = (1 if clip == 'death_a' else -1) * 1.45 * e
        off.z = -0.0
        for k in ('fl', 'fr', 'bl', 'br'):
            leg(k, 0.4 * e * (1 if k[0] == 'f' else -1), -0.3 * e)
        out['m_neck'] = rot_local(rig, 'm_neck', X, 0.4 * e)
        if flier:
            for s, sg in (('l', 1), ('r', -1)):
                if f'm_wing_{s}_1' in rig.pose.bones:
                    out[f'm_wing_{s}_1'] = rot_local(rig, f'm_wing_{s}_1', Y, sg * 0.6 * e)
    return out, off, body_pitch, roll


def solve(rig, desired, local, root_off, body_pitch, roll, frame, prev, hips_from=None):
    """Top-down solve: mount bones use local quaternions; rider bones take armature-space rotations
    (relative to the mount body's delta) from `desired`; keys everything at `frame`."""
    M = {}
    for n in R.order(rig):
        b = rig.data.bones[n]; pb = rig.pose.bones[n]
        rest = b.matrix_local
        parentM = M[b.parent.name] if b.parent else Matrix.Identity(4)
        rel = (b.parent.matrix_local.inverted() @ rest) if b.parent else rest
        if n == 'm_root':
            Lb = Matrix.Translation(Vector((0, 0, root_off.z))) @ Matrix.Rotation(roll, 4, 'Y')
            Lb = rest.inverted() @ Lb @ rest
        elif n == 'm_body':
            Lb = rot_local(rig, n, (1, 0, 0), body_pitch).to_matrix().to_4x4()
            if n in local:
                Lb = Lb @ local[n].to_matrix().to_4x4()
        elif n in local:
            Lb = local[n].to_matrix().to_4x4()
        elif n in desired:
            body = M['m_body'] @ rig.data.bones['m_body'].matrix_local.inverted()
            Rw = body.to_3x3() @ desired[n]
            Mb = Rw.to_4x4(); Mb.translation = (parentM @ rel).translation
            if n == 'hips' and hips_from is not None:
                Mb.translation = body @ hips_from
            Lb = rel.inverted() @ parentM.inverted() @ Mb
        else:
            Lb = Matrix.Identity(4)
        q = Lb.to_quaternion()
        if n in prev and prev[n].dot(q) < 0:
            q.negate()
        prev[n] = q
        pb.rotation_mode = 'QUATERNION'; pb.rotation_quaternion = q
        pb.keyframe_insert('rotation_quaternion', frame=frame, group=n)
        if n in ('m_root', 'hips'):
            pb.location = Lb.translation; pb.keyframe_insert('location', frame=frame, group=n)
        M[n] = parentM @ rel @ Lb
    return prev


# ----------------------------------------------------------------------------------------------- build
def append(path, names):
    with bpy.data.libraries.load(str(path), link=False) as (src, dst):
        dst.objects = [n for n in names if n in src.objects]
        if any(n == '__actions__' for n in names):
            dst.actions = [a for a in src.actions if a.startswith('lib_')]
    for o in dst.objects:
        bpy.context.scene.collection.objects.link(o)
    return {o.name: o for o in dst.objects}


def main():
    uid = L.argv()[0]
    a = L.assets()[uid]
    flier = a['kind'] == 'flier'
    mount_id = a.get('mount', uid)
    rider_id = a.get('rider')
    biped = mount_id == 'wyvern_mount'
    bpy.ops.wm.open_mainfile(filepath=str(L.WORK / 'blend' / f'{mount_id}_clean.blend'))
    sc = bpy.context.scene; sc.render.fps = FPS
    m0 = bpy.data.objects[mount_id]; m1 = bpy.data.objects[f'{mount_id}_lod1']
    Hm = L.assets()[mount_id]['height'] if rider_id else a['height']
    co = RG.surface_points(m0)
    rig, lm, saddle = build_skeleton('rig', co, flier, biped)
    print('[creature] landmarks', {k: (round(float(v), 3) if np.ndim(v) == 0 else [round(float(x), 2) for x in np.ravel(v)]) for k, v in lm.items() if k not in ('legs', 'wing')}, list(lm['legs']), 'wing' in lm)
    RG.skin(mount_id, rig, [m0, m1], Hm)
    meshes0, meshes1, weapons = [m0], [m1], []
    lib = None
    if rider_id:
        rpath = L.WORK / 'blend' / f'{rider_id}_rig.blend'
        objs = append(rpath, ['rig', rider_id, f'{rider_id}_lod1'] + [f'{w}_{s}' for w, s in a.get('weapons', [])] +
                      [f'{w}_{s}_lod1' for w, s in a.get('weapons', [])])
        rrig = objs['rig'] if 'rig' in objs else next(o for o in objs.values() if o.type == 'ARMATURE')
        rrig.name = 'rider_rig'
        lib = RG.load_lib()
        # seat: move the rider rig so its hips sit on the saddle
        hips = rrig.data.bones['hips'].head_local
        seat = saddle + Vector((0, 0, 0.08 * Hm)) - hips
        rrig.location = seat
        bpy.context.view_layer.update()
        for o in objs.values():
            if o.type == 'MESH':
                (meshes1 if o.name.endswith('_lod1') else meshes0).append(o) if not o.name.startswith('weapon_') else weapons.append(o)
        wkeep = {o.name: (o.parent_bone, o.matrix_world.copy()) for o in weapons}
        mkeep = {o.name: o.matrix_world.copy() for o in list(meshes0[1:]) + list(meshes1[1:])}
        # join the rider armature into the mount armature
        L.select_only(rig, rrig); rig.select_set(True); rrig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.join()
        L.select_only(rig); bpy.ops.object.mode_set(mode='EDIT')
        rig.data.edit_bones['root'].parent = rig.data.edit_bones['m_body']
        bpy.ops.object.mode_set(mode='OBJECT')
        for o in list(meshes0[1:]) + list(meshes1[1:]):
            for m in o.modifiers:
                if m.type == 'ARMATURE':
                    m.object = rig
            o.parent = rig
            bpy.context.view_layer.update(); o.matrix_world = mkeep[o.name]
        for o in weapons:
            pbn, mw = wkeep[o.name]
            o.parent = rig; o.parent_type = 'BONE'; o.parent_bone = pbn
            bpy.context.view_layer.update(); o.matrix_world = mw
        rig.data.bones['root'].use_deform = False
    # ---- clips
    s_r = None
    sit = None
    if rider_id:
        rbones = [b.name for b in lib.data.bones]
        hips_rest = rig.data.bones['hips'].head_local.copy()
        hips_in_body = hips_rest.copy()          # armature-space rest; solve() applies the m_body delta
        sit_s = R.sample(lib, bpy.data.actions['lib_sit'], [0], rbones)[0]
        mapping = dict(RG.COMMON, **RG.CLIPSETS[a.get('clipset', 'sword')])
        mapping.update(walk='idle', run='idle')    # the rider rides: upper body from idle while moving
    facts_clips = {}
    for clip, n in CLIPS.items():
        act = bpy.data.actions.new(clip); act.use_fake_user = True
        R.set_action(rig, act)
        src = None
        if rider_id:
            src = bpy.data.actions[f'lib_{mapping[clip]}']
            nf = int(src.get('frames', src.frame_range[1] + 1))
            n = max(n, nf) if not clip in ('walk', 'run') else n
            smp = R.sample(lib, src, list(range(nf)), rbones)
        prev = {}
        for f in range(n):
            local, off, pitch, roll = mount_pose(rig, clip, f, n if clip in LOOPS else n, flier, biped)
            desired = {}
            if rider_id:
                pose = smp[f % nf] if clip in LOOPS else smp[min(f, nf - 1)]
                for bn in rbones:
                    if bn in ('root',):
                        continue
                    src_m = sit_s[bn] if (bn.startswith(('thigh', 'shin', 'foot', 'toe')) or bn == 'hips') else pose[bn]
                    desired[bn] = src_m.to_3x3().normalized()
            prev = solve(rig, desired, local, off, pitch, roll, f, prev, hips_from=hips_in_body if rider_id else None)
        R.set_action(rig, None)
        facts_clips[clip] = dict(frames=n, duration=round((n - 1) / FPS, 4), loop=clip in LOOPS)
    if lib:
        bpy.data.objects.remove(lib, do_unlink=True)
    for act in list(bpy.data.actions):
        if act.name.startswith('lib_'):
            bpy.data.actions.remove(act)
    R.set_action(rig, bpy.data.actions['idle'])
    # merge LOD meshes (rider + mount) per LOD so a unit is one skinned mesh per LOD (+ rigid weapons)
    def merge(objs, name):
        for o in objs:
            if o.parent != rig:
                mw = o.matrix_world.copy(); o.parent = rig; o.matrix_world = mw
        L.select_only(*objs); bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        ob = bpy.context.view_layer.objects.active; ob.name = name; ob.data.name = name
        return ob
    lod0 = merge(meshes0, uid); lod1 = merge(meshes1, f'{uid}_lod1')
    for o in (lod0, lod1):
        if not any(m.type == 'ARMATURE' for m in o.modifiers):
            o.modifiers.new('Armature', 'ARMATURE').object = rig
    w0 = [o for o in weapons if not o.name.endswith('_lod1')]; w1 = [o for o in weapons if o.name.endswith('_lod1')]
    dst = L.OUT
    L.export_glb(dst / f'{uid}.glb', [rig, lod0] + w0, anims=True)
    if not a.get('squad'):
        L.export_glb(dst / f'{uid}_lod1.glb', [rig, lod1] + w1, anims=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(L.WORK / 'blend' / f'{uid}_rig.blend'), compress=True)
    facts = dict(id=uid, height=a['height'], tris_lod0=L.tris(lod0) + sum(L.tris(w) for w in w0),
                 tris_lod1=L.tris(lod1) + sum(L.tris(w) for w in w1), clips=facts_clips,
                 weapons=[dict(id=w.name.rsplit('_', 1)[0], node=w.name, bone=w.parent_bone) for w in w0],
                 team_frac=max(m0.get('team_frac', 0), 0.01), bones=[b.name for b in rig.data.bones],
                 mount=mount_id, rider=rider_id)
    (L.WORK / 'clean' / f'{uid}.json').write_text(json.dumps(facts, indent=1))
    print('[creature] done', uid, facts['tris_lod0'], facts['tris_lod1'])


if __name__ == '__main__':
    main()
