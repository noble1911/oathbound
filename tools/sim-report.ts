// Plays bot-vs-bot matches and prints a per-round summary (keeps, army sizes, battle length, replay size, sim time,
// item-skill casts per seat and each Lord's share of its army's damage), then the top squads of the last battle.
// Usage: node tools/sim-report.ts [seed=1] [strategyA=hard] [strategyB=rush] [lordA=marshal] [lordB=warden]
//   strategies: rush ranged armor air counter random | easy normal hard (= best)
import { newMatch, botPlan, simulateBattle, applyBattle, nextRound, decodeReplay, squadStatsAt } from '../src/sim/index.ts';
import type { BattleStatsAt } from '../src/sim/index.ts';
import type { BotStrategy, LordId } from '../src/sim/types.ts';

const [seedS = '1', sa = 'hard', sb = 'rush', la = 'marshal', lb = 'warden'] = process.argv.slice(2);
const s = newMatch(Number(seedS), [la as LordId, lb as LordId]);
const pad = (x: string | number, n: number): string => String(x).padEnd(n);
console.log(pad('rnd', 4) + pad('squads', 8) + pad('soldiers', 9) + pad('winner', 7) + pad('end', 11) + pad('points', 8) + pad('ticks', 6) + pad('keepDmg', 11) + pad('keeps', 12) + pad('lost', 9) + pad('KB', 7) + pad('ms', 6) + pad('gold', 10) + pad('casts', 8) + 'lord dmg %');
let last: BattleStatsAt | null = null;
while (s.phase === 'planning') {
  botPlan(s, 0, sa as BotStrategy);
  botPlan(s, 1, sb as BotStrategy);
  const t0 = performance.now();
  const { replay, result } = simulateBattle(s);
  const ms = performance.now() - t0;
  const kb = JSON.stringify(replay).length / 1024;
  const d = decodeReplay(replay);
  last = squadStatsAt(d, replay.ticks);
  const casts = [0, 1].map((seat) => d.skills!.filter((e) => replay.squads[e.squad].side === seat).length).join('/');
  const share = [0, 1].map((seat) => Math.round((100 * (result.lordDamage?.[seat] ?? 0)) / Math.max(1, result.damageDealt[seat]))).join('/');
  const gold = s.players.map((p) => p.gold).join('/');
  applyBattle(s, result);
  console.log(
    pad(s.round, 4) + pad(s.players.map((p) => p.squads.length).join('/'), 8) + pad(replay.soldiers.length, 9) + pad(result.winner ?? '-', 7) + pad(result.end, 11) + pad(result.score.join('/'), 8) +
    pad(result.ticks, 6) + pad(result.keepDamage.join('/'), 11) + pad(s.players.map((p) => p.keepHp).join('/'), 12) +
    pad(result.soldiersLost.join('/'), 9) + pad(kb.toFixed(0), 7) + pad(ms.toFixed(0), 6) + pad(gold, 10) + pad(casts, 8) + share,
  );
  if (s.phase === 'over') break;
  nextRound(s);
}
console.log('winner', s.winner, 'rounds', s.round);
if (last) {
  console.log('\nlast battle, squads by damage dealt:');
  console.log(pad('seat', 5) + pad('squad', 12) + pad('lv', 4) + pad('dealt', 8) + pad('taken', 8) + pad('mitig', 8) + pad('healed', 8) + pad('kills', 7) + pad('alive', 8) + 'skills');
  for (const q of [...last.squads].sort((a, b) => b.dealt - a.dealt).slice(0, 14)) {
    console.log(pad(q.side, 5) + pad(q.type + (q.summoned ? '*' : ''), 12) + pad(q.level, 4) + pad(q.dealt, 8) + pad(q.taken, 8) + pad(q.mitigated, 8) + pad(q.healingDone, 8) + pad(q.kills, 7) + pad(`${q.alive}/${q.soldiers}`, 8) +
      q.skills.map((k) => `${k.skill} x${k.casts} (${k.damage || k.healing})`).join(', '));
  }
}
