"""Authoring aid for tools/art/creatures.json: orthographic renders of a cleaned mount mesh in its rig frame
(after the config's yaw / shift), with the scale needed to overlay a metric grid and the configured joints.

blender -b --factory-startup --python tools/art/blender/creature_view.py -- <mount id> <out dir> [yaw_deg] [dx]
Out: <out>/<id>_{side,top,front}.png + <out>/<id>_view.json (centre + ortho scale); creature_grid.py draws the grid.
"""
import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np
from mathutils import Matrix, Vector

import art_lib as L
import render_review as RV

VIEWS = {  # name: (camera direction it looks along, image right, image up)
    'side': ((1, 0, 0), (0, -1, 0), (0, 0, 1)),
    'top': ((0, 0, -1), (1, 0, 0), (0, 1, 0)),
    'front': ((0, 1, 0), (1, 0, 0), (0, 0, 1)),
}


def main():
    a = L.argv()
    mid, out = a[0], Path(a[1]); out.mkdir(parents=True, exist_ok=True)
    cfg = json.loads((Path(__file__).resolve().parents[1] / 'creatures.json').read_text()).get(mid, {}) \
        if (Path(__file__).resolve().parents[1] / 'creatures.json').exists() else {}
    yaw = float(a[2]) if len(a) > 2 else cfg.get('yaw', 0.0)
    dx = float(a[3]) if len(a) > 3 else cfg.get('dx', 0.0)
    bpy.ops.wm.open_mainfile(filepath=str(L.WORK / 'blend' / f'{mid}_clean.blend'))
    ob = bpy.data.objects[mid]
    for o in bpy.data.objects:
        if o.type == 'MESH' and o is not ob:
            o.hide_render = True
    ob.data.transform(Matrix.Translation((-dx, 0, 0)) @ Matrix.Rotation(math.radians(yaw), 4, 'Z'))
    RV.setup_world()
    sc = bpy.context.scene
    sc.render.resolution_x = sc.render.resolution_y = 1400
    co = L.verts_np(ob)
    lo, hi = co.min(0), co.max(0)
    c = Vector((lo + hi) / 2); S = float(max(hi - lo)) * 1.08
    cd = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cd); sc.collection.objects.link(cam); sc.camera = cam
    cd.type = 'ORTHO'; cd.ortho_scale = S; cd.clip_end = S * 10
    for name, (d, r, u) in VIEWS.items():
        d, r, u = Vector(d), Vector(r), Vector(u)
        cam.matrix_world = Matrix((r, u, -d)).transposed().to_4x4()
        cam.location = c - d * S * 3
        sc.render.filepath = str(out / f'{mid}_{name}.png')
        bpy.ops.render.render(write_still=True)
    (out / f'{mid}_view.json').write_text(json.dumps(dict(centre=list(c), scale=S, yaw=yaw, dx=dx, lo=lo.tolist(), hi=hi.tolist())))
    print('[view]', mid, 'yaw', yaw, 'dx', dx, 'bounds', lo.round(2), hi.round(2))


if __name__ == '__main__':
    main()
