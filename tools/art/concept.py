"""Stage 1 (concept): prompt -> N seeded candidate images -> background cut-out -> contact sheet + pick.

Runs in the WSL venv (see docs/ART.md):
    python tools/art/concept.py --ids militia,knight --n 6 [--force]

Model: FLUX.1-schnell (Apache-2.0). The transformer is city96's GGUF Q6_K quantisation (fits in 16 GB
with room for the desktop); text encoders + VAE come from the ungated diffusers mirror
`unsloth/FLUX.1-schnell` (byte-identical to black-forest-labs/FLUX.1-schnell, which is login-gated).
Background removal: BiRefNet (MIT) -> RGBA cut-out that TRELLIS keeps as its matte.

Outputs (art-work/concept/<id>/): cand_<seed>.png, cand_<seed>_cut.png, sheet.jpg, prompt.txt, pick.json.
The pick is automatic (largest clean, uncropped silhouette) unless tools/art/picks.json overrides it.
"""
import argparse, gc, json, os, sys, time
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'tools' / 'art'
WORK = ROOT / 'art-work' / 'concept'
REPO = 'unsloth/FLUX.1-schnell'
GGUF = ('city96/FLUX.1-schnell-gguf', 'flux1-schnell-Q6_K.gguf')


def load_assets():
    return {a['id']: a for a in json.loads((ART / 'assets.json').read_text())['assets']}


def full_prompt(asset):
    style = (ART / 'prompts' / f"_style_{asset.get('style', 'character')}.txt").read_text().strip()
    subject = (ART / 'prompts' / f"{asset.get('prompt', asset['id'])}.txt").read_text().strip()
    return f'{subject} {style}'


def encode(prompts):
    from diffusers import FluxPipeline
    pipe = FluxPipeline.from_pretrained(REPO, transformer=None, vae=None, torch_dtype=torch.bfloat16)
    pipe.text_encoder.to('cuda'); pipe.text_encoder_2.to('cuda')
    out = {}
    with torch.no_grad():
        for k, p in prompts.items():
            pe, pooled, _ = pipe.encode_prompt(prompt=p, prompt_2=p, device='cuda', max_sequence_length=256)
            out[k] = (pe.cpu(), pooled.cpu())
    del pipe; gc.collect(); torch.cuda.empty_cache()
    return out


def generator_pipe():
    from diffusers import FluxPipeline, FluxTransformer2DModel, GGUFQuantizationConfig
    from huggingface_hub import hf_hub_download
    path = hf_hub_download(*GGUF)
    tr = FluxTransformer2DModel.from_single_file(
        path, quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
        torch_dtype=torch.bfloat16, config=REPO, subfolder='transformer')
    pipe = FluxPipeline.from_pretrained(REPO, transformer=tr, text_encoder=None, text_encoder_2=None,
                                        tokenizer=None, tokenizer_2=None, torch_dtype=torch.bfloat16)
    pipe.to('cuda')
    pipe.vae.enable_tiling()
    return pipe


class Matte:
    def __init__(self):
        from transformers import AutoModelForImageSegmentation
        self.m = AutoModelForImageSegmentation.from_pretrained('ZhengPeng7/BiRefNet', trust_remote_code=True)
        self.m.to('cuda').eval().half()

    @torch.no_grad()
    def __call__(self, img):
        x = img.convert('RGB').resize((1024, 1024), Image.BICUBIC)
        t = torch.from_numpy(np.asarray(x).astype(np.float32) / 255.0).permute(2, 0, 1)
        t = (t - torch.tensor([0.485, 0.456, 0.406])[:, None, None]) / torch.tensor([0.229, 0.224, 0.225])[:, None, None]
        pred = self.m(t[None].cuda().half())[-1].sigmoid()[0, 0].float().cpu().numpy()
        a = Image.fromarray((pred * 255).astype(np.uint8)).resize(img.size, Image.BICUBIC)
        out = img.convert('RGB').copy(); out.putalpha(a)
        return out


def score(cut):
    """Heuristic quality: penalise silhouettes touching the frame (cropped) and specks (floaters)."""
    a = np.asarray(cut)[:, :, 3] > 128
    h, w = a.shape
    if a.sum() < 0.02 * h * w:
        return -1.0, {}
    ys, xs = np.nonzero(a)
    edge = int(a[:3].any()) + int(a[-3:].any()) + int(a[:, :3].any()) + int(a[:, -3:].any())
    fill = a.sum() / ((ys.max() - ys.min() + 1) * (xs.max() - xs.min() + 1))
    from scipy import ndimage
    lab, n = ndimage.label(a)
    sizes = np.bincount(lab.ravel())[1:] if n else np.array([0])
    frag = 1.0 - sizes.max() / max(1, sizes.sum())
    bbox_h = (ys.max() - ys.min()) / h
    s = bbox_h - 0.6 * edge - 2.0 * frag + 0.2 * fill
    return float(s), dict(edge=edge, frag=round(float(frag), 4), fill=round(float(fill), 3), bbox_h=round(float(bbox_h), 3))


def sheet(cands, path):
    tw = 300
    ims = []
    for seed, p, sc in cands:
        im = Image.open(p).convert('RGB'); im.thumbnail((tw, 2 * tw))
        d = ImageDraw.Draw(im); d.rectangle([0, 0, tw, 18], fill=(0, 0, 0)); d.text((4, 3), f'seed {seed}  s={sc:.2f}', fill=(255, 255, 0))
        ims.append(im)
    H = max(i.height for i in ims)
    S = Image.new('RGB', (tw * len(ims), H), (40, 40, 40))
    for i, im in enumerate(ims):
        S.paste(im, (i * tw, 0))
    S.save(path, quality=88)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ids', required=True)
    ap.add_argument('--n', type=int, default=6)
    ap.add_argument('--seed0', type=int, default=1000)
    ap.add_argument('--steps', type=int, default=4)
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()
    assets = load_assets()
    ids = [i for i in args.ids.split(',') if i]
    picks_override = json.loads((ART / 'picks.json').read_text()) if (ART / 'picks.json').exists() else {}
    todo = [i for i in ids if args.force or not (WORK / i / 'pick.json').exists()]
    if todo:
        prompts = {i: full_prompt(assets[i]) for i in todo}
        emb = encode(prompts)
        pipe = generator_pipe()
        for i in todo:
            a = assets[i]; d = WORK / i; d.mkdir(parents=True, exist_ok=True)
            (d / 'prompt.txt').write_text(prompts[i])
            W, H = a.get('size', [832, 1216] if a.get('style', 'character') == 'character' else [1024, 1024])
            for k in range(args.n):
                seed = args.seed0 + k
                p = d / f'cand_{seed}.png'
                if p.exists() and not args.force:
                    continue
                t = time.time()
                pe, pooled = emb[i]
                img = pipe(prompt_embeds=pe.cuda(), pooled_prompt_embeds=pooled.cuda(), width=W, height=H,
                           num_inference_steps=args.steps, guidance_scale=0.0, max_sequence_length=256,
                           generator=torch.Generator('cpu').manual_seed(seed)).images[0]
                img.save(p)
                print(f'{i} seed {seed}: {time.time() - t:.1f}s', flush=True)
        del pipe; gc.collect(); torch.cuda.empty_cache()
    matte = Matte()
    for i in ids:
        d = WORK / i
        cands = []
        for p in sorted(d.glob('cand_*.png')):
            if p.stem.endswith('_cut'):
                continue
            seed = int(p.stem.split('_')[1])
            cp = d / f'cand_{seed}_cut.png'
            if not cp.exists() or args.force:
                matte(Image.open(p)).save(cp)
            s, info = score(Image.open(cp))
            cands.append((seed, p, s, info))
        cands.sort(key=lambda c: c[0])
        sheet([(c[0], c[1], c[2]) for c in cands], d / 'sheet.jpg')
        best = max(cands, key=lambda c: c[2])
        pick = int(picks_override.get(i, best[0]))
        (d / 'pick.json').write_text(json.dumps({'seed': pick, 'auto': best[0], 'file': f'cand_{pick}_cut.png',
                                                 'scores': {str(c[0]): [round(c[2], 3), c[3]] for c in cands}}, indent=1))
        print(f'{i}: pick seed {pick} (auto {best[0]})')


if __name__ == '__main__':
    main()
