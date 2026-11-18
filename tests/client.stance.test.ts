// The Lord's stance on the planning screen (src/ui/stance.ts): what the control shows (a pending stance first, a
// follow of a squad that is gone as an advance), the leash and follow spot the field markers draw (the sim's own
// numbers), the intents it sends (accepted by the sim), and the intel line on the enemy Lord's ghost.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FOLLOW_BEHIND, HOLD_LEASH, HOLD_WATCH, buildStats } from '../src/sim/battle.ts';
import { applyIntent, lordStance, newMatch } from '../src/sim/match.ts';
import { UNITS } from '../src/sim/data/units.ts';
import type { LordStance, Seat, Squad, UnitType, Vec2 } from '../src/sim/types.ts';
import { RANGED_LEASH_PLUS, followSpot, followable, ghostStanceText, sameStance, shownStance, stanceIntent, stanceLeash, stanceLine, stanceMarker, stanceTip } from '../src/ui/stance.ts';

const items = { weapon: null, armor: null, relic: null };
function sq(id: number, type: UnitType | 'lord', pos: Vec2, stance?: LordStance, owner: Seat = 0): Squad {
  return { id, owner, type, level: 1, pos, items: { ...items }, deployedRound: 1, spent: type === 'lord' ? 0 : UNITS[type].cost, ...(stance ? { stance } : {}) };
}
const army = (st?: LordStance): Squad[] => [sq(1, 'lord', [4000, 1200], st), sq(10, 'knights', [3000, 3400]), sq(11, 'archers', [5000, 2600])];

describe('the stance shown', () => {
  it('is Advance by default, the snapshot otherwise, and a pending one wins', () => {
    expect(shownStance(army(), null)).toEqual({ t: 'advance' });
    expect(shownStance(army({ t: 'hold' }), null)).toEqual({ t: 'hold' });
    expect(shownStance(army({ t: 'hold' }), { t: 'follow', squad: 10 })).toEqual({ t: 'follow', squad: 10 });
  });
  it('a follow of a squad that is not there (sold) is an advance, as in the sim', () => {
    const a = army({ t: 'follow', squad: 99 });
    expect(shownStance(a, null)).toEqual({ t: 'advance' });
    expect(lordStance({ squads: a })).toEqual({ t: 'advance' });
    expect(shownStance(army(), { t: 'follow', squad: 1 })).toEqual({ t: 'advance' });
  });
  it('the squads to follow are mine and not the Lord', () => {
    expect(followable(army()).map((q) => q.id)).toEqual([10, 11]);
  });
  it('sameStance compares the kind and the squad followed', () => {
    expect(sameStance({ t: 'hold' }, { t: 'hold' })).toBe(true);
    expect(sameStance({ t: 'follow', squad: 1 }, { t: 'follow', squad: 2 })).toBe(false);
    expect(sameStance({ t: 'advance' }, { t: 'hold' })).toBe(false);
  });
});

describe('the leash and the follow spot (the sim numbers)', () => {
  it('following, a melee Lord is leashed at HOLD_LEASH, a ranged one at his range + 3 m', () => {
    expect(stanceLeash(sq(1, 'lord', [0, 0]), 'marshal')).toBe(HOLD_LEASH);
    const mage = buildStats(sq(1, 'lord', [0, 0]), 'archmage');
    expect(mage.ranged).toBe(true);
    expect(stanceLeash(sq(1, 'lord', [0, 0]), 'archmage')).toBe(mage.range + RANGED_LEASH_PLUS);
    expect(stanceLeash(sq(1, 'lord', [0, 0]), 'archmage')).toBeGreaterThan(HOLD_LEASH);
  });
  it('the sim adds the same 3 m to a ranged Lord\'s leash', () => {
    const src = fs.readFileSync(new URL('../src/sim/battle.ts', import.meta.url), 'utf8');
    expect(src).toMatch(new RegExp(`st\\.ranged \\? st\\.range \\+ ${RANGED_LEASH_PLUS} : HOLD_LEASH`));
  });
  it('the follow spot is FOLLOW_BEHIND behind the squad, towards its own Keep', () => {
    expect(followSpot({ pos: [3000, 3400] }, 0)).toEqual([3000, 3400 - FOLLOW_BEHIND]);
    expect(followSpot({ pos: [3000, 8600] }, 1)).toEqual([3000, 8600 + FOLLOW_BEHIND]);
    expect(followSpot({ pos: [3000, 200] }, 0)[1]).toBe(0);
  });
});

describe('the field markers', () => {
  it('nothing for Advance; the watch ring round the Lord for Hold (any Lord); a tether to the spot behind the squad for Follow', () => {
    expect(stanceMarker({ t: 'advance' }, army(), 'marshal', 0, true)).toBeNull();
    const h = stanceMarker({ t: 'hold' }, army(), 'marshal', 0, false)!;
    expect(h).toMatchObject({ kind: 'hold', lord: [4000, 1200], post: [4000, 1200], leash: HOLD_WATCH, focus: false });
    expect(h.label).toBe(`Hold · watches ${HOLD_WATCH / 100}\u00a0m`);
    expect(stanceMarker({ t: 'hold' }, army(), 'archmage', 0, false)!.leash).toBe(HOLD_WATCH);
    const f = stanceMarker({ t: 'follow', squad: 10 }, army(), 'marshal', 0, true)!;
    expect(f).toMatchObject({ kind: 'follow', lord: [4000, 1200], post: [3000, 3400 - FOLLOW_BEHIND], lead: [3000, 3400], focus: true });
    expect(f.label).toBe('Follow Knights');
    expect(stanceMarker({ t: 'follow', squad: 99 }, army(), 'marshal', 0, true)).toBeNull();
  });
  it('words come from the same numbers', () => {
    expect(stanceTip('hold', HOLD_LEASH)).toContain(`within ${HOLD_WATCH / 100}\u00a0m`);
    expect(stanceTip('follow', HOLD_LEASH)).toContain(`within ${HOLD_LEASH / 100}\u00a0m`);
    expect(stanceTip('follow', HOLD_LEASH)).toContain(`${FOLLOW_BEHIND / 100}\u00a0m behind`);
    expect(stanceLine({ t: 'follow', squad: 10 }, army(), HOLD_LEASH)).toMatch(/^Follows Knights, 6\u00a0m behind/);
  });
});

describe('the intents the control sends', () => {
  it('are the sim\'s, and round-trip through lordStance', () => {
    const s = newMatch(3, ['marshal', 'warden']);
    s.phase = 'planning';
    const p = s.players[0];
    p.gold = 9000;
    p.unlocked.push('knights');
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'knights', pos: [3000, 3400] }).ok).toBe(true);
    const lead = p.squads.find((q) => q.type === 'knights')!;
    for (const st of [{ t: 'hold' }, { t: 'follow', squad: lead.id }, { t: 'advance' }] as LordStance[]) {
      expect(applyIntent(s, 0, stanceIntent(st))).toEqual({ ok: true });
      expect(shownStance(p.squads, null)).toEqual(st);
    }
  });
});

describe('enemy intel on the Lord\'s ghost', () => {
  it('names the stance of the last battle, and the squad he followed', () => {
    const foe = [sq(5, 'lord', [4000, 10800], undefined, 1), sq(50, 'knights', [4000, 8600], undefined, 1)];
    expect(ghostStanceText(foe[0], foe).kind).toBe('advance');
    expect(ghostStanceText({ stance: { t: 'hold' } }, foe)).toMatchObject({ kind: 'hold', short: 'Held' });
    expect(ghostStanceText({ stance: { t: 'follow', squad: 50 } }, foe)).toMatchObject({ kind: 'follow', line: 'Followed their Knights last battle' });
    // a follow of a squad not in that army was an advance in the battle
    expect(ghostStanceText({ stance: { t: 'follow', squad: 77 } }, foe).kind).toBe('advance');
  });
});
