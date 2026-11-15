"""Pose-space retargeting math shared by anim_library.py and rig.py.

Every bake works per frame in *armature space*: for each target bone we decide the desired rotation R_b
(3x3) and then solve the local basis  L_b = (Rest_p^-1 Rest_b)^-1 M_p^-1 M_b  top-down, keyframing quaternion
(+ location for the hips). Two rules for R_b:
  * 'delta'    R_t = R_s Rest_s^-1 Rest_t  -- the bone turns by the same world delta from its rest pose
                (UAL2 -> library rig, mirroring).
  * 'absolute' R_t = R_s                    -- the bone takes the source's armature-space orientation
                (library rig -> a fitted character rig whose arm chains are the library frames rotated
                rigidly into the mesh's A-pose, so equal orientation == same pose).
"""
import bpy
from mathutils import Matrix, Quaternion, Vector

S = Matrix.Diagonal((-1, 1, 1, 1))


def mirror_name(n):
    if n.endswith('.L'):
        return n[:-2] + '.R'
    if n.endswith('.R'):
        return n[:-2] + '.L'
    return n


def set_action(arm, act):
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    if act is not None and hasattr(arm.animation_data, 'action_slot') and len(act.slots):
        try:
            arm.animation_data.action_slot = act.slots[0]
        except Exception:
            pass


def sample(arm, act, frames, names):
    """{frame: {bone: armature-space 4x4}} for the source armature playing `act`."""
    set_action(arm, act)
    out = {}
    sc = bpy.context.scene
    for f in frames:
        sc.frame_set(int(f), subframe=f - int(f))
        bpy.context.view_layer.update()
        out[f] = {n: arm.pose.bones[n].matrix.copy() for n in names if n in arm.pose.bones}
    set_action(arm, None)
    return out


def order(arm):
    res = []
    def rec(b):
        res.append(b.name)
        for c in b.children:
            rec(c)
    for b in arm.data.bones:
        if b.parent is None:
            rec(b)
    return res


def solve_and_key(tgt, frame, desired_rot, hips_pos, hips_name='hips', prev=None):
    """desired_rot: {bone: 3x3 armature-space rotation}; bones missing keep their rest-relative identity.
    hips_pos: armature-space head position for the hips (or None). Keys quaternion (+hips location)."""
    M = {}
    prev = prev if prev is not None else {}
    for n in order(tgt):
        b = tgt.data.bones[n]
        pb = tgt.pose.bones[n]
        rest = b.matrix_local
        if b.parent is None:
            parentM = Matrix.Identity(4)
            rel = rest
        else:
            parentM = M[b.parent.name]
            rel = b.parent.matrix_local.inverted() @ rest
        natural = parentM @ rel
        R = desired_rot.get(n)
        if R is None:
            Mb = natural
        else:
            Mb = R.to_4x4()
            Mb.translation = natural.translation
        if n == hips_name and hips_pos is not None:
            Mb.translation = hips_pos
        Lb = rel.inverted() @ parentM.inverted() @ Mb
        q = Lb.to_quaternion()
        if n in prev and prev[n].dot(q) < 0:
            q.negate()
        prev[n] = q
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = q
        pb.keyframe_insert('rotation_quaternion', frame=frame, group=n)
        if n == hips_name:
            pb.location = Lb.translation
            pb.keyframe_insert('location', frame=frame, group=n)
        M[n] = parentM @ rel @ Lb
    return prev


def bake(tgt, act_name, segments, rule='absolute', hips_scale=1.0, hips_offset=None, extra=None, fps_step=1.0):
    """segments: list of dicts {arm, action, start, end, map: {tgt: src}, mirror: bool}; played back to back.
    extra(frame_index, desired_rot, tgt) may override rotations (procedural layers). Returns the new action."""
    act = bpy.data.actions.new(act_name)
    act.use_fake_user = True
    set_action(tgt, act)
    for pb in tgt.pose.bones:
        pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0); pb.scale = (1, 1, 1)
    out_f = 0.0
    prev = {}
    for seg in segments:
        src = seg['arm']; mp = seg['map']; mirror = seg.get('mirror', False)
        f = seg['start']
        frames = []
        while f <= seg['end'] + 1e-6:
            frames.append(round(f, 4)); f += fps_step
        smp = sample(src, seg['action'], frames, set(mp.values()))
        for fr in frames:
            pose = smp[fr]
            rot = {}
            for tn, sn in mp.items():
                sn2 = mirror_name(sn) if mirror else sn
                if sn2 not in pose:
                    continue
                Ms = pose[sn2]
                if mirror:
                    Ms = S @ Ms @ S
                if rule == 'delta':
                    rs = src.data.bones[sn2].matrix_local
                    if mirror:
                        rs = S @ rs @ S
                    R = Ms.to_3x3() @ rs.to_3x3().inverted() @ tgt.data.bones[tn].matrix_local.to_3x3()
                else:
                    R = Ms.to_3x3()
                rot[tn] = R.normalized()
            hp = None
            hs = [tn for tn, sn in mp.items() if tn == 'hips']
            if hs:
                sn = mp['hips']
                Ms = pose[sn]
                if mirror:
                    Ms = S @ Ms @ S
                hp = Ms.translation * hips_scale
                if hips_offset is not None:
                    hp = hp + hips_offset
            if extra:
                extra(out_f, rot, tgt)
            # a procedural layer may also move the hips (lunges, bounces): rot['_hips_shift'] = Vector
            shift = rot.pop('_hips_shift', None)
            if shift is not None and hp is not None:
                hp = hp + shift
            prev = solve_and_key(tgt, out_f, rot, hp, prev=prev)
            out_f += 1
    set_action(tgt, None)
    act['frames'] = out_f
    return act
