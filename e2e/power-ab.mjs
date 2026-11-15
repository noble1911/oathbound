// Power regression check of the remodel: `REAL=all e2e/render-power.mjs` on the OLD model set and on the NEW one,
// back to back and interleaved (old, new, old, new ...), so both see the same machine load. Absolute fps on this PC
// swings 2-10x with what other agents are running (CPU at 100 %), so only the old/new ratio of one run means anything.
//   node e2e/with-gpu-lock.mjs "power-ab" -- node e2e/power-ab.mjs <out.txt> [--stage art-work/stage_v2] [--rounds 2] [--tiers low,medium,high,ultra,saver] [--sets old,new]
// (always under the GPU lock: no TRELLIS / Cycles job may run during the measurement)
// `--sets old,cur` compares against what is in public/models/v2 without a staging overlay.
import { spawn } from 'node:child_process';
// async: the model-set server lives in THIS process, so a spawnSync would block it and every page load would time out
const run = (cmd, a, o) => new Promise((res) => {
  const p = spawn(cmd, a, { env: o.env });
  let stdout = '', stderr = '';
  p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d));
  p.on('close', (status) => res({ status, stdout, stderr }));
});
import fs from 'node:fs';
import { startServer } from './remodel-lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'art-work/remodel/power_ab.txt';
const rounds = Number(opt('--rounds', 2));
const tiers = opt('--tiers', 'low,medium,high,ultra,saver');
const sets = opt('--sets', 'old,new').split(',');
const srv = await startServer({ stage: opt('--stage', undefined), port: 5189 });
const rows = [];
let log = `# ${new Date().toISOString()}  power A/B, REAL=all, ${rounds} round(s), sets ${sets.join(' vs ')}, stage ${srv.stage}\n`;
try {
  for (let r = 0; r < rounds; r++) {
    for (const set of sets) {
      const env = { ...process.env, BASE: srv.base, REAL: 'all', TIERS: tiers };
      if (set !== 'cur') env.MANIFEST = `models/v2-${set}/manifest.json`; else delete env.MANIFEST;
      const p = await run(process.execPath, ['e2e/render-power.mjs'], { env });
      log += `\n## round ${r + 1}, ${set}\n${p.stdout}${p.stderr}`;
      for (const l of p.stdout.split(/\r?\n/)) if (l.startsWith('{')) rows.push({ set, round: r, ...JSON.parse(l) });
      fs.writeFileSync(out, log);
    }
  }
} finally {
  await srv.close();
}
const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
const table = [];
for (const tier of tiers.split(',')) {
  const row = { tier };
  for (const set of sets) {
    const m = rows.filter((x) => x.set === set && x.tier === tier);
    if (!m.length) continue;
    row[`${set} fps`] = med(m.map((x) => +x.battleFps));
    row[`${set} gpuMs`] = med(m.map((x) => +x.gpuMs || 0));
    row[`${set} tris`] = m[0].tris; row[`${set} draws`] = m[0].draws;
    row[`${set} idle/hidden`] = `${Math.max(...m.map((x) => +x.planningIdleFps))} / ${Math.max(...m.map((x) => +x.hiddenFps))}`;
  }
  const [a, b] = sets;
  if (row[`${a} fps`] && row[`${b} fps`]) row['fps new/old'] = (row[`${b} fps`] / row[`${a} fps`]).toFixed(2);
  table.push(row);
}
console.table(table);
log += `\n## summary (median over rounds)\n${JSON.stringify(table, null, 1)}\n`;
fs.writeFileSync(out, log);
