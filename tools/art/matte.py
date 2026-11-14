"""Matte + score + contact sheet + pick for Codex concept candidates (WSL venv).

python tools/art/matte.py --ids militia,knight [--force]
In : art-work/concepts/<id>/cand_<k>.png     Out: cand_<k>_cut.png (RGBA, BiRefNet matte), sheet.jpg, pick.json
Pick = tools/art/picks.json override, else the best heuristic score (uncropped, single clean silhouette).
"""
import argparse, json
from pathlib import Path

from PIL import Image

import concept as C   # Matte, score, sheet

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / 'art-work' / 'concepts'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ids', required=True)
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    picks = json.loads((C.ART / 'picks.json').read_text()) if (C.ART / 'picks.json').exists() else {}
    matte = None
    for i in a.ids.split(','):
        d = WORK / i
        cands = []
        for p in sorted(d.glob('cand_*.png')):
            if p.stem.endswith('_cut'):
                continue
            k = int(p.stem.split('_')[1])
            cp = d / f'cand_{k}_cut.png'
            if not cp.exists() or a.force:
                matte = matte or C.Matte()
                matte(Image.open(p)).save(cp)
            s, info = C.score(Image.open(cp))
            cands.append((k, p, s, info))
        if not cands:
            print(f'{i}: no candidates'); continue
        C.sheet([(c[0], c[1], c[2]) for c in cands], d / 'sheet.jpg')
        best = max(cands, key=lambda c: c[2])
        pick = int(picks.get(i, best[0]))
        (d / 'pick.json').write_text(json.dumps({'cand': pick, 'auto': best[0], 'file': f'cand_{pick}_cut.png',
                                                 'scores': {str(c[0]): [round(c[2], 3), c[3]] for c in cands}}, indent=1))
        print(f'{i}: pick cand {pick} (auto {best[0]})')


if __name__ == '__main__':
    main()
