"""Build the shared CC0 animation library on the Oathbound humanoid skeleton.

blender -b --factory-startup --python tools/art/blender/anim_library.py
Out: art-work/blend/anim_lib.blend  (armature `LibRig`, 23 bones, Quaternius UAL1 rest pose = T-pose;
     actions `lib_<name>`).

Sources (both CC0 1.0, Quaternius, downloaded from opengameart.org):
  UAL1 = Universal Animation Library [Standard]   (Rigify DEF-* bone names)
  UAL2 = Universal Animation Library 2 [Standard] (UE-style names; same joint positions, different bone rolls ->
         retargeted with the 'delta' rule)
Procedural clips (bow draw, victory pump) are authored here on top of the idle loop (CC0, ours).
Finger bones are dropped: the AI meshes have mitten hands.
"""
import math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
from mathutils import Matrix, Quaternion, Vector

import art_lib as L
import retarget as R

DL = L.WORK / 'downloads'
UAL1 = DL / 'ual1' / 'Animation Library[Standard]' / 'Godot' / 'AnimationLibrary_Godot_Standard.glb'
UAL2 = DL / 'ual2' / 'Universal Animation Library 2 [Standard]' / 'Unreal-Godot' / 'UAL2_Standard.glb'

# our bone -> (UAL1 bone, UAL2 bone)
BONES = {
    'root': ('root', 'root'), 'hips': ('DEF-hips', 'pelvis'),
    'spine1': ('DEF-spine.001', 'spine_01'), 'spine2': ('DEF-spine.002', 'spine_02'), 'spine3': ('DEF-spine.003', 'spine_03'),
    'neck': ('DEF-neck', 'neck_01'), 'head': ('DEF-head', 'Head'),
}
for s, u in (('L', 'l'), ('R', 'r')):
    BONES.update({
        f'shoulder.{s}': (f'DEF-shoulder.{s}', f'clavicle_{u}'), f'upper_arm.{s}': (f'DEF-upper_arm.{s}', f'upperarm_{u}'),
        f'forearm.{s}': (f'DEF-forearm.{s}', f'lowerarm_{u}'), f'hand.{s}': (f'DEF-hand.{s}', f'hand_{u}'),
        f'thigh.{s}': (f'DEF-thigh.{s}', f'thigh_{u}'), f'shin.{s}': (f'DEF-shin.{s}', f'calf_{u}'),
        f'foot.{s}': (f'DEF-foot.{s}', f'foot_{u}'), f'toe.{s}': (f'DEF-toe.{s}', f'ball_{u}'),
    })


def import_rig(path, tag):
    objs = L.import_glb(path)
    arm = next(o for o in objs if o.type == 'ARMATURE')
    for o in objs:
        if o.type == 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    arm.name = tag
    acts = {}
    for a in bpy.data.actions:
        if not a.get('_src'):
            a['_src'] = tag
            acts[a.name] = a
    return arm, acts


def build_lib_rig(src):
    """Copy the UAL1 deform skeleton (minus fingers) with identical rest matrices."""
    data = bpy.data.armatures.new('LibRig')
    rig = bpy.data.objects.new('LibRig', data)
    bpy.context.scene.collection.objects.link(rig)
    L.select_only(src)
    bpy.ops.object.mode_set(mode='EDIT')
    rest = {n: (src.data.edit_bones[s].head.copy(), src.data.edit_bones[s].tail.copy(), src.data.edit_bones[s].roll,
                src.data.edit_bones[s].parent.name if src.data.edit_bones[s].parent else None)
            for n, (s, _) in BONES.items()}
    bpy.ops.object.mode_set(mode='OBJECT')
    inv = {s: n for n, (s, _) in BONES.items()}
    L.select_only(rig)
    bpy.ops.object.mode_set(mode='EDIT')
    for n, (h, t, r, p) in rest.items():
        eb = data.edit_bones.new(n); eb.head = h; eb.tail = t; eb.roll = r
    for n, (h, t, r, p) in rest.items():
        if p:
            data.edit_bones[n].parent = data.edit_bones[inv[p]]
            data.edit_bones[n].use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    rig.matrix_world = src.matrix_world.copy()
    return rig


def aim_rot(rig, bone, d):
    rest = rig.data.bones[bone].matrix_local.to_3x3()
    y = rest.col[1].normalized()
    q = y.rotation_difference(Vector(d).normalized())
    return (q.to_matrix() @ rest).normalized()


def frame_rot(rig, bone, ydir, tdir):
    """Rotation giving `bone` its Y axis along ydir and its rest 'thumb' direction (armature -Y in the T-pose)
    along tdir -- full orientation control for wrist poses (spear grips)."""
    rest = rig.data.bones[bone].matrix_local.to_3x3()
    y0 = rest.col[1].normalized()
    t0 = Vector((0, -1, 0)); t0 = (t0 - y0 * t0.dot(y0)).normalized()
    y1 = Vector(ydir).normalized(); t1 = Vector(tdir); t1 = (t1 - y1 * t1.dot(y1)).normalized()
    A = Matrix((y0, t0, y0.cross(t0))).transposed()
    B = Matrix((y1, t1, y1.cross(t1))).transposed()
    return (B @ A.inverted() @ rest).normalized()


def to_rot(rig, b, spec):
    if len(spec) == 2 and hasattr(spec[0], '__len__'):
        return frame_rot(rig, b, spec[0], spec[1])
    return aim_rot(rig, b, spec)


def blend_rot(a, b, w):
    qa, qb = a.to_quaternion(), b.to_quaternion()
    return qa.slerp(qb, w).to_matrix()


def keyed_layer(keys, total):
    """keys: list of (frame, {bone: dir} | None). Returns f -> ({bone: dir}, weight) by linear interp."""
    def at(f):
        f = f % total if total else f
        for (f0, p0), (f1, p1) in zip(keys, keys[1:]):
            if f0 <= f <= f1:
                t = 0 if f1 == f0 else (f - f0) / (f1 - f0)
                t = t * t * (3 - 2 * t)
                return p0, p1, t
        return keys[-1][1], keys[-1][1], 0
    return at


def procedural(rig, keys, total):
    at = keyed_layer(keys, total)
    def extra(f, rot, tgt):
        p0, p1, t = at(f)
        bones = set((p0 or {}).keys()) | set((p1 or {}).keys())
        for b in bones:
            src = rot.get(b, tgt.data.bones[b].matrix_local.to_3x3())
            r0 = to_rot(tgt, b, p0[b]) if p0 and b in p0 else src
            r1 = to_rot(tgt, b, p1[b]) if p1 and b in p1 else src
            rot[b] = blend_rot(r0, r1, t)
    return extra


def lerp_keys(keys, f):
    """keys: [(frame, value-dict)]; smoothstep interpolation of every numeric tuple in the dicts."""
    if f <= keys[0][0]:
        return keys[0][1]
    for (f0, a), (f1, b) in zip(keys, keys[1:]):
        if f0 <= f <= f1:
            t = 0 if f1 == f0 else (f - f0) / (f1 - f0)
            t = t * t * (3 - 2 * t)
            return {k: tuple(x + (y - x) * t for x, y in zip(a[k], b[k])) for k in a}
    return keys[-1][1]


def two_handed(rig, keys, grip=0.45, bob=None):
    """Two-handed polearm layer. keys: [(frame, {'R': right-hand position relative to the chest (spine3 head,
    armature axes, metres on the 1.83 m mannequin), 'axis': direction of the weapon head})]. Both arms are
    solved by 2-bone IK every frame: the right hand goes to R with the weapon along `axis`, the left hand grips
    the shaft `grip` metres further down. Fitted characters copy the bone orientations, so their hands meet the
    shaft to within their difference in proportions."""
    B = rig.data.bones
    def rel(parent, child):
        return B[parent].matrix_local.to_3x3().inverted() @ (B[child].head_local - B[parent].head_local)
    off = {sd: (rel('spine3', f'shoulder.{sd}'), rel(f'shoulder.{sd}', f'upper_arm.{sd}')) for sd in 'LR'}
    l1 = B['upper_arm.L'].length; l2 = B['forearm.L'].length
    rest = {b.name: b.matrix_local.to_3x3() for b in B}

    def solve(S, T, pole):
        d = T - S
        dist = min(d.length, (l1 + l2) * 0.985)
        dn = d.normalized()
        a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
        h = math.sqrt(max(0.0, l1 * l1 - a * a))
        pp = pole - dn * pole.dot(dn)
        pp = pp.normalized() if pp.length > 1e-4 else Vector((0, 0, -1))
        E = S + dn * a + pp * h
        return E, S + dn * dist

    def extra(f, rot, tgt):
        k = lerp_keys(keys, f)
        R = Vector(k['R']); axis = Vector(k['axis']).normalized()
        if bob:
            R = R + Vector(bob(f))
        g = k['g'][0] if 'g' in k else grip       # per-key grip distance (a pike shaft slides through the front hand)
        hands = {'R': R, 'L': R - axis * g}
        for sd, sg in (('R', -1.0), ('L', 1.0)):
            Rs3 = rot.get('spine3', rest['spine3'])
            Rsh = rot.get(f'shoulder.{sd}', rest[f'shoulder.{sd}'])
            S = Rs3 @ off[sd][0] + Rsh @ off[sd][1]
            E, T = solve(S, hands[sd], Vector((sg * 0.65, 0.35, -0.65)))
            up = (E - S).normalized(); fore = (T - E).normalized()
            bend = fore - up * fore.dot(up)
            bend = bend.normalized() if bend.length > 1e-3 else Vector((0, -1, 0))
            rot[f'upper_arm.{sd}'] = frame_rot(tgt, f'upper_arm.{sd}', up, bend)
            rot[f'forearm.{sd}'] = frame_rot(tgt, f'forearm.{sd}', fore, axis)
            fing = fore - axis * fore.dot(axis)
            fing = fing.normalized() if fing.length > 1e-3 else up
            rot[f'hand.{sd}'] = frame_rot(tgt, f'hand.{sd}', fing, axis)
    return extra


def stride(rig, k):
    """Shorten a locomotion clip's stride: blend the leg bones toward the straight standing pose (k = 1 keeps
    the clip, 0.5 halves the leg swing). The mannequin's walk covers 1.06 m/s and its 'jog' 5.9 m/s; nothing in
    the library fits the 2.6-3.4 m/s most units move at, so the jog is cut down to a contained trot."""
    legs = [f'{b}.{sd}' for b in ('thigh', 'shin', 'foot', 'toe') for sd in 'LR']
    stand = {b: rig.data.bones[b].matrix_local.to_3x3() for b in legs}
    def extra(f, rot, tgt):
        for b in legs:
            if b in rot:
                rot[b] = blend_rot(stand[b], rot[b], k)
    return extra


def weighted(pose, wfun, shift=None):
    """Blend the pose (bone -> direction spec) over whatever the clip has, with weight wfun(frame) in 0..1;
    `shift` (armature-space offset in metres on the mannequin) moves the hips by weight x shift (lunges)."""
    def extra(f, rot, tgt):
        w = wfun(f)
        if w <= 0:
            return
        for b, spec in pose.items():
            src = rot.get(b, tgt.data.bones[b].matrix_local.to_3x3())
            rot[b] = blend_rot(src, to_rot(tgt, b, spec), w)
        if shift is not None:
            rot['_hips_shift'] = rot.get('_hips_shift', Vector((0, 0, 0))) + Vector(shift) * w
    return extra


def fade(layer, f0, f1):
    """Apply `layer` fully up to frame f0, then fade it out by f1 (weapon carries released at the start of a
    death: without this the weapon popped from its carry to the hanging-arm orientation on the first frame)."""
    def extra(f, rot, tgt):
        w = 1.0 if f <= f0 else 0.0 if f >= f1 else 1 - (f - f0) / (f1 - f0)
        if w <= 0:
            return
        base = dict(rot)
        layer(f, rot, tgt)
        if w < 1:
            w = w * w * (3 - 2 * w)
            for b in list(rot):
                if b.startswith('_'):
                    continue
                if b in base:
                    if rot[b] is not base[b]:
                        rot[b] = blend_rot(base[b], rot[b], w)
                else:
                    rot[b] = blend_rot(tgt.data.bones[b].matrix_local.to_3x3(), rot[b], w)
    return extra


def upright(deg, bones=None):
    """Tip the upper body back by `deg` (the library jog leans 25 deg from hip to head -- a sprint; armoured
    squads read better at ~15)."""
    up = ['spine1', 'spine2', 'spine3', 'neck', 'head'] + [f'{b}.{sd}' for b in ('shoulder', 'upper_arm', 'forearm', 'hand') for sd in 'LR']
    Rx = Matrix.Rotation(-math.radians(deg), 3, 'X')
    def extra(f, rot, tgt):
        for b in (bones or up):
            if b in rot:
                rot[b] = (Rx @ rot[b]).normalized()
    return extra


def pulse_w(a, b, c, d):
    """Weight curve: 0 until frame a, 1 from b to c, 0 again from d (smoothstep ramps)."""
    def w(f):
        if f <= a or f >= d:
            return 0.0
        t = (f - a) / (b - a) if f < b else 1.0 if f <= c else 1 - (f - c) / (d - c)
        return t * t * (3 - 2 * t)
    return w


def chain(*layers):
    def extra(f, rot, tgt):
        for l in layers:
            l(f, rot, tgt)
    return extra


# great axe, two-handed (the Warden). R = right hand relative to the chest, axis = where the axe head points.
AX_READY = dict(R=(-0.13, -0.27, 0.00), axis=(-0.32, -0.12, 0.94))            # port arms: head over the right shoulder
AX_CARRY = dict(R=(-0.14, -0.26, -0.03), axis=(-0.38, -0.05, 0.92))
AX_CHARGE = dict(R=(-0.20, -0.30, -0.14), axis=(-0.22, -0.62, 0.75))          # run: axe lowered toward the enemy
AX_UP = dict(R=(-0.10, 0.02, 0.50), axis=(-0.12, 0.62, 0.78))                 # wound up behind the head
AX_HIT = dict(R=(-0.04, -0.50, -0.30), axis=(0.02, -0.90, -0.44))             # buried in front
AX_SUNK = dict(R=(-0.04, -0.50, -0.36), axis=(0.02, -0.86, -0.52))
AX_WIND = dict(R=(-0.36, -0.06, -0.04), axis=(-0.72, 0.62, 0.30))             # drawn back to the right
AX_SWEEP = dict(R=(0.10, -0.46, -0.10), axis=(0.55, -0.83, 0.05))             # through the target
AX_FOLLOW = dict(R=(0.20, -0.34, -0.06), axis=(0.93, -0.30, 0.20))
AX_ALOFT = dict(R=(-0.26, -0.06, 0.60), axis=(-1.0, 0.0, 0.08))               # victory: axe held overhead in both hands
SPINE_BACK = {'spine3': ((0, 0.20, 1), (-0.15, -0.99, 0)), 'spine1': ((0, 0.10, 1), (0, -1, 0))}
SPINE_CRUNCH = {'spine3': ((0, -0.38, 1), (0.1, -1, 0)), 'spine1': ((0, -0.22, 1), (0, -1, 0))}
SPINE_NEUTRAL = {'spine3': ((0, 0.02, 1), (0, -1, 0)), 'spine1': ((0, 0.0, 1), (0, -1, 0))}
SPINE_COIL = {'spine3': ((0, 0.04, 1), (-0.55, -0.83, 0)), 'spine1': ((0, 0.0, 1), (-0.25, -0.97, 0))}
SPINE_UNCOIL = {'spine3': ((0, -0.12, 1), (0.55, -0.83, 0)), 'spine1': ((0, -0.06, 1), (0.25, -0.97, 0))}
SPINE_HEAVY = {'spine3': ((0, -0.10, 1), (0, -1, 0))}                          # weight carried low and forward
SPINE_LEAN = {'spine3': ((0, -0.26, 1), (0, -1, 0)), 'spine1': ((0, -0.12, 1), (0, -1, 0))}

BOW_READY = {'upper_arm.L': (0.35, -0.45, -0.82), 'forearm.L': (0.25, -0.85, -0.45), 'hand.L': (0.2, -0.9, -0.38)}
BOW_AIM = {'upper_arm.L': (0.3, -1, 0.06), 'forearm.L': (0.22, -1, 0.06), 'hand.L': (0.2, -1, 0.06),
           'upper_arm.R': (-0.72, 0.6, 0.06), 'forearm.R': (0.83, -0.54, 0.12), 'hand.R': (0.83, -0.54, 0.12)}
BOW_REL = dict(BOW_AIM, **{'upper_arm.R': (-0.85, 0.5, 0.12), 'forearm.R': (-0.45, 0.85, 0.25), 'hand.R': (-0.45, 0.85, 0.25)})
VIC_UP = {'upper_arm.R': (-0.25, -0.12, 0.96), 'forearm.R': (-0.08, -0.12, 0.99), 'hand.R': ((0, -1, 0.1), (0, 0.1, 1)),
          'upper_arm.L': (0.75, -0.15, -0.55), 'forearm.L': (0.55, -0.45, -0.6)}
# spear: forearm level, wrist flexed inward so the fist's thumb side (= weapon axis) points forward
TH_READY = {'upper_arm.R': (-0.3, -0.25, -0.92), 'forearm.R': (-0.05, -0.97, -0.2), 'hand.R': ((0.95, -0.1, -0.2), (0, -1, 0.05)),
            'upper_arm.L': (0.25, -0.35, -0.9), 'forearm.L': (-0.3, -0.9, -0.3)}
# the thrust comes from the body: chest coils back to the spear side, then drives forward over the front foot
TH_READY = dict(TH_READY, **{'spine3': ((0, 0.02, 1), (0, -1, 0))})
TH_PULL = dict(TH_READY, **{'upper_arm.R': (-0.45, 0.45, -0.77), 'forearm.R': (0.1, -0.98, -0.1), 'spine3': ((0, 0.10, 1), (-0.42, -0.91, 0))})
TH_HIT = dict(TH_READY, **{'upper_arm.R': (-0.15, -0.95, -0.25), 'forearm.R': (0.0, -1, 0.0), 'hand.R': ((0.95, -0.1, 0.05), (0, -1, 0.0)),
                            'spine3': ((0, -0.30, 1), (0.34, -0.94, 0))})
TH_HIGH_PULL = dict(TH_READY, **{'upper_arm.R': (-0.6, 0.3, 0.55), 'forearm.R': (0.15, -0.6, 0.8), 'hand.R': ((0.9, 0.1, 0.3), (0, -0.8, -0.6))})
TH_HIGH_HIT = dict(TH_READY, **{'upper_arm.R': (-0.3, -0.85, 0.35), 'forearm.R': (0.05, -0.97, -0.25), 'hand.R': ((0.9, -0.1, 0.1), (0, -0.95, -0.3))})
# upright sword swings (squads attack constantly: silhouettes stay tall). Hand specs are (finger dir, thumb dir);
# the sword blade runs along the thumb direction. spine3 specs (up, facing) twist the chest.
SW_READY = {'upper_arm.R': (-0.35, -0.25, -0.9), 'forearm.R': (-0.05, -0.9, -0.42), 'hand.R': ((0, -0.5, -0.85), (0, -0.85, 0.5)),
            'upper_arm.L': (0.4, -0.15, -0.9), 'forearm.L': (0.15, -0.7, -0.7), 'spine3': ((0, 0.04, 1), (0, -1, 0))}
SW_UP = dict(SW_READY, **{'upper_arm.R': (-0.4, 0.15, 0.9), 'forearm.R': (0.0, 0.55, 0.83), 'hand.R': ((0, 0.3, 0.95), (0, 0.95, -0.3)),
                          'spine3': ((0, 0.12, 1), (-0.35, -0.94, 0))})
SW_CHOP = dict(SW_READY, **{'upper_arm.R': (-0.2, -0.85, -0.45), 'forearm.R': (0.0, -0.8, -0.6), 'hand.R': ((0, -0.15, -0.99), (0, -1, 0.15)),
                            'spine3': ((0, -0.15, 1), (0.25, -0.97, 0))})
SW_WIDE = dict(SW_READY, **{'upper_arm.R': (-0.9, 0.35, -0.15), 'forearm.R': (-0.55, 0.75, 0.3), 'hand.R': ((-0.2, 0.2, 0.96), (-0.6, 0.8, 0)),
                            'spine3': ((0, 0.05, 1), (-0.45, -0.9, 0))})
SW_SWEEP = dict(SW_READY, **{'upper_arm.R': (0.25, -0.92, -0.2), 'forearm.R': (0.8, -0.55, -0.1), 'hand.R': ((0, 0, 1), (0.75, -0.66, 0)),
                             'spine3': ((0, -0.05, 1), (0.4, -0.92, 0))})
# polearm carry for idle / move: forearm forward, wrist turned so the shaft points forward and ~30 deg up
SP_CARRY = {'upper_arm.R': (-0.25, 0.0, -0.97), 'forearm.R': (-0.05, -0.85, -0.5), 'hand.R': ((0.9, -0.1, -0.35), (0, -0.87, 0.5))}
VIC_BENT = dict(VIC_UP, **{'upper_arm.R': (-0.55, -0.2, 0.8), 'forearm.R': (0.25, -0.45, 0.85), 'hand.R': ((0.2, -0.95, -0.1), (0.1, 0, 1))})


def main():
    L.clear()
    sc = bpy.context.scene
    sc.render.fps = 24
    a1, acts1 = import_rig(UAL1, 'UAL1')
    a2, acts2 = import_rig(UAL2, 'UAL2')
    for a in (a1, a2):
        R.set_action(a, None)
        for pb in a.pose.bones:
            pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0); pb.scale = (1, 1, 1)
    lib = build_lib_rig(a1)
    m1 = {n: s1 for n, (s1, _) in BONES.items()}
    m2 = {n: s2 for n, (_, s2) in BONES.items()}

    def seg(arm, acts, mp, name, mirror=False, start=None, end=None):
        act = acts[name]
        f0, f1 = act.frame_range
        return dict(arm=arm, action=act, map=mp, mirror=mirror,
                    start=f0 if start is None else start, end=f1 if end is None else end)

    U1 = lambda n, **k: seg(a1, acts1, m1, n, **k)
    U2 = lambda n, **k: seg(a2, acts2, m2, n, **k)
    clips = {
        'idle': [U1('Idle_Loop')],
        'idle_sword': [U1('Sword_Idle')],
        'walk': [U1('Walk_Loop')],
        'run': [U1('Jog_Fwd_Loop')],
        'slash_a': [U1('Sword_Attack')],
        'slash_b': [U2('Sword_Regular_B'), U2('Sword_Regular_B_Rec')],
        'slash_c': [U2('Sword_Regular_A'), U2('Sword_Regular_A_Rec')],
        'jab': [U1('Punch_Jab')],
        'cross': [U1('Punch_Cross')],
        'cast': [U1('Spell_Simple_Enter'), U1('Spell_Simple_Shoot'), U1('Spell_Simple_Exit')],
        'hit': [U1('Hit_Chest')],
        'hit_b': [U1('Hit_Head')],
        'death_a': [U1('Death01')],
        'death_b': [U1('Death01', mirror=True)],
        'knockback': [U2('Hit_Knockback')],
        'sit': [U1('Sitting_Idle_Loop')],
    }
    for name, segs in clips.items():
        rule = 'delta'
        act = R.bake(lib, f'lib_{name}', segs, rule=rule)
        print(f'[anim] {name}: {int(act["frames"])} frames')
    # procedural: bow draw-and-loose (36 f) and victory pump (48 f loop) layered on the idle loop
    bow = procedural(lib, [(0, BOW_READY), (9, BOW_AIM), (21, BOW_AIM), (23, BOW_REL), (28, BOW_REL), (36, BOW_READY)], 0)
    act = R.bake(lib, 'lib_bow', [U1('Idle_Loop', start=0, end=35)], rule='delta', extra=bow)
    print(f'[anim] bow: {int(act["frames"])} frames')
    sw = procedural(lib, [(0, SW_READY), (9, SW_UP), (14, SW_CHOP), (19, SW_CHOP), (30, SW_READY)], 0)
    R.bake(lib, 'lib_swing_a', [U1('Sword_Idle', start=0, end=29)], rule='delta', extra=sw)
    sw2 = procedural(lib, [(0, SW_READY), (9, SW_WIDE), (14, SW_SWEEP), (19, SW_SWEEP), (30, SW_READY)], 0)
    R.bake(lib, 'lib_swing_b', [U1('Sword_Idle', start=0, end=29)], rule='delta', extra=sw2)
    for base, src in (('idle', 'Idle_Loop'), ('walk', 'Walk_Loop'), ('run', 'Jog_Fwd_Loop')):
        carry = procedural(lib, [(0, SP_CARRY), (999, SP_CARRY)], 0)
        R.bake(lib, f'lib_{base}_spear', [U1(src)], rule='delta', extra=carry)
    th = procedural(lib, [(0, TH_READY), (8, TH_PULL), (12, TH_HIT), (18, TH_HIT), (28, TH_READY)], 0)
    R.bake(lib, 'lib_thrust_a', [U1('Sword_Idle', start=0, end=27)], rule='delta', extra=th)
    th2 = procedural(lib, [(0, TH_READY), (9, TH_HIGH_PULL), (14, TH_HIGH_HIT), (20, TH_HIGH_HIT), (30, TH_READY)], 0)
    R.bake(lib, 'lib_thrust_b', [U1('Sword_Idle', start=0, end=29)], rule='delta', extra=th2)
    ax = lambda keys, **k: two_handed(lib, keys, **k)
    hold = lambda sp: procedural(lib, [(0, sp), (999, sp)], 0)
    # ---- two-handed great axe (Warden): heavy timing -- walk and jog play 1.25x / 1.14x slower than the mannequin's
    R.bake(lib, 'lib_idle_axe', [U1('Idle_Loop')], rule='delta', extra=chain(hold(SPINE_HEAVY),
           ax([(0, AX_READY), (999, AX_READY)], bob=lambda f: (0, 0, 0.012 * math.sin(2 * math.pi * f / 60)))))
    R.bake(lib, 'lib_walk_axe', [U1('Walk_Loop')], rule='delta', fps_step=0.8, extra=chain(hold(SPINE_HEAVY),
           ax([(0, AX_CARRY), (999, AX_CARRY)], bob=lambda f: (0, 0, 0.018 * math.sin(4 * math.pi * f / 40)))))
    R.bake(lib, 'lib_jog', [U1('Jog_Fwd_Loop')], rule='delta', extra=stride(lib, 0.58))
    # sword arm carried in the ready stance while running: the mannequin pumps its fists, which swung the
    # blade point-down behind the runner (a visible weapon flip between walk and run)
    carry_sw = {k: SW_READY[k] for k in ('upper_arm.R', 'forearm.R', 'hand.R')}
    R.bake(lib, 'lib_run_sword', [U1('Jog_Fwd_Loop')], rule='delta', extra=hold(carry_sw))
    R.bake(lib, 'lib_jog_sword', [U1('Jog_Fwd_Loop')], rule='delta', extra=chain(stride(lib, 0.58), hold(carry_sw)))
    # the Warden keeps both hands on the axe when struck, and raises it to call his ability
    R.bake(lib, 'lib_hit_axe', [U1('Hit_Chest')], rule='delta', extra=ax([(0, AX_READY), (4, AX_CARRY), (999, AX_READY)]))
    R.bake(lib, 'lib_cast_axe', [U1('Sword_Idle', start=0, end=37)], rule='delta', extra=chain(
           procedural(lib, [(0, SPINE_NEUTRAL), (10, SPINE_BACK), (22, SPINE_BACK), (37, SPINE_NEUTRAL)], 0),
           ax([(0, AX_READY), (10, AX_ALOFT), (22, AX_ALOFT), (37, AX_READY)])))
    R.bake(lib, 'lib_run_axe', [U1('Jog_Fwd_Loop')], rule='delta', fps_step=0.88, extra=chain(stride(lib, 0.64), hold(SPINE_LEAN),
           ax([(0, AX_CHARGE), (999, AX_CHARGE)], bob=lambda f: (0, 0, 0.025 * math.sin(4 * math.pi * f / 25)))))
    R.bake(lib, 'lib_chop2h', [U1('Sword_Idle', start=0, end=37)], rule='delta', extra=chain(
           procedural(lib, [(0, SPINE_NEUTRAL), (7, SPINE_BACK), (11, SPINE_CRUNCH), (19, SPINE_CRUNCH), (37, SPINE_NEUTRAL)], 0),
           ax([(0, AX_READY), (7, AX_UP), (11, AX_HIT), (15, AX_SUNK), (20, AX_SUNK), (37, AX_READY)])))
    R.bake(lib, 'lib_cleave2h', [U1('Sword_Idle', start=0, end=37)], rule='delta', extra=chain(
           procedural(lib, [(0, SPINE_NEUTRAL), (8, SPINE_COIL), (12, SPINE_UNCOIL), (20, SPINE_UNCOIL), (37, SPINE_NEUTRAL)], 0),
           ax([(0, AX_READY), (8, AX_WIND), (12, AX_SWEEP), (16, AX_FOLLOW), (21, AX_FOLLOW), (37, AX_READY)])))
    R.bake(lib, 'lib_victory_axe', [U1('Idle_Loop', start=0, end=47)], rule='delta', extra=chain(hold(SPINE_BACK),
           ax([(0, AX_ALOFT), (999, AX_ALOFT)], bob=lambda f: (0, 0, 0.07 * math.sin(4 * math.pi * f / 48)))))
    vic = procedural(lib, [(0, VIC_UP), (12, VIC_BENT), (24, VIC_UP), (36, VIC_BENT), (48, VIC_UP)], 0)
    act = R.bake(lib, 'lib_victory', [U1('Idle_Loop', start=0, end=47)], rule='delta', extra=vic)
    print(f'[anim] victory: {int(act["frames"])} frames')
    # ------------------------------------------------------------------------------------------------------
    # animation audit pass (docs/art-review/ANIM-AUDIT.md): new clips only; the clipsets in rig.py pick them up
    HEAD_FWD = {'head': ((0, 0, 1), (0, -1, 0)), 'neck': ((0, -0.05, 1), (0, -1, 0))}
    left_guard = {k: SW_READY[k] for k in ('upper_arm.L', 'forearm.L')}
    # runs: the shield arm stays in guard (it pumped like the mannequin's fist and flung the shield over the
    # shoulder), and the torso is 9 deg more upright
    R.bake(lib, 'lib_run_sword_shield', [U1('Jog_Fwd_Loop')], rule='delta', extra=chain(upright(9), hold(carry_sw), hold(left_guard)))
    R.bake(lib, 'lib_run_spear_shield', [U1('Jog_Fwd_Loop')], rule='delta', extra=chain(upright(9), hold(SP_CARRY), hold(left_guard)))
    R.bake(lib, 'lib_run_up', [U1('Jog_Fwd_Loop')], rule='delta', extra=upright(9))
    # long-legged squads (archer, mage): the full jog covers 5.8 m/s, they move at 2.6-2.8 -> the contained jog
    R.bake(lib, 'lib_jog_up', [U1('Jog_Fwd_Loop')], rule='delta', extra=chain(stride(lib, 0.58), upright(9)))
    R.bake(lib, 'lib_run_sword_up', [U1('Jog_Fwd_Loop')], rule='delta', extra=chain(upright(9), hold(carry_sw)))
    R.bake(lib, 'lib_run_spear_up', [U1('Jog_Fwd_Loop')], rule='delta', extra=chain(upright(9), hold(SP_CARRY)))
    # ---- spear / lance (one-handed): the carry is kept through hit and cast and released over the first frames
    # of the deaths (the weapon popped 60 deg on the first frame of each), thrusts get a lunge from the legs
    R.bake(lib, 'lib_hit_spear', [U1('Hit_Chest')], rule='delta', extra=hold(SP_CARRY))
    R.bake(lib, 'lib_cast_spear', [U1('Spell_Simple_Enter'), U1('Spell_Simple_Shoot'), U1('Spell_Simple_Exit')], rule='delta', extra=hold(SP_CARRY))
    R.bake(lib, 'lib_death_a_spear', [U1('Death01')], rule='delta', extra=fade(hold(SP_CARRY), 3, 14))
    R.bake(lib, 'lib_death_b_spear', [U1('Death01', mirror=True)], rule='delta', extra=fade(hold(SP_CARRY), 3, 14))
    LUNGE = {'thigh.L': (0.08, -0.52, -0.85), 'shin.L': (0.0, 0.12, -0.99), 'thigh.R': (-0.1, 0.34, -0.93), 'shin.R': (0.0, 0.42, -0.9)}
    lunge = lambda a, b, c, d, dist=0.24, drop=0.07: weighted(LUNGE, pulse_w(a, b, c, d), shift=(0, -dist, -drop))
    R.bake(lib, 'lib_lunge_a', [U1('Sword_Idle', start=0, end=27)], rule='delta', extra=chain(th, lunge(7, 12, 17, 26)))
    R.bake(lib, 'lib_lunge_b', [U1('Sword_Idle', start=0, end=29)], rule='delta', extra=chain(th2, lunge(9, 14, 19, 28, 0.18, 0.05)))
    # ---- pike, two-handed (pikemen): rear (right) hand at the hip, front hand on the shaft, chest turned to the
    # pike side; levelled, drawn back and driven home with a lunge. R = rear hand relative to the chest.
    PK_TWIST = dict(HEAD_FWD, **{'spine3': ((0, 0.02, 1), (-0.5, -0.87, 0)), 'spine2': ((0, 0.0, 1), (-0.3, -0.95, 0))})
    PK_CARRY = dict(R=(-0.22, 0.06, -0.40), axis=(0.05, -0.85, 0.52), g=(-0.50,))
    PK_LEVEL = dict(R=(-0.22, 0.08, -0.20), axis=(0.04, -0.995, 0.06), g=(-0.50,))
    PK_PULL = dict(R=(-0.24, 0.20, -0.18), axis=(0.04, -0.995, 0.05), g=(-0.56,))
    PK_HIT = dict(R=(-0.13, -0.22, -0.12), axis=(0.03, -0.999, 0.02), g=(-0.30,))
    PK_HIGH = dict(R=(-0.22, 0.14, 0.10), axis=(0.03, -0.96, -0.26), g=(-0.50,))
    PK_HIGH_HIT = dict(R=(-0.12, -0.20, 0.02), axis=(0.03, -0.95, -0.30), g=(-0.30,))
    pk = lambda keys, **k: two_handed(lib, keys, **k)
    pk_hold = pk([(0, PK_CARRY), (999, PK_CARRY)])
    for base, src, more in (('idle', 'Idle_Loop', []), ('walk', 'Walk_Loop', []), ('run', 'Jog_Fwd_Loop', [upright(9)])):
        R.bake(lib, f'lib_{base}_pike', [U1(src)], rule='delta', extra=chain(*more, hold(PK_TWIST), pk_hold))
    PK_DRIVE = dict(PK_TWIST, **{'spine3': ((0, -0.26, 1), (0.1, -0.99, 0)), 'spine2': ((0, -0.12, 1), (0, -1, 0))})
    pk_spine = procedural(lib, [(0, PK_TWIST), (8, PK_TWIST), (12, PK_DRIVE), (18, PK_DRIVE), (28, PK_TWIST)], 0)
    R.bake(lib, 'lib_pike_a', [U1('Sword_Idle', start=0, end=27)], rule='delta', extra=chain(pk_spine, lunge(7, 12, 17, 26, 0.3, 0.09),
           pk([(0, PK_CARRY), (4, PK_LEVEL), (8, PK_PULL), (12, PK_HIT), (17, PK_HIT), (22, PK_LEVEL), (27, PK_CARRY)])))
    pk_spine2 = procedural(lib, [(0, PK_TWIST), (9, PK_TWIST), (14, PK_DRIVE), (20, PK_DRIVE), (30, PK_TWIST)], 0)
    R.bake(lib, 'lib_pike_b', [U1('Sword_Idle', start=0, end=29)], rule='delta', extra=chain(pk_spine2, lunge(9, 14, 19, 28, 0.22, 0.06),
           pk([(0, PK_CARRY), (9, PK_HIGH), (14, PK_HIGH_HIT), (19, PK_HIGH_HIT), (25, PK_LEVEL), (29, PK_CARRY)])))
    R.bake(lib, 'lib_hit_pike', [U1('Hit_Chest')], rule='delta', extra=chain(hold(PK_TWIST), pk_hold))
    R.bake(lib, 'lib_death_a_pike', [U1('Death01')], rule='delta', extra=fade(chain(hold(PK_TWIST), pk_hold), 3, 14))
    R.bake(lib, 'lib_death_b_pike', [U1('Death01', mirror=True)], rule='delta', extra=fade(chain(hold(PK_TWIST), pk_hold), 3, 14))
    PK_ALOFT = dict(R=(-0.20, -0.16, 0.34), axis=(0.0, -0.10, 0.995), g=(0.46,))
    R.bake(lib, 'lib_victory_pike', [U1('Idle_Loop', start=0, end=47)], rule='delta', extra=chain(hold(SPINE_BACK),
           pk([(0, PK_ALOFT), (999, PK_ALOFT)], bob=lambda f: (0, 0, 0.08 * math.sin(4 * math.pi * f / 48)))))
    # ---- great axe: both hands stay on the shaft while the Warden starts to fall
    R.bake(lib, 'lib_death_a_axe', [U1('Death01')], rule='delta', extra=fade(ax([(0, AX_READY), (999, AX_READY)]), 4, 16))
    R.bake(lib, 'lib_death_b_axe', [U1('Death01', mirror=True)], rule='delta', extra=fade(ax([(0, AX_READY), (999, AX_READY)]), 4, 16))
    # ---- bow: side-on stance, draw to the cheek, a short follow-through (the release arm was flung straight
    # back like a T-pose); bow_b = the same shot lofted 25 deg (ranged units alternate attack / attack2)
    def bow_keys(up):
        c, s_ = math.cos(up), math.sin(up)
        fw = lambda x, y=-1.0, z=0.0: (x, y * c - z * s_, -y * s_ + z * c)          # pitch a forward-ish direction up
        stance = dict(HEAD_FWD, **{'spine3': ((0, 0.04 + 0.5 * s_, 1), (-0.62, -0.78, 0)), 'spine2': ((0, 0.25 * s_, 1), (-0.35, -0.94, 0))})
        aim = dict(stance, **{'upper_arm.L': fw(0.42, -1, 0.04), 'forearm.L': fw(0.36, -1, 0.04), 'hand.L': fw(0.3, -1, 0.04),
                              'upper_arm.R': (-0.45, 0.85, 0.2 + 0.4 * s_), 'forearm.R': fw(0.72, -0.62, 0.3), 'hand.R': fw(0.72, -0.62, 0.3)})
        nock = dict(aim, **{'upper_arm.R': (-0.25, -0.75, -0.6), 'forearm.R': fw(0.6, -0.8, 0.1), 'hand.R': fw(0.6, -0.8, 0.1)})
        rel = dict(aim, **{'upper_arm.R': (-0.5, 0.82, 0.28 + 0.4 * s_), 'forearm.R': fw(0.45, -0.1, 0.55), 'hand.R': fw(0.2, 0.3, 0.6)})
        return [(0, BOW_READY), (6, nock), (13, aim), (21, aim), (23, rel), (28, rel), (36, BOW_READY)]
    R.bake(lib, 'lib_bow_a', [U1('Idle_Loop', start=0, end=35)], rule='delta', extra=procedural(lib, bow_keys(0.0), 0))
    R.bake(lib, 'lib_bow_b', [U1('Idle_Loop', start=0, end=35)], rule='delta', extra=procedural(lib, bow_keys(0.42), 0))
    # ---- casters: second cast with the other hand (attack2 of a caster used to be an empty-handed sword chop)
    R.bake(lib, 'lib_cast_b', [U1('Spell_Simple_Enter', mirror=True), U1('Spell_Simple_Shoot', mirror=True), U1('Spell_Simple_Exit', mirror=True)], rule='delta')
    # ---- staff (clerics): carried upright like a walking staff (it ran along the forearm and waved like a baton),
    # raised to cast, thrust head-first to strike. Hand spec = (fingers, thumb); the staff runs along the thumb.
    ST_CARRY = {'upper_arm.R': (-0.28, -0.05, -0.96), 'forearm.R': (-0.12, -0.82, -0.56), 'hand.R': ((0.95, -0.1, -0.2), (0.0, -0.10, 0.995))}
    ST_RAISE = {'upper_arm.R': (-0.3, -0.55, 0.78), 'forearm.R': (-0.12, -0.45, 0.88), 'hand.R': ((0.95, -0.1, 0.1), (0.0, -0.22, 0.975))}
    ST_CALL = dict(ST_RAISE, **{'hand.R': ((0.95, -0.1, 0.2), (0.0, -0.55, 0.83))})
    ST_WIND = {'upper_arm.R': (-0.4, 0.25, 0.3), 'forearm.R': (-0.1, -0.35, 0.93), 'hand.R': ((0.95, 0.1, 0.1), (0.0, 0.45, 0.89)),
               'spine3': ((0, 0.08, 1), (-0.3, -0.95, 0))}
    ST_STRIKE = {'upper_arm.R': (-0.2, -0.9, 0.1), 'forearm.R': (-0.02, -0.97, 0.2), 'hand.R': ((0.95, -0.1, 0.0), (0.0, -0.87, 0.5)),
                 'spine3': ((0, -0.2, 1), (0.25, -0.97, 0))}
    st_hold = hold(ST_CARRY)
    R.bake(lib, 'lib_idle_staff', [U1('Idle_Loop')], rule='delta', extra=st_hold)
    R.bake(lib, 'lib_walk_staff', [U1('Walk_Loop')], rule='delta', extra=st_hold)
    R.bake(lib, 'lib_run_staff', [U1('Jog_Fwd_Loop')], rule='delta', extra=chain(upright(11), st_hold))
    # contained jogs with the carries (faction squads move at 2.2-3.4 m/s: the full jog's 5-5.9 m/s played at the
    # 0.7x clamp still slid ~20 %)
    R.bake(lib, 'lib_jog_staff', [U1('Jog_Fwd_Loop')], rule='delta', extra=chain(stride(lib, 0.58), upright(11), st_hold))
    R.bake(lib, 'lib_jog_spear_shield', [U1('Jog_Fwd_Loop')], rule='delta', extra=chain(stride(lib, 0.58), upright(9), hold(SP_CARRY), hold(left_guard)))
    R.bake(lib, 'lib_jog_sword_shield', [U1('Jog_Fwd_Loop')], rule='delta', extra=chain(stride(lib, 0.58), upright(9), hold(carry_sw), hold(left_guard)))
    R.bake(lib, 'lib_hit_staff', [U1('Hit_Chest')], rule='delta', extra=st_hold)
    R.bake(lib, 'lib_death_a_staff', [U1('Death01')], rule='delta', extra=fade(st_hold, 3, 14))
    R.bake(lib, 'lib_death_b_staff', [U1('Death01', mirror=True)], rule='delta', extra=fade(st_hold, 3, 14))
    R.bake(lib, 'lib_cast_staff', [U1('Spell_Simple_Enter'), U1('Spell_Simple_Shoot'), U1('Spell_Simple_Exit')], rule='delta',
           extra=procedural(lib, [(0, ST_CARRY), (9, ST_RAISE), (14, ST_CALL), (22, ST_CALL), (36, ST_CARRY), (999, ST_CARRY)], 0))
    R.bake(lib, 'lib_staff_strike', [U1('Sword_Idle', start=0, end=31)], rule='delta', extra=chain(
           procedural(lib, [(0, ST_CARRY), (9, ST_WIND), (13, ST_STRIKE), (18, ST_STRIKE), (31, ST_CARRY)], 0), lunge(8, 13, 17, 28, 0.14, 0.04)))
    ST_ALOFT = {'upper_arm.R': (-0.3, -0.15, 0.94), 'forearm.R': (-0.1, -0.12, 0.99), 'hand.R': ((0.95, -0.1, 0.1), (0.0, -0.05, 0.999)),
                'upper_arm.L': (0.75, -0.15, -0.55), 'forearm.L': (0.55, -0.45, -0.6), 'spine3': ((0, 0.10, 1), (0, -1, 0))}
    ST_ALOFT2 = dict(ST_ALOFT, **{'upper_arm.R': (-0.42, -0.3, 0.86), 'forearm.R': (0.05, -0.3, 0.95), 'spine3': ((0, 0.02, 1), (0, -1, 0))})
    R.bake(lib, 'lib_victory_staff', [U1('Idle_Loop', start=0, end=47)], rule='delta',
           extra=procedural(lib, [(0, ST_ALOFT), (12, ST_ALOFT2), (24, ST_ALOFT), (36, ST_ALOFT2), (48, ST_ALOFT)], 0))
    # ---- golem: an overhead two-fist slam and a haymaker (its attacks were a boxer's jab / cross: no weight)
    def both(d):
        return {**{k + '.R': v for k, v in d.items()}, **{k + '.L': (-v[0], v[1], v[2]) for k, v in d.items()}}
    SL_UP = dict(both({'upper_arm': (-0.38, 0.12, 0.92), 'forearm': (-0.12, 0.4, 0.91)}), **SPINE_BACK)
    SL_HIT = dict(both({'upper_arm': (-0.3, -0.78, -0.55), 'forearm': (-0.05, -0.62, -0.78)}), **SPINE_CRUNCH)
    R.bake(lib, 'lib_slam', [U1('Idle_Loop', start=0, end=39)], rule='delta', extra=chain(
           procedural(lib, [(0, None), (13, SL_UP), (17, SL_HIT), (24, SL_HIT), (39, None)], 0), lunge(12, 17, 24, 38, 0.2, 0.1)))
    HK_WIND = dict({'upper_arm.R': (-0.85, 0.45, 0.1), 'forearm.R': (-0.5, 0.6, 0.6), 'upper_arm.L': (0.4, -0.5, -0.75), 'forearm.L': (0.0, -0.8, 0.6)}, **SPINE_COIL)
    HK_HIT = dict({'upper_arm.R': (0.1, -0.97, 0.05), 'forearm.R': (0.78, -0.6, 0.1), 'upper_arm.L': (0.55, 0.2, -0.8), 'forearm.L': (0.2, -0.5, -0.8)}, **SPINE_UNCOIL)
    R.bake(lib, 'lib_hook', [U1('Idle_Loop', start=0, end=39)], rule='delta', extra=chain(
           procedural(lib, [(0, None), (12, HK_WIND), (17, HK_HIT), (23, HK_HIT), (39, None)], 0), lunge(11, 17, 22, 38, 0.16, 0.06)))
    # ---- victory with some life: bigger pumps, the chest and head come up with each one, a small bounce
    VIC_HI = dict(VIC_UP, **{'spine3': ((0, 0.14, 1), (0, -1, 0)), 'head': ((0, 0.2, 1), (0, -1, 0.15))})
    VIC_LO = dict(VIC_BENT, **{'upper_arm.R': (-0.62, -0.3, 0.55), 'forearm.R': (0.3, -0.5, 0.8), 'spine3': ((0, -0.04, 1), (0, -1, 0)), 'head': ((0, 0, 1), (0, -1, 0))})
    bounce = lambda f, rot, tgt: rot.__setitem__('_hips_shift', Vector((0, 0, 0.035 * (0.5 - 0.5 * math.cos(4 * math.pi * f / 48)) - 0.02)))
    R.bake(lib, 'lib_victory_b', [U1('Idle_Loop', start=0, end=47)], rule='delta', extra=chain(
           procedural(lib, [(0, VIC_LO), (9, VIC_HI), (15, VIC_HI), (24, VIC_LO), (33, VIC_HI), (39, VIC_HI), (48, VIC_LO)], 0), bounce))
    # tidy: drop sources
    for o in (a1, a2):
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        if not a.name.startswith('lib_'):
            bpy.data.actions.remove(a)
    R.set_action(lib, bpy.data.actions['lib_idle'])
    (L.WORK / 'blend').mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(L.WORK / 'blend' / 'anim_lib.blend'), compress=True)
    print('[anim] saved', len([a for a in bpy.data.actions]), 'actions')


if __name__ == '__main__':
    main()
