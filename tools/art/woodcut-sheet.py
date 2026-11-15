# Contact sheets for review: every glyph cell (128 px and at 32 px in a friendly disc / enemy diamond) and every
# portrait (160 px and 40 px).   python tools/art/woodcut-sheet.py <out dir>
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

root = os.path.join(os.path.dirname(__file__), '..', '..')
dst = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 'art-work')
os.makedirs(dst, exist_ok=True)
glyphs = json.load(open(os.path.join(root, 'tools', 'art', 'ui-prompts', 'glyphs.json'), encoding='utf8'))
ids = list(glyphs)
font = ImageFont.load_default()
BG = (58, 74, 52)


def marker(cell, d, enemy):
    """What plates.ts draws: the glyph in a disc (yours) or a diamond (enemy) with the side's ring; d = disc diameter."""
    S = d * 4
    P = int(S * 1.4)
    m = Image.new('RGBA', (P, P), (0, 0, 0, 0))
    dr = ImageDraw.Draw(m)
    ring = (247, 62, 50) if enemy else (79, 160, 255)
    c = P / 2
    R = S / 2

    def shape(inset, fill):
        r = R - inset * S
        if enemy:
            k = r * 0.93 * 1.36
            dr.polygon([(c, c - k), (c + k, c), (c, c + k), (c - k, c)], fill=fill)
        else:
            dr.ellipse((c - r, c - r, c + r, c + r), fill=fill)
    shape(0, (10, 9, 9, 255))
    shape(0.03, ring + (255,))
    shape(0.105, (10, 9, 9, 255))
    g = cell.convert('RGBA').resize((int(S * 0.75), int(S * 0.75)), Image.LANCZOS)
    mask = Image.new('L', (P, P), 0)
    md = ImageDraw.Draw(mask)
    r = R - 0.125 * S
    if enemy:
        k = r * 0.93 * 1.36
        md.polygon([(c, c - k), (c + k, c), (c, c + k), (c - k, c)], fill=255)
    else:
        md.ellipse((c - r, c - r, c + r, c + r), fill=255)
    layer = Image.new('RGBA', (P, P), g.getpixel((2, 2)))
    layer.paste(g, (int(c - g.size[0] / 2), int(c - g.size[1] / 2)))
    m.paste(layer, (0, 0), mask)
    n = int(d * 1.4)
    return m.resize((n, n), Image.LANCZOS)


# ---- glyphs
W = 8
cw, ch = 190, 240
sheet = Image.new('RGB', (W * cw, ((len(ids) + W - 1) // W) * ch), BG)
dr = ImageDraw.Draw(sheet)
for i, id in enumerate(ids):
    p = os.path.join(root, 'art-work', 'glyphs', 'out', id + '.png')
    if not os.path.exists(p):
        continue
    cell = Image.open(p)
    x, y = (i % W) * cw, (i // W) * ch
    sheet.paste(cell, (x + 31, y + 4))
    xx = x + 2
    for d, en in [(48, False), (48, True), (32, False), (32, True)]:
        m = marker(cell, d, en)
        sheet.paste(m, (xx, y + 134 + (68 - m.size[1]) // 2), m)
        xx += m.size[0] - 8
    dr.text((x + 6, y + 204), id.replace('unit_', '').replace('lord_', 'L:'), fill=(240, 240, 240), font=font)
    dr.text((x + 6, y + 218), glyphs[id]['role'], fill=(200, 210, 190), font=font)
sheet.save(os.path.join(dst, 'sheet-glyphs.png'))

# ---- portraits
cw, ch = 170, 236
sheet = Image.new('RGB', (W * cw, ((len(ids) + W - 1) // W) * ch), (29, 35, 44))
dr = ImageDraw.Draw(sheet)
for i, id in enumerate(ids):
    p = os.path.join(root, 'public', 'ui', id + '.webp')
    if not os.path.exists(p):
        continue
    im = Image.open(p).convert('RGB')
    x, y = (i % W) * cw, (i // W) * ch
    sheet.paste(im.resize((160, 160), Image.LANCZOS), (x + 5, y + 4))
    sheet.paste(im.resize((40, 40), Image.LANCZOS), (x + 5, y + 168))
    sheet.paste(im.resize((28, 28), Image.LANCZOS), (x + 50, y + 174))
    dr.text((x + 84, y + 180), id.replace('unit_', '').replace('lord_', 'L:'), fill=(240, 240, 240), font=font)
sheet.save(os.path.join(dst, 'sheet-portraits.png'))
print('sheets in', dst)
