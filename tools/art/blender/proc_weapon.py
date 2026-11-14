"""Procedural weapons that image->3D cannot do (a 3.6 m pike is a 1-pixel line in a concept image).

blender -b --factory-startup --python tools/art/blender/proc_weapon.py -- weapon_pike
Out: art-work/blend/<id>_clean.blend with `<id>` / `<id>_lod1` in the same convention as cleanup.py's weapons
(long axis +Z, head up, grip at the origin; flat PBR materials).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import bmesh
from mathutils import Matrix

import art_lib as L


def mat(name, rgb, rough, metal):
    m = bpy.data.materials.new(name); m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*rgb, 1); p.inputs['Roughness'].default_value = rough; p.inputs['Metallic'].default_value = metal
    return m


def pike(name, length, seg):
    bm = bmesh.new()
    shaft = length * 0.9
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=0.018, radius2=0.015, depth=shaft,
                          matrix=Matrix.Translation((0, 0, shaft / 2)))
    nsh = len(bm.faces)
    # leaf-shaped head: socket + flattened double cone
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=0.022, radius2=0.02, depth=0.08,
                          matrix=Matrix.Translation((0, 0, shaft + 0.04)))
    h = bmesh.ops.create_cone(bm, cap_ends=True, segments=4, radius1=0.05, radius2=0.0, depth=length * 0.09,
                              matrix=Matrix.Translation((0, 0, shaft + 0.08 + length * 0.045)))
    for v in h['verts']:
        v.co.y *= 0.3
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=0.022, radius2=0.022, depth=0.05,
                          matrix=Matrix.Translation((0, 0, 0.025)))                       # butt cap
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    me.materials.append(mat(f'{name}_wood', (0.36, 0.22, 0.11), 0.8, 0.0))
    me.materials.append(mat(f'{name}_steel', (0.62, 0.62, 0.64), 0.35, 1.0))
    for i, p in enumerate(me.polygons):
        p.material_index = 0 if i < nsh else 1
        p.use_smooth = True
    me.transform(Matrix.Translation((0, 0, -length * 0.3)))                   # grip 30 % up the shaft
    me.attributes.new('_TEAM', 'FLOAT', 'POINT')
    return ob


def main():
    aid = L.argv()[0]
    a = L.assets()[aid]
    L.clear()
    pike(aid, a['length'], 8); pike(f'{aid}_lod1', a['length'], 5)
    for o in bpy.data.objects:
        o['team_frac'] = 0.0
    (L.WORK / 'blend').mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(L.WORK / 'blend' / f'{aid}_clean.blend'))
    print('[proc] done', aid, L.tris(bpy.data.objects[aid]), L.tris(bpy.data.objects[f'{aid}_lod1']))


if __name__ == '__main__':
    main()
