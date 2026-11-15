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
    import trappings
    ob = trappings.build(name, args, ctx)
    if ob is None or ob.type != 'MESH' or not ob.data.uv_layers or not ob.data.materials:
        raise RuntimeError(f'trappings.build({name!r}) must return a mesh object with a UV map and a material')
    if not ob.users_collection:
        bpy.context.scene.collection.objects.link(ob)
    return ob
