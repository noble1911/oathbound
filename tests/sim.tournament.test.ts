// Small-sample tournament smoke test (the full one is `node tools/tournament.ts`, see docs/BALANCE.md).
import { describe, expect, it } from 'vitest';
import { aggregate, formatReport, playMatch, TOURNAMENT_STRATEGIES } from '../src/sim/tournament.ts';
import { LORD_IDS } from '../src/sim/data/lords.ts';
import type { BotStrategy } from '../src/sim/types.ts';

describe('tournament smoke', () => {
  it('bots of every strategy finish matches and the report aggregates', () => {
    const recs = [];
    const strats: BotStrategy[] = [...TOURNAMENT_STRATEGIES, 'best'];
    let seed = 1;
    for (let i = 0; i < strats.length; i++) {
      const a = strats[i], b = strats[(i + 1) % strats.length];
      recs.push(playMatch(seed++, [LORD_IDS[i % 4], LORD_IDS[(i + 1) % 4]], [a, b]));
      recs.push(playMatch(seed++, [LORD_IDS[(i + 1) % 4], LORD_IDS[i % 4]], [b, a]));
    }
    for (const r of recs) {
      expect(r.winner === 0 || r.winner === 1 || r.winner === 'draw').toBe(true);
      expect(r.rounds).toBeGreaterThanOrEqual(3);
      expect(r.rounds).toBeLessThanOrEqual(30);
    }
    const rep = aggregate(recs);
    expect(rep.matches).toBe(recs.length);
    expect(rep.p0).toBeGreaterThan(0.15);
    expect(rep.p0).toBeLessThan(0.85);
    expect(Object.keys(rep.lords).length).toBe(4);
    expect(formatReport(rep)).toContain('Lords:');
  }, 120_000);
});
