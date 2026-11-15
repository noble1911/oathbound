// AI art pipeline driver. Stages per id (docs/ART.md):
//   concept (Codex image gen + BiRefNet matte, WSL) -> mesh (TRELLIS.2) -> cleanup (Blender) ->
//   build: rig.py (humanoids, golem) | creature.py (dragon, mounted units) | siege.py (faction Keeps: keep.mjs) ->
//   vat (squads: crowd mesh + VAT) -> review renders -> manifest
//   node tools/art/run.mjs militia,knight,keep_kingdom [--from cleanup] [--to vat] [--n 2] [--force] [--stage]
// --stage: outputs + manifest.json go to art-work/stage_v2/ instead of public/models/v2 (env ART_OUT for every
// stage); `node tools/art/ship.mjs <ids>` copies reviewed ids into public/models/v2.
// Dependencies (held weapons, rider/mount parts) are built first automatically. Stages run one at a time
// (GPU jobs must not overlap on a 16 GB card).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const STAGES = ['concept', 'mesh', 'cleanup', 'build', 'vat', 'review'];
const from = STAGES.indexOf(opt('--from', 'concept'));
const to = STAGES.indexOf(opt('--to', 'review'));
const force = args.includes('--force');
const stage = args.includes('--stage') || !!process.env.ART_OUT;
if (stage) process.env.ART_OUT ??= 'art-work/stage_v2';
const OUTREL = process.env.ART_OUT ?? 'public/models/v2';
const assets = Object.fromEntries(JSON.parse(readFileSync(join(here, 'assets.json'), 'utf8')).assets.map((a) => [a.id, a]));

function findBlender() {
  if (process.env.BLENDER) return process.env.BLENDER;
  const bf = 'C:/Program Files/Blender Foundation';
  if (existsSync(bf)) {
    const d = readdirSync(bf).filter((x) => /^Blender/.test(x)).sort().reverse()[0];
    if (d) return join(bf, d, 'blender.exe');
  }
  return 'blender';
}
const BLENDER = findBlender();
let failed = 0;
function run(cmd, a, label) {
  const t = Date.now();
  const r = spawnSync(cmd, a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  const lines = ((r.stdout ?? '') + (r.stderr ?? '')).split(/\r?\n/)
    .filter((l) => /^\[|Error|Traceback|line \d+|FAILED|pick|->|manifest|MB/.test(l) && !/HIPEW|DeprecationWarning/.test(l));
  console.log(`== ${label} (${((Date.now() - t) / 1000).toFixed(0)}s)\n${lines.join('\n')}`);
  if (r.status !== 0) { console.error(`!! ${label} failed (${r.status})`); failed++; return false; }
  return true;
}
const blender = (script, a, label) => run(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', join(here, 'blender', script), '--', ...a], label);

const want = (args.find((a) => !a.startsWith('--') && !STAGES.includes(a) && !/^\d+$/.test(a)) ?? '').split(',').filter(Boolean);
// parts with an `id` are TRELLIS pieces with their own concept + mesh (cleanup.py assembles them into the unit)
const partIds = (i) => (assets[i]?.parts ?? []).filter((p) => p.id).map((p) => p.id);
const deps = (i) => [...(assets[i]?.weapons ?? []).map((w) => w[0]), ...(assets[i]?.rider ? [assets[i].rider, assets[i].mount] : []), ...partIds(i)];
const pieceOnly = new Set(Object.keys(assets).flatMap(partIds));   // meshed, but never cleaned / built on their own
const ids = [];
const visit = (i) => { if (ids.includes(i)) return; deps(i).forEach(visit); ids.push(i); };
want.forEach(visit);
// faction Keeps / arrow towers are built from geometry (no concept / mesh / cleanup): keep.mjs does their whole chain
const keepIds = ids.filter((i) => assets[i]?.builder === 'keep_build.py');
if (keepIds.length) {
  const factions = [...new Set(keepIds.map((i) => i.replace(/^(keep|arrow_tower)_/, '')))];
  run(process.execPath, [join(here, 'keep.mjs'), factions.join(',')], `keep ${factions}`);
  for (const i of keepIds) ids.splice(ids.indexOf(i), 1);
  if (!ids.length) process.exit(failed ? 1 : 0);
}
const composite = (a) => !!a.rider || a.id === 'dragon' || !!a.creature;   // `creature`: a standalone creature.py build (bone drake, war elephant)
const need = (s) => STAGES.indexOf(s) >= from && STAGES.indexOf(s) <= to;
const sourced = ids.filter((i) => !assets[i].rider && !assets[i].procedural && assets[i].body !== false && !assets[i].authored);    // ids with their own concept + mesh

if (need('concept')) {
  const todo = sourced.filter((i) => force || !existsSync(join(root, 'art-work/concepts', i, 'pick.json')));
  if (todo.length) run(process.execPath, [join(here, 'concept.mjs'), todo.join(','), '--n', opt('--n', '2')], `concept ${todo}`);
}
if (need('mesh') && sourced.length) run(process.execPath, [join(here, 'mesh.mjs'), sourced.join(','), ...(force ? ['--force'] : [])], 'mesh');
for (const id of ids) {
  const a = assets[id];
  if (pieceOnly.has(id)) continue;
  if (need('cleanup') && a.procedural && !blender('proc_weapon.py', [id], `procedural ${id}`)) continue;
  if (need('cleanup') && !a.rider && !a.procedural && !a.authored && !blender('cleanup.py', [id], `cleanup ${id}`)) continue;
  if (need('build')) {
    let ok = true;
    if (a.builder) ok = blender(a.builder, [id], `${a.builder} ${id}`);     // per-asset builder (faction.py wraps rig.py / creature.py)
    else if (composite(a)) ok = blender('creature.py', [id], `creature ${id}`);
    else if (a.kind === 'humanoid' || (a.clipset && (a.style ?? 'character') === 'character')) ok = blender('rig.py', [id], `rig ${id}`);
    else if (a.kind === 'siege') ok = blender('siege.py', [id], `siege ${id}`);
    if (!ok) continue;
  }
  const crowd = a.squad && !a.part && (a.kind === 'humanoid' || !!a.rider);
  if (need('vat') && crowd && !blender('vat.py', [id], `vat ${id}`)) continue;
  if (need('review') && a.kind !== 'weapon' && !a.part) {
    const out = stage ? join(root, 'art-work/review/stage', `${id}.png`) : join(root, 'docs/art-review', `${id}.png`);
    let spec = 'y30+y-30+y180+y90';
    if (a.clipset || composite(a)) spec = 'y30+y180+p:walk:0.25+p:attack_melee_a:0.45+p:attack_melee_b:0.4+p:attack_bow:0.45+p:cast:0.5+p:hit:0.5+p:death_a:1+p:victory:0.25+p:run:0.3';
    if (a.kind === 'structure') spec = 'n:stage0:30+n:stage1:30+n:stage2:30+n:stage3:30+n:stage0:210';
    if (a.kind === 'siege') spec = 'y30+y-60+y180+p:fire:0.3+p:fire:0.6+p:death:1';
    const files = [`${OUTREL}/${id}.glb@${spec}`];
    if (existsSync(join(root, `${OUTREL}/${id}_lod1.glb`))) files.push(`${OUTREL}/${id}_lod1.glb@${a.kind === 'structure' ? 'n:stage0:30' : 'y30'}`);
    blender('render_review.py', [out, ...files], `review ${id}`);
    if (crowd) blender('vat_check.py', [id, join(root, stage ? 'art-work/review/stage' : 'docs/art-review', `${id}_vat.png`)], `vat check ${id}`);
  }
}
// only the ids of this run are packed and written to the manifest; other entries are left exactly as they are
run(process.execPath, [join(here, 'pack.mjs'), '--only', ids.join(',')], 'pack');
run(process.execPath, [join(here, 'manifest.mjs'), '--only', ids.join(',')], 'manifest');
if (failed) { console.error(`${failed} step(s) failed`); process.exitCode = 1; }
