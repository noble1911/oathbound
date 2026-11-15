"""Keep builder: cleaned keep mesh -> 4 destruction stages as sibling nodes (stage0 intact .. stage3 ruin).

blender -b --factory-startup --python tools/art/blender/keep.py -- keep

In : art-work/blend/keep_clean.blend (LOD0 `keep`, LOD1 `keep_lod1`)
Out: public/models/v2/keep.glb, keep_lod1.glb: root `keep` -> children `stage0`..`stage3` (show exactly one).
Stages 1-3 are boolean cuts of the intact mesh by a jagged, noise-displaced cutter at 80/58/34 % height plus a
rubble skirt of stone chunks (seeded, so rebuilds are identical). Cut faces and rubble use `Rubble` (plain PBR).
"""
import math, random, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import bmesh
import numpy as np
from mathutils import Vector, noise

import art_lib as L

CUTS = [None, 0.80, 0.58, 0.34]
RUBBLE = [0, 26, 48, 70]


def rubble_mat():
    m = bpy.data.materials.get('Rubble') or bpy.data.materials.new('Rubble')
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (0.09, 0.085, 0.08, 1)
    p.inputs['Roughness'].default_value = 0.92
    return m


def cutter(height, frac, size, seed, n=28):
    """Closed slab whose underside is a jagged noisy surface at frac*height."""
    bm = bmesh.new()

    z0 = frac * height
    rng = random.Random(seed)
    off = Vector((rng.random() * 50, rng.random() * 50, 0))
    grid = []
    for i in range(n + 1):
        row = []
        for j in range(n + 1):
            x = (i / n - 0.5) * size * 1.6; y = (j / n - 0.5) * size * 1.6
            h = noise.noise(Vector((x * 0.18, y * 0.18, 0)) + off) * height * 0.10
            h += noise.noise(Vector((x * 0.6, y * 0.6, 3)) + off) * height * 0.035
            h += (x * 0.35 + y * 0.2) / size * height * 0.12          # tilt: one side collapses more
            row.append(bm.verts.new((x, y, z0 + h)))
        grid.append(row)
    top = []
    for i in range(n + 1):
        top.append([bm.verts.new((v.co.x, v.co.y, height * 3)) for v in grid[i]])
    for i in range(n):
        for j in range(n):
            bm.faces.new((grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]))
            bm.faces.new((top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1]))
    for i in range(n):
        bm.faces.new((grid[i][0], grid[i + 1][0], top[i + 1][0], top[i][0]))
        bm.faces.new((grid[i + 1][n], grid[i][n], top[i][n], top[i + 1][n]))
        bm.faces.new((grid[0][i + 1], grid[0][i], top[0][i], top[0][i + 1]))
        bm.faces.new((grid[n][i], grid[n][i + 1], top[n][i + 1], top[n][i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new('cutter'); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new('cutter', me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(rubble_mat())
    return ob


def rubble(count, base_r, height, seed, detail=1):
    rng = random.Random(seed)
    bm = bmesh.new()
    for k in range(count):
        a = rng.random() * math.tau
        r = base_r * (0.75 + rng.random() * 0.55)
        s = height * (0.025 + rng.random() * 0.05)
        c = Vector((math.cos(a) * r, math.sin(a) * r, s * 0.35))
        ret = bmesh.ops.create_icosphere(bm, subdivisions=detail, radius=s)
        vs = ret['verts']
        for v in vs:
            v.co = Vector((v.co.x * (0.8 + rng.random() * 0.6), v.co.y * (0.8 + rng.random() * 0.6), v.co.z * 0.6)) + c
    me = bpy.data.meshes.new('rubble'); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new('rubble', me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(rubble_mat())
    for p in me.polygons:
        p.use_smooth = False
    if '_TEAM' not in me.attributes:
        me.attributes.new('_TEAM', 'FLOAT', 'POINT')
    return ob


def cut_height(x, y, H, frac, size, seed):
    rng = random.Random(seed)
    off = Vector((rng.random() * 50, rng.random() * 50, 0))
    h = noise.noise(Vector((x * 0.18, y * 0.18, 0)) + off) * H * 0.10
    h += noise.noise(Vector((x * 0.6, y * 0.6, 3)) + off) * H * 0.035
    h += (x * 0.35 + y * 0.2) / size * H * 0.12          # tilt: one side collapses more
    return frac * H + h


def stage(src, k, H, size, lod):
    """Delete everything above a jagged noise surface, cap the open walls with rubble-coloured faces
    (vertex-level cut: robust on AI meshes where exact booleans fail), add a rubble skirt."""
    ob = src.copy(); ob.data = src.data.copy(); ob.name = f'stage{k}' + ('_lod1' if lod else '')
    bpy.context.scene.collection.objects.link(ob)
    if CUTS[k] is None:
        return ob
    mats = [m.name for m in ob.data.materials if m]
    if 'Rubble' not in mats:
        ob.data.materials.append(rubble_mat())
    ri = [m.name for m in ob.data.materials].index('Rubble')
    bm = bmesh.new(); bm.from_mesh(ob.data)
    kill = [v for v in bm.verts if v.co.z > cut_height(v.co.x, v.co.y, H, CUTS[k], size, 100 + k)]
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    before = set(bm.faces)
    bmesh.ops.holes_fill(bm, edges=bm.edges, sides=0)
    new = [f for f in bm.faces if f not in before]
    for f in new:
        f.material_index = ri
    bmesh.ops.triangulate(bm, faces=new)
    bm.to_mesh(ob.data); bm.free()
    n = RUBBLE[k] // (2 if lod else 1)
    rb = rubble(n, size * 0.52, H, seed=200 + k, detail=0 if lod else 1)
    # rubble heaped on the broken top as well
    L.select_only(ob, rb)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    stone_caps(ob)
    return ob


_STONE_UV = {}


def stone_caps(ob):
    """Cut caps and rubble used an untextured `Rubble` material. The renderer lifts every Keep material's colour
    factor (x1.5, the baked stone is dark), which turned the untextured one pure white: blown-out tower tops and
    rubble on stage1-3. They now use the Keep's own stone material, their UVs parked on a patch of plain dark
    stone in its atlas, so they get exactly the same treatment as the walls."""
    me = ob.data
    names = [m.name if m else '' for m in me.materials]
    if 'Rubble' not in names:
        return
    ri = names.index('Rubble'); si = next(i for i, n in enumerate(names) if n and n != 'Rubble')
    if 'uv' not in _STONE_UV:
        nt = me.materials[si].node_tree
        bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        px = L.img_np(L._upstream_image(bsdf.inputs['Base Color'].links[0].from_node))[..., :3]
        h, w = px.shape[:2]; B = 64          # a big uniform patch: small ones mip-blend with the black atlas background
        blk = px[:h // B * B, :w // B * B].reshape(h // B, B, w // B, B, 3)
        mean = blk.mean((1, 3)); var = blk.var((1, 3)).sum(-1)
        lum = mean.mean(-1); sat = mean.max(-1) - mean.min(-1)
        used = lum[lum > 0.02]
        target = float(np.percentile(used, 90)) * 0.85            # wall stone, a little darker (broken, shadowed); not the roofs
        print('[keep] atlas block luminance percentiles 35/50/65/80/95:', np.percentile(used, [35, 50, 65, 80, 95]).round(3).tolist())
        score = var * 40 + np.abs(lum - target) * 12 + sat * 6 + (blk.min((1, 3)).mean(-1) < 0.03) * 5
        score[lum < 0.02] = 1e9
        by, bx = np.unravel_index(int(np.argmin(score)), score.shape)
        _STONE_UV['uv'] = ((bx + 0.5) * B / w, (by + 0.5) * B / h)
        print(f'[keep] cap / rubble stone texel at uv {_STONE_UV["uv"]}, colour {mean[by, bx].round(3).tolist()}')
    u, v = _STONE_UV['uv']
    uvl = me.uv_layers.active or me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        if poly.material_index == ri:
            poly.material_index = si
            # a few texels of spread per face: with constant UVs the normal map's derivative tangent frame is
            # degenerate and the faces shade black
            for k, li in enumerate(poly.loop_indices):
                uvl.data[li].uv = (u + (0.004 if k % 3 == 1 else 0.0), v + (0.004 if k % 3 == 2 else 0.0))
    me.materials.pop(index=ri)


def fit_budget(ob, budget):
    for _ in range(3):
        n = L.tris(ob)
        if n <= budget:
            break
        m = ob.modifiers.new('d', 'DECIMATE'); m.ratio = budget / n * 0.98; m.use_collapse_triangulate = True
        L.apply_mods(ob)
    return L.tris(ob)


def main():
    aid = L.argv()[0]
    bpy.ops.wm.open_mainfile(filepath=str(L.WORK / 'blend' / f'{aid}_clean.blend'))
    a = L.assets()[aid]
    H = a['height']
    src = bpy.data.objects[aid]; src.name = '_src'
    co = L.verts_np(src)
    size = float(max(np.ptp(co[:, 0]), np.ptp(co[:, 1])))
    # LOD0 stages: boolean cuts of the 15k mesh. LOD1 stages: the same stages decimated (they share LOD0's
    # texture atlas; collapse decimation keeps UVs), so both LODs show the same damage.
    out = {}
    # one file: a single Keep per side is on screen, so a LOD1 would only duplicate the textures
    for lod, name, budget in ((False, aid, a['lod0']),):
        root = bpy.data.objects.new(aid, None)
        bpy.context.scene.collection.objects.link(root)
        kids = []
        for k in range(4):
            s = stage(src, k, H, size, False)
            fit_budget(s, budget)
            s.name = f'stage{k}'
            s.parent = root
            kids.append(s)
            print(f'[keep] {name} stage{k}: {L.tris(s)} tris')
        L.export_glb(L.OUT / f'{name}.glb', [root] + kids)
        out[name] = [L.tris(s) for s in kids]
        for o in [root] + kids:
            bpy.data.objects.remove(o, do_unlink=True)
    (L.WORK / 'clean' / f'{aid}.json').write_text(__import__('json').dumps(dict(id=aid, height=H, stage_tris=out), indent=1))


if __name__ == '__main__':
    main()
