"""Decode a VAT exactly as the renderer will (from the shipped files only) and render sample frames.

blender -b --factory-startup --python tools/art/blender/vat_check.py -- <id> out.png [clip:t ...]
Reads public/models/v2/<id>.vat.json + .vat.pos.bin + the crowd GLB; moves every glTF vertex to texel
(_VID, frame) and decodes the packed normal (octPosW45) -- the reference implementation for the shader.
"""
import json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bpy
import numpy as np

import art_lib as L
import render_review as RR


def oct_unpack(w, k=45):
    qx = np.floor(w / k); qy = w - qx * k
    x = qx / (k - 1) * 2 - 1; y = qy / (k - 1) * 2 - 1
    z = 1 - np.abs(x) - np.abs(y)
    t = np.clip(-z, 0, None)
    x = x - np.sign(x) * t; y = y - np.sign(y) * t
    n = np.stack([x, y, z], 1)
    return n / np.linalg.norm(n, axis=1, keepdims=True)


def main():
    args = L.argv()
    aid, out = args[0], Path(args[1]).resolve()
    specs = args[2:] or ['idle:0', 'move:0.5', 'attack:0.45', 'attack2:0.4', 'hit:0.5', 'death:1', 'victory:0.3']
    meta = json.loads((L.OUT / f'{aid}.vat.json').read_text())
    W, rows, T = meta['width'], meta['rowsPerFrame'], meta['totalFrames']
    tex = np.fromfile(L.OUT / meta['pos'], dtype='<f2').astype(np.float32).reshape(T * rows, W, 4)
    L.clear(); RR.setup_world()
    objs = L.import_glb(L.OUT / meta['mesh'])
    ob = next(o for o in objs if o.type == 'MESH' and '_VID' in o.data.attributes)
    for o in objs:
        if o.type == 'ARMATURE':
            o.hide_render = True
    ob.modifiers.clear(); ob.parent = None
    # preview the team tint exactly as the renderer does: tintMask texture (R) at UV0
    timg = bpy.data.images.load(str(L.OUT / meta['tintMask'])); timg.colorspace_settings.name = 'Non-Color'
    for slot in ob.material_slots:
        nt = slot.material.node_tree
        pr = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        src = pr.inputs['Base Color'].links[0].from_socket
        tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = timg
        mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
        nt.links.new(tx.outputs['Color'], mix.inputs['Factor']); nt.links.new(src, mix.inputs[6])
        mix.inputs[7].default_value = (*RR.TEAM, 1); nt.links.new(mix.outputs[2], pr.inputs['Base Color'])
    me = ob.data
    vid = np.empty(len(me.vertices), np.float32)
    me.attributes['_VID'].data.foreach_get('value', vid)
    vid = vid.astype(int)
    clips = {c['name']: c for c in meta['clips']}
    tmp = L.WORK / 'review_tmp'; tmp.mkdir(parents=True, exist_ok=True)
    lo = np.array(meta['bounds']['min']); hi = np.array(meta['bounds']['max'])
    fit = (np.array([lo[0], -hi[2], lo[1]]), np.array([hi[0], -lo[2], hi[1]]))
    tiles = []
    for i, s in enumerate(specs):
        name, t = s.split(':')
        c = clips[name]
        f = c['start'] + int(round(float(t) * (c['frames'] - 1)))
        tx = tex[f * rows + vid // W, vid % W]
        p = tx[:, :3]
        p_bl = np.stack([p[:, 0], -p[:, 2], p[:, 1]], 1)
        me.vertices.foreach_set('co', p_bl.astype(np.float32).ravel())
        n = oct_unpack(tx[:, 3])
        me.normals_split_custom_set_from_vertices([tuple((v[0], -v[2], v[1])) for v in n])
        me.update()
        pth = tmp / f'vat_{i}.png'
        RR.render_one([ob], 30, pth, fit)
        tiles.append(pth)
    ims = [L.img_np(bpy.data.images.load(str(p)))[:, :, :3] for p in tiles]
    h, w = ims[0].shape[:2]
    sheet = np.ones((h, w * len(ims), 4), np.float32)
    for i, im in enumerate(ims):
        sheet[:, i * w:(i + 1) * w, :3] = im
    img = bpy.data.images.new('s', w * len(ims), h); L.np_img(img, sheet)
    img.filepath_raw = str(out); img.file_format = 'PNG'; img.save()
    print('[vatcheck] wrote', out, specs)


if __name__ == '__main__':
    main()
