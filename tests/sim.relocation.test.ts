// Relocation and Muster (DESIGN §2): squads from earlier rounds are locked in place, Muster (instead of the round's
// unlock) relocates up to three, selling an older squad refunds nothing, and the "moved" intel is public information.
import { describe, expect, it } from 'vitest';
import {
  MUSTER_MOVES, MARCH_CAP, LOCKED_ERROR, applyBattle, applyIntent, botPlan, canMuster, forceReady, mirrorPos, newMatch, nextRound, relocatedSquads, relocationsLeft,
  simulateBattle, squadLocked, viewFor, UNITS,
} from '../src/sim/index.ts';
import { rollItem } from '../src/sim/loot.ts';
import { Rng } from '../src/sim/rng.ts';
import type { BotStrategy, Item, LordId, MatchState, Seat, Squad, UnitType, Vec2 } from '../src/sim/types.ts';

/** Fight the planned round and open the next planning phase. */
function fight(s: MatchState): void {
  forceReady(s);
  applyBattle(s, simulateBattle(s, { record: false }).result);
  if (s.phase === 'results') nextRound(s);
}
const at = (seat: Seat, p: Vec2): Vec2 => (seat === 0 ? p : mirrorPos(p));
const SPOTS: Vec2[] = [[1500, 3000], [3000, 3000], [5000, 3000], [6500, 3000], [1500, 1800], [3000, 1800], [5000, 1800], [6500, 1800]];

/**
 * A match in round `round` planning in which both seats hold `n` cheap squads deployed in round 1 (so all are locked)
 * and nothing else: built by playing round 1 for real and then stepping the round counter, so lastArmy is genuine.
 */
function lockedMatch(n = 5, lords: [LordId, LordId] = ['marshal', 'warden']): MatchState {
  const s = newMatch(11, lords);
  for (const seat of [0, 1] as Seat[]) {
    const p = s.players[seat];
    p.gold = 5000;
    p.deployLimit = 99;
    expect(applyIntent(s, seat, { t: 'move', squad: p.squads[0].id, pos: at(seat, [400, 500]) }).ok).toBe(true); // the Lord, out of the way
    const unit = p.unlocked.find((u) => UNITS[u].cost <= 200)!;
    for (let i = 0; i < n; i++) expect(applyIntent(s, seat, { t: 'deploy', unit, pos: at(seat, SPOTS[i]) })).toEqual({ ok: true });
  }
  fight(s);
  expect(s.phase).toBe('planning');
  expect(s.round).toBe(2);
  return s;
}
const olds = (s: MatchState, seat: Seat): Squad[] => s.players[seat].squads.filter((q) => squadLocked(q, s.round));

describe('relocation: squads from earlier rounds are locked', () => {
  it('a squad may be moved freely in the round it is deployed, and is locked from the next round on', () => {
    const s = newMatch(3, ['marshal', 'warden']);
    expect(applyIntent(s, 0, { t: 'deploy', unit: s.players[0].unlocked[0], pos: [3000, 3000] }).ok).toBe(true);
    const q = s.players[0].squads[1];
    expect(squadLocked(q, s.round)).toBe(false);
    expect(applyIntent(s, 0, { t: 'move', squad: q.id, pos: [5000, 2500] })).toEqual({ ok: true });
    expect(applyIntent(s, 0, { t: 'move', squad: q.id, pos: [2000, 2000], facing: 10 })).toEqual({ ok: true });
    fight(s);
    expect(squadLocked(q, s.round)).toBe(true);
    const r = applyIntent(s, 0, { t: 'move', squad: q.id, pos: [5000, 2500] });
    expect(r).toEqual({ ok: false, error: LOCKED_ERROR });
    expect(q.pos).toEqual([2000, 2000]);
    expect(q.facing).toBe(10);
  });

  it('the Lord always moves, and a squad bought this round moves beside locked ones', () => {
    const s = lockedMatch();
    const p = s.players[0];
    const lord = p.squads[0];
    expect(squadLocked(lord, s.round)).toBe(false);
    expect(applyIntent(s, 0, { t: 'move', squad: lord.id, pos: [4000, 800] })).toEqual({ ok: true });
    expect(applyIntent(s, 0, { t: 'move', squad: lord.id, pos: [700, 900] })).toEqual({ ok: true });
    p.deployLimit = 99;
    expect(applyIntent(s, 0, { t: 'deploy', unit: p.unlocked[0], pos: [4000, 900] }).ok).toBe(true);
    const fresh = p.squads[p.squads.length - 1];
    expect(applyIntent(s, 0, { t: 'move', squad: fresh.id, pos: [4000, 1000] })).toEqual({ ok: true });
    expect(relocatedSquads(p, s.round)).toEqual([]);
    expect(relocationsLeft(p, s.round)).toBe(0);
  });

  it('turning on the spot is free for a locked squad; a turn that also moves is refused', () => {
    const s = lockedMatch();
    const q = olds(s, 0)[0];
    const pos: Vec2 = [q.pos[0], q.pos[1]];
    expect(applyIntent(s, 0, { t: 'move', squad: q.id, pos, facing: 100 })).toEqual({ ok: true });
    expect(q.facing).toBe(100);
    expect(q.pos).toEqual(pos);
    expect(applyIntent(s, 0, { t: 'move', squad: q.id, pos: [pos[0] + 1, pos[1]], facing: 30 }).ok).toBe(false);
    expect(q.facing).toBe(100);
    expect(relocatedSquads(s.players[0], s.round)).toEqual([]);
  });

  it('the lock holds for both seats alike', () => {
    const s = lockedMatch();
    for (const seat of [0, 1] as Seat[]) {
      for (const q of olds(s, seat)) expect(applyIntent(s, seat, { t: 'move', squad: q.id, pos: at(seat, [4000, 900]) })).toEqual({ ok: false, error: LOCKED_ERROR });
    }
  });
});

describe('Muster', () => {
  it('is offered every round from round 2 instead of the unlock, and never in round 1', () => {
    const s = newMatch(3, ['marshal', 'warden']);
    expect(canMuster(s.players[0], s.round)).toBe(false);
    expect(applyIntent(s, 0, { t: 'muster' }).ok).toBe(false);
    const t = lockedMatch();
    for (const p of t.players) {
      expect(p.musterOffer).toBe(true);
      expect(p.muster).toBe(false);
      expect(p.moveLimit).toBe(0);
      expect(canMuster(p, t.round)).toBe(true);
    }
  });

  it('costs the round\'s unlock: after Muster nothing can be unlocked, and after an unlock Muster is refused', () => {
    const s = lockedMatch();
    const p = s.players[0];
    const before = [...p.unlocked];
    expect(p.draftPicks).toBe(1);
    const option = p.draftOptions[0];
    expect(applyIntent(s, 0, { t: 'muster' })).toEqual({ ok: true });
    expect(p.muster).toBe(true);
    expect(p.moveLimit).toBe(MUSTER_MOVES);
    expect(p.draftPicks).toBe(0);
    expect(p.draftOptions).toEqual([]);
    expect(applyIntent(s, 0, { t: 'draft', unit: option }).ok).toBe(false);
    expect(applyIntent(s, 0, { t: 'muster' }).ok).toBe(false); // once a round
    fight(s);
    expect(p.unlocked).toEqual(before); // the timer did not unlock anything behind the Muster either
    // the other seat unlocked instead (its pending pick resolved): it could not also muster
    const q = s.players[1];
    expect(q.unlocked.length).toBe(4);
    // next round the choice is back, and unlocking spends it
    expect(p.musterOffer).toBe(true);
    expect(p.muster).toBe(false);
    expect(p.moveLimit).toBe(0);
    expect(applyIntent(s, 0, { t: 'draft', unit: p.draftOptions[0] })).toEqual({ ok: true });
    expect(canMuster(p, s.round)).toBe(false);
    expect(applyIntent(s, 0, { t: 'muster' }).ok).toBe(false);
  });

  it('allows exactly three relocations: the fourth squad is refused', () => {
    const s = lockedMatch(5);
    const p = s.players[0];
    expect(applyIntent(s, 0, { t: 'muster' }).ok).toBe(true);
    const sq = olds(s, 0);
    expect(sq.length).toBe(5);
    const to: Vec2[] = [[1500, 900], [3000, 900], [5000, 900], [6500, 900]];
    for (let i = 0; i < 3; i++) {
      expect(relocationsLeft(p, s.round)).toBe(3 - i);
      expect(applyIntent(s, 0, { t: 'move', squad: sq[i].id, pos: to[i] })).toEqual({ ok: true });
    }
    expect(relocationsLeft(p, s.round)).toBe(0);
    expect(relocatedSquads(p, s.round)).toEqual([sq[0].id, sq[1].id, sq[2].id]);
    const r = applyIntent(s, 0, { t: 'move', squad: sq[3].id, pos: to[3] });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('relocations');
    expect(sq[3].pos).toEqual(SPOTS[3]);
  });

  it('a relocated squad may keep moving, and moving it home gives the relocation back', () => {
    const s = lockedMatch(5);
    const p = s.players[0];
    applyIntent(s, 0, { t: 'muster' });
    const sq = olds(s, 0);
    for (let i = 0; i < 3; i++) expect(applyIntent(s, 0, { t: 'move', squad: sq[i].id, pos: [1500 + 1500 * i, 900] }).ok).toBe(true);
    // again and again: still one relocation
    expect(applyIntent(s, 0, { t: 'move', squad: sq[0].id, pos: [1500, 1000] })).toEqual({ ok: true });
    expect(applyIntent(s, 0, { t: 'move', squad: sq[0].id, pos: [1600, 1000] })).toEqual({ ok: true });
    expect(relocationsLeft(p, s.round)).toBe(0);
    // home again: the relocation is free for another squad
    expect(applyIntent(s, 0, { t: 'move', squad: sq[0].id, pos: SPOTS[0] })).toEqual({ ok: true });
    expect(relocationsLeft(p, s.round)).toBe(1);
    expect(applyIntent(s, 0, { t: 'move', squad: sq[4].id, pos: [6500, 900] })).toEqual({ ok: true });
    expect(applyIntent(s, 0, { t: 'move', squad: sq[0].id, pos: [1500, 1000] }).ok).toBe(false);
    // with no relocation left a squad at home can still go nowhere, but going home is always allowed
    expect(applyIntent(s, 0, { t: 'move', squad: sq[1].id, pos: SPOTS[1] })).toEqual({ ok: true });
    expect(relocationsLeft(p, s.round)).toBe(1);
  });

  it('the relocations last one round: next round everything is locked again where it stands', () => {
    const s = lockedMatch(4);
    applyIntent(s, 0, { t: 'muster' });
    const q = olds(s, 0)[0];
    expect(applyIntent(s, 0, { t: 'move', squad: q.id, pos: [4000, 900] }).ok).toBe(true);
    fight(s);
    expect(s.players[0].moveLimit).toBe(0);
    expect(q.pos).toEqual([4000, 900]);
    expect(applyIntent(s, 0, { t: 'move', squad: q.id, pos: [4000, 1000] })).toEqual({ ok: false, error: LOCKED_ERROR });
    expect(relocatedSquads(s.players[0], s.round)).toEqual([]); // home is now the new spot
  });

  it('with nothing left to unlock, Muster is still offered (and costs nothing)', () => {
    const s = lockedMatch();
    fight(s);
    const p = s.players[0];
    // unlock the whole roster by hand
    p.unlocked.push(...p.draftOptions);
    p.draftOptions = [];
    p.draftPicks = 0;
    fight(s);
    expect(s.round).toBe(4);
    expect(p.draftOptions).toEqual([]); // the Dragon comes in round 5
    expect(p.draftPicks).toBe(0);
    expect(canMuster(p, s.round)).toBe(true);
    expect(applyIntent(s, 0, { t: 'muster' })).toEqual({ ok: true });
  });

  it('is refused while ready, and outside planning', () => {
    const s = lockedMatch();
    applyIntent(s, 0, { t: 'ready' });
    expect(applyIntent(s, 0, { t: 'muster' }).ok).toBe(false);
    expect(s.players[0].muster).toBe(false);
  });
});

describe("the 'of the March' relic", () => {
  const relic = (id: number): Item => ({ id, base: 'war_banner', slot: 'relic', rarity: 'rare', ilvl: 5, implicit: { id: 'fleet', value: 6 }, affixes: [{ id: 'marching', value: 1 }], legendary: null });
  it('gives one relocation a round without Muster, at most MARCH_CAP, and Muster adds its three on top', () => {
    const s = lockedMatch(5);
    const p = s.players[0];
    p.squads[0].items.relic = relic(9001); // worn by the Lord
    fight(s);
    expect(p.moveLimit).toBe(1);
    expect(p.muster).toBe(false);
    const sq = olds(s, 0);
    expect(applyIntent(s, 0, { t: 'move', squad: sq[0].id, pos: [1500, 900] })).toEqual({ ok: true });
    const r = applyIntent(s, 0, { t: 'move', squad: sq[1].id, pos: [3000, 900] });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('relocations');
    expect(applyIntent(s, 0, { t: 'muster' })).toEqual({ ok: true });
    expect(p.moveLimit).toBe(1 + MUSTER_MOVES);
    expect(relocationsLeft(p, s.round)).toBe(MUSTER_MOVES);
    // three relics are still two moves; the other seat, without one, has none
    for (const [i, q] of sq.slice(0, 2).entries()) { q.level = 3; q.items.relic = relic(9002 + i); }
    fight(s);
    expect(p.moveLimit).toBe(MARCH_CAP);
    expect(s.players[1].moveLimit).toBe(0);
  });
  it('rolls only on rare or better relics', () => {
    const rng = new Rng(5);
    let seen = 0, id = 1;
    for (let i = 0; i < 3000; i++) {
      const it = rollItem(rng, id++, 1 + (i % 10), (['magic', 'rare', 'legendary'] as const)[i % 3]);
      if (![it.implicit, ...it.affixes].some((a) => a.id === 'marching')) continue;
      seen++;
      expect(it.slot).toBe('relic');
      expect(['rare', 'legendary']).toContain(it.rarity);
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('selling is not a way round the lock', () => {
  it('a squad sold in its own round refunds everything; an older squad refunds nothing and gives no deploy points back', () => {
    const s = lockedMatch(2);
    const p = s.players[0];
    const old = olds(s, 0)[0];
    p.gold = 1000;
    p.deployLimit = 4;
    expect(applyIntent(s, 0, { t: 'levelUp', squad: old.id }).ok).toBe(true);
    const unit = p.unlocked.find((u) => UNITS[u].cost <= 200)!;
    expect(applyIntent(s, 0, { t: 'deploy', unit, pos: [4000, 900] }).ok).toBe(true);
    const fresh = p.squads[p.squads.length - 1];
    expect(applyIntent(s, 0, { t: 'levelUp', squad: fresh.id }).ok).toBe(true);
    const used = p.deploysUsed;
    expect(used).toBeGreaterThan(0);
    let gold = p.gold;
    // the old squad: nothing back, not even the level bought this round
    expect(applyIntent(s, 0, { t: 'sell', squad: old.id })).toEqual({ ok: true });
    expect(p.gold).toBe(gold);
    expect(p.deploysUsed).toBe(used);
    // this round's squad: all of it back, and its deploy points
    gold = p.gold;
    expect(applyIntent(s, 0, { t: 'sell', squad: fresh.id })).toEqual({ ok: true });
    expect(p.gold).toBe(gold + fresh.spent);
    expect(fresh.spent).toBeGreaterThan(UNITS[unit].cost);
    expect(p.deploysUsed).toBe(0);
  });

  it('selling and rebuying costs the full price and a deploy, and the new squad starts at level 1 with no items', () => {
    const s = lockedMatch(2);
    const p = s.players[0];
    const old = olds(s, 0)[0];
    old.level = 3;
    p.gold = 300;
    p.deployLimit = 4;
    const gold = p.gold;
    applyIntent(s, 0, { t: 'sell', squad: old.id });
    expect(applyIntent(s, 0, { t: 'deploy', unit: old.type as UnitType, pos: [4000, 900] }).ok).toBe(true);
    const again = p.squads[p.squads.length - 1];
    expect(p.gold).toBe(gold - UNITS[old.type as UnitType].cost);
    expect(again.level).toBe(1);
    expect(p.deploysUsed).toBeGreaterThan(0);
  });
});

describe('intel: which enemy squads moved', () => {
  it('lastMoved lists exactly the squads that stood elsewhere in the battle before, new squads excluded', () => {
    const s = lockedMatch(4);
    // round 2 view: the first battle has no battle before it
    expect(viewFor(s, 0).enemy.lastMoved).toEqual([]);
    const e = s.players[1];
    applyIntent(s, 1, { t: 'muster' });
    const sq = olds(s, 1);
    expect(applyIntent(s, 1, { t: 'move', squad: sq[1].id, pos: at(1, [4000, 900]) }).ok).toBe(true);
    expect(applyIntent(s, 1, { t: 'move', squad: e.squads[0].id, pos: at(1, [700, 700]) }).ok).toBe(true); // the Lord
    expect(applyIntent(s, 1, { t: 'move', squad: sq[2].id, pos: [sq[2].pos[0], sq[2].pos[1]], facing: 7 }).ok).toBe(true); // a turn is not a move
    e.deployLimit = 99;
    expect(applyIntent(s, 1, { t: 'deploy', unit: e.unlocked[0], pos: at(1, [4000, 2400]) }).ok).toBe(true);
    // hidden until the battle: the view still shows last round's army and no moves
    const hidden = viewFor(s, 0);
    expect(hidden.enemy.lastMoved).toEqual([]);
    expect(hidden.enemy.lastArmy!.find((q) => q.id === sq[1].id)!.pos).toEqual(at(1, SPOTS[1]));
    fight(s);
    const v = viewFor(s, 0);
    expect([...v.enemy.lastMoved!].sort((a, b) => a - b)).toEqual([e.squads[0].id, sq[1].id].sort((a, b) => a - b));
    // and next round, with nobody moving, the list is empty again
    fight(s);
    expect(viewFor(s, 0).enemy.lastMoved).toEqual([]);
  });

  it('is hidden-information safe: the enemy block shows nothing of this round\'s Muster or relocations', () => {
    const s = lockedMatch(4);
    fight(s);
    const before = viewFor(s, 0);
    const keys = Object.keys(before.enemy).sort();
    expect(keys).toEqual(['faction', 'keepHp', 'keepMax', 'lastArmy', 'lastMoved', 'lord', 'ready', 'seat']);
    expect(applyIntent(s, 1, { t: 'muster' }).ok).toBe(true);
    for (const [i, q] of olds(s, 1).slice(0, 3).entries()) expect(applyIntent(s, 1, { t: 'move', squad: q.id, pos: at(1, [1500 + 1500 * i, 900]) }).ok).toBe(true);
    const after = viewFor(s, 0);
    expect(after).toEqual(before);
    const json = JSON.stringify(after.enemy);
    for (const k of ['muster', 'moveLimit', 'musterOffer', 'draftOptions', 'gold']) expect(json).not.toContain(`"${k}"`);
    // a spectator sees no more than a player does
    const spec = viewFor(s, null);
    expect(spec.you).toBe(null);
    for (const e of spec.enemies!) expect(Object.keys(e).sort()).toEqual(keys);
    // the view is a copy
    after.enemy.lastMoved!.push(999);
    expect(s.players[1].lastMoved).not.toContain(999);
  });
});

describe('bots obey the lock', () => {
  const STRATS: BotStrategy[] = ['easy', 'normal', 'hard', 'counter', 'air'];
  it('no bot moves a locked squad without Muster, and never more than three with it', () => {
    let musters = 0, relocations = 0;
    for (const [k, strat] of STRATS.entries()) {
      for (const lords of [['marshal', 'lich'], ['sultana', 'skylady'], ['ossuary', 'rocrider']] as [LordId, LordId][]) {
        const s = newMatch(40 + k, lords);
        while (s.phase === 'planning' && s.round < 12) {
          const home = new Map<number, Vec2>();
          for (const p of s.players) for (const q of p.squads) if (squadLocked(q, s.round)) home.set(q.id, [q.pos[0], q.pos[1]]);
          botPlan(s, 0, strat, 1);
          botPlan(s, 1, 'hard', 2);
          for (const p of s.players) {
            const moved = p.squads.filter((q) => home.has(q.id) && (home.get(q.id)![0] !== q.pos[0] || home.get(q.id)![1] !== q.pos[1]));
            expect(moved.length).toBeLessThanOrEqual(p.moveLimit ?? 0);
            expect(p.moveLimit).toBeLessThanOrEqual((p.muster ? MUSTER_MOVES : 0) + MARCH_CAP);
            expect(moved.map((q) => q.id)).toEqual(relocatedSquads(p, s.round));
            if (p.muster) { musters++; relocations += moved.length; }
            expect(p.ready).toBe(true);
          }
          applyBattle(s, simulateBattle(s, { record: false }).result);
          if ((s.phase as string) !== 'results') break;
          nextRound(s);
        }
      }
    }
    // Hard does call Muster in ordinary play
    expect(musters).toBeGreaterThan(0);
    expect(relocations).toBeGreaterThanOrEqual(musters);
  }, 120_000);

  it('the move rule itself is seat-symmetric: mirrored intents get the same answers', () => {
    const s = lockedMatch(5, ['marshal', 'marshal']);
    const script: { t: 'muster' | 'move'; i?: number; pos?: Vec2 }[] = [
      { t: 'move', i: 0, pos: [1500, 900] }, { t: 'muster' }, { t: 'move', i: 0, pos: [1500, 900] }, { t: 'move', i: 1, pos: [3000, 900] },
      { t: 'move', i: 2, pos: [5000, 900] }, { t: 'move', i: 3, pos: [6500, 900] }, { t: 'move', i: 0, pos: SPOTS[0] }, { t: 'move', i: 3, pos: [6500, 900] },
    ];
    const answers: boolean[][] = [[], []];
    for (const seat of [0, 1] as Seat[]) {
      const sq = olds(s, seat);
      for (const st of script) answers[seat].push(applyIntent(s, seat, st.t === 'muster' ? { t: 'muster' } : { t: 'move', squad: sq[st.i!].id, pos: at(seat, st.pos!) }).ok);
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[0]).toEqual([false, true, true, true, true, false, true, true]);
    expect(s.players[1].squads.map((q) => q.pos)).toEqual(s.players[0].squads.map((q) => mirrorPos(q.pos)));
  });
});
