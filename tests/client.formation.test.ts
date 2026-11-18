// Formation on the planning screen (src/ui/formation.ts): the words come from the sim's constants, the default is one
// constant, the selection toggle, the enemy intel, and that the march preview and Sync by speed follow the speed the
// sim gives each formation. Nothing here assumes which formation is the default or which carries the modifiers.
import { describe, expect, it } from 'vitest';
import { FORMATION_MIN_SIZE, UNITS, UNIT_TYPES, WIDE_AREA_PCT, WIDE_MELEE_PCT } from '../src/sim/data/units.ts';
import { buildStats } from '../src/sim/battle.ts';
import { TICK_HZ } from '../src/sim/constants.ts';
import { genTerrain } from '../src/sim/terrain.ts';
import {
  canForm, DEFAULT_FORMATION, FORMATIONS, formationCoach, formationLine, formationOf, formationRules, formationTip, ghostFormationText, groupTarget, marked,
  otherFormation, withFormation,
} from '../src/ui/formation.ts';
import { frontLine, marchOf, syncBySpeed } from '../src/ui/timing.ts';
import type { Formation, Squad, UnitType, Vec2 } from '../src/sim/types.ts';

const items = { weapon: null, armor: null, relic: null };
const terrain = genTerrain(7);
const D = DEFAULT_FORMATION, O = otherFormation(DEFAULT_FORMATION);
const sq = (id: number, type: UnitType | 'lord', formation?: Formation, pos: Vec2 = [4000, 2000]): Squad => ({
  id, owner: 0, type, level: 1, pos, items: { ...items }, deployedRound: 1, spent: 100, ...(formation ? { formation } : {}),
});

describe('formation: who has one, and the default', () => {
  it('squads of three or more soldiers; never the Lord, never one or two', () => {
    expect(canForm('lord')).toBe(false);
    for (const u of UNIT_TYPES) expect(canForm(u)).toBe(UNITS[u].squadSize >= FORMATION_MIN_SIZE);
    expect(canForm('militia')).toBe(true);
    expect(canForm('ballista')).toBe(false);
    expect(canForm('wyvern')).toBe(false);
  });

  it('absent is the default; a mark on a squad without the choice reads as the default, as the sim reads it', () => {
    expect(formationOf(sq(1, 'militia'))).toBe(D);
    expect(formationOf(sq(1, 'militia', O))).toBe(O);
    expect(formationOf(sq(1, 'ballista', O))).toBe(D);
    // stored as the sim stores it: the default is the field left out
    expect(withFormation(sq(1, 'militia', O), D).formation).toBeUndefined();
    expect(withFormation(sq(1, 'militia'), O).formation).toBe(O);
    expect(marked(D)).toBe(false);
    expect(marked(O)).toBe(true);
    expect(otherFormation(O)).toBe(D);
  });

  it('the selection toggle: any in the default takes them all to the other; all in the other go back', () => {
    expect(groupTarget([sq(1, 'militia'), sq(2, 'knights', O)])).toBe(O);
    expect(groupTarget([sq(1, 'militia', O), sq(2, 'knights', O), sq(3, 'ballista')])).toBe(D);
    expect(groupTarget([sq(1, 'lord'), sq(2, 'ballista')])).toBeNull();
  });
});

describe('formation: the words', () => {
  it('every number is the sim constant, in one place; the default is named once', () => {
    const all = [...FORMATIONS.map(formationTip), ...FORMATIONS.map(formationLine), formationCoach(), formationRules()].join(' ');
    expect(all).toContain(`${WIDE_AREA_PCT}%`);
    expect(all).toContain(`${WIDE_MELEE_PCT}%`);
    expect(formationTip(D)).toMatch(/the default/);
    expect(formationTip(O)).not.toMatch(/the default/);
    expect(formationRules()).toMatch(/locked in place/);
    for (const f of FORMATIONS) expect(formationTip(f)).toMatch(/\[R\]/);
    expect(all).not.toMatch(/\bturn/i);
  });

  it('an enemy ghost says how it stood last battle; one without a formation says nothing', () => {
    expect(ghostFormationText(sq(1, 'militia', 'deep'))).toBe('Stood deep last battle');
    expect(ghostFormationText(sq(1, 'militia', 'wide'))).toBe('Stood wide last battle');
    expect(ghostFormationText(sq(1, 'knights'))).toBe(`Stood ${D} last battle`);
    expect(ghostFormationText(sq(1, 'lord'))).toBeNull();
    expect(ghostFormationText(sq(1, 'golem'))).toBeNull();
  });
});

describe('formation: timing', () => {
  it("the march preview walks at the speed the sim gives each formation", () => {
    for (const type of ['knights', 'militia', 'pikemen'] as UnitType[]) {
      const sp = (f: Formation) => buildStats({ type, level: 1, items, formation: f }, null).speed;
      const m = (f: Formation) => marchOf({ type, level: 1, items, pos: [3999, 2000], formation: f }, null, 0, terrain, [], frontLine(0, []));
      for (const f of FORMATIONS) expect(m(f).speed).toBeCloseTo((sp(f) * TICK_HZ) / 100, 5);
      // faster reaches the river sooner, the same speed at the same time
      const [a, b] = [m('wide').river!.sec, m('deep').river!.sec];
      expect(Math.sign(a - b)).toBe(Math.sign(sp('deep') - sp('wide')));
    }
  });

  it('Sync by speed holds a squad further back when its formation makes it faster', () => {
    const run = (f: Formation) => {
      const group = [sq(1, 'knights', undefined, [2000, 2000]), sq(2, 'militia', f, [5500, 2000])];
      return syncBySpeed(group, [], 0, null, terrain, [], 0)!.spots.get(2)!.pos[1];
    };
    const faster = buildStats({ type: 'militia', level: 1, items, formation: 'deep' }, null).speed - buildStats({ type: 'militia', level: 1, items, formation: 'wide' }, null).speed;
    // seat 0's front edge is the high y: held back = lower y
    expect(Math.sign(run('wide') - run('deep'))).toBe(Math.sign(faster));
  });
});
