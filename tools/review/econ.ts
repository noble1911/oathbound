// Experiment 4: where the gold goes, round by round (Hard vs Hard and Normal vs Normal, every Lord pairing).
//   node tools/review/econ.ts --seeds 10 --strat hard
import { isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { UNITS } from '../../src/sim/data/units.ts';
import { income } from '../../src/sim/match.ts';
import type { LordId, MatchState, Seat } from '../../src/sim/types.ts';
import { arg, botPlanX, KNOB, lordPairs, mean, playMatch, pool, type Planner } from './lib.ts';

interface Job { seed: number; lords: [LordId, LordId]; strat: string }
interface R { round: number; start: number; deploy: number; level: number; left: number; used: number; limit: number; army: number; lvl: number; capped: boolean; deployGoldLimited: boolean; stash: number; onLord: number; onSquads: number }

export function work(j: Job): R[] {
  const out: R[] = [];
  const mk = (seat: Seat): Planner => (s: MatchState) => {
    const p = s.players[seat];
    const start = p.gold;
    const before = new Map(p.squads.map((q) => [q.id, q.spent]));
    KNOB.noLevel = false; KNOB.noLayout = false;
    botPlanX(s, seat, j.strat as never, seat + 1);
    let deploy = 0, level = 0;
    for (const q of p.squads) {
      if (q.type === 'lord') continue;
      if (!before.has(q.id)) { deploy += UNITS[q.type].cost; level += q.spent - UNITS[q.type].cost; } else level += q.spent - before.get(q.id)!;
    }
    const us = p.squads.filter((q) => q.type !== 'lord');
    const cheapest = Math.min(...p.unlocked.map((u) => UNITS[u].cost));
    out.push({
      round: s.round, start, deploy, level, left: p.gold, used: p.deploysUsed, limit: p.deployLimit, army: us.length,
      lvl: mean(us.map((q) => q.level)), capped: us.length >= 16,
      deployGoldLimited: p.deploysUsed < p.deployLimit && us.length < 16 && p.gold < cheapest,
      stash: p.stash.length,
      onLord: p.squads.filter((q) => q.type === 'lord').reduce((a, q) => a + Object.values(q.items).filter(Boolean).length, 0),
      onSquads: us.reduce((a, q) => a + Object.values(q.items).filter(Boolean).length, 0),
    });
  };
  playMatch(j.seed, j.lords, [mk(0), mk(1)]);
  return out;
}

async function main(): Promise<void> {
  const seeds = Number(arg('seeds', '10'));
  const strat = arg('strat', 'hard');
  const jobs: Job[] = [];
  let seed = Number(arg('seed0', '11000'));
  for (let k = 0; k < seeds; k++) for (const lords of lordPairs()) jobs.push({ seed: seed++, lords, strat });
  const rs = (await pool<Job, R[]>(new URL(import.meta.url), jobs)).flat();
  console.log(`${strat} vs ${strat}: ${jobs.length} matches, ${rs.length} seat-rounds`);
  console.log('round | income | gold at start | on deploys | on level-ups | unspent after | deploys used/limit | deploy limit hit | army size | avg level | at cap 16');
  const maxR = Math.max(...rs.map((r) => r.round));
  for (let r = 1; r <= Math.min(12, maxR); r++) {
    const xs = rs.filter((x) => x.round === r);
    if (xs.length < 20) continue;
    console.log(`${String(r).padStart(5)} | ${String(income(r)).padStart(6)} | ${mean(xs.map((x) => x.start)).toFixed(0).padStart(5)} | ${mean(xs.map((x) => x.deploy)).toFixed(0).padStart(5)} | ${mean(xs.map((x) => x.level)).toFixed(0).padStart(5)} | ${mean(xs.map((x) => x.left)).toFixed(0).padStart(5)} | ${mean(xs.map((x) => x.used)).toFixed(2)}/${mean(xs.map((x) => x.limit)).toFixed(2)} | ${(100 * mean(xs.map((x) => (x.used >= x.limit ? 1 : 0)))).toFixed(0).padStart(3)}% | ${mean(xs.map((x) => x.army)).toFixed(1).padStart(5)} | ${mean(xs.map((x) => x.lvl)).toFixed(2)} | ${(100 * mean(xs.map((x) => (x.capped ? 1 : 0)))).toFixed(0)}% (n=${xs.length})`);
  }
  console.log('round | items owned | worn by the Lord | worn by squads | idle in the stash');
  for (let r = 2; r <= Math.min(11, maxR); r++) {
    const xs = rs.filter((x) => x.round === r);
    if (xs.length < 20) continue;
    const own = mean(xs.map((x) => x.stash + x.onLord + x.onSquads));
    console.log(`${String(r).padStart(5)} | ${own.toFixed(2)} | ${mean(xs.map((x) => x.onLord)).toFixed(2)} | ${mean(xs.map((x) => x.onSquads)).toFixed(2)} | ${mean(xs.map((x) => x.stash)).toFixed(2)}`);
  }
  const tot = (f: (x: R) => number): number => rs.reduce((a, x) => a + f(x), 0);
  console.log(`Totals: deploys ${(100 * tot((x) => x.deploy) / tot((x) => x.deploy + x.level)).toFixed(1)}% of spend, level-ups ${(100 * tot((x) => x.level) / tot((x) => x.deploy + x.level)).toFixed(1)}%; mean unspent after planning ${mean(rs.map((x) => x.left)).toFixed(0)} gold`);
}

if (isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
