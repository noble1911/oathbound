"""Animation frame strips: re-import an exported GLB and render N evenly spaced frames of one or more clips
from a fixed camera, one row per clip -- for judging gaits, flaps and retargets frame by frame.

blender -b --factory-startup --python tools/art/blender/anim_strip.py -- out.png file.glb clip:N:yaw[:pitch] ...
  yaw 90 = side view (unit faces left), 0 = front, 180 = back; pitch = camera elevation in degrees (default 12).
"""
import math, os, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np
from mathutils import Vector

import art_lib as L
import retarget as R
import render_review as RV


def main():
    args = L.argv()
    out = Path(args[0]).resolve()
    L.clear()
    RV.setup_world()
    sc = bpy.context.scene
    objs = L.import_glb(args[1])
    for o in list(objs):
        if o.name.startswith('Icosphere'):
            objs.remove(o); bpy.data.objects.remove(o, do_unlink=True)
    RV.tint(objs)
    arm = next(o for o in objs if o.type == 'ARMATURE')
    tmp = L.WORK / 'review_tmp'; tmp.mkdir(parents=True, exist_ok=True)
    rows = []
    for spec in args[2:]:
        parts = spec.split(':')
        clip, n, yaw = parts[0], int(parts[1]), float(parts[2])
        pitch = float(parts[3]) if len(parts) > 3 else 12.0
        act = bpy.data.actions[clip] if clip in bpy.data.actions else next(a for a in bpy.data.actions if a.name.startswith(clip))
        R.set_action(arm, act)
        f0, f1 = act.frame_range
        loop = clip in ('idle', 'walk', 'run', 'victory')
        fr = [f0 + (f1 - f0) * i / (n if loop else n - 1) for i in range(n)]
        lo, hi = None, None
        for f in fr:
            sc.frame_set(int(f), subframe=f - int(f))
            a, b = RV.bounds(objs)
            lo = a if lo is None else np.minimum(lo, a); hi = b if hi is None else np.maximum(hi, b)
        lo = np.minimum(lo, [lo[0], lo[1], 0.0])
        c = Vector((lo + hi) / 2); size = float(max(hi - lo))
        cam = sc.camera
        if cam is None:
            cd = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cd); sc.collection.objects.link(cam); sc.camera = cam
            cd.type = 'ORTHO'
        # ground line helper: a thin dark plane at z = 0
        if 'ground' not in bpy.data.objects:
            bpy.ops.mesh.primitive_plane_add(size=24); g = bpy.context.active_object; g.name = 'ground'
            m = bpy.data.materials.new('g'); m.use_nodes = True
            m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.12, 0.13, 0.14, 1)
            g.data.materials.append(m)
        cam.data.ortho_scale = size * 1.1
        py = math.radians(pitch); ya = math.radians(yaw)
        d = Vector((math.sin(ya) * math.cos(py), -math.cos(ya) * math.cos(py), math.sin(py)))
        cam.location = c + d * size * 4
        cam.rotation_euler = (c - cam.location).to_track_quat('-Z', 'Y').to_euler()
        cam.data.clip_end = size * 20
        sc.render.resolution_x = sc.render.resolution_y = int(os.environ.get('STRIP_RES', 400))
        ims = []
        for i, f in enumerate(fr):
            sc.frame_set(int(f), subframe=f - int(f))
            p = tmp / f's_{len(rows)}_{i:02d}.png'
            sc.render.filepath = str(p)
            bpy.ops.render.render(write_still=True)
            ims.append(L.img_np(bpy.data.images.load(str(p)))[:, :, :3])
        per = int(os.environ.get('STRIP_COLS', 8))
        for i in range(0, len(ims), per):
            rows.append(np.concatenate(ims[i:i + per], 1))
    W = max(r.shape[1] for r in rows)
    sheet = np.zeros((sum(r.shape[0] for r in rows), W, 4), np.float32); sheet[...] = (0.32, 0.34, 0.38, 1)
    y = sheet.shape[0]
    for r in rows:
        y -= r.shape[0]
        sheet[y:y + r.shape[0], :r.shape[1], :3] = r
    img = bpy.data.images.new('sheet', W, sheet.shape[0])
    L.np_img(img, sheet)
    img.filepath_raw = str(out); img.file_format = 'PNG'; img.save()
    print('[strip] wrote', out)


if __name__ == '__main__':
    main()
