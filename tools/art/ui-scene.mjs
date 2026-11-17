// Woodcut backdrops and print ornaments for the menus, via the Codex CLI's image generation:
//   tools/art/ui-prompts/scene_<id>.txt + a style line of _style_woodcut.txt -> art-work/ui-scenes/<id>.png
// `scene_field` (the battlefield behind the menus when the live battle cannot draw) takes the `scene:` line (a
// night print); the paper pieces (map, initial, headpiece) take `paper:`.
//   node tools/art/ui-scene.mjs [ids,comma,separated] [--force]    then    python tools/art/ui-scene.py
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = join(root, 'tools/art/ui-prompts');
const OUT = join(root, 'art-work/ui-scenes');
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const force = args.includes('--force');
const sel = (args.find((a) => !a.startsWith('--')) ?? '').split(',').filter(Boolean);
const styleFile = readFileSync(join(P, '_style_woodcut.txt'), 'utf8');
const line = (key) => (styleFile.match(new RegExp(`^${key}: (.*)$`, 'm')) ?? [])[1]?.trim() ?? '';
const NIGHT = new Set(['field']);
const ids = readdirSync(P).filter((f) => /^scene_.*\.txt$/.test(f)).map((f) => f.slice(6, -4))
  .filter((id) => !sel.length || sel.includes(id)).filter((id) => force || !existsSync(join(OUT, `${id}.png`)));

function run(id) {
  const instr = `Use your image generation tool to create one image: ${readFileSync(join(P, `scene_${id}.txt`), 'utf8').trim()} ${line(NIGHT.has(id) ? 'scene' : 'paper')} Copy the generated image into the current directory as ${id}.png. Then reply with only the saved path.`.replace(/\s+/g, ' ');
  writeFileSync(join(OUT, `${id}.prompt.txt`), instr);
  return new Promise((res) => {
    const t0 = Date.now();
    const p = spawn('codex', ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', `"${OUT}"`, '-'], { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.end(instr);
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
console.log(`${ids.length} scene images`);
await Promise.all(ids.map(run));
