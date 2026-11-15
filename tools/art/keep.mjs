// Faction Keeps + arrow towers: textures, geometry, pack, manifest.
//   node tools/art/keep.mjs [kingdom,ashen,caliphate] [--tex] [--noao]
// --tex also rebuilds public/textures/keep/ (tools/art/keep_tex.py; add --fetch to download the CC0 sources).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const factions = (args.find((a) => !a.startsWith('--')) ?? 'kingdom,ashen,caliphate').split(',');
const run = (cmd, a) => {
  const r = spawnSync(cmd, a, { cwd: root, stdio: 'inherit', shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const bf = 'C:/Program Files/Blender Foundation';
const blender = process.env.BLENDER ?? (existsSync(bf) ? join(bf, readdirSync(bf).filter((d) => d.startsWith('Blender')).sort().at(-1), 'blender.exe') : 'blender');
if (args.includes('--tex')) run('python', ['tools/art/keep_tex.py', ...(args.includes('--fetch') ? ['--fetch'] : [])]);
run(blender, ['-b', '--factory-startup', '--python', 'tools/art/blender/keep_build.py', '--', factions.join(','), ...(args.includes('--noao') ? ['--noao'] : [])]);
const ids = factions.flatMap((f) => [`keep_${f}`, `arrow_tower_${f}`]).join(',');
run(process.execPath, ['tools/art/pack.mjs', '--only', ids]);
run(process.execPath, ['tools/art/manifest.mjs', '--only', ids]);
