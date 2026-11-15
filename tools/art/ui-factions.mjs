// NOTE (2026-11-15): unit, Lord and item art is now the woodcut set made by tools/art/ui-woodcut.mjs (see
// ui-prompts/_style_woodcut.txt); the per-id prompts were rewritten for it. Use this script only for the key art.
// Manuscript-style portraits for the Ashen Covenant and the Sun Caliphate (unit cards + Lords), via the Codex CLI
// image tool with two reference images: an existing portrait (the style) and the faction's approved concept.
//   node tools/art/ui-factions.mjs [ids,comma,separated] [--force] [--par 2]
// Prompts: tools/art/ui-prompts/<id>.txt + _style_manuscript.txt. Raw PNGs -> art-work/ui/, WebPs -> public/ui/
// (unit cards 320, Lords 512). Only the ids of this run are converted; public/ui/manifest.json gains them.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = join(root, 'tools/art/ui-prompts');
const OUT = join(root, 'art-work/ui');
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const force = args.includes('--force');
const par = Number(args.includes('--par') ? args[args.indexOf('--par') + 1] : 2);
const sel = (args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? '').split(',').filter(Boolean);
const style = readFileSync(join(P, '_style_manuscript.txt'), 'utf8').split('Generated with')[0].replace(/^Portrait style[^:]*:/, '').trim();
const ASHEN = ['unit_skeleton', 'unit_grave_knight', 'unit_bone_archer', 'unit_wraith_rider', 'unit_grave_acolyte', 'unit_bone_drake', 'unit_corpse_catapult', 'unit_bone_golem', 'lord_lich'];
const SUN = ['unit_spear_levy', 'unit_scimitar', 'unit_camel_archer', 'unit_mamluk', 'unit_djinn_binder', 'unit_sun_priest', 'unit_djinn', 'unit_war_elephant', 'unit_sand_golem', 'lord_sultana'];
const all = [...ASHEN, ...SUN];
const ids = all.filter((id) => !sel.length || sel.includes(id)).filter((id) => force || !existsSync(join(OUT, `${id}.png`)));

const fwd = (p) => p.split('\\').join('/');

function run(id) {
  const lord = id.startsWith('lord_');
  const refs = [join(root, 'art-work/ui', lord ? 'lord_warden.png' : 'unit_knights.png'), join(root, 'docs/art-review/factions', ASHEN.includes(id) ? 'ashen_1_lineup.png' : 'sun_1_lineup.png')];
  const text = `${readFileSync(join(P, `${id}.txt`), 'utf8').trim()} Style: ${style} Match the first reference image's manuscript style, border and square framing exactly; take the subject's design and colours from the second reference image. Unit team cloth in neutral grey-blue. No text, no letters. Square image.`.replace(/\s+/g, ' ');
  const instr = `Use your image generation tool to create one image: ${text} Copy the generated image into the current directory as ${id}.png. Then reply with only the saved path.`;
  return new Promise((res) => {
    const t0 = Date.now();
    const a = ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', JSON.stringify(fwd(OUT)), ...refs.flatMap((r) => ['-i', JSON.stringify(fwd(r))]), '--', '-'];
    const p = spawn('codex', a, { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.end(instr);
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('close', (code) => {
      const ok = existsSync(join(OUT, `${id}.png`)) && statSync(join(OUT, `${id}.png`)).size > 10000;
      if (!ok) writeFileSync(join(OUT, `${id}.codex.log`), log);
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${id} (${((Date.now() - t0) / 1000).toFixed(0)} s, exit ${code})`);
      res(ok);
    });
  });
}

console.log(`${ids.length} images, ${par} at a time`);
const queue = [...ids];
await Promise.all(Array.from({ length: par }, async () => {
  while (queue.length) await run(queue.shift());
}));
// convert only this script's ids; keep every other public/ui file and manifest entry as it is
const py = `
import json, os, sys
from PIL import Image
root, ids = sys.argv[1], sys.argv[2].split(',')
src = os.path.join(root, 'art-work', 'ui'); dst = os.path.join(root, 'public', 'ui')
mf = os.path.join(dst, 'manifest.json')
done = set(json.load(open(mf))) if os.path.exists(mf) else set()
for id in ids:
    f = os.path.join(src, id + '.png')
    if not os.path.exists(f):
        continue
    im = Image.open(f).convert('RGB'); w, h = im.size; s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    size = 512 if id.startswith('lord_') else 320
    im.resize((size, size), Image.LANCZOS).save(os.path.join(dst, id + '.webp'), 'WEBP', quality=84, method=6)
    done.add(id)
json.dump(sorted(done), open(mf, 'w'))
print(len(done), 'entries in public/ui/manifest.json')
`;
const r = spawnSync('python', ['-c', py, root, all.join(',')], { stdio: 'inherit' });
process.exit(r.status ?? 0);
