// Stage 1 (concept): prompt -> N candidate images via the Codex CLI's image generation (ChatGPT image model)
// -> art-work/concepts/<id>/cand_<k>.png, then matte + score + contact sheet + pick via tools/art/matte.py (WSL).
//   node tools/art/concept.mjs militia,knight [--n 2] [--par 3] [--force] [--no-matte]
// Prompt = prompts/<prompt or id>.txt + prompts/_style_<style>.txt (assets.json). The full prompt is saved
// next to each image (cand_<k>.prompt.txt). Codex image generation has no seed: candidates are numbered
// and the chosen one is recorded in tools/art/picks.json (kept in git) for reproducibility of the mesh.
// (tools/art/concept.py is the older local FLUX.1-schnell path, kept as an offline fallback.)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ART = join(root, 'tools/art');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const ids = (args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? '').split(',').filter(Boolean);
const N = Number(opt('--n', 2));
const PAR = Number(opt('--par', 3));
const force = args.includes('--force');
const assets = Object.fromEntries(JSON.parse(readFileSync(join(ART, 'assets.json'), 'utf8')).assets.map((a) => [a.id, a]));

function prompt(a) {
  const style = readFileSync(join(ART, 'prompts', `_style_${a.style ?? 'character'}.txt`), 'utf8').trim();
  const subject = readFileSync(join(ART, 'prompts', `${a.prompt ?? a.id}.txt`), 'utf8').trim();
  return `${subject} ${style}`.replace(/\s+/g, ' ');
}

function codex(outdir, name, text) {
  const instr = `Use your image generation tool to create one image: ${text} Copy the generated image into the current directory as ${name}.png. Then reply with only the saved path.`;
  return new Promise((res) => {
    const t = Date.now();
    // the prompt goes in on stdin ('-'): on Windows codex is a .cmd shim that needs a shell, which would split it
    const p = spawn('codex', ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', JSON.stringify(outdir), '-'],
      { shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.end(instr);
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('close', (code) => {
      writeFileSync(join(outdir, `${name}.codex.log`), log);
      const ok = existsSync(join(outdir, `${name}.png`)) && statSync(join(outdir, `${name}.png`)).size > 10000;
      console.log(`${name}: ${ok ? 'ok' : `FAILED (exit ${code})`} ${((Date.now() - t) / 1000).toFixed(0)}s`);
      res(ok);
    });
  });
}

const jobs = [];
for (const id of ids) {
  const a = assets[id];
  if (!a) { console.error(`unknown id ${id}`); process.exit(1); }
  const dir = join(root, 'art-work/concepts', id);
  mkdirSync(dir, { recursive: true });
  const text = prompt(a);
  writeFileSync(join(dir, 'prompt.txt'), text);
  for (let k = 0; k < N; k++) {
    const name = `cand_${k}`;
    if (!force && existsSync(join(dir, `${name}.png`))) continue;
    writeFileSync(join(dir, `${name}.prompt.txt`), text);
    jobs.push(() => codex(dir, name, text));
  }
}
let next = 0;
await Promise.all(Array.from({ length: Math.min(PAR, jobs.length) }, async () => {
  while (next < jobs.length) await jobs[next++]();
}));

if (!args.includes('--no-matte') && ids.length) {
  const wsl = root.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, '/');
  const r = spawnSync('wsl.exe', ['-e', 'bash', '-lc',
    `cd '${wsl}' && source ~/oathbound-art/.venv/bin/activate && HF_HUB_OFFLINE=1 python tools/art/matte.py --ids ${ids.join(',')}`],
    { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}
