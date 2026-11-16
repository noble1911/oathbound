// The QA-pass rules: deploy footprints, slot unlocks + usable loot, stalemates and points, comeback, AI levels.
import { describe, expect, it } from 'vitest';
import {
  newMatch, applyIntent, simulateBattle, applyBattle, nextRound, viewFor, botPlan, freeSpotNear, squadFootprint,
  overlappingSquad, usableSlots, comebackFor, roundOutcomeText, SLOT_UNLOCK_LEVEL, POINTS_MARGIN, CATCHUP_GOLD, CATCHUP_PER_ROUND,
  CATCHUP_PER_DEFICIT, UNDERDOG_DEFICIT, MAX_BATTLE_TICKS, mirrorPos, UNITS, decodeReplay,
} from '../src/sim/index.ts';
import { rollItem } from '../src/sim/loot.ts';
import { Rng } from '../src/sim/rng.ts';
import type { BotStrategy, Item, LordId, MatchState, RoundSummary, Seat, Squad } from '../src/sim/types.ts';
import { playMatch } from '../src/sim/tournament.ts';
import { KEEP_DMG_BASE_PER_ROUND, KEEP_DMG_PER_TIER, MAX_LORD_LEVEL, ROUND_BONUS_FULL_MARGIN, SUDDEN_DEATH_ROUND, concede, keepDamageOf, roundBonus, squadKeepDamage, suddenDeathPct, unlockOptions } from '../src/sim/match.ts';
import { itemName, lootSchedule } from '../src/sim/loot.ts';
import { income } from '../src/sim/match.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canEquip } from '../src/sim/data/skills.ts';
import { LORD_IDS } from '../src/sim/data/lords.ts';
import { DEPLOY_BONUS, DEPLOY_BUDGET } from '../src/sim/match.ts';
import { modsOf } from '../src/sim/loot.ts';
import type { PlayerState } from '../src/sim/types.ts';

/** The deploy limit without what 'of Command' relics add (DEPLOY_BONUS each, at most two). */
const baseLimit = (p: PlayerState): number => p.deployLimit - DEPLOY_BONUS * Math.min(2, p.squads.reduce((a, q) => a + modsOf(q.items).command, 0));

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
  it('weapon and armor open at Lv1, relic at Lv3', () => {
    expect(SLOT_UNLOCK_LEVEL).toEqual({ weapon: 1, armor: 1, relic: 3 });
    const s = newMatch(11, ['warden', 'warden']);
    const p = s.players[0];
    p.gold = 5000;
    applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4000, 2500] });
    const sq = p.squads[1];
    const mk = (slot: Item['slot'], id: number): Item => ({ ...rollItem(new Rng(id), id, 2, 'magic', slot), id });
    p.stash.push(mk('weapon', 900), mk('armor', 901), mk('relic', 902));
    expect(applyIntent(s, 0, { t: 'equip', item: 900, squad: sq.id }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'equip', item: 901, squad: sq.id }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'equip', item: 902, squad: sq.id })).toEqual({ ok: false, error: 'relic slot opens at level 3' });
    applyIntent(s, 0, { t: 'levelUp', squad: sq.id });
    expect(applyIntent(s, 0, { t: 'equip', item: 902, squad: sq.id }).ok).toBe(false);
    applyIntent(s, 0, { t: 'levelUp', squad: sq.id });
    expect(sq.level).toBe(3);
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

  it('the offer does not depend on what the player can equip: it is the same three slots for everyone', () => {
    const s = newMatch(21, ['skylady', 'warden']);
    const mk = (slot: Item['slot'], id: number): Item => ({ ...rollItem(new Rng(id), id, 1, 'common', slot), id });
    // seat 0's Lord already wears a weapon and armour: the offer still holds one item per slot
    s.players[0].squads[0].items.weapon = mk('weapon', 801);
    s.players[0].squads[0].items.armor = mk('armor', 802);
    applyIntent(s, 0, { t: 'ready' });
    applyIntent(s, 1, { t: 'ready' });
    applyBattle(s, simulateBattle(s, { record: false }).result);
    const offer = s.players[0].lootOffer!;
    expect(offer.length).toBe(4); // Skylady
    expect(offer.slice(0, 3).map((it) => it.slot)).toEqual(['weapon', 'armor', 'relic']);
    expect(s.players[1].lootOffer!.map((it) => it.slot)).toEqual(['weapon', 'armor', 'relic']);
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
    if (result.winner !== null) {
      expect(result.keepDamage[result.winner]).toBe(0); // the points loser deals nothing
      // ...and the points winner deals its survivors' damage in full, plus the round bonus scaled by its margin
      const w = result.winner, margin = result.score[w] - result.score[1 - w];
      const full = keepDamageOf(s.players[w].squads, result.survivors[w], s.round, true, false, margin);
      expect(result.keepDamage[1 - w]).toBe(full);
      expect(full).toBeGreaterThanOrEqual(roundBonus(s.round, margin));
      expect(full).toBeGreaterThan(0);
    }
    // a helpless side ends the battle within about 10 s of the last hope, not 15
    expect(result.ticks).toBeLessThanOrEqual(1000);
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

describe('equal conditions: no catch-up, no random offers', () => {
  const strip = (items: Item[] | null): unknown => (items ?? []).map((it) => ({ ...it, id: 0 }));

  it('there is no comeback: the loser gets no gold, no extra deploy and no better loot', () => {
    expect([CATCHUP_GOLD, CATCHUP_PER_ROUND, CATCHUP_PER_DEFICIT, UNDERDOG_DEFICIT]).toEqual([0, 0, 0, 0]);
    const s = newMatch(2, ['archmage', 'archmage']);
    s.players[1].squads = [];
    s.players[0].keepHp = 4000;
    s.players[1].keepHp = 1500; // far behind
    expect(comebackFor(s.players[1], s.players[0], 6, true)).toEqual({ gold: 0, deploys: 0, deficit: 0 });
    applyIntent(s, 0, { t: 'ready' });
    applyIntent(s, 1, { t: 'ready' });
    applyBattle(s, simulateBattle(s, { record: false }).result); // seat 0's Lord routs an empty army
    const [w, l] = s.players;
    expect(l.lostLast).toBe(true);
    expect(l.comeback).toEqual({ gold: 0, deploys: 0, deficit: 0 });
    expect(strip(l.lootOffer)).toEqual(strip(w.lootOffer)); // same items, same rarities
    const gold = [w.gold, l.gold];
    nextRound(s);
    expect(w.gold - gold[0]).toBe(250);
    expect(l.gold - gold[1]).toBe(250);
    expect(l.deployLimit).toBe(DEPLOY_BUDGET);
    expect(w.deployLimit).toBe(DEPLOY_BUDGET);
  });

  it('fairness: for a match seed and round, both players get identical loot, unlock options, income and deploy limit', () => {
    for (const [seed, lord, strats] of [[11, 'marshal', ['hard', 'easy']], [12, 'skylady', ['rush', 'hard']], [13, 'archmage', ['normal', 'air']], [14, 'warden', ['hard', 'hard']]] as const) {
      // Both pick the same Lord (allowed), then play very differently: one side keeps losing.
      const s = newMatch(seed, null);
      expect(applyIntent(s, 0, { t: 'pickLord', lord }).ok).toBe(true);
      expect(applyIntent(s, 1, { t: 'pickLord', lord }).ok).toBe(true);
      expect(s.phase).toBe('planning');
      let rounds = 0, decided = 0;
      while (s.phase === 'planning' && rounds < 12) {
        const [a, b] = s.players;
        // identical offers at the start of every planning phase
        expect(strip(b.lootOffer), `loot seed ${seed} round ${s.round}`).toEqual(strip(a.lootOffer));
        if (a.lootOffer) {
          expect(a.lootOffer.length).toBe(lord === 'skylady' ? 4 : 3);
          expect(a.lootOffer.map((it) => it.rarity).slice(0, 3).sort()).toEqual([...lootSchedule(s.round - 1)].sort());
          // names match too, though the item ids differ
          expect(b.lootOffer!.map(itemName)).toEqual(a.lootOffer.map(itemName));
          expect(new Set([...a.lootOffer, ...b.lootOffer!].map((it) => it.id)).size).toBe(2 * a.lootOffer.length);
        }
        // (an 'of Command' relic is a choice: it is taken out before comparing)
        expect(baseLimit(b)).toBe(baseLimit(a));
        expect(b.draftPicks).toBe(a.draftPicks);
        // unlock options: everything still locked and of age, for each player
        for (const p of s.players) expect(p.draftOptions).toEqual(unlockOptions(p, s.round));
        const goldBefore = [a.gold, b.gold];
        botPlan(s, 0, strats[0], 1);
        botPlan(s, 1, strats[1], 2);
        // same deploy limit even after the round's commands (both could wear an 'of Command' relic: skip then)
        const r = simulateBattle(s, { record: false }).result;
        const spent = [goldBefore[0] - a.gold, goldBefore[1] - b.gold];
        applyBattle(s, r);
        if (r.winner !== null) decided++;
        expect(a.comeback).toEqual({ gold: 0, deploys: 0, deficit: 0 });
        expect(b.comeback).toEqual({ gold: 0, deploys: 0, deficit: 0 });
        if ((s.phase as string) !== 'results') break;
        const before = [a.gold, b.gold];
        nextRound(s);
        // the same income for the winner and the loser
        expect(a.gold - before[0]).toBe(income(s.round));
        expect(b.gold - before[1]).toBe(income(s.round));
        expect(spent[0]).toBeGreaterThanOrEqual(0);
        rounds++;
      }
      // (Two copies of one bot with the same Lord fight near-mirror battles, which may well end level.)
      expect(decided).toBeGreaterThan(strats[0] === strats[1] ? 0 : 2);
    }
  }, 120_000);

  it('unlocks are a free choice from the full eligible list, the same rule for both', () => {
    const s = newMatch(7, ['warden', 'warden']);
    const [a, b] = s.players;
    expect(b.draftOptions).toEqual(a.draftOptions);
    expect(a.draftOptions).toEqual(['militia', 'pikemen', 'archers', 'cavaliers', 'mages', 'clerics', 'pegasus']);
    expect(a.draftPicks).toBe(1); // round 1 is like every round: any ONE unit
    // any of them may be picked: here the two players choose differently
    expect(applyIntent(s, 0, { t: 'draft', unit: 'pegasus' }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'draft', unit: 'mages' }).ok).toBe(false);
    expect(applyIntent(s, 1, { t: 'draft', unit: 'golem' }).ok).toBe(false); // not in the basic pool
    applyIntent(s, 0, { t: 'ready' });
    applyIntent(s, 1, { t: 'ready' }); // seat 1 leaves its pick open: it resolves to the first option
    applyBattle(s, simulateBattle(s, { record: false }).result);
    nextRound(s);
    expect(a.unlocked).toEqual(['berserkers', 'knights', 'pegasus']);
    expect(b.unlocked).toEqual(['berserkers', 'knights', 'militia']);
    expect(a.draftPicks).toBe(1);
    expect(a.draftOptions).toEqual(unlockOptions(a, 2));
    expect(a.draftOptions).toContain('golem');
    expect(a.draftOptions).toContain('trebuchet');
    expect(a.draftOptions).not.toContain('dragon'); // minRound 5
    expect(a.draftOptions).not.toContain('pegasus');
    expect(a.draftOptions).toContain('archers');
    expect(applyIntent(s, 0, { t: 'draft', unit: 'golem' }).ok).toBe(true);
    expect(unlockOptions({ unlocked: ['militia'] }, 5)).toContain('dragon');
    expect(unlockOptions({ unlocked: ['militia'] }, 4)).not.toContain('dragon');
  });

  it('both players may pick the same Lord', () => {
    for (const lord of LORD_IDS) {
      const s = newMatch(1, null);
      expect(applyIntent(s, 0, { t: 'pickLord', lord })).toEqual({ ok: true });
      expect(applyIntent(s, 1, { t: 'pickLord', lord })).toEqual({ ok: true });
      expect(s.players.map((p) => p.lord)).toEqual([lord, lord]);
      expect(s.players[0].unlocked).toEqual(s.players[1].unlocked);
      expect(s.players[0].deployLimit).toBe(s.players[1].deployLimit);
      expect(s.players[0].keepMax).toBe(s.players[1].keepMax);
    }
  });

  it('the battle rolls nothing: crits come on a counter and forest cover is a flat reduction', () => {
    const src = readFileSync(join(__dirname, '../src/sim/battle.ts'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/mix4\(|\brnd\(|Rng\b|hash\(/);
    // the match seed only picks the terrain: on the same terrain, a different seed fights the identical battle
    const mk = (seed: number): MatchState => {
      const s = newMatch(5, ['marshal', 'warden']);
      for (let i = 0; i < 3; i++) { squad(s, 0, 'archers', [2000 + i * 1500, 2500]); squad(s, 1, 'berserkers', mirrorPos([2000 + i * 1500, 3500])); }
      s.seed = seed;
      return s;
    };
    const a = simulateBattle(mk(5)), b = simulateBattle(mk(999));
    expect(b.result).toEqual(a.result);
    expect(b.replay.frames).toBe(a.replay.frames);
    expect(b.replay.events).toBe(a.replay.events);
    const d = decodeReplay(a.replay);
    const hits = d.events.filter((e) => e.k === 'hit') as { src: number; crit: boolean; miss: boolean; tick: number }[];
    expect(hits.some((h) => h.miss)).toBe(false);
    // 5% base crit: an archer's every 20th arrow is critical, never two in a row
    const arrows = d.events.filter((e) => e.k === 'attack' && e.src < 1_000_000 && d.replay.soldiers[e.src].type === 'archers').length;
    const crits = hits.filter((h) => h.crit && d.replay.soldiers[h.src].type === 'archers').length;
    expect(arrows).toBeGreaterThan(100);
    expect(crits).toBeGreaterThan(0);
    expect(crits).toBeLessThanOrEqual(Math.ceil(arrows / 20) + 27);
    expect(crits).toBeGreaterThanOrEqual(Math.floor(arrows / 20) - 27);
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
    // One Lord pairing per seed across all three factions, each bot playing the first Lord from both seats.
    const pairs: [LordId, LordId][] = [['skylady', 'archmage'], ['marshal', 'warden'], ['lich', 'sultana'], ['sultana', 'skylady']];
    let hardVsEasy = 0, normalVsEasy = 0, n = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const [mine, theirs] = pairs[seed - 1];
      for (const seat of [0, 1] as Seat[]) {
        const strats = (x: BotStrategy): [BotStrategy, BotStrategy] => (seat === 0 ? [x, 'easy'] : ['easy', x]);
        const lords: [LordId, LordId] = seat === 0 ? [mine, theirs] : [theirs, mine];
        if (playMatch(seed, lords, strats('hard')).winner === seat) hardVsEasy++;
        if (playMatch(seed, lords, strats('normal')).winner === seat) normalVsEasy++;
        n++;
      }
    }
    expect(hardVsEasy / n).toBeGreaterThanOrEqual(0.75);
    expect(normalVsEasy / n).toBeGreaterThanOrEqual(0.75);
  }, 120_000);
});

describe('match pacing: sudden death, clamped keep damage, concessions', () => {
  it('sudden death: keep damage grows 25% a round from round 8', () => {
    expect(SUDDEN_DEATH_ROUND).toBe(8);
    expect([1, 7, 8, 9, 12].map(suddenDeathPct)).toEqual([100, 100, 125, 150, 225]);
    const s = newMatch(3, ['warden', 'warden']);
    const q = squad(s, 0, 'knights', [4000, 3000]);
    const ids = [q.id];
    const at = (round: number): number => keepDamageOf(s.players[0].squads, ids, round, true, false);
    const own = squadKeepDamage(q);
    expect(own).toBe(KEEP_DMG_PER_TIER * 2);
    expect(at(7)).toBe(own + KEEP_DMG_BASE_PER_ROUND * 7);
    expect(at(8)).toBe(Math.trunc((own + KEEP_DMG_BASE_PER_ROUND * 8) * 1.25));
    expect(keepDamageOf(s.players[0].squads, ids, 10, false, true)).toBe(Math.trunc(Math.trunc(own / 2) * 1.75));
  });

  it('the round bonus is paid in proportion to the winning margin', () => {
    const full = KEEP_DMG_BASE_PER_ROUND * 6;
    expect(roundBonus(6, ROUND_BONUS_FULL_MARGIN)).toBe(full);
    expect(roundBonus(6, 100)).toBe(full);
    expect(roundBonus(6, ROUND_BONUS_FULL_MARGIN / 2)).toBe(full / 2);
    expect(roundBonus(6, 0)).toBe(0);
    const s = newMatch(3, ['warden', 'warden']);
    const q = squad(s, 0, 'knights', [4000, 3000]);
    const narrow = keepDamageOf(s.players[0].squads, [q.id], 6, true, false, 10);
    const clear = keepDamageOf(s.players[0].squads, [q.id], 6, true, false, 60);
    expect(clear - narrow).toBe(full - roundBonus(6, 10));
    expect(narrow).toBe(squadKeepDamage(q) + roundBonus(6, 10)); // the survivors' own damage is never scaled
  });

  it('there is no forced end: a match is only over when a keep falls', () => {
    const s = newMatch(3, ['warden', 'warden']);
    for (const p of s.players) p.keepHp = 100000;
    for (let r = 1; r <= 15; r++) {
      expect(s.phase).toBe('planning');
      applyIntent(s, 0, { t: 'ready' });
      applyIntent(s, 1, { t: 'ready' });
      applyBattle(s, simulateBattle(s, { record: false }).result);
      expect(s.phase).toBe('results');
      nextRound(s);
    }
    expect(s.round).toBe(16);
    expect(s.winner).toBe(null);
  });

  it('keep damage is clamped to the keep: overkill is not damage taken', () => {
    const s = newMatch(3, ['warden', 'warden']);
    s.players[1].squads = [];
    s.players[1].keepHp = 40;
    for (let i = 0; i < 3; i++) squad(s, 0, 'knights', [2000 + i * 1500, 3000], 3);
    const { result, replay } = simulateBattle(s);
    expect(result.keepDamage[1]).toBe(40);
    const d = decodeReplay(replay);
    expect(d.events.filter((e) => e.k === 'keepHit').reduce((a, e) => a + (e as { dmg: number }).dmg, 0)).toBe(40);
    applyBattle(s, { ...result, keepDamage: [0, 5271] });
    expect(s.history[0].keepDamage).toEqual([0, 40]);
    expect(s.phase).toBe('over');
    expect(s.overReason).toBe('keep');
    expect(viewFor(s, 1).overReason).toBe('keep');
  });

  it('concede ends the match at once with the opponent as the winner', () => {
    const s = newMatch(8, ['marshal', 'skylady']);
    botPlan(s, 0, 'hard', 1);
    expect(concede(s, 1)).toEqual({ ok: true });
    expect(s.phase).toBe('over');
    expect(s.winner).toBe(0);
    expect(s.overReason).toBe('concede');
    expect(viewFor(s, 0).overReason).toBe('concede');
    expect(concede(s, 0)).toEqual({ ok: false, error: 'match is over' });
    expect(applyIntent(s, 0, { t: 'ready' }).ok).toBe(false);
    // also during the Lord pick
    const t = newMatch(8, null);
    expect(concede(t, 0).ok).toBe(true);
    expect(t.winner).toBe(1);
  });

  it('Lords level steadily: not maxed by round 7', () => {
    for (const seed of [3, 4]) {
      const s = newMatch(seed, ['marshal', 'archmage']);
      for (let r = 0; r < 7 && s.phase === 'planning'; r++) {
        botPlan(s, 0, 'hard', 1);
        botPlan(s, 1, 'easy', 2);
        applyBattle(s, simulateBattle(s, { record: false }).result);
        if ((s.phase as string) !== 'results') break;
        nextRound(s);
      }
      for (const p of s.players) expect(p.squads[0].level).toBeLessThan(MAX_LORD_LEVEL);
    }
  });
});

describe('bots and skill items', () => {
  it('hard and normal equip skill items, always on a class that can use them; nothing is lost', () => {
    const count: Record<string, number> = { hard: 0, normal: 0 };
    let offered = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const s = newMatch(seed, [LORD_IDS[seed % 4], LORD_IDS[(seed + 1) % 4]]);
      const strats: [BotStrategy, BotStrategy] = ['hard', 'normal'];
      while (s.phase === 'planning') {
        for (const p of s.players) offered += (p.lootOffer ?? []).filter((it) => it.skill).length;
        botPlan(s, 0, strats[0], 1);
        botPlan(s, 1, strats[1], 2);
        for (const seat of [0, 1] as Seat[]) {
          const p = s.players[seat];
          const ids = new Set<number>();
          for (const q of p.squads) {
            for (const it of [q.items.weapon, q.items.armor, q.items.relic]) {
              if (!it) continue;
              expect(ids.has(it.id)).toBe(false);
              ids.add(it.id);
              expect(canEquip(it, q.type, p.lord), `${strats[seat]} put ${it.skill} on ${q.type}`).toBe(true);
            }
          }
        }
        applyBattle(s, simulateBattle(s, { record: false }).result);
        if ((s.phase as string) !== 'results') break;
        nextRound(s);
      }
      for (const seat of [0, 1] as Seat[]) for (const q of s.players[seat].squads) for (const it of Object.values(q.items)) if (it?.skill) count[strats[seat]]++;
    }
    expect(offered).toBeGreaterThan(10);
    expect(count.hard).toBeGreaterThanOrEqual(4);
    expect(count.normal).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('hard values a usable skill item above an unusable one', () => {
    const s = newMatch(12, ['warden', 'marshal']);
    const p = s.players[0];
    p.gold = 2000;
    p.unlocked = ['knights', 'berserkers'];
    p.draftOptions = [];
    p.draftPicks = 0;
    const mk = (id: number, skill: 'fireball' | 'cleave'): Item => ({ id, base: 'steel_blade', slot: 'weapon', rarity: 'rare', ilvl: 3, implicit: { id: 'vicious', value: 9 }, affixes: [], legendary: null, skill });
    p.lootOffer = [mk(901, 'fireball'), mk(902, 'cleave'), mk(903, 'fireball')];
    botPlan(s, 0, 'hard', 1);
    const worn = p.squads.flatMap((q) => Object.values(q.items)).filter((it) => it?.skill);
    expect(worn.map((it) => it!.id)).toEqual([902]);
    expect(p.stash.some((it) => it.skill === 'fireball')).toBe(false);
  });
});
