"""Assemble the old-vs-new review sheets from e2e/model-compare.mjs captures.
python e2e/model-sheets.py <e2e/shots/remodel/<batch>> <review dir> [id,id,...]
Per unit: <id>_cameras.jpg (overhead frame + 3x crops, mid-battle, close-up, both teams), <id>_motion.jpg (strips);
per faction: <faction>_overview.jpg (close-ups old | new of every unit). Sheets are copied to the review dir."""
import json, re, shutil, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1]); RAW = OUT / 'raw'; REVIEW = Path(sys.argv[2])
POS = json.loads((RAW / 'pos.json').read_text())
lib = (Path(__file__).parent / 'remodel-lib.mjs').read_text()
FACTION = {m.group(1): {'K': 'kingdom', 'A': 'ashen', 'C': 'caliphate'}[m.group(2)] for m in re.finditer(r"(\w+): \{[^}]*?f: ([KAC])\b", lib)}
ids = sys.argv[3].split(',') if len(sys.argv) > 3 else sorted({k.split('__')[0] for k in POS})
BG = (18, 18, 20)
try:
    FONT = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 26); SMALL = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 20)
except OSError:
    FONT = SMALL = ImageFont.load_default()


def label(im, text, font=FONT):
    d = ImageDraw.Draw(im)
    w = d.textlength(text, font=font)
    d.rectangle([0, 0, w + 20, font.size + 14], fill=(0, 0, 0))
    d.text((10, 5), text, fill=(255, 255, 255), font=font)
    return im


def load(i, v, name):
    f = RAW / f'{i}__{v}__{name}.png'
    return Image.open(f).convert('RGB') if f.exists() else None


def crop(im, xy, w, h, zoom=1.0):
    x, y = xy
    x0 = int(min(max(x - w / 2, 0), im.width - w)); y0 = int(min(max(y - h / 2, 0), im.height - h))
    im = im.crop((x0, y0, x0 + w, y0 + h))
    return im.resize((int(w * zoom), int(h * zoom)), Image.LANCZOS) if zoom != 1 else im


def hstack(tiles, gap=8):
    tiles = [t for t in tiles if t is not None]
    H = max(t.height for t in tiles); W = sum(t.width for t in tiles) + gap * (len(tiles) - 1)
    s = Image.new('RGB', (W, H), BG); x = 0
    for t in tiles:
        s.paste(t, (x, 0)); x += t.width + gap
    return s


def vstack(rows, gap=8):
    rows = [r for r in rows if r is not None]
    W = max(r.width for r in rows); H = sum(r.height for r in rows) + gap * (len(rows) - 1)
    s = Image.new('RGB', (W, H), BG); y = 0
    for r in rows:
        s.paste(r, (0, y)); y += r.height + gap
    return s


def titled(row, title):
    s = Image.new('RGB', (row.width, row.height + 34), BG)
    ImageDraw.Draw(s).text((8, 5), title, fill=(230, 230, 230), font=SMALL); s.paste(row, (0, 34))
    return s


def variants(i):
    vs = []
    for v, lab in (('old', 'OLD'), ('new', 'NEW')):
        info = POS.get(f'{i}__{v}__info')
        if info:
            vs.append((v, lab + ('' if info['art'] else ' (STAND-IN: the art model did not load)')))
    return vs


def save(im, name):
    OUT.mkdir(parents=True, exist_ok=True); REVIEW.mkdir(parents=True, exist_ok=True)
    if im.width > 3400:
        im = im.resize((3400, int(im.height * 3400 / im.width)), Image.LANCZOS)
    im.save(OUT / name, quality=88)
    shutil.copyfile(OUT / name, REVIEW / name)
    print(' ', OUT / name, im.size)


def cameras(i):
    vs = variants(i)
    if not vs or load(i, vs[0][0], 'overview') is None:
        return
    rows = []
    rows.append(titled(hstack([label(load(i, v, 'overview').resize((800, 450), Image.LANCZOS), lab) for v, lab in vs]), f'{i}: planning / overhead camera (1600x900 frame, halved), blue squad near, red far'))
    t = []
    for v, lab in vs:
        im = load(i, v, 'overview')
        for tag, key in (('blue', 'overview'), ('red', 'overview_red')):
            xy = POS.get(f'{i}__{v}__{key}')
            if xy:
                t.append(label(crop(im, xy, 300, 200, 2.0), f'{lab} {tag}'))
    rows.append(titled(hstack(t), 'same frames: 300x200 px around each squad, enlarged 2x (what the player sees while planning)'))
    for shot, title, z in (('mid_blue', 'mid-battle camera, blue', 0.5), ('mid_red', 'mid-battle camera, red', 0.5), ('close_blue', 'close-up, blue', 0.75), ('close_red', 'close-up, red', 0.75), ('back_blue', 'close-up from behind (the RTS camera side), blue', 0.75)):
        t = []
        for v, lab in vs:
            im = load(i, v, shot)
            if im is not None:
                t.append(label(im.resize((int(im.width * z), int(im.height * z)), Image.LANCZOS), lab))
        if t:
            rows.append(titled(hstack(t), f'{i}: {title}'))
    save(vstack(rows), f'{i}_cameras.jpg')


def motion(i):
    vs = variants(i)
    rows = []
    clips = []
    for v, _ in vs:
        for c, d in POS.get(f'{i}__{v}__strips', []):
            if c not in [x[0] for x in clips]:
                clips.append((c, d))
    for c, d in clips:
        for v, lab in vs:
            tiles = []
            k = 0
            while (im := load(i, v, f'strip_{c}_{k}')) is not None:
                tiles.append(im.resize((330, 330), Image.LANCZOS)); k += 1
            if tiles:
                rows.append(label(hstack(tiles, 0), f'{lab}  {c}  ({d:.2f} s)', SMALL))
    if rows:
        save(vstack(rows, 4), f'{i}_motion.jpg')


def overview(faction, members):
    cells = []
    for i in members:
        vs = variants(i)
        t = []
        for v, lab in vs:
            for shot in ('close_blue', 'close_red'):
                im = load(i, v, shot)
                if im is not None:
                    t.append(label(im.resize((480, 270), Image.LANCZOS), f'{i} {lab} {shot[6:]}', SMALL))
        if t:
            cells.append(hstack(t, 4))
    if cells:
        save(vstack(cells, 4), f'_{faction}_overview.jpg')


for i in ids:
    cameras(i); motion(i)
for f in ('kingdom', 'ashen', 'caliphate'):
    overview(f, [i for i in ids if FACTION.get(i) == f])
