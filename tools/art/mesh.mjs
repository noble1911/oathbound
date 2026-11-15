// Stage 2 (mesh): picked concept cut-out -> TRELLIS.2 (trellis-cpp, Vulkan) -> art-work/mesh/<id>.glb
//   node tools/art/mesh.mjs militia,knight [--force] [--seed 42] [--res 1024]
//   node tools/art/mesh.mjs --queue art-work/remodel/gpu_queue.txt     (GPU queue, see below)
// Settings (the War Elephant A/B test, docs/ART.md section 10): the q8 1024 flows, `--res 1024 --atlas 4096
// --steps 16`, ONE run per separable part (body, mount, rider, howdah: each its own asset id with a clean concept).
// assets.json `mesh: { res, atlas, steps, seed }` overrides per asset (weapons default to 512: they are tiny on screen).
// A mesh made with other settings is moved to art-work/mesh/v1/ and rebuilt.
// GPU protocol: only one GPU job at a time. Every run waits for art-work/fx_gpu.lock to disappear, writes it
// (purpose, pid, time) and removes it afterwards (also on a crash / Ctrl-C).
// Queue mode: the file lists ids (one per line, `#` comments; append while it runs). The queue takes the first
// id whose concept is picked and whose mesh is missing / outdated, and polls every 60 s when nothing is ready.
// It ends when the file holds a line `!stop` and nothing is pending. Failures are retried once, then skipped.
// Env overrides: TRELLIS_CLI (trellis-cli.exe), TRELLIS_MODELS (GGUF dir with the 512 + 1024 flows).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = process.env.TRELLIS_CLI ?? 'E:/local/red-portal/RedPortalUnreal/Saved/Local3D/trellis-cpp-v0.8.1/runtime/trellis-cli.exe';
const MODELS = process.env.TRELLIS_MODELS ?? 'E:/local/red-portal-ai/trellis2-q8-1024';
const LOCK = join(root, 'art-work/fx_gpu.lock');
const MESH = join(root, 'art-work/mesh');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const VAL = new Set(['--seed', '--res', '--queue', '--atlas', '--steps']);
const ids = (args.find((a, i) => !a.startsWith('--') && !VAL.has(args[i - 1])) ?? '').split(',').filter(Boolean);
const force = args.includes('--force');
const queue = opt('--queue', null);
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
const assetsNow = () => Object.fromEntries(readJson(join(root, 'tools/art/assets.json'), { assets: [] }).assets.map((a) => [a.id, a]));
mkdirSync(join(MESH, 'v1'), { recursive: true });

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let held = false;
function lock(purpose) {
  let said = false;
  while (existsSync(LOCK)) {
    if (!said) { console.log(`waiting for the GPU: ${readFileSync(LOCK, 'utf8').trim()}`); said = true; }
    sleep(400);                                          // poll fast: other lock users (e2e/with-gpu-lock.mjs) do too, a slow poll never wins the lock
  }
  writeFileSync(LOCK, `tools/art/mesh.mjs: ${purpose} (pid ${process.pid}, ${new Date().toISOString()})\n`);
  held = true;
}
function unlock() { if (held) { rmSync(LOCK, { force: true }); held = false; } }
process.on('exit', unlock);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { unlock(); process.exit(130); });

function settings(id) {
  const a = assetsNow()[id] ?? {};
  const m = a.mesh ?? {};
  const res = Number(opt('--res', m.res ?? (a.kind === 'weapon' || a.kind === 'prop' ? 512 : 1024)));
  return {
    res, atlas: Number(opt('--atlas', m.atlas ?? (res >= 1024 ? 4096 : 2048))), steps: Number(opt('--steps', m.steps ?? 16)),
    seed: String(opt('--seed', m.seed ?? 42)),
  };
}
function concept(id) {
  const picks = readJson(join(root, 'tools/art/picks.json'), {});
  // Codex concepts (art-work/concepts, candidate index) win over the legacy FLUX ones (art-work/concept, seed)
  const codexDir = join(root, 'art-work/concepts', id);
  const cdir = existsSync(join(codexDir, 'pick.json')) ? codexDir : join(root, 'art-work/concept', id);
  if (!existsSync(join(cdir, 'pick.json'))) return null;
  const pj = readJson(join(cdir, 'pick.json'), {});
  const s = picks[id] ?? pj.cand ?? pj.seed;
  const img = join(cdir, `cand_${s}_cut.png`);
  return existsSync(img) ? { img, s } : null;
}
/** 'done' | 'todo' | 'wait' (no picked concept yet) */
function state(id) {
  const c = concept(id);
  if (!c) return 'wait';
  const out = join(MESH, `${id}.glb`);
  if (!existsSync(out)) return 'todo';
  const run = readJson(`${out}.run.json`, {});
  const st = settings(id);
  const same = run.res === st.res && run.atlas === st.atlas && run.steps === st.steps && String(run.seed) === String(st.seed) && String(run.concept) === String(c.s) && run.input === c.img;
  return same && !force ? 'done' : 'todo';
}
function build(id) {
  const c = concept(id);
  const st = settings(id);
  const out = join(MESH, `${id}.glb`);
  const a = [c.img, out, '--models', MODELS, '--res', String(st.res), '--atlas', String(st.atlas), '--steps', String(st.steps), '--seed', st.seed, '--webp', 'off'];
  lock(`trellis ${st.res} ${id}`);
  if (existsSync(out)) {                                  // keep the FIRST previous generation (the 512 runs of the v2 pipeline); later re-runs are dropped
    for (const ext of ['', '.log', '.run.json']) {
      if (!existsSync(out + ext)) continue;
      const old = join(MESH, 'v1', `${id}.glb${ext}`);
      if (existsSync(old)) rmSync(out + ext); else renameSync(out + ext, old);
    }
  }
  const t = Date.now();
  let r;
  try { r = spawnSync(CLI, a, { encoding: 'utf8', maxBuffer: 1 << 28 }); } finally { unlock(); }
  writeFileSync(`${out}.log`, (r.stdout ?? '') + (r.stderr ?? ''));
  const ok = r.status === 0 && existsSync(out);
  if (ok) writeFileSync(`${out}.run.json`, JSON.stringify({ input: c.img, concept: c.s, ...st, args: a, cli: CLI, ms: Date.now() - t }, null, 1));
  console.log(ok ? `${id}: concept ${c.s} -> ${out} (res ${st.res}, atlas ${st.atlas}) in ${((Date.now() - t) / 1000).toFixed(0)}s  [${new Date().toLocaleTimeString()}]`
    : `${id}: TRELLIS failed (${r.status}); see ${out}.log`);
  return ok;
}

if (queue) {
  const fails = {};
  for (;;) {
    const lines = readFileSync(queue, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    const stop = lines.includes('!stop');
    const want = [...new Set(lines.filter((l) => l !== '!stop'))].filter((i) => (fails[i] ?? 0) < 2);
    const next = want.find((i) => state(i) === 'todo');
    if (next) { if (!build(next)) fails[next] = (fails[next] ?? 0) + 1; continue; }
    if (stop) break;
    sleep(60000);
  }
  const bad = Object.keys(fails).filter((i) => fails[i] >= 2);
  if (bad.length) { console.error(`failed: ${bad.join(', ')}`); process.exitCode = 1; }
} else {
  for (const id of ids) {
    const s = state(id);
    if (s === 'wait') { console.error(`${id}: no picked concept`); process.exitCode = 1; continue; }
    if (s === 'done') { console.log(`${id}: up to date, skip`); continue; }
    if (!build(id)) process.exitCode = 1;
  }
}
