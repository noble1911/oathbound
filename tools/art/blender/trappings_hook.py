"""Bridge between cleanup.py (`parts` with a `builder`) and the trappings kit (tools/art/blender/trappings.py).

Contract of `trappings.build(name, args, ctx)`:
  name  builder name from assets.json (`"builder": "caparison"`), args = the part's `args` dict
  ctx   dict(unit=<asset id>, asset=<assets.json entry>, body=<TRELLIS body object, already oriented / scaled, or None>,
             height=<unit height, m>, parts={<name>: <object>} built so far)
  ->    ONE Blender mesh object in unit space (metres, Z up, the unit faces -Y), with
          * one UV map, islands inside 0..1 and not overlapping (cleanup re-packs them into the unit atlas),
          * material(s) whose Principled Base Color (and optionally Roughness / Metallic / Normal) are what the
            atlas should show: the albedo already neutral grey under the team mask,
          * optional custom properties: `team_image` = name of a greyscale bpy image in the same UVs (the part's
            own team mask), `double_sided` = True for single-sheet cloth (gets a double-sided primitive).
The object is both the bake source and the low mesh; the part's `pos` / `yaw` / `scale` are applied on top."""
import bpy


def build(name, args, ctx):
    """`args.frame` = {"rig": true, "tilt": deg, "pivot": [x, y, z]}: build the part in another frame of the body.
    The drape builders expect a body along Y, centred on x = 0, with a level back. `rig`: the body is first put
    into the rig frame of tools/art/creatures.json (its `yaw` / `dx`: a mount mesh that TRELLIS returned turned);
    `tilt`: then pitched by that many degrees about X through `pivot` (an upright wyvern / roc: 50-60 lays its
    back level). The finished part is transformed back, so it sits on the body as cleanup holds it."""
    import trappings
    fr = args.get('frame')
    body = ctx.get('body')
    if fr and body is not None:
        import json, math
        from pathlib import Path
        from mathutils import Matrix, Vector
        M = Matrix.Identity(4)
        if fr.get('rig'):
            cfg = json.loads((Path(__file__).resolve().parents[1] / 'creatures.json').read_text()).get(ctx.get('unit') or ctx.get('id'), {})
            M = Matrix.Translation((-cfg.get('dx', 0.0), 0, 0)) @ Matrix.Rotation(math.radians(cfg.get('yaw', 0.0)), 4, 'Z')
        if fr.get('tilt'):
            pv = Vector(fr.get('pivot', (0, 0, 0)))
            M = Matrix.Translation(pv) @ Matrix.Rotation(math.radians(fr['tilt']), 4, 'X') @ Matrix.Translation(-pv) @ M
        b2 = body.copy(); b2.data = body.data.copy(); bpy.context.scene.collection.objects.link(b2)
        b2.data.transform(M); b2.data.update()
        ob = trappings.build(name, {k: v for k, v in args.items() if k != 'frame'}, dict(ctx, body=b2))
        ob.data.transform(M.inverted()); ob.data.update()
        bpy.data.objects.remove(b2, do_unlink=True)
    else:
        ob = trappings.build(name, args, ctx)
    if ob is None or ob.type != 'MESH' or not ob.data.uv_layers or not ob.data.materials:
        raise RuntimeError(f'trappings.build({name!r}) must return a mesh object with a UV map and a material')
    if not ob.users_collection:
        bpy.context.scene.collection.objects.link(ob)
    return ob
