"""Review sheet of an authored siege engine from its exported GLB and team mask (docs/ART.md section 10.x).

blender -b --factory-startup --python tools/art/blender/siege_review.py -- out.jpg model.glb team.png spec [cols]
  spec: '+'-separated tiles, each `yaw:elev[:clip:frame[:zoom]]` (yaw 0 = looking at the front, 180 = from behind;
        clip '-' = rest pose (idle, frame 0); zoom > 1 frames tighter)
  env REVIEW_TEAM='r,g,b' (default red 0.85,0.12,0.10): albedo *= mix(1, team, mask) with the mask sampled at UV0,
        as the renderer does. REVIEW_RES='w,h' per tile (default 640,640).
Lighting as render_review.py (key / fill / rim suns, AgX), orthographic camera framed on the rest-pose bounds.
"""
import math, os, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np
from mathutils import Vector

import art_lib as L


def setup():
    sc = bpy.context.scene
    try:
        sc.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        sc.render.engine = 'BLENDER_EEVEE_NEXT'
    w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (0.32, 0.34, 0.38, 1); bg.inputs['Strength'].default_value = 0.9
    for name, rot, e in (('key', (50, 0, 35), 3.2), ('fill', (60, 0, -120), 1.0), ('rim', (35, 0, 170), 2.0)):
        ld = bpy.data.lights.new(name, 'SUN'); ld.energy = e
        lo = bpy.data.objects.new(name, ld); sc.collection.objects.link(lo)
        lo.rotation_euler = [math.radians(v) for v in rot]
    names = [i.name for i in type(sc.view_settings).bl_rna.properties['view_transform'].enum_items]
    sc.view_settings.view_transform = 'AgX' if 'AgX' in names else 'Filmic'
    gm = bpy.data.meshes.new('ground'); gm.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new('ground', gm); sc.collection.objects.link(g)
    m = bpy.data.materials.new('ground'); m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.36, 0.31, 0.24, 1)
    m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.95
    gm.materials.append(m)


def tint(objs, mask_path, team):
    img = bpy.data.images.load(str(mask_path)); img.colorspace_settings.name = 'Non-Color'
    done = set()
    for o in objs:
        for slot in getattr(o, 'material_slots', []):
            m = slot.material
            if not m or m.name in done:
                continue
            done.add(m.name)
            nt = m.node_tree
            p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
            if not p.inputs['Base Color'].is_linked:
                continue
            src = p.inputs['Base Color'].links[0].from_socket
            t = nt.nodes.new('ShaderNodeTexImage'); t.image = img
            mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
            nt.links.new(t.outputs['Color'], mix.inputs['Factor'])
            nt.links.new(src, mix.inputs[6]); mix.inputs[7].default_value = (*team, 1)
            nt.links.new(mix.outputs[2], p.inputs['Base Color'])


def main():
    a = L.argv()
    out, glb, mask, spec = a[0], a[1], a[2], a[3]
    cols = int(a[4]) if len(a) > 4 else 0
    team = tuple(float(x) for x in os.environ.get('REVIEW_TEAM', '0.85,0.12,0.10').split(','))
    rw, rh = (int(x) for x in os.environ.get('REVIEW_RES', '640,640').split(','))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    setup()
    objs = L.import_glb(glb)
    tint(objs, mask, team)
    sc = bpy.context.scene
    sc.render.fps = 24
    meshes = [o for o in objs if o.type == 'MESH']
    acts = {}
    for o in objs:
        if o.animation_data:
            o.animation_data.action = None
    bpy.context.view_layer.update()
    co = np.concatenate([np.array([o.matrix_world @ v.co for v in o.data.vertices]) for o in meshes])
    lo, hi = co.min(0), co.max(0)
    c0 = Vector(((lo + hi) / 2).tolist()); size0 = float(np.linalg.norm(hi - lo))
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = 'ORTHO'; cam.data.clip_end = 300
    sc.render.resolution_x, sc.render.resolution_y = rw, rh
    sc.render.image_settings.file_format = 'PNG'
    tiles = []
    for k, t in enumerate(spec.split('+')):
        f = t.split(':')
        yaw, el = float(f[0]), float(f[1])
        clip = f[2] if len(f) > 2 else '-'
        fr = float(f[3]) if len(f) > 3 else 0
        zoom = float(f[4]) if len(f) > 4 else 1.0
        if clip == '-':                                      # rest pose = idle at frame 0 (node TRS of the GLB)
            clip, fr = 'idle', 0
        for o in objs:
            ad = o.animation_data
            if not ad:
                continue
            for tr in ad.nla_tracks:
                tr.mute = tr.name != clip
                tr.is_solo = False
        sc.frame_set(int(fr), subframe=fr - int(fr))
        az, e = math.radians(yaw), math.radians(el)
        d = Vector((math.sin(az) * math.cos(e), -math.cos(az) * math.cos(e), math.sin(e)))
        cam.location = c0 + d * 60
        cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        cam.data.ortho_scale = size0 * 0.92 / zoom
        p = str(Path(out).with_suffix('')) + f'_t{k}.png'
        sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(p); px = np.array(img.pixels[:], np.float32).reshape(rh, rw, 4)
        bpy.data.images.remove(img); os.remove(p)
        tiles.append(px)
    n = len(tiles); cols = cols or n; rows = (n + cols - 1) // cols
    while len(tiles) < rows * cols:
        tiles.append(np.full_like(tiles[0], 0.3))
    sheet = np.concatenate([np.concatenate(tiles[r * cols:(r + 1) * cols], 1) for r in range(rows)][::-1], 0)
    im = bpy.data.images.new('sheet', sheet.shape[1], sheet.shape[0])
    im.pixels.foreach_set(sheet.ravel())
    im.filepath_raw = out
    im.file_format = 'JPEG' if out.lower().endswith(('.jpg', '.jpeg')) else 'PNG'
    sc.render.image_settings.quality = 88
    im.save()
    print('[review]', out, n, 'tiles')


if __name__ == '__main__':
    main()
