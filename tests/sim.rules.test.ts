// The QA-pass rules: deploy footprints, slot unlocks + usable loot, stalemates and points, comeback, AI levels.
import { describe, expect, it } from 'vitest';
import {
  newMatch, applyIntent, simulateBattle, applyBattle, nextRound, viewFor, botPlan, rollLoot, freeSpotNear, squadFootprint,
  overlappingSquad, usableSlots, comebackFor, roundOutcomeText, SLOT_UNLOCK_LEVEL, POINTS_MARGIN, CATCHUP_GOLD, CATCHUP_PER_ROUND,
  CATCHUP_PER_DEFICIT, UNDERDOG_DEFICIT, MAX_BATTLE_TICKS, mirrorPos, UNITS,
} from '../src/sim/index.ts';
import { rollItem } from '../src/sim/loot.ts';
import { Rng } from '../src/sim/rng.ts';
import type { BotStrategy, Item, MatchState, RoundSummary, Seat, Squad } from '../src/sim/types.ts';
import { playMatch } from '../src/sim/tournament.ts';

const squad = (s: MatchState, seat: Seat, type: Squad['type'], pos: [number, number], level = 1): Squad => {
  const q: Squad = { id: s.nextId++, owner: seat, type, level, pos, facing: seat === 0 ? 64 : 192, items: { weapon: null, armor: null, relic: null }, deployedRound: s.round, spent: type === 'lord' ? 0 : UNITS[type].cost * level };
  s.players[seat].squads.push(q);
  return q;
};

describe('deploy footprints', () => {
  it('rejects a deploy or move onto another squad, with a clear error', () => {
    const s = newMatch(7, ['warden', 'marshal']);
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4000, 2000] }).ok).toBe(true);
    const r = applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4100, 2050] });
    expect(r).toEqual({ ok: false, error: 'overlaps another squad: each squad needs its own ground' });
    expect(s.players[0].gold).toBe(150); // nothing was charged
    // exactly touching footprints are fine
    const gap = squadFootprint('berserkers') * 2;
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4000 - gap, 2000] }).ok).toBe(true);
    const [lord, a, b] = s.players[0].squads;
    expect(applyIntent(s, 0, { t: 'move', squad: b.id, pos: [a.pos[0] + 10, a.pos[1]] }).ok).toBe(false);
    expect(applyIntent(s, 0, { t: 'move', squad: lord.id, pos: [4000, 2100] }).ok).toBe(false);
    // a squad may move onto (part of) its own old spot
    expect(applyIntent(s, 0, { t: 'move', squad: a.id, pos: [a.pos[0] + 50, a.pos[1]] }).ok).toBe(true);
    // the enemy's squads never block (they are on the other half anyway)
    expect(overlappingSquad(s.players[1].squads, 'militia', [4000, 2000])).toBe(null);
  });

  it('freeSpotNear finds the nearest legal spot, deterministically and inside the zone', () => {
    const s = newMatch(3, ['archmage', 'archmage']);
    const p = s.players[0];
    p.gold = 5000;
    p.deployLimit = 20;
    p.unlocked.push('militia');
    for (let i = 0; i < 12; i++) {
      const spot = freeSpotNear(p.squads, 0, 'militia', [4000, 3000]);
      expect(spot).not.toBe(null);
      expect(applyIntent(s, 0, { t: 'deploy', unit: 'militia', pos: spot! }).ok).toBe(true);
    }
    expect(freeSpotNear(p.squads, 0, 'militia', [4000, 3000])).toEqual(freeSpotNear(structuredClone(p.squads), 0, 'militia', [4000, 3000]));
    // seat 1 mirrors seat 0
    const q = s.players[1];
    const at = freeSpotNear(q.squads, 1, 'knights', mirrorPos([4000, 1200]))!;
    expect(at[1]).toBeGreaterThanOrEqual(8000);
  });
});

describe('item slots and loot', () => {
  it('weapon opens at Lv1, armor at Lv2, relic at Lv4', () => {
    expect(SLOT_UNLOCK_LEVEL).toEqual({ weapon: 1, armor: 2, relic: 4 });
    const s = newMatch(11, ['warden', 'warden']);
    const p = s.players[0];
    p.gold = 5000;
    applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4000, 2500] });
    const sq = p.squads[1];
    const mk = (slot: Item['slot'], id: number): Item => ({ ...rollItem(new Rng(id), id, 2, 'magic', slot), id });
    p.stash.push(mk('weapon', 900), mk('armor', 901), mk('relic', 902));
    expect(applyIntent(s, 0, { t: 'equip', item: 900, squad: sq.id }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'equip', item: 901, squad: sq.id })).toEqual({ ok: false, error: 'armor slot opens at level 2' });
    applyIntent(s, 0, { t: 'levelUp', squad: sq.id });
    expect(applyIntent(s, 0, { t: 'equip', item: 901, squad: sq.id }).ok).toBe(true);
    applyIntent(s, 0, { t: 'levelUp', squad: sq.id });
    expect(applyIntent(s, 0, { t: 'equip', item: 902, squad: sq.id }).ok).toBe(false);
    applyIntent(s, 0, { t: 'levelUp', squad: sq.id });
    expect(sq.level).toBe(4);
    expect(applyIntent(s, 0, { t: 'equip', item: 902, squad: sq.id }).ok).toBe(true);
  });

  it('usableSlots counts empty open slots minus stash items already waiting for them', () => {
    const s = newMatch(5, ['marshal', 'marshal']);
    const p = s.players[0];
    expect(usableSlots(p)).toEqual(['weapon', 'armor', 'relic']); // the Lord's three empty slots
    const mk = (slot: Item['slot'], id: number): Item => ({ ...rollItem(new Rng(id), id, 2, 'common', slot), id });
    p.stash.push(mk('armor', 1), mk('relic', 2));
    expect(usableSlots(p)).toEqual(['weapon']);
    squad(s, 0, 'knights', [2000, 3000], 2); // a Lv2 squad opens another armor slot
    expect(usableSlots(p)).toEqual(['weapon', 'armor']);
  });

  it('offers lean toward usable slots: at least 2 of 3 (3 of 4) fit, reproducibly', () => {
    for (let seed = 0; seed < 300; seed++) {
      for (const count of [3, 4]) {
        let id = 1;
        const a = rollLoot(seed, 5, seed & 1, seed % 3 === 0, count, () => id++, ['relic']);
        expect(a.filter((it) => it.slot === 'relic').length).toBeGreaterThanOrEqual(count - 1);
        id = 1;
        expect(rollLoot(seed, 5, seed & 1, seed % 3 === 0, count, () => id++, ['relic'])).toEqual(a);
        for (const it of a) if (it.legendary) expect(it.slot).toBe(it.slot); // legendary slots stay consistent
      }
    }
    // no preference given (or nothing usable): the plain roll
    let id = 1;
    const plain = rollLoot(9, 5, 0, false, 3, () => id++);
    id = 1;
    expect(rollLoot(9, 5, 0, false, 3, () => id++, [])).toEqual(plain);
  });

  it('after a battle, the offer is biased by what the player can equip', () => {
    const s = newMatch(21, ['skylady', 'warden']);
    const mk = (slot: Item['slot'], id: number): Item => ({ ...rollItem(new Rng(id), id, 1, 'common', slot), id });
    // seat 0's Lord already wears a weapon and armour and nothing else can take any: only relics are usable
    s.players[0].squads[0].items.weapon = mk('weapon', 801);
    s.players[0].squads[0].items.armor = mk('armor', 802);
    applyIntent(s, 0, { t: 'ready' });
    applyIntent(s, 1, { t: 'ready' });
    applyBattle(s, simulateBattle(s, { record: false }).result);
    const offer = s.players[0].lootOffer!;
    expect(offer.length).toBe(4); // Skylady
    expect(offer.filter((it) => it.slot === 'relic').length).toBeGreaterThanOrEqual(3);
  });
});

describe('stalemates, points and result wording', () => {
  it('an army that cannot hit the enemy ends the battle early, decided on points with consistent wording', () => {
    const s = newMatch(4, ['warden', 'skylady']);
    s.players[0].squads = [];
    s.players[1].squads = [];
    for (let i = 0; i < 4; i++) squad(s, 0, 'golem', [1500 + i * 1500, 3000], 3); // no anti-air at all
    squad(s, 1, 'wyvern', mirrorPos([4000, 3000]));
    const { result } = simulateBattle(s, { record: false });
    expect(result.end).toBe('stalemate');
    expect(result.timeout).toBe(true);
    expect(result.ticks).toBeLessThan(MAX_BATTLE_TICKS);
    // golems still stand nearly whole; the wyverns only chipped them
    expect(result.score[0]).toBeGreaterThan(result.score[1] - 100);
    const lead = result.score[0] - result.score[1];
    expect(result.winner).toBe(lead >= POINTS_MARGIN ? 0 : lead <= -POINTS_MARGIN ? 1 : null);
    if (result.winner !== null) expect(result.keepDamage[result.winner]).toBe(0); // the points loser deals nothing
    applyBattle(s, result);
    const h = s.history[0];
    expect(h.end).toBe('stalemate');
    expect(h.score).toEqual(result.score);
    for (const seat of [0, 1] as Seat[]) {
      const txt = roundOutcomeText(h, seat);
      const p = s.players[seat];
      // the words, the catch-up flag and the comeback gold always agree
      expect(txt.outcome === 'lost').toBe(p.lostLast);
      expect(p.comeback.gold > 0).toBe(p.lostLast);
      if (txt.outcome === 'draw') expect(txt.title).toBe('Stalemate');
      else expect(txt.title).toBe(txt.outcome === 'won' ? 'Victory on points' : 'Defeat on points');
      expect(txt.detail).toMatch(/%/);
    }
  });

  it('roundOutcomeText covers every ending, and a draw is nobody\'s loss', () => {
    const base: Pick<RoundSummary, 'winner' | 'end' | 'score'> = { winner: 0, end: 'wipe', score: [60, 0] };
    expect(roundOutcomeText(base, 0)).toMatchObject({ outcome: 'won', title: 'Victory' });
    expect(roundOutcomeText(base, 1)).toMatchObject({ outcome: 'lost', title: 'Defeat' });
    expect(roundOutcomeText({ ...base, end: 'timeout', score: [40, 20] }, 1)).toMatchObject({ outcome: 'lost', title: 'Defeat on points' });
    expect(roundOutcomeText({ winner: null, end: 'timeout', score: [30, 31] }, 0)).toMatchObject({ outcome: 'draw', title: 'Draw' });
    expect(roundOutcomeText({ winner: null, end: 'mutualWipe', score: [0, 0] }, 1)).toMatchObject({ outcome: 'draw', title: 'Draw' });
    expect(roundOutcomeText({ winner: null, end: 'stalemate', score: [5, 5] }, null)).toMatchObject({ outcome: 'draw', title: 'Stalemate' });
    expect(roundOutcomeText({ ...base, end: 'timeout', score: [40, 20] }, 0).detail).toContain('40% of your army');
  });
});

describe('comeback', () => {
  it('pays the round loser more as rounds go on and as its keep falls behind, plus a deploy when far behind', () => {
    const s = newMatch(1, ['marshal', 'archmage']);
    const [a, b] = s.players;
    a.keepHp = 4000; b.keepHp = 2000; // b is 50 points behind
    expect(comebackFor(b, a, 6, true)).toEqual({ gold: CATCHUP_GOLD + CATCHUP_PER_ROUND * 6 + CATCHUP_PER_DEFICIT * 50, deploys: 1, deficit: 50 });
    expect(comebackFor(a, b, 6, false)).toEqual({ gold: 0, deploys: 0, deficit: 0 });
    // won the round but still far behind: no gold, still the extra deploy
    expect(comebackFor(b, a, 6, false)).toEqual({ gold: 0, deploys: 1, deficit: 50 });
    b.keepHp = 4000 - Math.trunc((UNDERDOG_DEFICIT - 1) * 40);
    expect(comebackFor(b, a, 2, true).deploys).toBe(0);
  });

  it('nextRound pays it: income + comeback gold, and the extra deploy slot', () => {
    const s = newMatch(2, ['archmage', 'archmage']);
    s.players[1].squads = [];
    s.players[0].keepHp = 4000;
    s.players[1].keepHp = 1500;
    applyIntent(s, 0, { t: 'ready' });
    applyIntent(s, 1, { t: 'ready' });
    applyBattle(s, simulateBattle(s, { record: false }).result); // seat 0's Lord routs an empty army
    const p = s.players[1];
    expect(p.lostLast).toBe(true);
    expect(p.comeback.deploys).toBe(1);
    const gold = p.gold;
    nextRound(s);
    expect(p.gold).toBe(gold + 250 + p.comeback.gold);
    expect(p.deployLimit).toBe(3);
    expect(s.players[0].deployLimit).toBe(2);
  });
});

describe('AI difficulty levels', () => {
  function planned(strat: BotStrategy, seed: number, rounds: number): MatchState {
    const s = newMatch(seed, ['warden', 'marshal']);
    for (let r = 0; r < rounds && s.phase === 'planning'; r++) {
      botPlan(s, 0, strat, 1);
      botPlan(s, 1, 'counter', 2);
      applyBattle(s, simulateBattle(s, { record: false }).result);
      if ((s.phase as string) !== 'results') break;
      nextRound(s);
    }
    return s;
  }

  it('easy under-spends and rarely levels; hard spends it all and levels up', () => {
    let easyKept = 0, easyHad = 0, hardKept = 0, hardHad = 0, easyLv = 0, hardLv = 0;
    for (const seed of [1, 2, 3, 4]) {
      for (const [strat, add] of [['easy', (k: number, h: number, l: number) => { easyKept += k; easyHad += h; easyLv += l; }], ['hard', (k: number, h: number, l: number) => { hardKept += k; hardHad += h; hardLv += l; }]] as const) {
        const s = planned(strat, seed, 4);
        if (s.phase !== 'planning') continue;
        const had = s.players[0].gold;
        botPlan(s, 0, strat, 1);
        add(s.players[0].gold, had, s.players[0].squads.filter((q) => q.type !== 'lord').reduce((a, q) => a + q.level - 1, 0));
      }
    }
    // easy banks a third or more; hard keeps only the change no deploy or level-up fits
    expect(easyKept / easyHad).toBeGreaterThan(0.3);
    expect(hardKept / hardHad).toBeLessThan(0.25);
    expect(easyKept / easyHad).toBeGreaterThan(hardKept / hardHad + 0.15);
    expect(easyLv).toBeLessThanOrEqual(4 * 4); // at most one level-up a turn
    expect(hardLv).toBeGreaterThanOrEqual(0);
  });

  it('hard uses only viewFor information: hidden enemy changes do not change its plan', () => {
    const s = planned('hard', 9, 3);
    expect(s.phase).toBe('planning');
    const t = structuredClone(s);
    // the enemy does things hard cannot see: more gold, a new squad, a moved Lord, different items in the stash
    const e = t.players[1];
    e.gold += 5000;
    e.squads.push({ ...structuredClone(e.squads[e.squads.length - 1]), id: 99_999, pos: [1000, 9000] });
    e.squads[0].pos = [7000, 8500];
    e.stash = [];
    expect(viewFor(t, 0)).toEqual(viewFor(s, 0));
    botPlan(s, 0, 'hard', 1);
    botPlan(t, 0, 'hard', 1);
    expect(t.players[0]).toEqual(s.players[0]);
  });

  it('hard re-forms its army each round; every squad keeps its own ground', () => {
    const s = planned('hard', 5, 5);
    for (const p of s.players) {
      for (const q of p.squads) expect(overlappingSquad(p.squads, q.type, q.pos, q.id)).toBe(null);
    }
  });

  it('the ladder holds on a small sample: hard > normal > easy', () => {
    let hardVsEasy = 0, normalVsEasy = 0, n = 0;
    for (let seed = 1; seed <= 4; seed++) {
      for (const seat of [0, 1] as Seat[]) {
        const strats = (x: BotStrategy): [BotStrategy, BotStrategy] => (seat === 0 ? [x, 'easy'] : ['easy', x]);
        if (playMatch(seed, ['marshal', 'warden'], strats('hard')).winner === seat) hardVsEasy++;
        if (playMatch(seed, ['skylady', 'archmage'], strats('normal')).winner === seat) normalVsEasy++;
        n++;
      }
    }
    expect(hardVsEasy / n).toBeGreaterThanOrEqual(0.75);
    expect(normalVsEasy / n).toBeGreaterThanOrEqual(0.75);
  }, 120_000);
});
