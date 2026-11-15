// Ship reviewed models from the stage (art-work/stage_v2, written by `run.mjs --stage`) to public/models/v2.
//   node tools/art/ship.mjs lord_marshal,war_elephant [--dry]
// Per id: the files `<id>.glb, <id>_lod1.glb, <id>_team.png, <id>.vat.json, <id>.vat.pos.bin, <id>_lod1_tint.png`
// that exist in the stage are copied over; a shipped file the stage no longer has (e.g. a tint mask that is gone)
// is removed. The files being replaced are first backed up to art-work/backup_v2/pre_remodel/ (only if that
// backup does not hold them yet: the first, pre-remodel version is the one kept). The id's manifest entry is
// copied from the stage manifest into public/models/v2/manifest.json; every other entry stays byte-for-byte
// (other agents regenerate props / Keeps at the same time). Unpacked originals follow into art-work/unpacked/.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES } from './files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGE = join(root, process.env.ART_OUT ?? 'art-work/stage_v2');
const OUT = join(root, 'public/models/v2');
const BACKUP = join(root, 'art-work/backup_v2/pre_remodel');
const RAW = join(root, 'art-work/unpacked');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const ids = (args.find((a) => !a.startsWith('--')) ?? '').split(',').filter(Boolean);
if (!ids.length) { console.error('usage: node tools/art/ship.mjs <id,id,...> [--dry]'); process.exit(1); }
mkdirSync(BACKUP, { recursive: true });

const stageMf = JSON.parse(readFileSync(join(STAGE, 'manifest.json'), 'utf8'));
const mfPath = join(OUT, 'manifest.json');
let bad = 0;
const shipped = [];
for (const id of ids) {
  const key = stageMf.models[id] ? 'models' : stageMf.props[id] ? 'props' : null;
  if (!key || !existsSync(join(STAGE, `${id}.glb`))) { console.error(`${id}: not in the stage (run \`node tools/art/run.mjs ${id} --stage\` first)`); bad++; continue; }
  let bytes = 0;
  for (const f of FILES(id)) {
    const src = join(STAGE, f), dst = join(OUT, f);
    if (existsSync(dst) && !existsSync(join(BACKUP, f)) && !dry) copyFileSync(dst, join(BACKUP, f));
    if (existsSync(src)) {
      bytes += readFileSync(src).length;
      if (!dry) {
        copyFileSync(src, dst);
        if (existsSync(join(RAW, 'stage', f))) copyFileSync(join(RAW, 'stage', f), join(RAW, f));
      }
    } else if (existsSync(dst) && !dry) rmSync(dst);
  }
  shipped.push([id, key]);
  console.log(`${dry ? '(dry) ' : ''}${id}: shipped ${(bytes / 1e6).toFixed(2)} MB`);
}
if (!dry && shipped.length) {
  const cur = JSON.parse(readFileSync(mfPath, 'utf8'));       // the latest file: someone may have written it meanwhile
  for (const [id, key] of shipped) cur[key][id] = stageMf[key][id];
  writeFileSync(mfPath, JSON.stringify(cur, null, 1));
  console.log(`manifest: ${shipped.length} entr${shipped.length > 1 ? 'ies' : 'y'} merged into public/models/v2/manifest.json`);
}
process.exitCode = bad ? 1 : 0;
