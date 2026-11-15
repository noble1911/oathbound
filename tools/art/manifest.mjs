// Build public/models/v2/manifest.json (renderer contract: top-level `models` keyed by modelId, each
// { glb, vat?, tintMask?, scale, clips } + extra facts) from the per-asset facts the Blender stages write
// to art-work/clean/<id>.json, plus the real file sizes. Copies the LOD0 team masks.
//   node tools/art/manifest.mjs
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(root, 'public/models/v2');
const CLEAN = join(root, 'art-work/clean');
const assets = JSON.parse(readFileSync(join(root, 'tools/art/assets.json'), 'utf8')).assets;
const size = (f) => (existsSync(join(OUT, f)) ? statSync(join(OUT, f)).size : 0);
const read = (f) => (existsSync(join(CLEAN, f)) ? JSON.parse(readFileSync(join(CLEAN, f), 'utf8')) : null);
const PRIMARY = { sword: 'attack_melee_a', spear: 'attack_melee_a', cast: 'cast', bow: 'attack_bow', fist: 'attack_melee_a', greataxe: 'attack_melee_a', pike: 'attack_melee_a', staff: 'cast' };

const out = {
  version: 2,
  conventions: {
    units: 'metres; scale 1 (infantry 1.8 m)', up: '+Y', facing: '+Z', origin: 'feet / base centre at (0,0,0)',
    skeleton: 'oathbound_humanoid_v1 (root, hips, spine1-3, neck, head, shoulder/upper_arm/forearm/hand/thigh/shin/foot/toe .L/.R)',
    tint: 'albedo.rgb *= mix(vec3(1), team, mask); mask = tintMask.r at UV0 (flipY=false); team cloth is pre-neutralised grey',
    crowd: 'squad entries: glb = single-primitive skinned crowd mesh (LOD1 + weapons), vat = compact VatMeta (docs/ART.md)',
    docs: 'docs/ART.md',
  },
  models: {},
  props: {},
};
for (const a of assets) {
  if (a.part || a.kind === 'weapon') continue;
  const id = a.id;
  const f = read(`${id}.json`);
  if (!f || !existsSync(join(OUT, `${id}.glb`))) continue;
  const e = { kind: a.kind, scale: 1, height: f.height ?? a.height };
  // creature.py writes `<id>_unit_team.png` (whole unit, one atlas); plain units keep cleanup's `<id>_team.png`
  const unitMask = join(CLEAN, `${id}_unit_team.png`);
  const lodMask = existsSync(unitMask) ? unitMask : join(CLEAN, `${id}_team.png`);
  if (f.team_frac > 0 && existsSync(lodMask)) copyFileSync(lodMask, join(OUT, `${id}_team.png`));
  if (f.crowd) {
    e.glb = f.crowd.glb;
    e.vat = f.crowd.vat;
    e.tintMask = f.crowd.tint;
    e.detail = { glb: `${id}.glb`, tintMask: existsSync(join(OUT, `${id}_team.png`)) ? `${id}_team.png` : undefined };
  } else {
    e.glb = `${id}.glb`;
    if (existsSync(join(OUT, `${id}_lod1.glb`))) e.lod1 = `${id}_lod1.glb`;
    if (existsSync(join(OUT, `${id}_team.png`))) e.tintMask = `${id}_team.png`;
  }
  if (f.clips) {
    const cs = a.clipset ?? 'sword';
    e.clips = {
      idle: 'idle', move: 'walk', run: 'run', attack: PRIMARY[cs], attack2: cs === 'bow' || cs === 'staff' ? 'attack_melee_a' : 'attack_melee_b',
      cast: 'cast', hit: 'hit', death: 'death_a', death2: 'death_b', victory: 'victory',
    };
    e.clipInfo = Object.fromEntries(Object.entries(f.clips).map(([k, v]) => [k, { duration: v.duration, loop: v.loop }]));
    if (f.weapons) e.weapons = f.weapons.map((w) => ({ node: w.node, bone: w.bone }));
  }
  if (f.clips_custom) e.clips = f.clips_custom;
  if (f.nodes) e.nodes = f.nodes;
  if (f.stage_tris) {
    e.nodes = ['stage0', 'stage1', 'stage2', 'stage3'];
    e.stages = 'show exactly one child: stage0 intact .. stage3 ruin (HP thresholds are the client\'s call)';
  }
  e.tris = f.stage_tris ? { lod0: f.stage_tris[id], lod1: f.stage_tris[`${id}_lod1`] ?? null } : { lod0: f.tris_lod0 ?? null, lod1: f.tris_lod1 ?? null };
  const files = readdirSync(OUT).filter((x) => x.startsWith(`${id}.`) || x.startsWith(`${id}_`));
  e.bytes = Object.fromEntries(files.map((x) => [x, size(x)]));
  e.totalBytes = files.reduce((t, x) => t + size(x), 0);
  if (a.kind === 'prop') { delete e.scale; out.props[id] = e; } else out.models[id] = e;
}
// `--only a,b,c`: refresh just those entries and keep the rest of the existing manifest byte-for-byte (so a unit
// rebuild cannot clobber prop entries someone else is regenerating at the same time).
const onlyArg = process.argv.indexOf('--only');
const mf = join(OUT, 'manifest.json');
if (onlyArg > 0 && existsSync(mf)) {
  const only = new Set(process.argv[onlyArg + 1].split(','));
  const cur = JSON.parse(readFileSync(mf, 'utf8'));
  for (const key of ['models', 'props']) {
    for (const id of only) if (out[key][id]) cur[key][id] = out[key][id];
    out[key] = cur[key];
  }
  out.conventions = cur.conventions ?? out.conventions;
}
writeFileSync(mf, JSON.stringify(out, null, 1));
let total = 0;
for (const x of readdirSync(OUT)) total += size(x);
console.log(`manifest: ${Object.keys(out.models).length} models + ${Object.keys(out.props).length} props, public/models/v2 total ${(total / 1e6).toFixed(2)} MB`);
for (const [k, e] of [...Object.entries(out.models), ...Object.entries(out.props)]) console.log(`  ${k.padEnd(14)} tris ${JSON.stringify(e.tris)}  ${(e.totalBytes / 1e6).toFixed(2)} MB`);
