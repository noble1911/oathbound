// The planning formation helpers (src/ui/timing.ts): the march preview reads the sim's speeds and
// terrain, the move order is always legal on the server, mirror / group placement stay in the zone,
// and "sync by speed" makes melee squads reach the river together.
import { describe, expect, it } from 'vitest';
import { applyIntent, deployZone, inDeployZone, newMatch, overlappingSquad } from '../src/sim/match.ts';
import { genTerrain } from '../src/sim/terrain.ts';
import { UNITS } from '../src/sim/data/units.ts';
import { TICK_HZ } from '../src/sim/constants.ts';
import { frontLine, groupPlace, marchOf, mirrorPlace, planMoves, snapPos, syncBySpeed, type Placed } from '../src/ui/timing.ts';
import type { MatchState, Seat, Squad, UnitType, Vec2 } from '../src/sim/types.ts';

const items = { weapon: null, armor: null, relic: null };
const terrain = genTerrain(7);

function sq(id: number, type: UnitType, pos: Vec2, owner: Seat = 0): Squad {
  return { id, owner, type, level: 1, pos, items: { ...items }, deployedRound: 1, spent: UNITS[type].cost };
}

/** A planning match whose seat-0 army is `army` (ids kept). */
function match(army: Squad[], seat: Seat = 0): MatchState {
  const s = newMatch(5, ['marshal', 'warden']);
  s.phase = 'planning';
  s.players[seat].squads = army.map((q) => ({ ...q, owner: seat }));
  return s;
}

describe('march preview', () => {
  it('walks at the unit speed of the sim and reaches the river later from further back', () => {
    for (const type of ['knights', 'cavaliers', 'militia'] as UnitType[]) {
      const near = marchOf({ type, level: 1, items, pos: [3999, 3800] }, null, 0, terrain, [], frontLine(0, []));
      const far = marchOf({ type, level: 1, items, pos: [3999, 1500] }, null, 0, terrain, [], frontLine(0, []));
      expect(near.speed).toBeCloseTo((UNITS[type].speed * TICK_HZ) / 100);
      expect(near.river).not.toBeNull();
      expect(far.river!.sec).toBeGreaterThan(near.river!.sec);
      expect(near.pts.length).toBeGreaterThan(2);
    }
  });

  it('is mirror-exact between the seats', () => {
    const a = marchOf({ type: 'knights', level: 1, items, pos: [2500, 3000] }, null, 0, terrain, [], frontLine(0, []));
    const b = marchOf({ type: 'knights', level: 1, items, pos: [7999 - 2500, 11999 - 3000] }, null, 1, terrain, [], frontLine(1, []));
    expect(b.river!.sec).toBeCloseTo(a.river!.sec, 1);
  });
});

describe('placement helpers', () => {
  const army = [sq(1, 'knights', [1000, 3000]), sq(2, 'militia', [2000, 3000]), sq(3, 'cavaliers', [3000, 3000]), sq(4, 'pikemen', [6999, 3000])];

  it('orders moves so the server accepts every one (a mirror swaps squads)', () => {
    const s = match(army);
    const targets = mirrorPlace(army, 0);
    for (const i of planMoves(army, targets, 0)) expect(applyIntent(s, 0, i)).toEqual({ ok: true });
    for (const q of s.players[0].squads) expect(q.pos).toEqual(targets.get(q.id)!.pos);
  });

  it('moves a group inside the zone with no overlaps', () => {
    const group = army.slice(0, 3);
    const out = groupPlace(group, [army[3]!], 0, [-5000, 4000], 100)!;
    expect(out.size).toBe(3);
    const placed = [...out].map(([id, p]) => ({ ...army.find((q) => q.id === id)!, pos: p.pos }));
    for (const q of placed) {
      expect(inDeployZone(0, q.pos)).toBe(true);
      expect(overlappingSquad([...placed, army[3]!], q.type, q.pos, q.id)).toBeNull();
      expect(q.pos[0] % 100 === 0 || q.pos[0] === deployZone(0).x1).toBe(true);
    }
    const s = match(army);
    for (const i of planMoves(army, out, 0)) expect(applyIntent(s, 0, i).ok).toBe(true);
  });

  it('snaps to the grid inside the zone', () => {
    expect(snapPos([1234, 3999], 100, 0)).toEqual([1200, 3900]);
    expect(snapPos([1234, 1251], 50, 0)).toEqual([1250, 1250]);
    expect(snapPos([1234, 1251], 0, 0)).toEqual([1234, 1251]);
  });

  it('syncs melee squads so they reach the river together, the slowest in front', () => {
    const group = [sq(1, 'knights', [2000, 2000]), sq(2, 'cavaliers', [2600, 2000]), sq(3, 'militia', [3400, 2000])];
    const r = syncBySpeed(group, [], 0, 'marshal', terrain, [], 0)!;
    expect(r).not.toBeNull();
    const at = (id: number) => r.spots.get(id)!.pos;
    // knights (2.2 m/s) stand furthest forward, cavaliers (6.4 m/s) furthest back
    expect(at(1)[1]).toBeGreaterThan(at(3)[1]);
    expect(at(3)[1]).toBeGreaterThan(at(2)[1]);
    const secs = group.map((q) => marchOf({ ...q, pos: at(q.id) }, 'marshal', 0, terrain, [], frontLine(0, [])).river!.sec);
    expect(Math.max(...secs) - Math.min(...secs)).toBeLessThan(1);
    const s = match(group);
    for (const i of planMoves(group, r.spots as Map<number, Placed>, 0)) expect(applyIntent(s, 0, i).ok).toBe(true);
  });
});
