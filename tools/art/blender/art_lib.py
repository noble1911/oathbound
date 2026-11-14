"""Shared helpers for the AI art pipeline's Blender stages (Blender 5.2, run headless).

Conventions (docs/ART.md): 1 Blender unit = 1 m, Z-up, figure faces -Y in Blender (glTF -> +Y up,
faces +Z in three.js), origin at ground centre of the footprint.
"""
import json, math, os, sys
from pathlib import Path

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
ART = ROOT / 'tools' / 'art'
WORK = ROOT / 'art-work'
OUT = ROOT / 'public' / 'models' / 'v2'


def argv():
    a = sys.argv
    return a[a.index('--') + 1:] if '--' in a else []


def assets():
    return {a['id']: a for a in json.loads((ART / 'assets.json').read_text())['assets']}


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def use_gpu():
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA'):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            devs = [d for d in prefs.devices if d.type == kind]
            if devs:
                for d in prefs.devices:
                    d.use = d.type == kind
                bpy.context.scene.cycles.device = 'GPU'
                return kind
        except Exception:
            pass
    bpy.context.scene.cycles.device = 'CPU'
    return 'CPU'


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    return [o for o in bpy.data.objects if o not in before]


def join_meshes(objs, name):
    meshes = [o for o in objs if o.type == 'MESH']
    for o in objs:
        if o.type != 'MESH':
            o.select_set(False)
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    # unparent keeping transform, apply it
    mw = ob.matrix_world.copy()
    ob.parent = None
    ob.matrix_world = mw
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in objs:
        if o.name in bpy.data.objects and o != ob and o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    ob.name = name
    ob.data.name = name
    return ob


def verts_np(ob):
    n = len(ob.data.vertices)
    co = np.empty(n * 3, np.float32)
    ob.data.vertices.foreach_get('co', co)
    return co.reshape(-1, 3)


def tris(ob):
    ob.data.calc_loop_triangles()
    return len(ob.data.loop_triangles)


def select_only(*objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def apply_mods(ob):
    select_only(ob)
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def remove_floaters(ob, min_frac=0.002, keep_min=None):
    """Delete loose components with fewer than min_frac of the faces."""
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bm.faces.ensure_lookup_table()
    seen = set(); comps = []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack = [f]; comp = []
        seen.add(f.index)
        while stack:
            g = stack.pop(); comp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index); stack.append(h)
        comps.append(comp)
    total = len(bm.faces)
    kill = [c for c in comps if len(c) < min_frac * total]
    dead = 0
    for c in kill:
        dead += len(c)
        bmesh.ops.delete(bm, geom=c, context='FACES')
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bm.to_mesh(ob.data); bm.free()
    return len(comps), len(kill), dead


def best_yaw(pts2, prefer_wide_x=True):
    """Yaw (radians, about Z) that aligns the min-area bounding rectangle with the axes, choosing among
    the 90-degree-equivalent solutions the one with X the wide axis (if asked) and the smallest |angle|."""
    best = None
    for k in range(0, 180):
        a = math.radians(k * 0.5)
        c, s = math.cos(a), math.sin(a)
        x = pts2[:, 0] * c - pts2[:, 1] * s
        y = pts2[:, 0] * s + pts2[:, 1] * c
        area = (x.max() - x.min()) * (y.max() - y.min())
        if best is None or area < best[0]:
            best = (area, a, x.max() - x.min(), y.max() - y.min())
    _, a, w, d = best
    cands = [a + k * math.pi / 2 for k in range(-4, 5)]
    out = []
    for c_ in cands:
        rot = (k_ := round((c_ - a) / (math.pi / 2))) % 2
        wide_x = (w >= d) if rot == 0 else (d > w)
        if prefer_wide_x and not wide_x:
            continue
        out.append(c_)
    if not out:
        out = cands
    return min(out, key=lambda v: abs(math.atan2(math.sin(v), math.cos(v))))


def rotate_z(ob, ang):
    ob.data.transform(Matrix.Rotation(ang, 4, 'Z'))
    ob.data.update()


def ground_and_scale(ob, height, length=None, centre='bbox'):
    co = verts_np(ob)
    lo, hi = co.min(0), co.max(0)
    if length:
        s = length / max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    else:
        s = height / (hi[2] - lo[2])
    if centre == 'feet':
        low = co[co[:, 2] < lo[2] + 0.12 * (hi[2] - lo[2])]
        cx, cy = (low[:, 0].min() + low[:, 0].max()) / 2, (low[:, 1].min() + low[:, 1].max()) / 2
    else:
        cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    m = Matrix.Diagonal((s, s, s, 1)) @ Matrix.Translation((-cx, -cy, -lo[2]))
    ob.data.transform(m)
    ob.data.update()
    return s


def find_images(ob):
    """(basecolor_image, mr_image) from an imported TRELLIS material."""
    base = mr = None
    for slot in ob.material_slots:
        m = slot.material
        if not m or not m.node_tree:
            continue
        for n in m.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED':
                bc = n.inputs['Base Color']
                if bc.is_linked:
                    base = _upstream_image(bc.links[0].from_node)
                for key in ('Roughness', 'Metallic'):
                    s = n.inputs[key]
                    if s.is_linked and mr is None:
                        mr = _upstream_image(s.links[0].from_node)
    return base, mr


def _upstream_image(node, depth=0):
    if node.type == 'TEX_IMAGE':
        return node.image
    if depth > 4:
        return None
    for i in node.inputs:
        if i.is_linked:
            r = _upstream_image(i.links[0].from_node, depth + 1)
            if r:
                return r
    return None


def new_image(name, size, non_color=False, alpha=False):
    if name in bpy.data.images:
        bpy.data.images.remove(bpy.data.images[name])
    img = bpy.data.images.new(name, size, size, alpha=alpha)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def img_np(img):
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)


def np_img(img, arr):
    img.pixels.foreach_set(arr.astype(np.float32).ravel())
    img.update()


def build_material(name, base, normal=None, mr=None, rough=0.7, metal=0.0, emissive=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes['Principled BSDF']
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = base
    nt.links.new(t.outputs['Color'], p.inputs['Base Color'])
    if normal is not None:
        tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = normal
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
    if mr is not None:
        tm = nt.nodes.new('ShaderNodeTexImage'); tm.image = mr
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(tm.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], p.inputs['Roughness'])
        nt.links.new(sep.outputs['Blue'], p.inputs['Metallic'])
    else:
        p.inputs['Roughness'].default_value = rough
        p.inputs['Metallic'].default_value = metal
    if emissive is not None:
        te = nt.nodes.new('ShaderNodeTexImage'); te.image = emissive
        nt.links.new(te.outputs['Color'], p.inputs['Emission Color'])
        p.inputs['Emission Strength'].default_value = 1.0
    return m


def resized_copy(img, size, name):
    c = img.copy()
    c.name = name
    c.scale(size, size)
    return c


def export_glb(path, objs, anims=False, extra=None):
    select_only(*objs)
    kw = dict(filepath=str(path), export_format='GLB', use_selection=True, export_apply=False,
              export_yup=True, export_image_format='WEBP', export_image_quality=88,
              export_materials='EXPORT', export_normals=True, export_texcoords=True,
              export_tangents=False, export_attributes=True, export_vertex_color='NONE',
              export_animations=anims, export_extras=True)
    if anims:
        # 12 fps sampling (three.js interpolates linearly) and constant channels dropped: ~3x smaller clips
        kw.update(export_animation_mode='ACTIONS', export_frame_step=2, export_force_sampling=True,
                  export_optimize_animation_keep_anim_armature=False, export_optimize_animation_keep_anim_object=False,
                  export_optimize_animation_size=True, export_def_bones=True, export_reset_pose_bones=True,
                  export_anim_single_armature=True)
    if extra:
        kw.update(extra)
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError as e:
        # option names drift between Blender versions; drop the unknown ones and retry
        msg = str(e)
        for k in list(kw):
            if k in msg:
                kw.pop(k)
        bpy.ops.export_scene.gltf(**kw)
