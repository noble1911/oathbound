// UI 2D art via the Codex CLI's image generation: Lord portraits, item base icons, unit card art and
// the title key art. Prompts: tools/art/ui-prompts/<id>.txt + _style.txt. Raw PNGs land in
// art-work/ui/ (gitignored); tools/art/ui-webp.py writes the WebPs the client loads from public/ui/.
//   node tools/art/ui-art.mjs [ids,comma,separated | prefix like "item_"] [--force] [--par 2]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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
const style = readFileSync(join(P, '_style.txt'), 'utf8').trim();
const all = readdirSync(P).filter((f) => f.endsWith('.txt') && !f.startsWith('_')).map((f) => f.slice(0, -4));
const ids = all.filter((id) => !sel.length || sel.some((s) => id === s || id.startsWith(s))).filter((id) => force || !existsSync(join(OUT, `${id}.png`)));

function run(id) {
  const text = `${readFileSync(join(P, `${id}.txt`), 'utf8').trim()} ${style}`.replace(/\s+/g, ' ');
  const instr = `Use your image generation tool to create one image: ${text} Copy the generated image into the current directory as ${id}.png. Then reply with only the saved path.`;
  return new Promise((res) => {
    const t0 = Date.now();
    const p = spawn('codex', ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', OUT, '-'], { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    // the prompt goes through stdin: a Windows shell would split an argument at every space
    p.stdin.end(instr);
    p.stdout.on('data', () => {});
    p.stderr.on('data', () => {});
    p.on('close', (code) => {
      const ok = existsSync(join(OUT, `${id}.png`));
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
const r = spawnSync('python', [join(root, 'tools/art/ui-webp.py')], { stdio: 'inherit' });
process.exit(r.status ?? 0);
