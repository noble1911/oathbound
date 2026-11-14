"""Stage 5 (crowd + VAT) for squad units: one single-primitive skinned crowd mesh and its compact VAT.

blender -b --factory-startup --python tools/art/blender/vat.py -- <id>

In : art-work/blend/<id>_rig.blend (rig, LOD0 `<id>`, LOD1 `<id>_lod1`, weapons parented to bones)
Out: public/models/v2/<id>_lod1.glb       crowd mesh = LOD1 body + LOD1 weapons merged into ONE skinned
                                            primitive (weapons weighted 1.0 to their bone), one 512^2 basecolour
                                            atlas re-baked from the LOD0 sources, all clips, point attribute
                                            `_VID` (three.js: geometry.attributes._vid) = VAT texel index.
     public/models/v2/<id>_lod1_tint.png  team mask (R) in that atlas's UVs.
     public/models/v2/<id>.vat.json       VatMeta (src/render/crowd/vat.ts) + compact-encoding fields
     public/models/v2/<id>.vat.pos.bin    RGBA float16, little-endian: xyz = object-space position (three.js
                                            space, metres), w = octahedral normal packed as ox*45+oy
                                            (ox, oy integers 0..44; exact in f16). No .nrm.bin.
Texel of vertex v, frame f: (v % width, f * rowsPerFrame + floor(v / width)), v = _vid (unique Blender
vertex, so UV-seam duplicates share a texel). Clip fps vary per clip (see clips[].fps).
"""
import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np

import art_lib as L
import retarget as R
from cleanup import emit_restore, unwrap

OCT = 45
# canonical crowd clip name -> (source action by clipset, sample fps)
PRIMARY = {'sword': 'attack_melee_a', 'spear': 'attack_melee_a', 'cast': 'cast', 'bow': 'attack_bow', 'fist': 'attack_melee_a'}
SECONDARY = {'sword': 'attack_melee_b', 'spear': 'attack_melee_b', 'cast': 'attack_melee_a', 'bow': 'attack_melee_a', 'fist': 'attack_melee_b'}


def plan(clipset):
    p = [('idle', 'idle', 10, True), ('move', 'walk', 12, True), ('run', 'run', 12, True),
         ('attack', PRIMARY[clipset], 12, False), ('attack2', SECONDARY[clipset], 12, False)]
    if clipset == 'cast':
        p.append(('cast', 'cast', 12, False))
    p += [('hit', 'hit', 12, False), ('death', 'death_a', 10, False), ('victory', 'victory', 8, True)]
    return p


def to_gltf(a):
    return np.stack([a[:, 0], a[:, 2], -a[:, 1]], 1)


def oct_pack(n):
    n = n / np.maximum(np.abs(n).sum(1, keepdims=True), 1e-9)
    x, y, z = n[:, 0], n[:, 1], n[:, 2]
    ox = np.where(z >= 0, x, (1 - np.abs(y)) * np.where(x >= 0, 1, -1))
    oy = np.where(z >= 0, y, (1 - np.abs(x)) * np.where(y >= 0, 1, -1))
    qx = np.clip(np.round((ox * 0.5 + 0.5) * (OCT - 1)), 0, OCT - 1)
    qy = np.clip(np.round((oy * 0.5 + 0.5) * (OCT - 1)), 0, OCT - 1)
    return qx * OCT + qy


def emit_from(mat, what, mask_img=None):
    """Route a channel of a source material into an Emission output for baking:
    'color' basecolour, 'rough' / 'metal' (the BSDF inputs), 'team' = the LOD0 team-mask texture when the
    source has one (crisp), else the `_TEAM` vertex attribute."""
    nt = mat.node_tree
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    old = [l.from_socket for l in out.inputs['Surface'].links]
    em = nt.nodes.new('ShaderNodeEmission'); em.name = '_bake_emit'
    p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    if what in ('color', 'rough', 'metal'):
        s = p.inputs[{'color': 'Base Color', 'rough': 'Roughness', 'metal': 'Metallic'}[what]]
        if s.is_linked:
            nt.links.new(s.links[0].from_socket, em.inputs['Color'])
        else:
            v = s.default_value
            em.inputs['Color'].default_value = tuple(v) if what == 'color' else (v, v, v, 1)
    elif mask_img is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = mask_img; t.name = '_bake_attr'
        nt.links.new(t.outputs['Color'], em.inputs['Color'])
    else:
        at = nt.nodes.new('ShaderNodeAttribute'); at.attribute_name = '_TEAM'; at.name = '_bake_attr'
        nt.links.new(at.outputs['Fac'], em.inputs['Color'])
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return old


def source_mask(o):
    """LOD0 team mask png of a source object (body `<id>`, weapon `weapon_x_L` -> weapon_x)."""
    sid = o.name if not o.name.startswith('weapon_') else o.name.rsplit('_', 1)[0]
    p = L.WORK / 'clean' / f'{sid}_team.png'
    if not p.exists():
        return None
    img = bpy.data.images.load(str(p), check_existing=True)
    img.colorspace_settings.name = 'Non-Color'
    return img


def bake_atlas(crowd, sources, size, H):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.samples = 2
    L.use_gpu()
    base = L.new_image(f'{crowd.name}_base', size)
    mask = L.new_image(f'{crowd.name}_mask', size, non_color=True)
    rough = L.new_image(f'{crowd.name}_r', size // 2, non_color=True)
    metal = L.new_image(f'{crowd.name}_m', size // 2, non_color=True)
    tmp = bpy.data.materials.new('_bake'); tmp.use_nodes = True
    crowd.data.materials.clear(); crowd.data.materials.append(tmp)
    mat_mask = {}
    for o in sources:
        mk = source_mask(o)
        for m in o.data.materials:
            if m:
                mat_mask[m] = mk
    for img, what in ((base, 'color'), (mask, 'team'), (rough, 'rough'), (metal, 'metal')):
        olds = {m: emit_from(m, what, mk) for m, mk in mat_mask.items()}
        nt = tmp.node_tree
        tn = nt.nodes.get('_t') or nt.nodes.new('ShaderNodeTexImage'); tn.name = '_t'; tn.image = img
        nt.nodes.active = tn
        bpy.ops.object.select_all(action='DESELECT')
        for o in sources:
            o.hide_render = False; o.select_set(True)
        crowd.select_set(True); bpy.context.view_layer.objects.active = crowd
        b = sc.render.bake
        b.use_selected_to_active = True; b.cage_extrusion = 0.015 * H; b.max_ray_distance = 0.05 * H
        b.margin = 4; b.margin_type = 'EXTEND'
        bpy.ops.object.bake(type='EMIT')
        for m, old in olds.items():
            nt2 = m.node_tree
            if '_bake_attr' in nt2.nodes:
                nt2.nodes.remove(nt2.nodes['_bake_attr'])
            emit_restore(m, old)
    # squads must read from the RTS camera: lift the albedo a little (TRELLIS bakes run dark)
    px = L.img_np(base)
    px[..., :3] = np.clip(px[..., :3] ** 0.85 * 1.08, 0, 1)
    L.np_img(base, px)
    mr = L.new_image(f'{crowd.name}_mr', size // 2, non_color=True)
    pk = np.ones_like(L.img_np(rough)); pk[..., 1] = L.img_np(rough)[..., 0]; pk[..., 2] = L.img_np(metal)[..., 0]
    L.np_img(mr, pk)
    bpy.data.images.remove(rough); bpy.data.images.remove(metal)
    crowd.data.materials.clear()
    m = L.build_material(f'{crowd.name}_mat', base, None, mr)
    crowd.data.materials.append(m)
    base.pack(); mr.pack()
    return base, mask


def glb_attr(path, name):
    """Read a float SCALAR vertex attribute of the first primitive from a GLB (for the _VID order check)."""
    import struct
    b = Path(path).read_bytes()
    jl = struct.unpack_from('<I', b, 12)[0]
    j = json.loads(b[20:20 + jl])
    bin_off = 20 + jl + 8
    for m in j['meshes']:
        for p in m['primitives']:
            if name in p['attributes']:
                acc = j['accessors'][p['attributes'][name]]
                bv = j['bufferViews'][acc['bufferView']]
                o = bin_off + bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
                return np.frombuffer(b, '<f4', acc['count'], o), len(m['primitives'])
    return None, 0


def motion_check(aid, a, crowd, F, clips):
    """Mounted squads: fail the bake when the VAT itself shows a rigid mount -- hooves (ground mounts) or wing
    tips (fliers) that do not move against the body in the move / run clips. Measured on the baked texels, so
    it covers weights, clips and sampling together."""
    if not a.get('rider'):
        return
    names = {g.index: g.name for g in crowd.vertex_groups}
    dom = {}
    for v in crowd.data.vertices:
        if v.groups:
            g = max(v.groups, key=lambda g: g.weight)
            dom.setdefault(names[g.group], []).append(v.index)
    body = np.array(dom.get('m_body', []) + dom.get('m_chest', []), int)
    chains = {}
    for n in names.values():
        if n.startswith(('m_leg_', 'm_wing_')):
            chains.setdefault(n.rsplit('_', 1)[0], []).append(n)
    flier = a['kind'] == 'flier'
    errs = []
    assert len(body) > 10, 'crowd mesh has no vertices on the mount body bones'
    for c in clips:
        if c['name'] not in ('move', 'run'):
            continue
        P = F[c['start']:c['start'] + c['frames'], :, :3]
        for chain, bones in sorted(chains.items()):
            if ('wing' in chain) != flier:
                continue
            bones = sorted(bones, key=lambda b: int(b.rsplit('_', 1)[1]))
            idx = np.array([i for b in bones[len(bones) // 2:] for i in dom.get(b, [])], int)
            if len(idx) < 2:
                errs.append(f"{c['name']}: {chain} owns {len(idx)} crowd vertices on its lower bones"); continue
            rel = P[:, idx].mean(1) - P[:, body].mean(1)
            travel = float(np.linalg.norm(rel.max(0) - rel.min(0)))
            need = 0.3
            print(f"[vat] check {c['name']} {chain}: {len(idx)} verts travel {travel:.2f} m against the body")
            if travel < need:
                errs.append(f"{c['name']}: {chain} moves only {travel:.2f} m against the body (< {need})")
    if errs:
        raise RuntimeError(f'{aid}: VAT motion checks FAILED (mount would play as a rigid block): ' + '; '.join(errs))


def main():
    aid = L.argv()[0]
    a = L.assets()[aid]
    H = a['height']
    bpy.ops.wm.open_mainfile(filepath=str(L.WORK / 'blend' / f'{aid}_rig.blend'))
    sc = bpy.context.scene
    src_fps = sc.render.fps
    rig = bpy.data.objects['rig']
    R.set_action(rig, None)
    for pb in rig.pose.bones:
        pb.matrix_basis.identity()
    bpy.context.view_layer.update()
    body0 = bpy.data.objects[aid]; body1 = bpy.data.objects[f'{aid}_lod1']
    w0 = [o for o in bpy.data.objects if o.name.startswith('weapon_') and not o.name.endswith('_lod1')]
    w1 = [o for o in bpy.data.objects if o.name.startswith('weapon_') and o.name.endswith('_lod1')]
    # ---- merge LOD1 body + weapons into one skinned mesh
    parts = []
    c = body1.copy(); c.data = body1.data.copy(); sc.collection.objects.link(c); parts.append(c)
    for w in w1:
        d = w.copy(); d.data = w.data.copy(); sc.collection.objects.link(d)
        mw = w.matrix_world.copy(); bone = w.parent_bone
        d.parent = None; d.matrix_world = mw
        L.select_only(d); bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        vg = d.vertex_groups.new(name=bone); vg.add(list(range(len(d.data.vertices))), 1.0, 'REPLACE')
        if '_TEAM' not in d.data.attributes:
            d.data.attributes.new('_TEAM', 'FLOAT', 'POINT')
        parts.append(d)
    for p in parts:
        p.modifiers.clear()
    L.select_only(*parts); bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    crowd = bpy.context.view_layer.objects.active
    crowd.name = f'{aid}_crowd'; crowd.data.name = f'{aid}_crowd'
    mw = crowd.matrix_world.copy(); crowd.parent = None; crowd.matrix_world = mw
    L.select_only(crowd); bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for uv in list(crowd.data.uv_layers):
        crowd.data.uv_layers.remove(uv)
    crowd.data.uv_layers.new(name='UVMap')
    for poly in crowd.data.polygons:
        poly.use_smooth = True
    for an in ("sharp_face", "sharp_edge", "custom_normal"):
        if an in crowd.data.attributes:
            crowd.data.attributes.remove(crowd.data.attributes[an])
    unwrap(crowd, 0.008)
    vid = crowd.data.attributes.new('_VID', 'FLOAT', 'POINT')
    V = len(crowd.data.vertices)
    vid.data.foreach_set('value', np.arange(V, dtype=np.float32))
    for o in [body0] + w0:
        o.hide_render = False
    base, mask = bake_atlas(crowd, [body0] + w0, 512, H)
    mk = L.img_np(mask)
    timg = L.new_image(f'{aid}_lod1_tint', 512, non_color=True)
    t = np.ones_like(mk); t[..., :3] = np.clip(mk[..., :1], 0, 1)
    L.np_img(timg, t); timg.scale(256, 256)
    timg.filepath_raw = str(L.OUT / f'{aid}_lod1_tint.png'); timg.file_format = 'PNG'; timg.save()
    crowd.parent = rig
    am = crowd.modifiers.new('Armature', 'ARMATURE'); am.object = rig
    # ---- export crowd GLB (replaces rig.py's multi-node LOD1)
    tris = L.tris(crowd)
    L.export_glb(L.OUT / f'{aid}_lod1.glb', [rig, crowd], anims=True)
    order, nprim = glb_attr(L.OUT / f'{aid}_lod1.glb', '_VID')
    assert order is not None and nprim == 1, 'crowd GLB must be one primitive carrying _VID'
    # ---- sample the VAT per Blender vertex
    dg = bpy.context.evaluated_depsgraph_get()
    width = min(V, 4096); rows = math.ceil(V / width)
    frames, clips, start = [], [], 0
    for cname, act_name, fps, loop in plan(a.get('clipset', 'sword')):
        act = bpy.data.actions[act_name]
        f0, f1 = act.frame_range
        dur = (f1 - f0) / src_fps
        if loop and cname in ('move', 'run') and dur * fps < 10:
            fps = int(math.ceil(10 / dur))            # short cycles (gallop 0.5 s, wing beats): >= 10 samples per cycle
        n = max(1, int(round(dur * fps)) + (0 if loop else 1))
        R.set_action(rig, act)
        for k in range(n):
            tt = min(k / fps, dur)
            f = f0 + tt * src_fps
            sc.frame_set(int(math.floor(f)), subframe=f - math.floor(f))
            oe = crowd.evaluated_get(bpy.context.evaluated_depsgraph_get())
            me = oe.to_mesh()
            co = np.empty(V * 3, np.float32); me.vertices.foreach_get('co', co)
            no = np.empty(V * 3, np.float32); me.vertices.foreach_get('normal', no)
            oe.to_mesh_clear()
            p = to_gltf(co.reshape(-1, 3)); nn = to_gltf(no.reshape(-1, 3))
            frames.append(np.concatenate([p, oct_pack(nn)[:, None]], 1))
        clips.append(dict(name=cname, start=start, frames=n, fps=fps, loop=loop, duration=round(dur, 4), source=act_name))
        start += n
    R.set_action(rig, bpy.data.actions['idle'])
    F = np.stack(frames)                                          # [frames, V, 4]
    motion_check(aid, a, crowd, F, clips)
    tex = np.zeros((start, rows * width, 4), np.float32)
    tex[:, :V] = F
    tex.astype('<f2').tofile(L.OUT / f'{aid}.vat.pos.bin')
    pts = F[:, :, :3].reshape(-1, 3)
    meta = dict(version=1, vertexCount=int(V), width=int(width), rowsPerFrame=int(rows), totalFrames=int(start),
                format='f16', clips=clips,
                bounds=dict(min=[round(float(v), 4) for v in pts.min(0)], max=[round(float(v), 4) for v in pts.max(0)]),
                pos=f'{aid}.vat.pos.bin', nrm=None,
                normalEncoding='octPosW45', vertexIndexAttribute='_vid',
                mesh=f'{aid}_lod1.glb', tintMask=f'{aid}_lod1_tint.png')
    (L.OUT / f'{aid}.vat.json').write_text(json.dumps(meta, indent=1))
    facts = json.loads((L.WORK / 'clean' / f'{aid}.json').read_text())
    facts['tris_lod1'] = tris
    facts['crowd'] = dict(glb=f'{aid}_lod1.glb', vat=f'{aid}.vat.json', tint=f'{aid}_lod1_tint.png', vertices=V,
                          gltf_vertices=int(len(order)))
    (L.WORK / 'clean' / f'{aid}.json').write_text(json.dumps(facts, indent=1))
    bpy.ops.wm.save_as_mainfile(filepath=str(L.WORK / 'blend' / f'{aid}_crowd.blend'), compress=True)
    print(f'[vat] {aid}: crowd {tris} tris, {V} verts ({len(order)} glTF), {start} frames, '
          f'{tex.nbytes / 2 / 1e6:.2f} MB VAT')


if __name__ == '__main__':
    main()
