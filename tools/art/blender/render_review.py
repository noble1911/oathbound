"""Review renders: re-import exported GLB(s) and render a labelled contact strip (turntable + poses).

blender -b --factory-startup --python tools/art/blender/render_review.py -- out.png a.glb[@spec] b.glb[@spec] ...
  spec (optional, '+'-separated): yaw angles like 'y0+y90+y180' and/or poses like 'p:attack_melee_a:0.4'
  (clip name : normalised time). Default spec: y30+y-30+y180. Team tint (red) is applied via `_TEAM`
  when the mesh carries it, to check the mask.
"""
import math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np
from mathutils import Vector

import art_lib as L
import retarget as R

TEAM = (0.85, 0.12, 0.10)


def setup_world():
    sc = bpy.context.scene
    try:
        sc.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        sc.render.engine = 'BLENDER_EEVEE_NEXT'
    w = bpy.data.worlds.new('w'); sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (0.32, 0.34, 0.38, 1); bg.inputs['Strength'].default_value = 0.9
    for name, rot, e in (('key', (50, 0, 35), 3.2), ('fill', (60, 0, -120), 1.0), ('rim', (35, 0, 170), 2.0)):
        ld = bpy.data.lights.new(name, 'SUN'); ld.energy = e
        lo = bpy.data.objects.new(name, ld); sc.collection.objects.link(lo)
        lo.rotation_euler = [math.radians(v) for v in rot]
    sc.view_settings.view_transform = 'AgX' if 'AgX' in [i.name for i in type(sc.view_settings).bl_rna.properties['view_transform'].enum_items] else 'Filmic'
    sc.render.film_transparent = False
    sc.render.resolution_x = 420; sc.render.resolution_y = 560


def tint(objs):
    for o in objs:
        if o.type != 'MESH' or '_TEAM' not in o.data.attributes:
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
            at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_name = '_TEAM'
            mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
            nt.links.new(at.outputs['Fac'], mix.inputs['Factor'])
            nt.links.new(src, mix.inputs[6])
            mix.inputs[7].default_value = (*TEAM, 1)
            nt.links.new(mix.outputs[2], p.inputs['Base Color'])


def bounds(objs):
    bpy.context.view_layer.update()
    pts = []
    for o in objs:
        if o.type == 'MESH':
            dg = bpy.context.evaluated_depsgraph_get()
            oe = o.evaluated_get(dg)
            me = oe.to_mesh()
            pts += [oe.matrix_world @ v.co for v in list(me.vertices)[::7]]
            oe.to_mesh_clear()
    a = np.array([[p.x, p.y, p.z] for p in pts])
    return a.min(0), a.max(0)


def render_one(objs, yaw, path, fit=None):
    sc = bpy.context.scene
    lo, hi = fit or bounds(objs)
    c = Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2))
    size = max(hi - lo)
    cam = sc.camera
    if cam is None:
        cd = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cd); sc.collection.objects.link(cam); sc.camera = cam
        cd.type = 'ORTHO'
    cam.data.ortho_scale = size * 1.12
    d = Vector((math.sin(math.radians(yaw)), -math.cos(math.radians(yaw)), 0.42)).normalized()
    cam.location = c + d * size * 4
    cam.rotation_euler = (c - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.clip_end = size * 20
    sc.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def main():
    args = L.argv()
    out = Path(args[0]).resolve()
    L.clear()
    setup_world()
    tiles = []
    tmp = L.WORK / 'review_tmp'; tmp.mkdir(parents=True, exist_ok=True)
    k = 0
    for item in args[1:]:
        glb, _, spec = item.partition('@')
        spec = spec or 'y30+y-30+y180'
        objs = L.import_glb(glb)
        for o in list(objs):
            if o.name.startswith('Icosphere'):   # glTF importer's bone display shape
                objs.remove(o); bpy.data.objects.remove(o, do_unlink=True)
        tint(objs)
        arm = next((o for o in objs if o.type == 'ARMATURE'), None)
        fit = None
        for s in spec.split('+'):
            yaw = 30
            if s.startswith('n:'):
                # n:<node>[:yaw] -> show only that mesh node (e.g. Keep destruction stages)
                parts = s.split(':')
                for o in objs:
                    if o.type == 'MESH':
                        o.hide_render = o.name.split('.')[0] != parts[1]
                yaw = float(parts[2]) if len(parts) > 2 else 30
            elif s.startswith('p:'):
                _, clip, t = s.split(':')
                act = next((a for a in bpy.data.actions if a.name == clip or a.name.startswith(clip + '_') or a.name.startswith(clip)), None)
                if arm and act:
                    R.set_action(arm, act)
                    f0, f1 = act.frame_range
                    bpy.context.scene.frame_set(int(f0 + (f1 - f0) * float(t)))
                elif act:
                    # node-animated (siege): one action, one slot per object
                    for o in objs:
                        ad = o.animation_data
                        if not ad:
                            continue
                        ad.action = act
                        for sl in act.slots:
                            if o.name in sl.name_display:
                                ad.action_slot = sl
                    f0, f1 = act.frame_range
                    bpy.context.scene.frame_set(int(f0 + (f1 - f0) * float(t)))
            else:
                yaw = float(s[1:])
                if arm:
                    R.set_action(arm, None)
                    for pb in arm.pose.bones:
                        pb.matrix_basis.identity()
            p = tmp / f'{k:03d}.png'; k += 1
            if fit is None:
                fit = bounds(objs)
                lo, hi = fit
                pad = (hi - lo) * 0.25
                fit = (lo - pad * np.array([1, 1, 0]), hi + pad)
            render_one(objs, yaw, p, fit)
            tiles.append((p, f'{Path(glb).stem} {s}'))
        for o in objs:
            bpy.data.objects.remove(o, do_unlink=True)
    ims = []
    for p, label in tiles:
        im = bpy.data.images.load(str(p))
        ims.append(L.img_np(im)[:, :, :3])
    h = max(i.shape[0] for i in ims)
    cols = min(len(ims), 6)
    rows = math.ceil(len(ims) / cols)
    W = ims[0].shape[1]
    sheet = np.zeros((h * rows, W * cols, 4), np.float32); sheet[...] = (0.32, 0.34, 0.38, 1)
    for i, im in enumerate(ims):
        r, c = divmod(i, cols)
        r = rows - 1 - r
        sheet[r * h: r * h + im.shape[0], c * W: c * W + im.shape[1], :3] = im
    img = bpy.data.images.new('sheet', W * cols, h * rows)
    L.np_img(img, sheet)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.filepath_raw = str(out); img.file_format = 'PNG'; img.save()
    print('[review] wrote', out, [t[1] for t in tiles])


if __name__ == '__main__':
    main()
