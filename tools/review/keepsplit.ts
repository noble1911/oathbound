// How much of the keep damage is the flat round bonus (70 x round, paid to the round winner) and how much comes from
// surviving squads? Hard vs Hard, every Lord pairing.   node tools/review/keepsplit.ts
import { KEEP_DMG_BASE_PER_ROUND, suddenDeathPct } from '../../src/sim/match.ts';
import { hard, lordPairs, playMatch } from './lib.ts';
let base = 0, all = 0, closeWins = 0, closeBase = 0, closeAll = 0, wins = 0;
let seed = 17000;
for (let k = 0; k < 2; k++) for (const lords of lordPairs()) playMatch(seed++, lords, [hard, hard], {
  post: (s, r) => {
    if (r.winner === null) { all += r.keepDamage[0] + r.keepDamage[1]; return; }
    const d = r.keepDamage[1 - r.winner];
    const b = Math.min(d, Math.trunc(KEEP_DMG_BASE_PER_ROUND * s.round * suddenDeathPct(s.round) / 100));
    base += b; all += d; wins++;
    if (Math.abs(r.score[0] - r.score[1]) < 20) { closeWins++; closeBase += b; closeAll += d; }
  },
});
console.log(`round bonus = ${(100 * base / all).toFixed(1)}% of all keep damage; in close rounds (margin < 20 points, ${(100 * closeWins / wins).toFixed(0)}% of decided rounds) it is ${(100 * closeBase / closeAll).toFixed(1)}%, mean keep damage of a close win ${(closeAll / closeWins).toFixed(0)} vs ${(all / wins).toFixed(0)} overall`);
