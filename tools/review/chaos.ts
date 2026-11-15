// Experiment 6: how sensitive is a battle to tiny placement changes? Hard vs Hard; before each battle the whole army
// of one seat is shifted sideways by 10 cm, 1 m or 3 m, or one squad by 1 m. Result flips are split by how close the
// unchanged battle was (its points margin, or a wipe).
//   node tools/review/chaos.ts --seeds 4
import { isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { simulateBattle } from '../../src/sim/battle.ts';
import type { LordId, MatchState, Seat } from '../../src/sim/types.ts';
import { arg, hard, lordPairs, mean, outcome, own, playMatch, pool, relayout } from './lib.ts';

const shift = (dx: number) => (s: MatchState, seat: Seat): void => relayout(s, seat, (q) => { const [x, y] = own(seat, q.pos); return [x + dx, y]; });
const V: Record<string, (s: MatchState, seat: Seat) => void> = {
  all10cm: shift(10), all1m: shift(100), all3m: shift(300),
  one1m: (s, seat) => { const q = s.players[seat].squads.find((x) => x.type !== 'lord'); relayout(s, seat, (x) => (x === q ? [own(seat, x.pos)[0] + 100, own(seat, x.pos)[1]] : null)); },
};
interface Job { seed: number; lords: [LordId, LordId] }
interface Row { end: string; margin: number; survivorsLeft: number; flips: Record<string, number> }

export function work(j: Job): Row[] {
  const rows: Row[] = [];
  playMatch(j.seed, j.lords, [hard, hard], {
    post: (s, r) => {
      const row: Row = { end: r.end, margin: Math.abs(r.score[0] - r.score[1]), survivorsLeft: r.survivors[0].length + r.survivors[1].length, flips: {} };
      for (const [k, f] of Object.entries(V)) {
        let fl = 0;
        for (const seat of [0, 1] as Seat[]) { const c = structuredClone(s); f(c, seat); if (outcome(simulateBattle(c, { record: false }).result, seat) !== outcome(r, seat)) fl += 0.5; }
        row.flips[k] = fl;
      }
      rows.push(row);
    },
  });
  return rows;
}

async function main(): Promise<void> {
  const seeds = Number(arg('seeds', '4'));
  const jobs: Job[] = [];
  let seed = Number(arg('seed0', '15000'));
  for (let k = 0; k < seeds; k++) for (const lords of lordPairs()) jobs.push({ seed: seed++, lords });
  const rows = (await pool<Job, Row[]>(new URL(import.meta.url), jobs)).flat();
  const buckets: [string, (r: Row) => boolean][] = [
    ['all battles', () => true],
    ['points margin < 20', (r) => r.margin < 20],
    ['points margin 20-49', (r) => r.margin >= 20 && r.margin < 50],
    ['points margin >= 50', (r) => r.margin >= 50],
  ];
  console.log(`${rows.length} battles. Share whose round result changes when one seat's army is moved:`);
  console.log('bucket                | share of battles | ' + Object.keys(V).join(' | '));
  for (const [n, f] of buckets) {
    const xs = rows.filter(f);
    console.log(`${n.padEnd(21)} | ${(100 * xs.length / rows.length).toFixed(1).padStart(5)}% | ` + Object.keys(V).map((k) => (100 * mean(xs.map((r) => r.flips[k]))).toFixed(1) + '%').join(' | '));
  }
}

if (isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
