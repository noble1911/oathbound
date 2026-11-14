// Budgets (task spec): a 90 s, ~250-soldier battle simulates in < 1.5 s in Node; its replay is < ~400 KB uncompressed.
import { describe, expect, it } from 'vitest';
import { decodeReplay, simulateBattle } from '../src/sim/index.ts';
import { bigBattle } from '../src/sim/fixtures.ts';

describe('performance and replay size budgets', () => {
  for (const heavy of [false, true]) {
    it(`${heavy ? 'heavy (healers, runs ~90 s)' : 'mixed'} ~230-soldier battle`, () => {
      const s = bigBattle(1, heavy);
      simulateBattle(s); // warm-up (JIT)
      const t0 = performance.now();
      const { replay } = simulateBattle(s);
      const ms = performance.now() - t0;
      const bytes = JSON.stringify(replay).length;
      console.log(`${heavy ? 'heavy' : 'mixed'}: ${replay.soldiers.length} soldiers, ${replay.ticks} ticks, ${ms.toFixed(0)} ms, ${(bytes / 1024).toFixed(0)} KB, ${replay.eventCount} events`);
      expect(replay.soldiers.length).toBeGreaterThan(200);
      expect(ms).toBeLessThan(1500);
      expect(bytes).toBeLessThan(400 * 1024);
      const t1 = performance.now();
      decodeReplay(replay);
      expect(performance.now() - t1).toBeLessThan(500);
    }, 30_000);
  }
});
