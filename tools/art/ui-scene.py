# Convert art-work/ui-scenes/*.png (tools/art/ui-scene.mjs) to the WebPs the menus load from public/ui/:
#   scene_field      1536 wide  the woodcut battlefield behind the menus when the live battle cannot draw
#   scene_initial    384 square the printer's initial O (the title menu)
#   scene_headpiece  1200 wide  the marching headpiece, cropped to its strip (the title menu)
# and add their ids to public/ui/manifest.json (the other entries are left as they are).
import json, os
from PIL import Image

root = os.path.join(os.path.dirname(__file__), '..', '..')
src = os.path.join(root, 'art-work', 'ui-scenes')
dst = os.path.join(root, 'public', 'ui')
SPEC = {'field': (1536, None, 80), 'initial': (384, None, 86), 'headpiece': (1200, (0.0, 0.31, 1.0, 0.76), 82)}
done = []
for id, (width, crop, q) in SPEC.items():
    p = os.path.join(src, id + '.png')
    if not os.path.exists(p):
        continue
    im = Image.open(p).convert('RGB')
    w, h = im.size
    if crop:
        im = im.crop((round(crop[0] * w), round(crop[1] * h), round(crop[2] * w), round(crop[3] * h)))
        w, h = im.size
    im = im.resize((width, round(width * h / w)), Image.LANCZOS)
    if id != 'field':
        # the paper pieces are laid over the UI's own parchment with `mix-blend-mode: multiply`: lift their paper to
        # white (divide by its colour, the median of the light pixels) so only the ink prints
        import numpy as np
        px = np.asarray(im).astype(np.float32)
        light = px[px.sum(axis=2) > 540]
        paper = np.median(light, axis=0) * 0.97
        im = Image.fromarray(np.clip(px / paper * 255.0, 0, 255).astype(np.uint8))
    im.save(os.path.join(dst, f'scene_{id}.webp'), 'WEBP', quality=q, method=6)
    done.append(f'scene_{id}')
mf = os.path.join(dst, 'manifest.json')
ids = set(json.load(open(mf))) | set(done)
json.dump(sorted(ids), open(mf, 'w'))
print(f'{len(done)} scene webp in public/ui: {done}')
