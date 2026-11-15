// The key fairness property: swap the seats and mirror both armies through the field centre, and the battle must
// play out as the exact mirror image — same winner (swapped), same keep damage, and every soldier's position (mirrored)
// and HP identical on every keyframe.
import { describe, expect, it } from 'vitest';
import { applyBattle, botPlan, decodeReplay, newMatch, nextRound, simulateBattle } from '../src/sim/index.ts';
import { mirrorSquads } from '../src/sim/match.ts';
import type { BotStrategy, DecodedReplay, LordId, MatchState, Seat } from '../src/sim/types.ts';
import { FIELD_H, FIELD_W } from '../src/sim/constants.ts';
import { SKILLS, SKILL_IDS, canEquip } from '../src/sim/data/skills.ts';
import { SLOT_UNLOCK_LEVEL } from '../src/sim/data/items.ts';
import { UNIT_TYPES } from '../src/sim/data/units.ts';
import type { Item, UnitType } from '../src/sim/types.ts';

function swapped(s: MatchState): MatchState {
  const m = structuredClone(s);
  const [a, b] = [structuredClone(s.players[0]), structuredClone(s.players[1])];
  m.players = [
    { ...b, seat: 0, squads: mirrorSquads(b.squads, 0), lastArmy: b.lastArmy ? mirrorSquads(b.lastArmy, 0) : null },
    { ...a, seat: 1, squads: mirrorSquads(a.squads, 1), lastArmy: a.lastArmy ? mirrorSquads(a.lastArmy, 1) : null },
  ];
  return m;
}

/** Map soldier index -> (side, squad index, soldier index) so the two replays can be matched up. */
function keys(d: DecodedReplay, s: MatchState): string[] {
  return d.replay.soldiers.map((so) => {
    const squads = s.players[so.side].squads;
    const qi = squads.findIndex((q) => q.id === so.squad);
    const nth = d.replay.soldiers.filter((o) => o.squad === so.squad && o.side === so.side && o.summoned === so.summoned && o.id < so.id).length;
    return `${so.side}:${so.summoned ? 'S' : ''}${qi}:${nth}`;
  });
}

function checkMirror(s: MatchState): { winner: Seat | null; ticks: number; soldiers: number } {
  const m = swapped(s);
  const A = simulateBattle(s), B = simulateBattle(m);
  const ra = A.result, rb = B.result;
  const flip = (w: Seat | null): Seat | null => (w === null ? null : ((1 - w) as Seat));
  expect(rb.winner).toBe(flip(ra.winner));
  expect(rb.timeout).toBe(ra.timeout);
  expect(rb.ticks).toBe(ra.ticks);
  expect(rb.keepDamage).toEqual([ra.keepDamage[1], ra.keepDamage[0]]);
  expect(rb.survivors).toEqual([ra.survivors[1], ra.survivors[0]]);
  expect(rb.lordXp).toEqual([ra.lordXp[1], ra.lordXp[0]]);
  expect(rb.damageDealt).toEqual([ra.damageDealt[1], ra.damageDealt[0]]);
  expect(rb.soldiersLost).toEqual([ra.soldiersLost[1], ra.soldiersLost[0]]);
  expect(B.replay.ticks).toBe(A.replay.ticks);
  // Frame-by-frame mirror.
  const da = decodeReplay(A.replay), db = decodeReplay(B.replay);
  expect(db.soldierCount).toBe(da.soldierCount);
  expect(db.frameCount).toBe(da.frameCount);
  const ka = keys(da, s), kb = keys(db, m);
  const idxB = new Map(kb.map((k, i) => [k, i]));
  const n = da.soldierCount;
  let mismatches = 0;
  for (let i = 0; i < n; i++) {
    const [side, rest] = [Number(ka[i][0]), ka[i].slice(1)];
    const j = idxB.get(`${1 - side}${rest}`);
    expect(j, ka[i]).toBeDefined();
    for (let f = 0; f < da.frameCount; f++) {
      const a = f * n + i, b = f * n + j!;
      if (da.anim[a] === 255 && db.anim[b] === 255) continue;
      const bad = db.x[b] !== FIELD_W - 1 - da.x[a] || db.y[b] !== FIELD_H - 1 - da.y[a] || db.hp[b] !== da.hp[a] || db.anim[b] !== da.anim[a] || db.facing[b] !== ((da.facing[a] + 128) & 255);
      if (bad) {
        if (process.env.MIRROR_DEBUG && mismatches < 5) console.log('mismatch', ka[i], A.replay.soldiers[i].type, 'frame', f, [da.x[a], da.y[a], da.facing[a], da.hp[a], da.anim[a]], [FIELD_W - 1 - db.x[b], FIELD_H - 1 - db.y[b], (db.facing[b] + 128) & 255, db.hp[b], db.anim[b]]);
        mismatches++;
      }
    }
  }
  expect(mismatches).toBe(0);
  return { winner: ra.winner, ticks: ra.ticks, soldiers: n };
}

describe('mirror symmetry (seat fairness)', () => {
  const cases: [number, [LordId, LordId], [BotStrategy, BotStrategy]][] = [
    [1, ['marshal', 'archmage'], ['rush', 'ranged']],
    [2, ['warden', 'skylady'], ['armor', 'air']],
    [3, ['skylady', 'archmage'], ['counter', 'random']],
    [4, ['archmage', 'warden'], ['best', 'air']],
    // faction mirrors and cross-faction battles
    [5, ['lich', 'lich'], ['best', 'rush']],
    [6, ['sultana', 'sultana'], ['counter', 'best']],
    [7, ['lich', 'sultana'], ['best', 'ranged']],
    [8, ['sultana', 'marshal'], ['air', 'best']],
    [9, ['archmage', 'lich'], ['random', 'armor']],
    // the six newer Lords, each in a bot match
    [16, ['deathknight', 'rajah'], ['hard', 'normal']],
    [17, ['ossuary', 'vizier'], ['normal', 'hard']],
    [18, ['drakerider', 'rocrider'], ['hard', 'hard']],
    [19, ['vizier', 'deathknight'], ['best', 'easy']],
    [20, ['rocrider', 'ossuary'], ['hard', 'counter']],
    [21, ['rajah', 'drakerider'], ['air', 'hard']],
  ];
  for (const [seed, lords, strats] of cases) {
    it(`seed ${seed}: ${lords.join(' vs ')} (${strats.join(' vs ')}) mirrors exactly every round`, () => {
      const s = newMatch(seed, lords);
      let rounds = 0;
      while (s.phase === 'planning' && rounds < 8) {
        botPlan(s, 0, strats[0], 1);
        botPlan(s, 1, strats[1], 2);
        checkMirror(s);
        applyBattle(s, simulateBattle(s, { record: false }).result);
        rounds++;
        if ((s.phase as string) !== 'results') break;
        nextRound(s);
      }
      expect(rounds).toBeGreaterThan(2);
    }, 60_000);
  }

  it('item skills mirror exactly: every skill in play on both sides, asymmetric armies', () => {
    // Seat 0 and seat 1 field different armies; every squad wears every skill item its class and level allow.
    const kingdom: [UnitType[], UnitType[]] = [
      ['militia', 'knights', 'mages', 'clerics', 'archers', 'cavaliers', 'trebuchet', 'pegasus', 'golem', 'berserkers'],
      ['pikemen', 'berserkers', 'archers', 'mages', 'wyvern', 'ballista', 'cavaliers', 'militia', 'dragon', 'clerics'],
    ];
    // The whole Ashen roster against the whole Caliphate roster (and the reverse): every faction mechanic in play.
    const ashen: UnitType[] = ['skeleton', 'grave_knight', 'bone_archer', 'wraith_rider', 'grave_acolyte', 'bone_drake', 'corpse_catapult', 'bone_golem', 'grave_acolyte', 'skeleton'];
    const caliphate: UnitType[] = ['spear_levy', 'scimitar', 'camel_archer', 'mamluk', 'djinn_binder', 'sun_priest', 'djinn', 'war_elephant', 'sand_golem', 'sun_priest'];
    expect(new Set([...kingdom[0], ...kingdom[1], ...ashen, ...caliphate]).size).toBe(UNIT_TYPES.length);
    const cases: [number, [LordId, LordId], [UnitType[], UnitType[]], number][] = [
      [11, ['archmage', 'marshal'], kingdom, 11], [12, ['skylady', 'warden'], kingdom, 11],
      [13, ['lich', 'sultana'], [ashen, caliphate], 8], [14, ['sultana', 'lich'], [caliphate, ashen], 8], [15, ['lich', 'lich'], [ashen, ashen], 5],
    ];
    for (const [seed, lords, armies, minSkills] of cases) {
      const s = newMatch(seed, [...lords] as [LordId, LordId]);
      s.round = 7;
      let id = 9000;
      const worn = new Set<string>();
      for (const seat of [0, 1] as Seat[]) {
        const p = s.players[seat];
        armies[seat].forEach((u, k) => {
          const x = 900 + (k % 5) * 1500, y = 3500 - Math.floor(k / 5) * 1300;
          p.squads.push({ id: s.nextId++, owner: seat, type: u, level: 4, pos: seat === 0 ? [x, y] : [FIELD_W - 1 - x, FIELD_H - 1 - y], facing: seat === 0 ? 64 : 192, items: { weapon: null, armor: null, relic: null }, deployedRound: 1, spent: 400 });
        });
        for (const q of p.squads) {
          for (const k of SKILL_IDS) {
            const slot = SKILLS[k].slot;
            if (q.items[slot] || !canEquip({ skill: k }, q.type, p.lord) || (q.type !== 'lord' && q.level < SLOT_UNLOCK_LEVEL[slot])) continue;
            // spread the skills of one slot over the squads of a class
            if (worn.has(`${seat}:${k}`) && SKILL_IDS.some((o) => o !== k && SKILLS[o].slot === slot && canEquip({ skill: o }, q.type, p.lord) && !worn.has(`${seat}:${o}`))) continue;
            const it: Item = { id: id++, base: slot === 'weapon' ? 'steel_blade' : slot === 'armor' ? 'mail_hauberk' : 'oath_ring', slot, rarity: 'rare', ilvl: 7, implicit: { id: slot === 'armor' ? 'stalwart' : 'vicious', value: 6 }, affixes: [], legendary: null, skill: k };
            q.items[slot] = it;
            worn.add(`${seat}:${k}`);
          }
        }
      }
      const r = checkMirror(s);
      expect(r.soldiers).toBeGreaterThan(80);
      const d = decodeReplay(simulateBattle(s).replay);
      const cast = new Set(d.skills!.map((e) => e.skill));
      expect(cast.size).toBeGreaterThanOrEqual(minSkills);
      if (lords.includes('lich')) {
        // the dead rise: skeletons are summoned, and the Lich-Priest's necromancy fires
        expect(d.events.some((e) => e.k === 'summon')).toBe(true);
        expect(d.events.some((e) => e.k === 'ability' && e.ability === 'necromancy')).toBe(true);
      }
      if (lords.includes('sultana')) expect(d.events.some((e) => e.k === 'ability' && e.ability === 'radiance')).toBe(true);
    }
  }, 60_000);

  it('the newer Lord abilities mirror exactly, each cast by the Lord in the thick of a fight', () => {
    // Both seats field different armies; seat 0's Lord stands at the front, so its ability has targets.
    const cases: [number, [LordId, LordId], string][] = [
      [31, ['deathknight', 'warden'], 'soul_reap'], [32, ['ossuary', 'marshal'], 'grave_taunt'], [33, ['drakerider', 'archmage'], 'plague_breath'],
      [34, ['vizier', 'lich'], 'whirlwind'], [35, ['rajah', 'sultana'], 'stampede'], [36, ['rocrider', 'skylady'], 'talon'],
      [37, ['ossuary', 'rajah'], 'grave_taunt'], [38, ['rocrider', 'rocrider'], 'talon'],
    ];
    const armies: [UnitType[], UnitType[]] = [['militia', 'knights', 'archers', 'pikemen', 'mages', 'cavaliers'], ['skeleton', 'grave_knight', 'scimitar', 'spear_levy', 'bone_archer', 'camel_archer']];
    for (const [seed, lords, ability] of cases) {
      const s = newMatch(seed, [...lords] as [LordId, LordId]);
      s.round = 6;
      for (const seat of [0, 1] as Seat[]) {
        const p = s.players[seat];
        p.squads[0].level = 4;
        const lp: [number, number] = seat === 0 ? [3700, 3600] : [5200, 2400];
        p.squads[0].pos = seat === 0 ? lp : [FIELD_W - 1 - lp[0], FIELD_H - 1 - lp[1]];
        armies[seat].forEach((u, k) => {
          const x = 1500 + (k % 3) * 2200, y = 3800 - Math.floor(k / 3) * 1200;
          p.squads.push({ id: s.nextId++, owner: seat, type: u, level: 2, pos: seat === 0 ? [x, y] : [FIELD_W - 1 - x, FIELD_H - 1 - y], facing: seat === 0 ? 64 : 192, items: { weapon: null, armor: null, relic: null }, deployedRound: 1, spent: 300 });
        });
      }
      checkMirror(s);
      const d = decodeReplay(simulateBattle(s).replay);
      expect(d.events.some((e) => e.k === 'ability' && e.ability === ability), `${lords.join('/')} ${ability}`).toBe(true);
    }
  }, 60_000);

  it('identical armies on both sides draw or split evenly', () => {
    // Seat 1 gets the exact mirror of seat 0's army: the outcome must be symmetric (no winner, equal losses).
    const s = newMatch(9, ['marshal', 'marshal']);
    for (let r = 0; r < 4; r++) {
      botPlan(s, 0, 'random', 3);
      s.players[1] = { ...structuredClone(s.players[0]), seat: 1, squads: mirrorSquads(s.players[0].squads, 1) };
      const { result } = simulateBattle(s);
      expect(result.winner).toBe(null);
      expect(result.soldiersLost[0]).toBe(result.soldiersLost[1]);
      expect(result.keepDamage[0]).toBe(result.keepDamage[1]);
      applyBattle(s, result);
      if ((s.phase as string) !== 'results') break;
      nextRound(s);
    }
  }, 60_000);
});
