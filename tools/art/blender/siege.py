"""Siege engines: rigid-part node animation (no skinning).

blender -b --factory-startup --python tools/art/blender/siege.py -- ballista|trebuchet

In : art-work/blend/<id>_clean.blend (static LOD0 `<id>` / LOD1 `<id>_lod1`)
Out: public/models/v2/<id>.glb, <id>_lod1.glb. Root `<id>` (faces +Z, origin at the ground centre):
  ballista : body (carriage + bow, recoils), bolt (procedural; flies forward on `fire`, re-appears on `reload`)
  trebuchet: frame (static), arm (pivot at the axle; swings over the top on `fire`), rope (sling, child of arm,
             pivot at the arm tip), stone (child of rope, released on `fire`)
Clips (glTF animations from NLA tracks, 24 fps): idle, fire, reload, hit, death. Fire releases at
`fireTime` (manifest) -- spawn the projectile VFX there.
"""
import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

import art_lib as L

FPS = 24


def orient(objs, front_rule):
    """Rotate all LODs about Z so the carriage's long axis is Y and the front faces -Y."""
    co = L.verts_np(objs[0]); z = co[:, 2]
    base = co[z < 0.35 * z.max()]
    yaw = L.best_yaw(base[:, :2], prefer_wide_x=True) + math.pi / 2
    for o in objs:
        L.rotate_z(o, yaw)
    co = L.verts_np(objs[0]); y = co[:, 1]; ln = np.ptp(y)
    fr = co[y < y.min() + 0.3 * ln]; bk = co[y > y.max() - 0.3 * ln]
    flip = front_rule(fr, bk)
    if flip:
        for o in objs:
            L.rotate_z(o, math.pi)
    for o in objs:
        c = L.verts_np(o)
        o.data.transform(Matrix.Translation((-(c[:, 0].min() + c[:, 0].max()) / 2, -(c[:, 1].min() + c[:, 1].max()) / 2, -c[:, 2].min())))


def mat_flat(name, rgb, rough=0.6, metal=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*rgb, 1); p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    return m


def prim(name, kind, **kw):
    bm = bmesh.new()
    if kind == 'cyl':
        bmesh.ops.create_cone(bm, cap_ends=True, segments=kw.get('seg', 6), radius1=kw['r'], radius2=kw.get('r2', kw['r']), depth=kw['d'])
    else:
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=kw['r'])
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    me.attributes.new('_TEAM', 'FLOAT', 'POINT')
    return ob


def key(ob, f, loc=None, rot=None, scale=None):
    if loc is not None:
        ob.location = loc; ob.keyframe_insert('location', frame=f)
    if rot is not None:
        ob.rotation_euler = rot; ob.keyframe_insert('rotation_euler', frame=f)
    if scale is not None:
        ob.scale = scale; ob.keyframe_insert('scale', frame=f)


def clip(objs, name, fn, n):
    """Make one action per object for clip `name`, push each to an NLA track named `name`."""
    for o in objs:
        if o.animation_data is None:
            o.animation_data_create()
        act = bpy.data.actions.new(f'{name}__{o.name}')
        o.animation_data.action = act
        fn(o, n)
        tr = o.animation_data.nla_tracks.new(); tr.name = name
        tr.strips.new(name, 0, act)
        o.animation_data.action = None
    return n


def split(ob, mask, name, pivot):
    """Separate the vertices in `mask` (and their faces) into a new object whose origin is `pivot`."""
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bm.verts.ensure_lookup_table()
    sel = [f for f in bm.faces if all(mask[v.index] for v in f.verts)]
    sel_idx = {f.index for f in sel}
    bm2 = bmesh.new()
    me2 = bpy.data.meshes.new(name)
    tmp = ob.data.copy()
    bmesh.ops.delete(bm, geom=sel, context='FACES_ONLY')
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bm.to_mesh(ob.data); bm.free()
    bmt = bmesh.new(); bmt.from_mesh(tmp)
    bmt.faces.ensure_lookup_table()
    keep = set(range(len(bmt.faces))) - sel_idx
    bmesh.ops.delete(bmt, geom=[bmt.faces[i] for i in keep], context='FACES_ONLY')
    bmesh.ops.delete(bmt, geom=[v for v in bmt.verts if not v.link_faces], context='VERTS')
    bmt.to_mesh(me2); bmt.free(); bpy.data.meshes.remove(tmp)
    me2.transform(Matrix.Translation(-pivot))
    o2 = bpy.data.objects.new(name, me2); bpy.context.scene.collection.objects.link(o2)
    o2.location = pivot
    for m in ob.data.materials:
        me2.materials.append(m)
    return o2


def build_ballista(body, H, lod):
    co = L.verts_np(body)
    L_ = np.ptp(co[:, 1]); top = np.percentile(co[co[:, 1] < co[:, 1].min() + 0.5 * L_][:, 2], 92)
    wood = mat_flat('BoltWood', (0.32, 0.2, 0.1)); iron = mat_flat('BoltIron', (0.5, 0.5, 0.52), 0.35, 1.0)
    shaft = prim('bolt', 'cyl', r=0.025, d=L_ * 0.55, seg=5 if lod else 8)
    shaft.data.transform(Matrix.Rotation(math.pi / 2, 4, 'X'))
    tip = prim('tip', 'cyl', r=0.05, r2=0.0, d=0.18, seg=5 if lod else 8)
    tip.data.transform(Matrix.Rotation(-math.pi / 2, 4, 'X') @ Matrix.Translation((0, 0, 0)))
    tip.location = (0, -L_ * 0.3, 0)
    shaft.data.materials.append(wood); tip.data.materials.append(iron)
    L.select_only(shaft, tip); bpy.context.view_layer.objects.active = shaft; bpy.ops.object.join()
    bolt = bpy.context.view_layer.objects.active; bolt.name = 'bolt'
    bolt.location = (0, -L_ * 0.05, top + 0.02)
    body.name = 'body'
    rest_b = bolt.location.copy()
    def anim(o, n, clipname):
        if o.name.startswith('bolt'):
            if clipname == 'fire':
                key(o, 0, loc=rest_b, scale=(1, 1, 1)); key(o, 2, loc=rest_b + Vector((0, -0.4, 0)))
                key(o, 4, loc=rest_b + Vector((0, -6, 0.2)), scale=(1, 1, 1)); key(o, 5, scale=(0, 0, 0)); key(o, n - 1, loc=rest_b, scale=(0, 0, 0))
            elif clipname == 'reload':
                key(o, 0, loc=rest_b + Vector((0, 0.7, 0.05)), scale=(0, 0, 0)); key(o, n * 0.25, loc=rest_b + Vector((0, 0.7, 0.05)), scale=(1, 1, 1))
                key(o, n * 0.7, loc=rest_b + Vector((0, 0.08, 0)), scale=(1, 1, 1)); key(o, n - 1, loc=rest_b, scale=(1, 1, 1))
            elif clipname == 'death':
                key(o, 0, loc=rest_b, scale=(1, 1, 1)); key(o, 6, scale=(0, 0, 0))
            else:
                key(o, 0, loc=rest_b, scale=(1, 1, 1)); key(o, n - 1, loc=rest_b, scale=(1, 1, 1))
        else:
            if clipname == 'fire':
                key(o, 0, loc=(0, 0, 0), rot=(0, 0, 0)); key(o, 2, loc=(0, -0.03, 0), rot=(-0.02, 0, 0))        # audit pass: readable recoil
                key(o, 5, loc=(0, 0.3, 0.03), rot=(0.12, 0, 0)); key(o, 10, loc=(0, 0.2, 0), rot=(-0.02, 0, 0))
                key(o, 20, loc=(0, 0, 0), rot=(0, 0, 0)); key(o, n - 1, loc=(0, 0, 0), rot=(0, 0, 0))
            elif clipname == 'reload':
                key(o, 0, loc=(0, 0, 0), rot=(0, 0, 0))
                for i in range(1, 7):                                   # the crew cranks the windlass: small rhythmic rock
                    key(o, n * i / 8, rot=(0.022 * (1 if i % 2 else -0.4), 0, 0.012 * (1 if i % 2 else -1)))
                key(o, n - 1, loc=(0, 0, 0), rot=(0, 0, 0))
            elif clipname == 'hit':
                key(o, 0, loc=(0, 0, 0), rot=(0, 0, 0)); key(o, 2, loc=(0, 0.08, 0), rot=(0.07, 0.09, 0.05)); key(o, 5, loc=(0, 0.02, 0), rot=(-0.03, -0.04, -0.02))
                key(o, n - 1, loc=(0, 0, 0), rot=(0, 0, 0))
            elif clipname == 'death':
                key(o, 0, loc=(0, 0, 0), rot=(0, 0, 0)); key(o, 6, loc=(0.05, 0.1, 0.05), rot=(0.1, 0.2, 0.05))
                key(o, 16, loc=(0.35, 0.05, -0.12), rot=(0.12, 0.95, 0.12)); key(o, 20, loc=(0.37, 0.05, -0.1), rot=(0.12, 0.88, 0.12))
                key(o, n - 1, loc=(0.38, 0.05, -0.12), rot=(0.12, 0.93, 0.12))
            else:
                key(o, 0, loc=(0, 0, 0), rot=(0, 0, 0)); key(o, n - 1, loc=(0, 0, 0), rot=(0, 0, 0))
    return [body, bolt], anim, {'fireTime': round(4 / FPS, 3)}


def build_trebuchet(body, H, lod):
    co = L.verts_np(body)
    # the throwing arm is the longest straight beam above the base: seeded RANSAC line fit
    from rig import surface_points
    dense = surface_points(body, 120000)
    up = dense[dense[:, 2] > 0.3 * H]
    rng = np.random.default_rng(3)
    best = None
    for _ in range(600):
        i, j = rng.choice(len(up), 2, replace=False)
        dd = up[j] - up[i]; nl = np.linalg.norm(dd)
        if nl < 0.25 * H or abs(dd[2]) / nl > 0.85:          # skip short or near-vertical (upright) beams
            continue
        dd = dd / nl
        rr = up - up[i]; sp = rr @ dd
        inl = np.linalg.norm(rr - np.outer(sp, dd), axis=1) < 0.035 * H
        if inl.sum() < 800:
            continue
        ext = np.percentile(sp[inl], 99) - np.percentile(sp[inl], 1)
        score = inl.sum() * ext
        if best is None or score > best[0]:
            best = (score, up[i].copy(), dd.copy())
    c = best[1]; dd = best[2]
    # RANSAC sits on the beam's surface: refit the axis through the beam's volume (PCA of nearby dense points)
    for _ in range(2):
        rr = dense - c; sp = rr @ dd
        nb = dense[np.linalg.norm(rr - np.outer(sp, dd), axis=1) < 0.08 * H]
        c = nb.mean(0); dd = np.linalg.svd(nb - c, full_matrices=False)[2][0]
    rr = dense - c; sp = rr @ dd
    pp = np.linalg.norm(rr - np.outer(sp, dd), axis=1)
    beam_r = float(np.percentile(pp[pp < 0.08 * H], 90)) + 0.01 * H
    d = Vector(dd.tolist())
    if d.z < 0:
        d = -d
    rel = co - c
    sproj = rel @ np.array(d)
    perp = np.linalg.norm(rel - np.outer(sproj, np.array(d)), axis=1)
    near = perp < beam_r
    s0, s1 = np.percentile(sproj[near], 1), np.percentile(sproj[near], 99.5)
    tip = Vector(c.tolist()) + d * s1
    piv = Vector(c.tolist()) + d * (s0 + 0.28 * (s1 - s0))      # long arm : short arm ~ 2.5 : 1
    seg = tip - piv; ln = seg.length
    s = sproj - (s0 + 0.28 * (s1 - s0))
    mask = near & (sproj >= s0 - 0.02 * H) & (sproj <= s1 + 0.02 * H)
    # the sling/bucket hanging under the tip travels with the arm
    dtip = co - np.array(tip)
    mask |= (np.linalg.norm(dtip[:, :2], axis=1) < 0.15 * H) & (dtip[:, 2] < 0.02 * H) & (dtip[:, 2] > -0.3 * H)
    print('[siege] arm verts', int(mask.sum()), 'of', len(co), 'pivot', [round(v, 2) for v in piv], 'tip', [round(v, 2) for v in tip])
    arm = split(body, mask, 'arm', piv)
    body.name = 'frame'
    arm.parent = body          # the arm rides the frame (rocking on fire, the collapse on death)
    rope_len = 0.18 * H
    rope = prim('rope', 'cyl', r=0.02, d=rope_len, seg=4)
    rope.data.transform(Matrix.Translation((0, 0, -rope_len / 2)))
    rope.data.materials.append(mat_flat('Rope', (0.45, 0.36, 0.22), 0.9))
    rope.parent = arm; rope.location = tip - piv
    stone = prim('stone', 'ico', r=0.035 * H); stone.data.materials.append(mat_flat('Stone', (0.4, 0.39, 0.37), 0.9))
    stone.parent = rope; stone.location = (0, 0, -rope_len)
    # throw: the long arm swings about X so its tip travels over the top toward -Y (front)
    yz = Vector((0, seg.y, seg.z)).normalized()
    a0 = math.atan2(yz.y, yz.z)                      # current angle from +Z toward +Y
    swing = a0 + math.radians(60)                    # +X rotation lifts +Y over the top; ends 60 deg past vertical (front)
    def anim(o, n, clipname):
        if o.name == 'arm':
            if clipname == 'fire':
                key(o, 0, rot=(0, 0, 0)); key(o, 6, rot=(swing * 0.25, 0, 0)); key(o, 12, rot=(swing, 0, 0))
                key(o, 16, rot=(swing * 1.09, 0, 0)); key(o, 22, rot=(swing * 0.96, 0, 0)); key(o, 29, rot=(swing * 1.02, 0, 0)); key(o, n - 1, rot=(swing, 0, 0))
            elif clipname == 'reload':
                key(o, 0, rot=(swing, 0, 0)); key(o, n - 1, rot=(0, 0, 0))
            elif clipname == 'death':
                key(o, 0, rot=(0, 0, 0)); key(o, n - 1, rot=(swing * 0.6, 0.2, 0))
            else:
                key(o, 0, rot=(0, 0, 0)); key(o, n - 1, rot=(0, 0, 0))
        elif o.name == 'rope':
            if clipname == 'fire':
                key(o, 0, rot=(0, 0, 0)); key(o, 8, rot=(-swing * 0.6, 0, 0)); key(o, 12, rot=(-swing * 1.1, 0, 0)); key(o, n - 1, rot=(-swing * 0.2, 0, 0))
            else:
                key(o, 0, rot=(0, 0, 0)); key(o, n - 1, rot=(0, 0, 0))
        elif o.name == 'stone':
            if clipname == 'fire':
                key(o, 0, scale=(1, 1, 1)); key(o, 11, scale=(1, 1, 1)); key(o, 12, scale=(0, 0, 0)); key(o, n - 1, scale=(0, 0, 0))
            elif clipname == 'reload':
                key(o, 0, scale=(0, 0, 0)); key(o, n * 0.7, scale=(0, 0, 0)); key(o, n - 1, scale=(1, 1, 1))
            elif clipname == 'death':
                key(o, 0, scale=(1, 1, 1)); key(o, 4, scale=(0, 0, 0))
            else:
                key(o, 0, scale=(1, 1, 1)); key(o, n - 1, scale=(1, 1, 1))
        else:
            if clipname == 'hit':
                key(o, 0, rot=(0, 0, 0)); key(o, 2, rot=(0.025, 0.05, 0.03)); key(o, 6, rot=(-0.01, -0.02, -0.01)); key(o, n - 1, rot=(0, 0, 0))
            elif clipname == 'fire':                                   # the frame rocks as the arm goes over
                key(o, 0, rot=(0, 0, 0)); key(o, 9, rot=(0.03, 0, 0)); key(o, 14, rot=(-0.05, 0, 0)); key(o, 21, rot=(0.02, 0, 0)); key(o, n - 1, rot=(0, 0, 0))
            elif clipname == 'death':
                key(o, 0, loc=(0, 0, 0), rot=(0, 0, 0)); key(o, 8, loc=(0, 0, -0.05), rot=(0.04, 0.12, 0.02))
                key(o, 22, loc=(0.5, 0, -0.5), rot=(0.1, 0.62, 0.08)); key(o, 27, loc=(0.5, 0, -0.45), rot=(0.1, 0.57, 0.08)); key(o, n - 1, loc=(0.52, 0, -0.5), rot=(0.1, 0.6, 0.08))
            else:
                key(o, 0, loc=(0, 0, 0), rot=(0, 0, 0)); key(o, n - 1, loc=(0, 0, 0), rot=(0, 0, 0))
    return [body, arm, rope, stone], anim, {'fireTime': round(12 / FPS, 3)}


def strip(parts, lens, out, kit, spec=None):
    """SIEGE_STRIP=out.png: side-on EEVEE tiles of clip poses (`SIEGE_POSES` = 'fire:0,fire:6,...'), team cloth in blue."""
    import os
    import trappings as TR
    import trappings_lib as T
    poses = [p.split(':') for p in (os.environ.get('SIEGE_POSES') or 'idle:0,fire:5,fire:10,fire:14,fire:24,reload:30,hit:2,death:35').split(',')]
    for o in parts[:1]:
        TR.tint_preview(o)
    co = np.concatenate([np.array([o.matrix_world @ v.co for v in o.data.vertices]) for o in parts])
    lo, hi = co.min(0), co.max(0)
    me = bpy.data.meshes.new('_bb'); me.from_pydata([tuple(lo - (0, 2.5, 0)), tuple(hi + (0, 1.5, 3.0))], [], [])
    bb = bpy.data.objects.new('_bb', me); bpy.context.scene.collection.objects.link(bb)
    tiles = []
    yaw = float(os.environ.get('SIEGE_YAW', -62))
    for k, (cl, fr) in enumerate(poses):
        for o in parts:
            for tr in o.animation_data.nla_tracks:
                tr.mute = tr.name != cl
        bpy.context.scene.frame_set(int(fr))
        f = str(out).replace('.png', f'_{k}.png')
        TR.render_views(f, [bb], views=[(yaw, 10)], res=(640, 640))
        tiles.append(T.load_px(f)); os.remove(f)
    for o in parts:
        for tr in o.animation_data.nla_tracks:
            tr.mute = False
    bpy.context.scene.frame_set(0)
    bpy.data.objects.remove(bb, do_unlink=True)
    sheet = np.concatenate(tiles, 1)
    img = bpy.data.images.new('_s', sheet.shape[1], sheet.shape[0]); img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = str(out); img.file_format = 'PNG'; img.save(); bpy.data.images.remove(img)
    for o in list(bpy.data.objects):
        if o.name.startswith('_pv'):
            bpy.data.objects.remove(o, do_unlink=True)


def authored(aid, a):
    """Authored engines (assets.json `authored: true`): geometry + atlas from siege_kit.py, no TRELLIS mesh.
    Writes <id>.glb / <id>_lod1.glb to art_lib.OUT when `ART_OUT` (run.mjs --stage) is set, else to
    art-work/stage_v2/ (never straight into public/models/v2), the team masks and facts to art-work/clean/."""
    import os
    import siege_kit as SK
    out = L.OUT if os.environ.get('ART_OUT') or os.environ.get('SIEGE_PUBLIC') else L.WORK / 'stage_v2'
    out.mkdir(parents=True, exist_ok=True); (L.WORK / 'clean').mkdir(parents=True, exist_ok=True)
    facts = dict(id=aid, height=a['height'], clips={}, authored=True)
    for lod, name in ((False, aid), (True, f'{aid}_lod1')):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.context.scene.render.fps = FPS
        r = SK.build(aid, lod)
        nodes = r['nodes']
        root = bpy.data.objects.new(aid, None); bpy.context.scene.collection.objects.link(root)
        parts = [nodes[n] for n in r['order']]
        for n in r['order']:
            if nodes[n].parent is None:
                nodes[n].parent = root
        bpy.context.view_layer.update()
        for cname, n in r['lens'].items():
            clip(parts, cname, lambda o, nn, c=cname: r['anim'](o.name, c, nn, key, o), n)
            facts['clips'][cname] = dict(duration=round((n - 1) / FPS, 3), loop=cname == 'idle')
        facts['fireTime'] = round(r['fire_frame'] / FPS, 3)
        facts['nodes'] = list(r['order'])
        kit = r['kit']
        L.save_gray(kit.team, L.WORK / 'clean' / (f'{aid}_lod1_team.png' if lod else f'{aid}_team.png'), *((256, 256) if lod else (1024, 1024)))
        co = np.concatenate([np.array([o.matrix_world @ v.co for v in o.data.vertices]) for o in parts])
        if not lod:
            facts['bounds'] = [co.min(0).round(3).tolist(), co.max(0).round(3).tolist()]
            facts['team_frac'] = max(0.01, float((kit.team > 0.5).mean()))
            facts['atlas'] = int(parts[0]['atlas']); facts['texel'] = round(float(parts[0]['texel']), 1)
            facts['height'] = round(float(co[:, 2].max()), 2)             # the real rest height (pennants included)
            if r.get('release'):
                # where the projectile leaves the engine, model space (Blender: -Y forward, Z up): the renderer's `muzzle` height
                facts['release'] = [round(float(x), 3) for x in r['release']]
            if r.get('throw_top'):
                facts['throw_top'] = r['throw_top']
        L.export_glb(out / f'{name}.glb', [root] + parts, anims=True,
                     extra=dict(export_animation_mode='NLA_TRACKS', export_anim_single_armature=False,
                                export_optimize_animation_keep_anim_object=True, export_optimize_animation_size=False))
        facts['tris_lod1' if lod else 'tris_lod0'] = sum(L.tris(p) for p in parts)
        if not lod and os.environ.get('SIEGE_STRIP'):           # review: poses of the clips, straight from the build scene
            strip(parts, r['lens'], os.environ['SIEGE_STRIP'], kit)
        if not lod and os.environ.get('SIEGE_BLEND'):
            bpy.ops.wm.save_as_mainfile(filepath=os.environ['SIEGE_BLEND'], compress=True)
    facts['clips_custom'] = {'idle': 'idle', 'attack': 'fire', 'reload': 'reload', 'hit': 'hit', 'death': 'death'}
    (L.WORK / 'clean' / f'{aid}.json').write_text(json.dumps(facts, indent=1))
    print('[siege] authored', aid, 'tris', facts['tris_lod0'], facts['tris_lod1'], 'atlas', facts['atlas'], 'bounds', facts['bounds'], '->', out)


def main():
    aid = L.argv()[0]
    a = L.assets()[aid]
    H = a['height']
    if a.get('authored'):
        return authored(aid, a)
    bpy.ops.wm.open_mainfile(filepath=str(L.WORK / 'blend' / f'{aid}_clean.blend'))
    bpy.context.scene.render.fps = FPS
    l0 = bpy.data.objects[aid]; l1 = bpy.data.objects[f'{aid}_lod1']
    l0.name = '_l0'; l1.name = '_l1'
    if aid == 'ballista':
        rule = lambda fr, bk: np.ptp(fr[:, 0]) < np.ptp(bk[:, 0])           # bow (widest) at the front
    else:
        rule = lambda fr, bk: fr[:, 2].max() > bk[:, 2].max()               # cocked arm tip at the back
    if a.get('flip'):                                   # assets.json `flip`: the front rule guessed wrong for this mesh
        rule0 = rule; rule = lambda fr, bk: not rule0(fr, bk)
    orient([l0, l1], rule)
    facts = dict(id=aid, height=H, clips={})
    for lod, src, name in ((False, l0, aid), (True, l1, f'{aid}_lod1')):
        src.name = 'body'
        parts, anim, extra = (build_ballista if aid == 'ballista' else build_trebuchet)(src, H, lod)
        root = bpy.data.objects.new(aid, None); bpy.context.scene.collection.objects.link(root)
        for p in parts:
            if p.parent is None:
                p.parent = root
        lens = {'idle': 48, 'fire': 30 if aid == 'ballista' else 40, 'reload': 48 if aid == 'ballista' else 72, 'hit': 10, 'death': 36}
        for cname, n in lens.items():
            clip(parts, cname, lambda o, nn, c=cname: anim(o, nn, c), n)
            facts['clips'][cname] = dict(duration=round((n - 1) / FPS, 3), loop=cname == 'idle')
        facts.update(extra)
        facts['nodes'] = [p.name.split('.')[0] for p in parts]
        L.export_glb(L.OUT / f'{name}.glb', [root] + parts, anims=True,
                     extra=dict(export_animation_mode='NLA_TRACKS', export_anim_single_armature=False,
                                    export_optimize_animation_keep_anim_object=True, export_optimize_animation_size=False))
        facts['tris_lod1' if lod else 'tris_lod0'] = sum(L.tris(p) for p in parts)
        for o in [root] + parts:
            bpy.data.objects.remove(o, do_unlink=True)
    facts['clips_custom'] = {'idle': 'idle', 'attack': 'fire', 'reload': 'reload', 'hit': 'hit', 'death': 'death'}
    facts['team_frac'] = 0.01
    (L.WORK / 'clean' / f'{aid}.json').write_text(json.dumps(facts, indent=1))
    print('[siege] done', aid, facts['tris_lod0'], facts['tris_lod1'])


if __name__ == '__main__':
    main()
