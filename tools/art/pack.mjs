// Stage 7 (pack): meshopt-compress the shipped GLBs with gltfpack (EXT_meshopt_compression + KHR_mesh_quantization;
// WebP textures, node names, materials and extras kept). Roughly halves download size.
//   node tools/art/pack.mjs            (needs `npx gltfpack`, pinned below)
// Skipped: squad crowd meshes (`<id>_lod1.glb` with a `.vat.json`) -- gltfpack drops custom vertex attributes
// and the crowd needs `_VID`. Custom attributes (`_TEAM`) are dropped from packed files: tint them with the
// manifest `tintMask` texture. three.js: `gltfLoader.setMeshoptDecoder(MeshoptDecoder)` from
// 'three/examples/jsm/libs/meshopt_decoder.module.js'.
// Unpacked originals are kept in art-work/unpacked/ (render_review.py reads those for review renders).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(root, 'public/models/v2');
const RAW = join(root, 'art-work/unpacked');
mkdirSync(RAW, { recursive: true });
const GLTFPACK = 'gltfpack@0.22.0';

const isPacked = (f) => {
  const b = readFileSync(f);
  const n = b.readUInt32LE(12);
  return b.slice(20, 20 + n).toString().includes('EXT_meshopt_compression');
};
let before = 0, after = 0;
for (const f of readdirSync(OUT).filter((x) => x.endsWith('.glb'))) {
  const id = f.replace(/_lod1\.glb$|\.glb$/, '');
  if (f.endsWith('_lod1.glb') && existsSync(join(OUT, `${id}.vat.json`))) continue;   // crowd mesh: keep _VID
  const out = join(OUT, f), raw = join(RAW, f);
  if (isPacked(out)) continue;                             // already packed (rebuilds write unpacked files)
  copyFileSync(out, raw);
  const r = spawnSync('npx', ['-y', GLTFPACK, '-i', raw, '-o', out, '-cc', '-kn', '-km', '-ke'],
    { shell: process.platform === 'win32', encoding: 'utf8' });
  if (r.status !== 0) { console.error(`${f}: gltfpack failed\n${r.stderr}`); copyFileSync(raw, out); continue; }
  before += statSync(raw).size; after += statSync(out).size;
  console.log(`${f.padEnd(26)} ${(statSync(raw).size / 1e6).toFixed(2)} -> ${(statSync(out).size / 1e6).toFixed(2)} MB`);
}
console.log(`packed: ${(before / 1e6).toFixed(1)} -> ${(after / 1e6).toFixed(1)} MB`);
