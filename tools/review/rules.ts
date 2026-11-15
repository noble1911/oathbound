// Rule what-ifs applied to BOTH seats (fair by construction), Hard vs Hard, every Lord pairing.
//   node tools/review/rules.ts --rule cap3|cap1|gold100
import { isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { UNITS } from '../../src/sim/data/units.ts';
import type { LordId, MatchState, Seat } from '../../src/sim/types.ts';
import { arg, hard, lordPairs, mean, playMatch, pool } from './lib.ts';

interface Job { seed: number; lords: [LordId, LordId]; rule: string }
interface Res { rounds: number; lvlShare: number; avgLvl: number; margin: number; p0: number }
export function work(j: Job): Res {
  let dep = 0, lvl = 0;
  const plan = (s: MatchState, seat: Seat): void => {
    const p = s.players[seat];
    if (j.rule === 'cap3') p.deployLimit += 1;
    if (j.rule === 'cap1') p.deployLimit = Math.max(1, p.deployLimit - 1);
    if (j.rule === 'gold100' && s.round > 1) p.gold += 100;
    const before = new Map(p.squads.map((q) => [q.id, q.spent]));
    hard(s, seat);
    for (const q of p.squads) if (q.type !== 'lord') { if (!before.has(q.id)) { dep += UNITS[q.type].cost; lvl += q.spent - UNITS[q.type].cost; } else lvl += q.spent - before.get(q.id)!; }
  };
  const { s } = playMatch(j.seed, j.lords, [plan, plan]);
  const us = [...s.players[0].squads, ...s.players[1].squads].filter((q) => q.type !== 'lord');
  const w = s.winner === 0 || s.winner === 1 ? s.players[s.winner] : null;
  return { rounds: s.round, lvlShare: lvl / Math.max(1, dep + lvl), avgLvl: mean(us.map((q) => q.level)), margin: w ? w.keepHp / w.keepMax : 0, p0: s.winner === 0 ? 1 : s.winner === 1 ? 0 : 0.5 };
}
async function main(): Promise<void> {
  for (const rule of arg('rule', 'base,cap3,cap1,gold100').split(',')) {
    const jobs: Job[] = [];
    let seed = 19000;
    for (let k = 0; k < Number(arg('seeds', '10')); k++) for (const lords of lordPairs()) jobs.push({ seed: seed++, lords, rule });
    const rs = await pool<Job, Res>(new URL(import.meta.url), jobs);
    console.log(`${rule.padEnd(8)} | avg rounds ${mean(rs.map((r) => r.rounds)).toFixed(2)} | level-ups ${(100 * mean(rs.map((r) => r.lvlShare))).toFixed(1)}% of spend | final avg squad level ${mean(rs.map((r) => r.avgLvl)).toFixed(2)} | winner keep left ${(100 * mean(rs.filter((r) => r.margin > 0).map((r) => r.margin))).toFixed(1)}% | P0 ${(100 * mean(rs.map((r) => r.p0))).toFixed(1)}%`);
  }
}
if (isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
