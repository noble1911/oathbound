// Relocation and Muster on the planning screen (src/ui/relocation.ts and the relocation-aware helpers in
// src/ui/timing.ts): what may be dragged, what Mirror / Sync / group moves leave in place, and that every move the
// client plans is one the sim accepts in order.
import { describe, expect, it } from 'vitest';
import { applyIntent, newMatch, MUSTER_MOVES } from '../src/sim/match.ts';
import { UNITS } from '../src/sim/data/units.ts';
import { groupPlace, planMoves, type Placed } from '../src/ui/timing.ts';
import { DEFAULT_FORMATION, formationIntent, formationOf, otherFormation } from '../src/ui/formation.ts';
import { dragRefusal, ghostMark, lockState, mirrorable, pinnedIn, relocCount, relocSource, targetsRefusal, type RelocMe } from '../src/ui/relocation.ts';
import { draftKey } from '../src/ui/loot.ts';
import type { MatchState, Squad, UnitType, Vec2 } from '../src/sim/types.ts';

const items = { weapon: null, armor: null, relic: null };
function sq(id: number, type: UnitType | 'lord', pos: Vec2, deployedRound: number): Squad {
  return { id, owner: 0, type, level: 1, pos, items: { ...items }, deployedRound, spent: type === 'lord' ? 0 : UNITS[type].cost };
}

/** Round 2 planning: a Lord, five squads from round 1 (locked, standing where they fought) and one bought this round. */
function round2(): MatchState {
  const s = newMatch(5, ['marshal', 'warden']);
  s.phase = 'planning';
  s.round = 2;
  const p = s.players[0];
  const old = [sq(1, 'lord', [4000, 600], 1), ...[0, 1, 2, 3, 4].map((i) => sq(10 + i, 'militia', [1200 + i * 1300, 3000], 1))];
  p.squads = [...old.map((q) => ({ ...q, pos: [q.pos[0], q.pos[1]] as Vec2 })), sq(20, 'knights', [4000, 1000], 2)];
  p.lastArmy = old.map((q) => ({ ...q, pos: [q.pos[0], q.pos[1]] as Vec2 }));
  p.musterOffer = true;
  p.muster = false;
  p.moveLimit = 0;
  p.ready = false;
  s.nextId = 100;
  return s;
}
const me = (s: MatchState): RelocMe => s.players[0];
const at = (s: MatchState, id: number) => s.players[0].squads.find((q) => q.id === id)!;
const send = (s: MatchState, targets: Map<number, Placed>) => {
  const out = planMoves(s.players[0].squads, targets, 0, { me: me(s), round: s.round });
  return out.map((i) => applyIntent(s, 0, i));
};

describe('locked squads', () => {
  it('only the Lord and this round\'s squads are free; locked ones refuse a drag with the reason', () => {
    const s = round2();
    expect(lockState(me(s), at(s, 1), 2)).toBe('free');
    expect(lockState(me(s), at(s, 20), 2)).toBe('free');
    expect(lockState(me(s), at(s, 10), 2)).toBe('locked');
    expect(dragRefusal(me(s), 1, 2)).toBeNull();
    expect(dragRefusal(me(s), 20, 2)).toBeNull();
    expect(dragRefusal(me(s), 10, 2)).toMatch(/Locked in place since round 1\. Its formation is still free to change; take Muster/);
  });

  it('a locked squad changes formation freely and stays put; a group drag leaves pinned squads exactly in place, snap on', () => {
    const s = round2();
    const home = [...at(s, 10).pos];
    // the formation is not a move: no relocation, no lock refusal, and the squad keeps its exact spot
    const other = otherFormation(DEFAULT_FORMATION);
    expect(applyIntent(s, 0, formationIntent(10, other))).toEqual({ ok: true });
    expect(formationOf(at(s, 10))).toBe(other);
    expect(at(s, 10).pos).toEqual(home);
    expect(relocCount(me(s), 2).used).toBe(0);
    expect(applyIntent(s, 0, formationIntent(10, DEFAULT_FORMATION))).toEqual({ ok: true });
    expect(at(s, 10).formation).toBeUndefined();
    const group = [at(s, 10), at(s, 11), at(s, 20)];
    const out = groupPlace(group, s.players[0].squads.filter((q) => !group.includes(q)), 0, [300, 0], 100, new Set([10, 11]))!;
    expect(out.get(10)!.pos).toEqual(at(s, 10).pos);
    expect(out.get(11)!.pos).toEqual(at(s, 11).pos);
    expect(out.get(20)!.pos[0] % 100).toBe(0);
    for (const r of send(s, out)) expect(r).toEqual({ ok: true });
  });

  it('a group drag moves only what may move unless the relocations cover every locked squad', () => {
    const s = round2();
    expect([...pinnedIn(me(s), [10, 11, 20], 2)].sort()).toEqual([10, 11]);
    expect(applyIntent(s, 0, { t: 'muster' })).toEqual({ ok: true });
    expect(pinnedIn(me(s), [10, 11, 20], 2).size).toBe(0);
    expect([...pinnedIn(me(s), [10, 11, 12, 13], 2)].sort()).toEqual([10, 11, 12, 13]);
  });

  it('Mirror moves the Lord, this round\'s squads and relocated ones', () => {
    const s = round2();
    expect(mirrorable(me(s), 2).map((q) => q.id).sort((a, b) => a - b)).toEqual([1, 20]);
  });
});

describe('Muster', () => {
  it('three relocations, the fourth refused before it is sent, and a move home frees one', () => {
    const s = round2();
    expect(targetsRefusal(me(s), new Map([[10, { pos: [1200, 2200] as Vec2 }]]), 2)).toMatch(/Locked in place/);
    expect(applyIntent(s, 0, { t: 'muster' })).toEqual({ ok: true });
    expect(relocCount(me(s), 2)).toEqual({ used: 0, limit: MUSTER_MOVES, left: MUSTER_MOVES });
    for (const id of [10, 11, 12]) {
      const t = new Map([[id, { pos: [at(s, id).pos[0], 2200] as Vec2 }]]);
      expect(targetsRefusal(me(s), t, 2)).toBeNull();
      for (const r of send(s, t)) expect(r).toEqual({ ok: true });
    }
    expect(relocCount(me(s), 2).left).toBe(0);
    expect(lockState(me(s), at(s, 10), 2)).toBe('relocated');
    expect(dragRefusal(me(s), 10, 2)).toBeNull();
    expect(dragRefusal(me(s), 13, 2)).toBe('All 3 relocations used: move one back to free a move');
    const fourth = new Map([[13, { pos: [at(s, 13).pos[0], 2200] as Vec2 }]]);
    expect(targetsRefusal(me(s), fourth, 2)).toMatch(/All 3 relocations used/);
    // a relocated squad moves again for free; sending one home (an undo) frees its move
    for (const r of send(s, new Map([[10, { pos: [1400, 2000] as Vec2 }]]))) expect(r).toEqual({ ok: true });
    for (const r of send(s, new Map([[10, { pos: [1200, 3000] as Vec2 }]]))) expect(r).toEqual({ ok: true });
    expect(relocCount(me(s), 2).left).toBe(1);
    expect(targetsRefusal(me(s), fourth, 2)).toBeNull();
  });

  it('a swap of homes and new spots is ordered so each move is legal at its step', () => {
    const s = round2();
    applyIntent(s, 0, { t: 'muster' });
    for (const id of [10, 11, 12]) send(s, new Map([[id, { pos: [at(s, id).pos[0], 2200] as Vec2 }]]));
    // 10 goes home and 13 leaves in one plan: the home move must go first
    const t = new Map<number, Placed>([[13, { pos: [at(s, 13).pos[0], 2200] }], [10, { pos: [1200, 3000] }]]);
    expect(targetsRefusal(me(s), t, 2)).toBeNull();
    for (const r of send(s, t)) expect(r).toEqual({ ok: true });
    expect(at(s, 13).pos).toEqual([at(s, 13).pos[0], 2200]);
  });

  it('the recruit picker is rebuilt when Muster comes or goes, and the HUD names where moves come from', () => {
    const s = round2();
    const p = s.players[0];
    p.draftOptions = ['archers'];
    p.draftPicks = 1;
    const with_ = draftKey(p, 2);
    p.musterOffer = false;
    expect(draftKey(p, 2)).not.toBe(with_);
    expect(relocSource({ moveLimit: 3, muster: true })).toBe('Muster');
    expect(relocSource({ moveLimit: 1, muster: false })).toBe('of the March');
    expect(relocSource({ moveLimit: 5, muster: true })).toBe('Muster + of the March');
  });
});

describe('enemy intel marks', () => {
  it('moved, new last round (from round 3), never the Lord', () => {
    expect(ghostMark({ id: 5, type: 'militia', deployedRound: 1 }, [5], 3)).toBe('moved');
    expect(ghostMark({ id: 6, type: 'militia', deployedRound: 2 }, [], 3)).toBe('new');
    expect(ghostMark({ id: 6, type: 'militia', deployedRound: 1 }, [], 2)).toBeNull();
    expect(ghostMark({ id: 1, type: 'lord', deployedRound: 1 }, [1], 3)).toBeNull();
    expect(ghostMark({ id: 7, type: 'militia', deployedRound: 1 }, undefined, 4)).toBeNull();
  });
});
