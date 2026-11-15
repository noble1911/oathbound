# Battlefield glyph atlas for the in-world squad plates (src/render/plates.ts).
#   art-work/glyphs/<id>.png (Codex, see tools/art/ui-woodcut.mjs)  ->  public/ui/plates.webp + public/ui/plates.json
# Every glyph is forced into its faction's three flat colours (disc, glyph, accent), then centred and scaled so its
# silhouette just fits one circle, so the set reads as one family whatever the generator drew. Cells are 128 px
# (the plate shows them at 30 to 60 px), 8 x 8 = 1024 x 1024; the order is the key order of ui-prompts/glyphs.json and
# is written to plates.json, which is what the client reads. The last cell is the fallback (a plain helm on slate).
# Also writes art-work/glyphs/out/<id>.png (one 128 px cell each) for contact sheets.
#   python tools/art/glyph-atlas.py
import json, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

root = os.path.join(os.path.dirname(__file__), '..', '..')
src = os.path.join(root, 'art-work', 'glyphs')
out = os.path.join(src, 'out')
os.makedirs(out, exist_ok=True)
glyphs = json.load(open(os.path.join(root, 'tools', 'art', 'ui-prompts', 'glyphs.json'), encoding='utf8'))
CELL, COLS, ROWS = 128, 8, 8
FILL = 0.98  # the silhouette's enclosing circle, as a fraction of the cell's half-size
WORK = 768
BOLD = 9  # px of WORK (odd): strokes grow by (BOLD - 1) / 2 on each side

# faction: (disc, glyph, accent) as shipped, and what the generator tends to paint for each (the k-means seeds)
PALETTE = {
    'kingdom': ((0x1b, 0x2e, 0xa0), (0xf4, 0xea, 0xd0), (0xbc, 0xc7, 0xdb)),
    'ashen': ((0x16, 0x17, 0x1a), (0xe8, 0xe1, 0xca), (0x6c, 0xe0, 0x62)),
    'caliphate': ((0xb2, 0x44, 0x27), (0xf2, 0xdc, 0xa8), (0x2a, 0xc4, 0xb6)),
}
SEED = {
    'kingdom': ((10, 20, 170), (250, 240, 215), (160, 160, 165)),
    'ashen': ((20, 20, 20), (235, 228, 205), (120, 200, 60)),
    'caliphate': ((190, 70, 40), (240, 215, 165), (40, 170, 160)),
}


def quantise(im, faction):
    """Label every pixel 0 disc / 1 glyph / 2 accent (k-means from the faction's seeds; the border fixes the disc)."""
    a = np.asarray(im.convert('RGB').resize((WORK, WORK), Image.LANCZOS)).astype(np.float32)
    px = a.reshape(-1, 3)
    c = np.array(SEED[faction], dtype=np.float32)
    edge = np.concatenate([a[:6].reshape(-1, 3), a[-6:].reshape(-1, 3), a[:, :6].reshape(-1, 3), a[:, -6:].reshape(-1, 3)])
    c[0] = np.median(edge, axis=0)
    for _ in range(8):
        d = ((px[:, None, :] - c[None]) ** 2).sum(-1)
        lab = d.argmin(1)
        for k in (1, 2):
            if (lab == k).sum() > 50:
                c[k] = px[lab == k].mean(0)
    # anti-aliased edges between glyph and disc land in the accent cluster as hairlines: open the accent mask
    # (erode, dilate) and hand what falls out to the nearer of disc / glyph
    m = Image.fromarray(((lab == 2) * 255).astype(np.uint8).reshape(WORK, WORK))
    opened = np.asarray(m.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))).reshape(-1) > 127
    thin = (lab == 2) & ~opened
    lab[thin] = d[thin][:, :2].argmin(1)
    lab = lab.reshape(WORK, WORK)
    # bolden: the plate shows a cell at 30 to 45 px, where a hairline (a bowstring, a lance) would vanish
    ink = Image.fromarray(((lab > 0) * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(BOLD))
    acc = Image.fromarray(((lab == 2) * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(BOLD))
    grown = (np.asarray(ink) > 127) & (lab == 0)
    lab[grown] = np.where(np.asarray(acc)[grown] > 127, 2, 1)
    return lab


def cell(im, faction):
    lab = quantise(im, faction)
    ys, xs = np.nonzero(lab)
    if len(xs) == 0:
        raise SystemExit('empty glyph')
    # drop stray specks: keep rows / columns that carry real ink
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
    r = np.sqrt(((xs - cx) ** 2 + (ys - cy) ** 2).max())
    pal = np.array(PALETTE[faction], dtype=np.uint8)
    rgb = Image.fromarray(pal[lab])
    # place: scale so the enclosing circle (centre = bbox centre) has radius FILL * half a cell, supersampled 4x
    S = CELL * 4
    k = FILL * (S / 2) / r
    canvas = Image.new('RGB', (S, S), tuple(PALETTE[faction][0]))
    w = max(1, round(WORK * k))
    scaled = rgb.resize((w, w), Image.LANCZOS)
    canvas.paste(scaled, (round(S / 2 - cx * k), round(S / 2 - cy * k)))
    return canvas.resize((CELL, CELL), Image.LANCZOS)


def fallback():
    S = CELL * 4
    im = Image.new('RGB', (S, S), (0x3a, 0x43, 0x50))
    d = ImageDraw.Draw(im)
    c, u = S / 2, S / 128
    d.pieslice((c - 34 * u, c - 40 * u, c + 34 * u, c + 28 * u), 180, 360, fill=(0xe8, 0xeb, 0xef))
    d.rectangle((c - 34 * u, c - 6 * u, c + 34 * u, c + 34 * u), fill=(0xe8, 0xeb, 0xef))
    d.rectangle((c - 12 * u, c + 2 * u, c + 12 * u, c + 34 * u), fill=(0x3a, 0x43, 0x50))
    d.rectangle((c - 34 * u, c - 4 * u, c + 34 * u, c + 4 * u), fill=(0x3a, 0x43, 0x50))
    return im.resize((CELL, CELL), Image.LANCZOS)


atlas = Image.new('RGB', (COLS * CELL, ROWS * CELL), (0x3a, 0x43, 0x50))
ids = []
for id, g in glyphs.items():
    p = os.path.join(src, id + '.png')
    if not os.path.exists(p):
        print('missing', id)
        continue
    c = cell(Image.open(p), g['faction'])
    c.save(os.path.join(out, id + '.png'))
    i = len(ids)
    atlas.paste(c, ((i % COLS) * CELL, (i // COLS) * CELL))
    ids.append(id)
assert len(ids) < COLS * ROWS
i = len(ids)
fb = fallback()
fb.save(os.path.join(out, '_fallback.png'))
atlas.paste(fb, ((i % COLS) * CELL, (i // COLS) * CELL))
dst = os.path.join(root, 'public', 'ui')
atlas.save(os.path.join(dst, 'plates.webp'), 'WEBP', lossless=True, method=6)
json.dump({'cell': CELL, 'cols': COLS, 'rows': ROWS, 'ids': ids, 'fallback': i,
           'factions': {id: glyphs[id]['faction'] for id in ids}}, open(os.path.join(dst, 'plates.json'), 'w'))
print(f'{len(ids)} glyphs -> public/ui/plates.webp ({os.path.getsize(os.path.join(dst, "plates.webp")) // 1024} KB)')
