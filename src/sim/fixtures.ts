// Large fixed armies for the performance / replay-size budgets (tests and tools/sim-report.ts --perf).
import { mirrorPos } from './constants.ts';
import { newMatch } from './match.ts';
import type { LordId, MatchState, Seat, UnitType } from './types.ts';
import { UNIT_TYPES } from './data/units.ts';

/** ~250-soldier battle: 15 squads + Lord per side. `heavy` = tanky healer armies that run the full 90 s. */
export function bigBattle(seed: number, heavy = false, lords: [LordId, LordId] = ['warden', 'archmage']): MatchState {
  const s = newMatch(seed, lords);
  const army: [UnitType, number][] = heavy
    ? [['militia', 5], ['knights', 4], ['clerics', 3], ['archers', 3], ['pikemen', 1]]
    : [['militia', 5], ['archers', 3], ['pikemen', 2], ['knights', 2], ['mages', 2], ['clerics', 1], ['cavaliers', 1]];
  for (const seat of [0, 1] as Seat[]) {
    const p = s.players[seat];
    p.unlocked = [...UNIT_TYPES];
    let k = 0;
    for (const [u, n] of army) {
      for (let i = 0; i < n; i++, k++) {
        const x = 700 + (k % 5) * 1600, y = 3600 - Math.floor(k / 5) * 900;
        const pos = seat === 0 ? [x, y] as [number, number] : mirrorPos([x, y]);
        p.squads.push({ id: s.nextId++, owner: seat, type: u, level: heavy ? 3 : 2, pos, facing: seat === 0 ? 64 : 192, items: { weapon: null, armor: null, relic: null }, deployedRound: 1, spent: 0 });
      }
    }
  }
  s.round = 8;
  return s;
}
