// Plays bot-vs-bot matches and prints a per-round summary (keeps, army sizes, battle length, replay size, sim time).
// Usage: node tools/sim-report.ts [seed=1] [strategyA=best] [strategyB=rush] [lordA=marshal] [lordB=warden]
import { newMatch, botPlan, simulateBattle, applyBattle, nextRound, decodeReplay } from '../src/sim/index.ts';
import type { BotStrategy, LordId } from '../src/sim/types.ts';

const [seedS = '1', sa = 'best', sb = 'rush', la = 'marshal', lb = 'warden'] = process.argv.slice(2);
const s = newMatch(Number(seedS), [la as LordId, lb as LordId]);
const pad = (x: string | number, n: number): string => String(x).padEnd(n);
console.log(pad('rnd', 4) + pad('squads', 8) + pad('soldiers', 9) + pad('winner', 7) + pad('ticks', 6) + pad('keepDmg', 11) + pad('keeps', 12) + pad('lost', 9) + pad('KB', 7) + pad('ms', 6) + 'gold');
while (s.phase === 'planning') {
  botPlan(s, 0, sa as BotStrategy);
  botPlan(s, 1, sb as BotStrategy);
  const t0 = performance.now();
  const { replay, result } = simulateBattle(s);
  const ms = performance.now() - t0;
  const kb = JSON.stringify(replay).length / 1024;
  if (s.round === 1) decodeReplay(replay);
  const gold = s.players.map((p) => p.gold).join('/');
  applyBattle(s, result);
  console.log(
    pad(s.round, 4) + pad(s.players.map((p) => p.squads.length).join('/'), 8) + pad(replay.soldiers.length, 9) + pad(result.winner ?? '-', 7) +
    pad(result.ticks, 6) + pad(result.keepDamage.join('/'), 11) + pad(s.players.map((p) => p.keepHp).join('/'), 12) +
    pad(result.soldiersLost.join('/'), 9) + pad(kb.toFixed(0), 7) + pad(ms.toFixed(0), 6) + gold,
  );
  if (s.phase === 'over') break;
  nextRound(s);
}
console.log('winner', s.winner, 'rounds', s.round);
