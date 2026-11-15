// Targeted edit of tools/art/assets.json (read-modify-write in one step, so parallel editors do not clobber each other):
//   node tools/art/aset.mjs lord_marshal lod0=30000 tier='"hero"' parts='[{"name":"x","id":"y"}]' grade=   (empty value: delete the key)
//   node tools/art/aset.mjs --new war_elephant_crew kind='"part"' part=true height=1.7                      (append a new entry)
// Several ids: `a,b,c key=value`. Values are JSON; an unknown id is an error unless --new.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const f = join(dirname(fileURLToPath(import.meta.url)), 'assets.json');
const argv = process.argv.slice(2);
const add = argv[0] === '--new';
if (add) argv.shift();
const [idArg, ...kv] = argv;
const text = readFileSync(f, 'utf8');
const CRLF = String.fromCharCode(13, 10);
const eol = text.includes(CRLF) ? CRLF : String.fromCharCode(10);      // keep the file's line endings
const doc = JSON.parse(text);
for (const id of idArg.split(',')) {
  let a = doc.assets.find((x) => x.id === id);
  if (!a && add) { a = { id }; doc.assets.push(a); }
  if (!a) { console.error(`unknown id ${id}`); process.exit(1); }
  for (const s of kv) {
    const i = s.indexOf('=');
    const k = s.slice(0, i), v = s.slice(i + 1);
    if (v === '') delete a[k]; else a[k] = JSON.parse(v);
  }
  console.log(id, JSON.stringify(Object.fromEntries(kv.map((s) => [s.slice(0, s.indexOf('=')), a[s.slice(0, s.indexOf('='))]]))));
}
writeFileSync(f, JSON.stringify(doc, null, 1).split(String.fromCharCode(10)).join(eol));
