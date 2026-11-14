// Stage 2 (mesh): picked concept cut-out -> TRELLIS.2 (trellis-cpp, Vulkan) -> art-work/mesh/<id>.glb
//   node tools/art/mesh.mjs militia,knight [--force] [--seed 42]
// Env overrides: TRELLIS_CLI (trellis-cli.exe), TRELLIS_MODELS (GGUF dir). The q8 weights only ship the
// 512 flows, so --res 512 (the runtime then decimates to 150k faces and bakes a 1024 atlas).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = process.env.TRELLIS_CLI ?? 'E:/local/red-portal/RedPortalUnreal/Saved/Local3D/trellis-cpp-v0.8.1/runtime/trellis-cli.exe';
const MODELS = process.env.TRELLIS_MODELS ?? 'E:/local/red-portal-ai/trellis2-q8-a57397bd';
const args = process.argv.slice(2);
const ids = (args.find((a) => !a.startsWith('--')) ?? '').split(',').filter(Boolean);
const force = args.includes('--force');
const seed = args.includes('--seed') ? args[args.indexOf('--seed') + 1] : '42';
const picks = existsSync(join(root, 'tools/art/picks.json')) ? JSON.parse(readFileSync(join(root, 'tools/art/picks.json'), 'utf8')) : {};
mkdirSync(join(root, 'art-work/mesh'), { recursive: true });

for (const id of ids) {
  // Codex concepts (art-work/concepts, candidate index) win over the legacy FLUX ones (art-work/concept, seed)
  const codexDir = join(root, 'art-work/concepts', id);
  const cdir = existsSync(join(codexDir, 'pick.json')) ? codexDir : join(root, 'art-work/concept', id);
  const pj = JSON.parse(readFileSync(join(cdir, 'pick.json'), 'utf8'));
  const s = picks[id] ?? pj.cand ?? pj.seed;
  const img = join(cdir, `cand_${s}_cut.png`);
  const out = join(root, 'art-work/mesh', `${id}.glb`);
  if (existsSync(out) && !force) { console.log(`${id}: exists, skip`); continue; }
  const a = [img, out, '--models', MODELS, '--res', '512', '--seed', seed, '--webp', 'off'];
  const t = Date.now();
  const r = spawnSync(CLI, a, { encoding: 'utf8', maxBuffer: 1 << 28 });
  writeFileSync(`${out}.log`, (r.stdout ?? '') + (r.stderr ?? ''));
  writeFileSync(`${out}.run.json`, JSON.stringify({ input: img, seed: s, args: a, cli: CLI, ms: Date.now() - t }, null, 1));
  if (r.status !== 0 || !existsSync(out)) { console.error(`${id}: TRELLIS failed (${r.status}); see ${out}.log`); process.exitCode = 1; continue; }
  console.log(`${id}: concept seed ${s} -> ${out} in ${((Date.now() - t) / 1000).toFixed(0)}s`);
}
