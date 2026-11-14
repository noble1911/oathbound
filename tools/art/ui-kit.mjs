// The UI material kit (docs/UI-STYLE.md): flat texture sheets from the Codex CLI's image generation,
// one per prompt in tools/art/ui-kit-prompts/<id>.txt (+ _style.txt). Raw PNGs land in
// art-work/ui-kit/ (gitignored); tools/art/ui-kit.py keys, cuts and 9-slices them into the WebPs
// the stylesheet loads from public/ui/kit/.
//   node tools/art/ui-kit.mjs [ids,comma,separated] [--force] [--par 4]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = join(root, 'tools/art/ui-kit-prompts');
const OUT = join(root, 'art-work/ui-kit');
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const force = args.includes('--force');
const par = Number(args.includes('--par') ? args[args.indexOf('--par') + 1] : 4);
const sel = (args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? '').split(',').filter(Boolean);
const style = readFileSync(join(P, '_style.txt'), 'utf8').trim();
const all = readdirSync(P).filter((f) => f.endsWith('.txt') && !f.startsWith('_')).map((f) => f.slice(0, -4));
const ids = all.filter((id) => !sel.length || sel.includes(id)).filter((id) => force || !existsSync(join(OUT, `${id}.png`)));

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

console.log(`${ids.length} sheets, ${par} at a time`);
const queue = [...ids];
await Promise.all(Array.from({ length: par }, async () => {
  while (queue.length) await run(queue.shift());
}));
if (!args.includes('--no-pack')) {
  const r = spawnSync('python', [join(root, 'tools/art/ui-kit.py')], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}
