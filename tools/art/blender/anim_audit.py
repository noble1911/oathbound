"""Numeric audit of the humanoid clips (rig.py output): ground contact, stride speed and limb sanity per clip.

blender -b --factory-startup --python tools/art/blender/anim_audit.py -- <id> [<id> ...]
Reads art-work/blend/<id>_rig.blend and prints one row per clip:
  floor    lowest sole point over the clip minus its rest height (cm): > +3 floats, < -3 sinks into the ground
  mesh     lowest LOD1 body vertex over the clip (cm; deaths should end near 0, not below)
  speed    walk / run: ground speed implied by the planted foot (m/s) -- compare with the renderer's
           walkSpeed / runSpeed in src/render/crowd/archetypes.ts (a mismatch shows as foot sliding)
  splay    largest sideways angle of a thigh from vertical over the clip (deg; > 35 in idle / walk = a bad fit)
Exit code 1 if any hard limit is broken (rest-pose leg bones more than 25 deg off vertical, feet more than
12 cm under the ground in a locomotion clip).
"""
import math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np

import art_lib as L
import retarget as R

CLIPS = ['idle', 'walk', 'run', 'attack_melee_a', 'attack_melee_b', 'attack_bow', 'cast', 'hit', 'death_a', 'death_b', 'victory']


def audit(aid):
    bpy.ops.wm.open_mainfile(filepath=str(L.WORK / 'blend' / f'{aid}_rig.blend'))
    sc = bpy.context.scene
    rig = bpy.data.objects['rig']
    body = bpy.data.objects[f'{aid}_lod1']
    B = rig.data.bones
    bad = []
    for s in 'LR':
        for b in ('thigh', 'shin'):
            d = (B[f'{b}.{s}'].tail_local - B[f'{b}.{s}'].head_local).normalized()
            ang = math.degrees(math.acos(max(-1, min(1, -d.z))))
            if ang > 25:
                bad.append(f'rest {b}.{s} is {ang:.0f} deg off vertical')
    rest_sole = min(B['toe.L'].tail_local.z, B['toe.R'].tail_local.z, B['foot.L'].tail_local.z)
    print(f'[audit] {aid}: hips {B["hips"].head_local.z:.2f} m, rest sole {rest_sole * 100:.0f} cm')
    for clip in CLIPS:
        act = bpy.data.actions.get(clip)
        if not act:
            bad.append(f'missing clip {clip}'); continue
        R.set_action(rig, act)
        f0, f1 = act.frame_range
        sole, mesh, splay, toes = [], [], 0.0, []
        for f in range(int(f0), int(f1) + 1):
            sc.frame_set(f)
            pb = rig.pose.bones
            z = {s: min(pb[f'toe.{s}'].tail.z, pb[f'toe.{s}'].head.z, pb[f'foot.{s}'].head.z + (B[f'toe.{s}'].tail_local.z - B[f'foot.{s}'].head_local.z)) for s in 'LR'}
            sole.append(min(z.values()))
            toes.append([(pb[f'toe.{s}'].head.y, pb[f'toe.{s}'].head.z) for s in 'LR'])
            oe = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
            me = oe.to_mesh()
            co = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get('co', co)
            oe.to_mesh_clear()
            mesh.append(float(co.reshape(-1, 3)[:, 2].min()))
            for s in 'LR':
                d = (pb[f'thigh.{s}'].tail - pb[f'thigh.{s}'].head).normalized()
                splay = max(splay, math.degrees(math.asin(min(1, abs(d.x)))))
        floor = (min(sole) - rest_sole) * 100
        speed = ''
        if clip in ('walk', 'run'):
            t = np.array(toes)                         # [frames, 2, (y, z)]
            v = []
            for i in range(len(t) - 1):
                k = int(np.argmin(t[i, :, 1]))         # the lower foot is the planted one
                if abs(t[i + 1, k, 1] - t[i, k, 1]) < 0.01:
                    v.append((t[i + 1, k, 0] - t[i, k, 0]) * sc.render.fps)
            speed = f'{np.median(v):5.2f} m/s' if v else '  n/a'
            if floor < -12:
                bad.append(f'{clip}: feet sink {-floor:.0f} cm')
        print(f'[audit]   {clip:15s} floor {floor:+5.0f} cm  mesh {min(mesh) * 100:+5.0f} cm  splay {splay:3.0f} deg  {speed}')
    R.set_action(rig, None)
    for b in bad:
        print(f'[audit] !! {aid}: {b}')
    return bad


if __name__ == '__main__':
    fails = [b for a in L.argv() for b in audit(a)]
    if fails:
        sys.exit(1)
