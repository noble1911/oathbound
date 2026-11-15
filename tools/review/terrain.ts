// Experiment 5: does the map matter? Hard vs Hard; every battle is re-run on other maps with the same two armies.
//   node tools/review/terrain.ts --seeds 4
// Maps: the match's own; no river (forests, hills and ruins kept); a river with no crossings; a flat field;
// and a "hard river" where wading costs 80% of speed (MOVE_PCT patched in this process only; the flow field's step
// costs are not exported, so pathing still prices the river as today).
import { isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { simulateBattle } from '../../src/sim/battle.ts';
import { MOVE_PCT } from '../../src/sim/terrain.ts';
import type { LordId, MatchState, Terrain } from '../../src/sim/types.ts';
import { arg, hard, lordPairs, mean, outcome, playMatch, pool } from './lib.ts';

const MAPS: Record<string, (t: Terrain) => Terrain> = {
  noRiver: (t) => ({ seed: t.seed + 0x1000000, features: t.features.filter((f) => f.kind !== 'river' && f.kind !== 'bridge' && f.kind !== 'ford') }),
  noCrossings: (t) => ({ seed: t.seed + 0x2000000, features: t.features.filter((f) => f.kind !== 'bridge' && f.kind !== 'ford') }),
  flat: (t) => ({ seed: t.seed + 0x3000000, features: [] }),
  // the "keep" key of navFor's cache needs a distinct seed and first-feature x
};

interface Job { seed: number; lords: [LordId, LordId] }
interface Row { round: number; three: boolean; base: { o: number; t: number; end: string }; v: Record<string, { o: number; t: number; end: string }> }

const run = (s: MatchState): { o: number; t: number; end: string } => {
  const { result } = simulateBattle(s, { record: false });
  return { o: outcome(result, 0), t: result.ticks / 20, end: result.end };
};

export function work(j: Job): Row[] {
  const rows: Row[] = [];
  playMatch(j.seed, j.lords, [hard, hard], {
    post: (s, r) => {
      const row: Row = { round: s.round, three: s.terrain.features.some((f) => f.kind === 'ford'), base: { o: outcome(r, 0), t: r.ticks / 20, end: r.end }, v: {} };
      for (const [k, f] of Object.entries(MAPS)) { const c = structuredClone(s); c.terrain = f(c.terrain); row.v[k] = run(c); }
      const save = MOVE_PCT[3];
      MOVE_PCT[3] = 20;
      row.v.hardRiver = run(structuredClone(s));
      MOVE_PCT[3] = save;
      rows.push(row);
    },
  });
  return rows;
}

async function main(): Promise<void> {
  const seeds = Number(arg('seeds', '4'));
  const jobs: Job[] = [];
  let seed = Number(arg('seed0', '13000'));
  for (let k = 0; k < seeds; k++) for (const lords of lordPairs()) jobs.push({ seed: seed++, lords });
  const rows = (await pool<Job, Row[]>(new URL(import.meta.url), jobs)).flat();
  console.log(`${jobs.length} matches, ${rows.length} battles (${rows.filter((r) => r.three).length} on 3-crossing maps)`);
  console.log(`base: battle ${mean(rows.map((r) => r.base.t)).toFixed(1)} s, timeouts+stalls ${(100 * mean(rows.map((r) => (r.base.end === 'timeout' || r.base.end === 'stalemate' ? 1 : 0)))).toFixed(1)}%`);
  console.log('map         | round result changed | battle length s | timeouts+stalls');
  for (const k of [...Object.keys(MAPS), 'hardRiver']) {
    const ch = mean(rows.map((r) => (r.v[k].o !== r.base.o ? 1 : 0)));
    console.log(`${k.padEnd(11)} | ${(100 * ch).toFixed(1).padStart(5)}% | ${mean(rows.map((r) => r.v[k].t)).toFixed(1)} | ${(100 * mean(rows.map((r) => (r.v[k].end === 'timeout' || r.v[k].end === 'stalemate' ? 1 : 0)))).toFixed(1)}%`);
  }
}

if (isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
