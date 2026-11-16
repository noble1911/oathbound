// Run a command while holding the shared GPU lock (art-work/fx_gpu.lock), so GPU measurements (render-power) and
// captures are not skewed by a TRELLIS / Cycles job, and so two GPU jobs never overlap on the 16 GB card.
//   node e2e/with-gpu-lock.mjs "<purpose>" -- <command> [args...]
// The art queue (tools/art/mesh.mjs --queue) re-takes the lock within milliseconds of releasing it, so this polls
// every 20 ms and creates the lock exclusively; it then checks that it still owns the file (the queue writes
// without `wx`) and goes back to waiting if it lost the race. The lock is always removed at the end.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK = join(dirname(fileURLToPath(import.meta.url)), '..', 'art-work', 'fx_gpu.lock');
const i = process.argv.indexOf('--');
const purpose = process.argv[2];
const cmd = process.argv.slice(i + 1);
const mine = `e2e/with-gpu-lock.mjs: ${purpose} (pid ${process.pid}, ${new Date().toISOString()})\n`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let held = false;
const release = () => { if (held && existsSync(LOCK) && readFileSync(LOCK, 'utf8') === mine) rmSync(LOCK, { force: true }); held = false; };
process.on('exit', release);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { release(); process.exit(130); });
// Standing rule: no GPU work while the user is gaming (same gate as tools/art/mesh.mjs). GPU_GATE = comma list of process
// names (default Wow.exe; empty = no gate); polls every 2 min and resumes by itself.
const GATE = (process.env.GPU_GATE ?? 'Wow.exe').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const gaming = () => {
  if (!GATE.length || process.platform !== 'win32') return null;
  const out = (spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout ?? '').toLowerCase();
  return GATE.find((g) => out.includes(`"${g}"`)) ?? null;
};
const t0 = Date.now();
let said = false;
for (;;) {
  for (let g, told = false; (g = gaming());) {
    if (!told) { told = true; console.error(`paused: ${g} is running (no GPU work while the user plays); polling every 2 min`); }
    sleep(120000);
  }
  try { writeFileSync(LOCK, mine, { flag: 'wx' }); } catch {
    if (!said) { said = true; try { console.error(`waiting for the GPU: ${readFileSync(LOCK, 'utf8').trim()}`); } catch { /* gone again */ } }
    sleep(20);
    continue;
  }
  sleep(400);
  if (existsSync(LOCK) && readFileSync(LOCK, 'utf8') === mine) { held = true; break; }
}
console.error(`GPU lock taken after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
sleep(3000);                                               // let the previous job's VRAM go
const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
release();
process.exit(r.status ?? 1);
