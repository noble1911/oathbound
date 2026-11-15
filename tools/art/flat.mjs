// Flat art for authored trappings (docs/ART.md section 10): prompts/flat/<name>.txt -> art-work/flat/<name>.png
// with the image generation of the Codex CLI (as concept.mjs; no matte: the builders key black backgrounds and
// magenta team cloth themselves).   node tools/art/flat.mjs shield_sun,banner_sun [--force] [--par 2]   |   --all
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROMPTS = join(root, 'tools/art/prompts/flat');
const OUT = join(root, 'art-work/flat');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const force = args.includes('--force');
const PAR = Number(opt('--par', 2));
const all = readdirSync(PROMPTS).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, ''));
const names = args.includes('--all') ? all : (args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? '').split(',').filter(Boolean);
mkdirSync(OUT, { recursive: true });

function codex(name) {
  const text = readFileSync(join(PROMPTS, `${name}.txt`), 'utf8').trim().replace(/\s+/g, ' ');
  const instr = `Use your image generation tool to create one image: ${text} Copy the generated image into the current directory as ${name}.png. Then reply with only the saved path.`;
  return new Promise((res) => {
    const t = Date.now();
    const p = spawn('codex', ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', JSON.stringify(OUT), '-'],
      { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.end(instr);
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('close', (code) => {
      writeFileSync(join(OUT, `${name}.codex.log`), log);
      const f = join(OUT, `${name}.png`);
      const ok = existsSync(f) && statSync(f).size > 10000;
      console.log(`${name}: ${ok ? 'ok' : `FAILED (exit ${code})`} ${((Date.now() - t) / 1000).toFixed(0)}s`);
      res(ok);
    });
  });
}
const jobs = [];
for (const n of names) {
  if (!existsSync(join(PROMPTS, `${n}.txt`))) { console.error(`no prompt for ${n}`); process.exitCode = 1; continue; }
  const f = join(OUT, `${n}.png`);
  if (existsSync(f) && !force) continue;
  if (force) rmSync(f, { force: true });
  jobs.push(() => codex(n));
}
let next = 0, bad = 0;
await Promise.all(Array.from({ length: Math.min(PAR, jobs.length) }, async () => {
  while (next < jobs.length) if (!(await jobs[next++]())) bad++;
}));
if (bad) process.exitCode = 1;
