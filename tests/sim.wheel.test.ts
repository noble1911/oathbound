// The counter wheel, deploy weights and Swarm growth (DESIGN §2, §3; docs/reviews/GAMEPLAY-2026-11-16.md).
import { describe, expect, it } from 'vitest';
import { applyIntent, decodeReplay, makeTransforms, newMatch, sampleReplay, simulateBattle, squadSheet, viewFor, LORDS, LORD_IDS, UNITS, UNIT_TYPES } from '../src/sim/index.ts';
import { COUNTER_PCT } from '../src/sim/constants.ts';
import { WHEEL, beatenBy, beatsClass, classBeats } from '../src/sim/data/wheel.ts';
import { squadSizeAt } from '../src/sim/data/units.ts';
import { buildStats, squadSize } from '../src/sim/battle.ts';
import { DEPLOY_BUDGET, deployPointsText, deployWeight, squadFootprint } from '../src/sim/match.ts';
import type { DecodedReplay, LordId, MatchState, Seat, UnitType, Vec2, WheelClass } from '../src/sim/types.ts';

type Spec = [unit: UnitType, level: number, pos: Vec2];
function arena(mine: Spec[], theirs: Spec[], lords: [LordId, LordId] = ['marshal', 'marshal']): MatchState {
  const s = newMatch(7, lords);
  s.round = 6;
  for (const seat of [0, 1] as Seat[]) {
    const p = s.players[seat];
    p.squads[0].pos = seat === 0 ? [300, 500] : [7699, 11499];
    for (const [unit, level, pos] of seat === 0 ? mine : theirs) {
      const at: Vec2 = seat === 0 ? pos : [7999 - pos[0], 11999 - pos[1]];
      p.squads.push({ id: s.nextId++, owner: seat, type: unit, level, pos: at, facing: seat === 0 ? 64 : 192, items: { weapon: null, armor: null, relic: null }, deployedRound: 1, spent: 0 });
    }
  }
  return s;
}
const run = (s: MatchState): DecodedReplay => decodeReplay(simulateBattle(s).replay);

describe('the counter wheel', () => {
  it('is a ring of eight: each class beats the next and is beaten by the one before', () => {
    expect(WHEEL).toEqual(['swarm', 'giant', 'line', 'cavalry', 'ranged', 'air', 'siege', 'magic']);
    for (const c of WHEEL) {
      expect(beatenBy(beatsClass(c))).toBe(c);
      expect(classBeats(c, beatsClass(c))).toBe(true);
      expect(classBeats(beatsClass(c), c)).toBe(false);
      expect(WHEEL.filter((o) => classBeats(c, o))).toEqual([beatsClass(c)]);
    }
    expect(beatsClass('magic')).toBe('swarm');
    expect(COUNTER_PCT).toBe(150);
  });

  it('gives every unit and every Lord exactly one class (Lords: their body or mount)', () => {
    for (const u of UNIT_TYPES) expect(WHEEL).toContain(UNITS[u].class);
    for (const l of LORD_IDS) expect(WHEEL).toContain(LORDS[l].class);
    const of = (c: WheelClass): UnitType[] => UNIT_TYPES.filter((u) => UNITS[u].class === c);
    expect(of('swarm')).toEqual(['militia', 'skeleton', 'spear_levy']);
    expect(of('siege')).toEqual(['ballista', 'trebuchet', 'corpse_catapult', 'sun_mirror']);
    expect(UNITS.clerics.class).toBe('magic'); // healers count as Magic
    expect(UNITS.sun_priest.class).toBe('magic');
    expect(LORDS.rajah.class).toBe('giant');
    expect(LORDS.skylady.class).toBe('air');
    // no per-unit tag bonuses remain on any unit
    for (const u of UNIT_TYPES) expect((UNITS[u] as unknown as Record<string, unknown>).effective).toBeUndefined();
  });

  it(`deals ${COUNTER_PCT}% damage to the class it beats, and nothing extra otherwise`, () => {
    // Archers (Ranged) shooting Knights (Line: neutral), then the same Knights re-classed as Air (beaten by Ranged).
    const firstHit = (): number => {
      const d = run(arena([['archers', 1, [4000, 2000]]], [['knights', 1, [4000, 2600]]]));
      const archers = new Set(d.replay.squads.find((q) => q.type === 'archers' && q.side === 0)!.soldiers);
      const h = d.events.find((e) => e.k === 'hit' && archers.has(e.src));
      if (!h || h.k !== 'hit') throw new Error('no hit');
      return h.dmg;
    };
    const neutral = firstHit();
    const was = UNITS.knights.class;
    try {
      UNITS.knights.class = 'air';
      const counter = firstHit();
      expect(counter).toBeGreaterThanOrEqual(Math.floor((neutral * COUNTER_PCT) / 100) - 1);
      expect(counter).toBeLessThanOrEqual(Math.ceil((neutral * COUNTER_PCT) / 100) + 1);
      // and the reverse pairing (Air hitting Ranged) is no counter: Knights-as-Air shooting nothing changes nothing
      UNITS.knights.class = 'cavalry'; // Cavalry beats Ranged, not the other way round
      expect(firstHit()).toBe(neutral);
    } finally {
      UNITS.knights.class = was;
    }
  });

  it('carries the class into battle stats; ranged units aim at the class they beat', () => {
    const a = buildStats({ type: 'archers', level: 1, items: { weapon: null, armor: null, relic: null } }, null);
    const p = buildStats({ type: 'pegasus', level: 1, items: { weapon: null, armor: null, relic: null } }, null);
    expect(WHEEL[a.wc]).toBe('ranged');
    expect(a.beats).toBe(p.wc);
    expect(a.prefCls).toBe(true);
    const lord = buildStats({ type: 'lord', level: 1, items: { weapon: null, armor: null, relic: null } }, 'rajah');
    expect(WHEEL[lord.wc]).toBe('giant');
  });
});

describe('deploy weights', () => {
  it('weighs units by cost in half-points: 100 = ½, 150-300 = 1, 400+ = 1½', () => {
    for (const u of UNIT_TYPES) {
      const c = UNITS[u].cost;
      expect(deployWeight(u)).toBe(c <= 100 ? 1 : c <= 300 ? 2 : 3);
    }
    expect(deployWeight('militia')).toBe(1);
    expect(deployWeight('sand_golem')).toBe(2);
    expect(deployWeight('dragon')).toBe(3);
    expect(DEPLOY_BUDGET).toBe(4);
    expect([1, 2, 3, 4, 6].map(deployPointsText)).toEqual(['½', '1', '1½', '2', '3']);
  });

  it('lets four cheap squads, two mid ones, or a Golem and a cheap squad in one round', () => {
    const play = (units: UnitType[]): boolean[] => {
      const s = newMatch(3, ['warden', 'warden']);
      const p = s.players[0];
      p.unlocked = [...UNIT_TYPES];
      p.gold = 5000;
      return units.map((u, i) => applyIntent(s, 0, { t: 'deploy', unit: u, pos: [800 + i * 1500, 2200] }).ok);
    };
    expect(play(['militia', 'archers', 'pikemen', 'militia', 'archers'])).toEqual([true, true, true, true, false]);
    expect(play(['knights', 'cavaliers', 'militia'])).toEqual([true, true, false]);
    expect(play(['golem', 'militia', 'archers'])).toEqual([true, true, false]);
    expect(play(['golem', 'knights'])).toEqual([true, false]);
  });

  it('refunds the weight when a squad is sold in its round', () => {
    const s = newMatch(3, ['warden', 'warden']);
    const p = s.players[0];
    p.unlocked = [...UNIT_TYPES];
    p.gold = 5000;
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'golem', pos: [2000, 2200] }).ok).toBe(true);
    expect(p.deploysUsed).toBe(3);
    expect(applyIntent(s, 0, { t: 'sell', squad: p.squads[1].id }).ok).toBe(true);
    expect(p.deploysUsed).toBe(0);
  });
});

describe('Swarm squads level by adding soldiers', () => {
  it('grow by a quarter of their base size per level, with no per-soldier growth', () => {
    expect([1, 2, 3, 4, 5].map((l) => squadSizeAt('militia', l))).toEqual([12, 15, 18, 21, 24]);
    expect([1, 2, 3, 4, 5].map((l) => squadSizeAt('skeleton', l))).toEqual([10, 12, 15, 17, 20]);
    expect(squadSizeAt('knights', 5)).toBe(4);
    const items = { weapon: null, armor: null, relic: null };
    expect(squadSize({ type: 'militia', level: 3, items })).toBe(18);
    const m1 = buildStats({ type: 'militia', level: 1, items }, null), m5 = buildStats({ type: 'militia', level: 5, items }, null);
    expect(m5.hp).toBe(m1.hp);
    expect(m5.dmg).toBe(m1.dmg);
    const k1 = buildStats({ type: 'knights', level: 1, items }, null), k3 = buildStats({ type: 'knights', level: 3, items }, null);
    expect(k3.hp).toBeGreaterThan(k1.hp);
  });

  it('field their grown squad in battle and on the sheet, inside the footprint they reserve', () => {
    const s = arena([['militia', 4, [4000, 2000]]], [['militia', 1, [4000, 2000]]]);
    const d = run(s);
    const mine = d.replay.squads.find((q) => q.type === 'militia' && q.side === 0)!;
    const theirs = d.replay.squads.find((q) => q.type === 'militia' && q.side === 1)!;
    expect(mine.soldiers.length).toBe(21);
    expect(theirs.soldiers.length).toBe(12);
    // the formation stays inside the ground the squad reserves (squadFootprint: the half-extent of its Lv5 grid)
    const fp = squadFootprint('militia');
    const tf = sampleReplay(d, 0, makeTransforms(d.soldierCount));
    for (const i of mine.soldiers) {
      const dx = tf.x[i] - 4000, dy = tf.y[i] - 2000;
      expect(Math.max(Math.abs(dx), Math.abs(dy))).toBeLessThanOrEqual(fp);
    }
    const sheet = squadSheet(viewFor(s, 0), s.players[0].squads[1].id)!;
    const n = sheet.stats.find((x) => x.key === 'soldiers')!;
    expect([n.base, n.value]).toEqual([12, 21]);
  });
});
