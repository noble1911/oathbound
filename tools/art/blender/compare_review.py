"""Old-vs-new close review of one unit in Blender (EEVEE): the GLBs side by side, full body from two yaws and a
close-up of the top third, team tint from `_TEAM` (as render_review.py). For judging texture sharpness, unwrap
seams and the team mask before the in-engine sheets.

blender -b --factory-startup --python tools/art/blender/compare_review.py -- out.png old.glb new.glb [yaw,yaw] [zoom 0..1]
  (a single GLB works too; default yaws 25,205; zoom = the height fraction where the close-up is centred, default 0.8)
"""
import math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np
from mathutils import Vector

import art_lib as L
import render_review as RV


def tint_tex(objs, glb):
    """Team tint as the engine does it: albedo *= mix(1, team, mask texture at UV0). The mask is looked up next to
    the shipped file (art-work/unpacked/stage/x.glb -> art-work/stage_v2/x_team.png, art-work/unpacked/x.glb ->
    public/models/v2/x_team.png, else beside the GLB); without one the `_TEAM` vertex attribute is used."""
    g = Path(glb).resolve(); uid = g.stem.replace('_lod1', '')
    cands = [g.parent / f'{uid}_team.png']
    if g.parent.name == 'stage':
        cands.insert(0, L.WORK / 'stage_v2' / f'{uid}_team.png')
    elif g.parent.name == 'unpacked':
        cands.insert(0, L.ROOT / 'public' / 'models' / 'v2' / f'{uid}_team.png')
    mp = next((c for c in cands if c.exists()), None)
    if mp is None:
        return RV.tint(objs)
    img = bpy.data.images.load(str(mp)); img.colorspace_settings.name = 'Non-Color'
    for o in objs:
        if o.type != 'MESH' or o.name.startswith('weapon_'):
            continue
        for slot in o.material_slots:
            m = slot.material
            if not m or m.get('_tinted'):
                continue
            m['_tinted'] = 1
            nt = m.node_tree
            p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
            if not p.inputs['Base Color'].is_linked:
                continue
            src = p.inputs['Base Color'].links[0].from_socket
            t = nt.nodes.new('ShaderNodeTexImage'); t.image = img
            mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
            nt.links.new(t.outputs['Color'], mix.inputs['Factor'])
            nt.links.new(src, mix.inputs[6])
            mix.inputs[7].default_value = (*RV.TEAM, 1)
            nt.links.new(mix.outputs[2], p.inputs['Base Color'])


def main():
    args = L.argv()
    out = Path(args[0]).resolve()
    glbs = [a for a in args[1:] if a.lower().endswith('.glb')]
    rest = [a for a in args[1:] if not a.lower().endswith('.glb')]
    yaws = [float(v) for v in rest[0].split(',')] if rest else [25, 205]
    zoom = float(rest[1]) if len(rest) > 1 else 0.8
    L.clear()
    RV.setup_world()
    sc = bpy.context.scene
    groups = []
    x = 0.0
    for g in glbs:
        objs = L.import_glb(g)
        for o in list(objs):
            if o.name.startswith('Icosphere'):
                objs.remove(o); bpy.data.objects.remove(o, do_unlink=True)
        tint_tex(objs, g)
        bpy.context.view_layer.update()
        ms = [o for o in objs if o.type == 'MESH']
        pts = np.array([o.matrix_world @ Vector(c) for o in ms for c in o.bound_box])
        lo, hi = pts.min(0), pts.max(0)
        roots = [o for o in objs if o.parent is None]
        w = float(max(hi[0] - lo[0], hi[1] - lo[1]))
        for r in roots:
            r.location.x += x + w / 2 - (lo[0] + hi[0]) / 2
        groups.append((x + w / 2, float(hi[2]), w))
        x += w * 1.15
    H = max(g[1] for g in groups); W = x
    cd = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cd); sc.collection.objects.link(cam); sc.camera = cam
    cd.type = 'ORTHO'
    tiles = []
    tmp = L.WORK / 'review_tmp'; tmp.mkdir(parents=True, exist_ok=True)

    def shot(k, yaw, centre, scale, rx, ry):
        # the objects turn (each about its own axis), the camera stays in front
        for o in bpy.data.objects:
            if o.parent is None and o.type in ('MESH', 'ARMATURE', 'EMPTY'):
                o.rotation_mode = 'XYZ'; o.rotation_euler.z = math.radians(yaw)
        sc.render.resolution_x = rx; sc.render.resolution_y = ry
        cd.ortho_scale = scale; cd.clip_end = 200
        d = Vector((0, -1, 0.25)).normalized()
        cam.location = Vector(centre) + d * 40
        cam.rotation_euler = (Vector(centre) - cam.location).to_track_quat('-Z', 'Y').to_euler()
        p = tmp / f'cmp_{k}.png'
        sc.render.filepath = str(p)
        bpy.ops.render.render(write_still=True)
        tiles.append(p)
    rx = 1800; ry = int(rx * (H * 1.1) / max(W, 1e-3)); ry = max(600, min(ry, 1600))
    for i, yaw in enumerate(yaws):
        shot(f'full{i}', yaw, (W / 2 - 0.075 * W / max(len(groups), 1) * 0, 0, H * 0.5), max(W, H * 1.1 * rx / ry) * 1.02, rx, ry)
    zs = W * 0.55
    shot('zoom', yaws[0], (W / 2, 0, H * zoom), zs, 1800, int(1800 * 0.5))
    imgs = [bpy.data.images.load(str(p)) for p in tiles]
    Wt = max(i.size[0] for i in imgs); Ht = sum(i.size[1] for i in imgs)
    canvas = np.zeros((Ht, Wt, 4), np.float32); canvas[..., 3] = 1
    y = Ht
    for im in imgs:
        a = L.img_np(im); h, w = a.shape[:2]
        y -= h
        canvas[y:y + h, :w] = a
    res = bpy.data.images.new('sheet', Wt, Ht)
    L.np_img(res, canvas)
    res.filepath_raw = str(out); res.file_format = 'JPEG' if out.suffix.lower() in ('.jpg', '.jpeg') else 'PNG'
    sc.render.image_settings.quality = 90
    res.save()
    print('[compare] wrote', out)


if __name__ == '__main__':
    main()
