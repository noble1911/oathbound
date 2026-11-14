# Convert art-work/ui/*.png to the WebPs the client loads from public/ui/ (centre-cropped squares:
# portraits 512, unit cards 320, item icons 256; key art 1920 wide). Writes public/ui/manifest.json
# listing what exists, so the client can fall back to crest placeholders for anything missing.
import json, os, sys
from PIL import Image

root = os.path.join(os.path.dirname(__file__), '..', '..')
src = os.path.join(root, 'art-work', 'ui')
dst = os.path.join(root, 'public', 'ui')
os.makedirs(dst, exist_ok=True)
done = []
for f in sorted(os.listdir(src)):
    if not f.endswith('.png'):
        continue
    id = f[:-4]
    im = Image.open(os.path.join(src, f)).convert('RGB')
    w, h = im.size
    if id == 'keyart':
        im = im.resize((1920, round(1920 * h / w)), Image.LANCZOS)
        q = 82
    else:
        s = min(w, h)
        im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
        size = 512 if id.startswith('lord_') else 320 if id.startswith('unit_') else 256
        im = im.resize((size, size), Image.LANCZOS)
        q = 84
    im.save(os.path.join(dst, id + '.webp'), 'WEBP', quality=q, method=6)
    done.append(id)
json.dump(sorted(done), open(os.path.join(dst, 'manifest.json'), 'w'))
print(f'{len(done)} webp in public/ui')
