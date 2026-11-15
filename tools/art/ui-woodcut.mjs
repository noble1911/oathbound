// Woodcut unit / Lord art via the Codex CLI's image generation (see tools/art/ui-prompts/_style_woodcut.txt):
//   portraits  tools/art/ui-prompts/<id>.txt + the `portrait:` style line  -> art-work/ui/<id>.png
//   glyphs     tools/art/ui-prompts/glyphs.json + the `glyph:` style line   -> art-work/glyphs/<id>.png
// then run  python tools/art/ui-webp.py  (portraits -> public/ui/*.webp) and  python tools/art/glyph-atlas.py
// (glyphs -> public/ui/plates.webp + plates.json, the atlas the in-world squad plates sample).
//   items      tools/art/ui-prompts/item_<base>.txt + the `item:` style line -> art-work/ui/item_<base>.png
//   node tools/art/ui-woodcut.mjs portrait|glyph|item [ids,comma,separated | prefix] [--force] [--par 3]
// A reference image is attached when art-work/refs/<kind>/<id>.png exists (character refs for Lords), else
// art-work/refs/<kind>/_<faction>.png (a style anchor per faction), else none.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = join(root, 'tools/art/ui-prompts');
const args = process.argv.slice(2);
const kind = args[0] === 'glyph' ? 'glyph' : args[0] === 'item' ? 'item' : 'portrait';
const OUT = join(root, kind === 'glyph' ? 'art-work/glyphs' : 'art-work/ui');
const REFS = join(root, 'art-work/refs', kind);
mkdirSync(OUT, { recursive: true });
const force = args.includes('--force');
const par = Number(args.includes('--par') ? args[args.indexOf('--par') + 1] : 3);
const sel = (args.slice(1).find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? '').split(',').filter(Boolean);

const styleFile = readFileSync(join(P, '_style_woodcut.txt'), 'utf8');
const line = (key) => (styleFile.match(new RegExp(`^${key.replace('.', '\\.')}: (.*)$`, 'm')) ?? [])[1]?.trim() ?? '';
const glyphs = JSON.parse(readFileSync(join(P, 'glyphs.json'), 'utf8'));
const pool = kind === 'item' ? readdirSync(P).filter((f) => /^item_.*\.txt$/.test(f)).map((f) => f.slice(0, -4)) : Object.keys(glyphs);
const ids = pool.filter((id) => !sel.length || sel.some((s) => id === s || id.startsWith(s))).filter((id) => force || !existsSync(join(OUT, `${id}.png`)));

function prompt(id) {
  if (kind === 'item') return `${readFileSync(join(P, `${id}.txt`), 'utf8').trim()} ${line('item')}`;
  const f = glyphs[id].faction;
  const fill = (s) => s.replace(/\{(palette|panel|disc|glyph|accent)\}/g, (_, k) => line(`${f}.${k}`));
  if (kind === 'glyph') return fill(line('glyph').replace('{subject}', glyphs[id].prompt));
  return `${readFileSync(join(P, `${id}.txt`), 'utf8').trim()} ${fill(line('portrait'))}`;
}

function run(id) {
  const own = join(REFS, `${id}.png`);
  const fac = join(REFS, `_${glyphs[id]?.faction ?? 'style'}.png`);
  const ref = existsSync(own) ? own : existsSync(fac) ? fac : null;
  const how = !ref ? '' : ref === own
    ? ' The attached image shows this same character in an OLD art style: keep the character (face, costume, gear) but redraw it entirely in the new style described here; do not copy the old style, colours, background or border.'
    : ' The attached image is a STYLE reference from the same icon set: match its flatness, line weight and palette exactly, but draw the different subject described here.';
  const instr = `Use your image generation tool to create one image: ${prompt(id)}${how} Copy the generated image into the current directory as ${id}.png. Then reply with only the saved path.`.replace(/\s+/g, ' ');
  writeFileSync(join(OUT, `${id}.prompt.txt`), instr);
  return new Promise((res) => {
    const t0 = Date.now();
    const a = ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', OUT, ...(ref ? ['-i', ref] : []), '-'];
    const p = spawn('codex', a.map((x) => (/\s/.test(x) ? `"${x}"` : x)), { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.end(instr); // through stdin: a Windows shell would split an argument at every space
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('close', (code) => {
      const ok = existsSync(join(OUT, `${id}.png`));
      if (!ok) writeFileSync(join(OUT, `${id}.log`), log);
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${id} (${((Date.now() - t0) / 1000).toFixed(0)} s, exit ${code})`);
      res(ok);
    });
  });
}

console.log(`${ids.length} ${kind} images, ${par} at a time`);
const queue = [...ids];
await Promise.all(Array.from({ length: par }, async () => {
  while (queue.length) await run(queue.shift());
}));
