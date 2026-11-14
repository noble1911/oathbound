"""Overlay a metric grid (+ the joints of tools/art/creatures.json) on creature_view.py renders.
python tools/art/creature_grid.py <dir> <mount id>   (needs Pillow; authoring aid only)"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw

VIEWS = {'side': ((0, -1, 0), (0, 0, 1)), 'top': ((1, 0, 0), (0, 1, 0)), 'front': ((1, 0, 0), (0, 0, 1))}
d, mid = Path(sys.argv[1]), sys.argv[2]
v = json.loads((d / f'{mid}_view.json').read_text())
cfgp = Path(__file__).resolve().parent / 'creatures.json'
cfg = json.loads(cfgp.read_text()).get(mid, {}) if cfgp.exists() else {}
c, S = v['centre'], v['scale']
step = 0.1 if S < 3 else (0.25 if S < 6 else 0.5)
for name, (r, u) in VIEWS.items():
    im = Image.open(d / f'{mid}_{name}.png').convert('RGB'); W = im.size[0]; dr = ImageDraw.Draw(im)
    ax = [i for i in range(3) if r[i]][0]; ay = [i for i in range(3) if u[i]][0]; sx = r[ax]
    X = lambda p: (sx * (p - c[ax]) / S + 0.5) * W
    Y = lambda p: (0.5 - (p - c[ay]) / S) * W
    k = int(S / step) + 2
    for i in range(-k, k):
        t = i * step
        big = abs(t / (step * 5) - round(t / (step * 5))) < 1e-6
        for (a, b, col) in ((X(t), None, (255, 90, 90)), (None, Y(t), (90, 130, 255))):
            if a is not None and 0 <= a < W:
                dr.line([a, 0, a, W], fill=col, width=2 if big else 1); dr.text((a + 2, 2), f'{t:g}', fill=(255, 255, 0))
            if b is not None and 0 <= b < W:
                dr.line([0, b, W, b], fill=col, width=2 if big else 1); dr.text((2, b + 1), f'{t:g}', fill=(0, 255, 255))
    chains = {'spine': cfg.get('spine'), 'neck': (cfg.get('neck') or []) + ([cfg['head']] if 'head' in cfg else []), 'tail': cfg.get('tail')}
    for grp in ('legs', 'wings'):
        g = cfg.get(grp, {})
        for k, pts in g.items():
            chains[k] = pts
            other = k[:-1] + 'r' if k.endswith('l') else None
            if other and other not in g:
                chains[other] = [[-p[0], p[1], p[2]] for p in pts]
    if 'seat' in cfg:
        chains['seat'] = [cfg['seat'], cfg['seat']]
    for nm, pts in chains.items():
        if not pts:
            continue
        q = [(X(p[ax]), Y(p[ay])) for p in pts]
        dr.line(q, fill=(0, 255, 0), width=3)
        for x, y in q:
            dr.ellipse([x - 5, y - 5, x + 5, y + 5], outline=(255, 255, 255), width=2)
        dr.text((q[0][0] + 6, q[0][1] - 12), nm, fill=(255, 255, 255))
    im.save(d / f'{mid}_{name}_grid.jpg', quality=85)
print('grid', mid, 'step', step)
