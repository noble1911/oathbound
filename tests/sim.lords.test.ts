// The six newer Lords (DESIGN §4): every faction has four, one per role. For each: the passive shows on the squad sheet,
// the ability fires and does what it says, and the battle is deterministic.
import { describe, expect, it } from 'vitest';
import { decodeReplay, newMatch, simulateBattle, squadSheet, squadStatsAt, viewFor, FACTIONS, LORDS, LORD_IDS, UNITS } from '../src/sim/index.ts';
import { ABILITY_CODES, STAT_CAUSES } from '../src/sim/replay.ts';
import { ABILITY_CD, LORD_CLASS, lordSkills } from '../src/sim/data/skills.ts';
import {
  LORD_ABILITY_IDS, LORD_ROLE, LORD_ROLES, OSSUARY_KEEP_BONUS, TALON_THROW, TAUNT_TICKS, lordAuraRing,
} from '../src/sim/data/lords.ts';
import { KEEP_HP } from '../src/sim/match.ts';
import type { DecodedReplay, LordId, MatchState, ReplayEvent, Seat, UnitType, Vec2 } from '../src/sim/types.ts';

type Spec = [unit: UnitType, level: number, pos: Vec2];
/** A hand-built battle (positions in each seat's own frame); `lordAt` places seat 0's Lord, seat 1's waits in a corner. */
function arena(mine: Spec[], theirs: Spec[], lords: [LordId, LordId], lordAt: Vec2 | null = null): MatchState {
  const s = newMatch(7, lords);
  s.round = 6;
  for (const seat of [0, 1] as Seat[]) {
    const p = s.players[seat];
    p.squads[0].pos = seat === 0 ? lordAt ?? [300, 500] : [7699, 11499];
    p.squads[0].level = 3;
    for (const [unit, level, pos] of seat === 0 ? mine : theirs) {
      const at: Vec2 = seat === 0 ? pos : [7999 - pos[0], 11999 - pos[1]];
      p.squads.push({ id: s.nextId++, owner: seat, type: unit, level, pos: at, facing: seat === 0 ? 64 : 192, items: { weapon: null, armor: null, relic: null }, deployedRound: 1, spent: UNITS[unit].cost * level });
    }
  }
  return s;
}
const run = (s: MatchState): DecodedReplay => decodeReplay(simulateBattle(s).replay);
type Ab = Extract<ReplayEvent, { k: 'ability' }>;
const casts = (d: DecodedReplay, ability: string): Ab[] => d.events.filter((e): e is Ab => e.k === 'ability' && e.ability === ability);
const lordOf = (d: DecodedReplay, side: Seat): number => d.replay.squads.find((q) => q.type === 'lord' && q.side === side)!.soldiers[0];
const lordRow = (d: DecodedReplay, side: Seat) => squadStatsAt(d, d.replay.ticks).squads.find((q) => q.type === 'lord' && q.side === side)!;

const NEW: LordId[] = ['deathknight', 'ossuary', 'drakerider', 'vizier', 'rajah', 'rocrider'];
/** One arena per new Lord in which its ability has something to do. */
const SCENE: Record<string, () => MatchState> = {
  deathknight: () => arena([['skeleton', 2, [4000, 3900]], ['grave_knight', 2, [4600, 3900]]], [['militia', 2, [4000, 3900]], ['militia', 2, [4600, 3900]]], ['deathknight', 'warden'], [4300, 3500]),
  ossuary: () => arena([['grave_knight', 2, [4000, 3900]]], [['militia', 2, [4000, 3900]], ['berserkers', 2, [4600, 3900]]], ['ossuary', 'marshal'], [4300, 3700]),
  drakerider: () => arena([['grave_knight', 2, [4000, 3900]]], [['militia', 2, [4000, 3900]], ['pikemen', 2, [4400, 3900]]], ['drakerider', 'marshal'], [4000, 3200]),
  vizier: () => arena([['scimitar', 2, [4000, 3900]]], [['militia', 2, [4000, 3900]], ['pikemen', 2, [4400, 3900]]], ['vizier', 'marshal'], [4000, 2800]),
  rajah: () => arena([['scimitar', 2, [4000, 3900]]], [['militia', 2, [4000, 3900]], ['pikemen', 2, [4400, 3900]]], ['rajah', 'marshal'], [4300, 3600]),
  rocrider: () => arena([['camel_archer', 2, [4000, 2800]], ['scimitar', 2, [4000, 3900]]], [['knights', 2, [4000, 3900]], ['militia', 1, [4600, 3900]]], ['rocrider', 'warden'], [4000, 3000]),
};

describe('the twelve Lords: data', () => {
  it('four Lords per faction, one in each role, each with a passive, an ability and an aura ring', () => {
    expect(LORD_IDS.length).toBe(12);
    for (const f of ['kingdom', 'ashen', 'caliphate'] as const) {
      expect(FACTIONS[f].lords.length).toBe(4);
      expect(FACTIONS[f].lords.map((l) => LORD_ROLE[l])).toEqual([...LORD_ROLES]);
    }
    expect(FACTIONS.ashen.lords).toEqual(['deathknight', 'lich', 'ossuary', 'drakerider']);
    expect(FACTIONS.caliphate.lords).toEqual(['sultana', 'vizier', 'rajah', 'rocrider']);
    expect(new Set(LORD_IDS.map((l) => LORDS[l].ability)).size).toBe(12);
    for (const l of LORD_IDS) {
      const L = LORDS[l];
      expect(L.modelId).toBe(`lord_${l}`);
      expect(LORD_CLASS[l]).toBeTruthy();
      expect(LORD_ABILITY_IDS).toContain(L.ability);
      expect(ABILITY_CODES).toContain(L.ability);
      expect(ABILITY_CD[L.ability]).toBeGreaterThan(0);
      expect(lordAuraRing(L.ability).radius).toBeGreaterThan(0);
      expect(L.passive && L.abilityName && L.abilityText).toBeTruthy();
      const sk = lordSkills(l, 4);
      expect(sk.find((x) => x.kind === 'active')!.text).not.toMatch(/undefined|NaN/);
    }
    for (const c of ['soul_reap', 'plague_breath', 'whirlwind', 'stampede', 'talon'] as const) expect(STAT_CAUSES).toContain(c);
    expect(STAT_CAUSES.length).toBeLessThan(64);
  });
});

describe('the newer Lords: passives', () => {
  const sheet = (lord: LordId, unit: UnitType, key: string): number => {
    const s = arena([[unit, 1, [4000, 3000]]], [], [lord, lord]);
    return squadSheet(viewFor(s, 0), s.players[0].squads[1].id)!.stats.find((x) => x.key === key)!.value;
  };
  it('each shows on the squad sheet against a Lord without it (a unit under another Lord is only possible in a test)', () => {
    expect(sheet('deathknight', 'skeleton', 'damage')).toBeGreaterThan(sheet('ossuary', 'skeleton', 'damage'));
    expect(sheet('deathknight', 'bone_archer', 'damage')).toBe(sheet('ossuary', 'bone_archer', 'damage')); // infantry only
    expect(sheet('ossuary', 'skeleton', 'armor')).toBeGreaterThan(sheet('deathknight', 'skeleton', 'armor'));
    expect(sheet('drakerider', 'skeleton', 'speed')).toBeGreaterThan(sheet('lich', 'skeleton', 'speed'));
    expect(sheet('vizier', 'djinn_binder', 'attackInterval')).toBeLessThan(sheet('rajah', 'djinn_binder', 'attackInterval'));
    expect(sheet('vizier', 'scimitar', 'attackInterval')).toBe(sheet('rajah', 'scimitar', 'attackInterval')); // magic only
    expect(sheet('rajah', 'sand_golem', 'hp')).toBeGreaterThan(sheet('vizier', 'sand_golem', 'hp'));
    expect(sheet('rajah', 'sand_golem', 'armor')).toBeGreaterThan(sheet('vizier', 'sand_golem', 'armor'));
    expect(sheet('rocrider', 'camel_archer', 'damage')).toBeGreaterThan(sheet('vizier', 'camel_archer', 'damage'));
    expect(sheet('rocrider', 'mamluk', 'damage')).toBe(sheet('vizier', 'mamluk', 'damage')); // archers only
    expect(newMatch(1, ['ossuary', 'marshal']).players[0].keepMax).toBe(KEEP_HP + OSSUARY_KEEP_BONUS);
  });
});

describe('the newer Lords: abilities', () => {
  it('Death Knight: Soul Reaping makes the allies around him drain life from what they strike', () => {
    const d = run(SCENE.deathknight());
    const me = lordOf(d, 0);
    expect(casts(d, 'soul_reap').some((e) => e.src === me && e.radius > 0 && e.dur > 0)).toBe(true);
    // the drained life is restored to soldiers other than the Lord too
    const rows = d.replay.squads.filter((q) => q.side === 0 && q.type !== 'lord').map((q) => q.row);
    expect(d.tallies!.some((e) => e.cause === 'soul_reap' && e.heal > 0 && rows.includes(e.src))).toBe(true);
  });

  it('Ossuary Warden: Grave Taunt forces the enemies around him to attack him, and he braces', () => {
    const d = run(SCENE.ossuary());
    const me = lordOf(d, 0);
    const cast = casts(d, 'grave_taunt').find((e) => e.src === me && e.radius > 0)!;
    expect(cast).toBeTruthy();
    const marked = casts(d, 'grave_taunt').filter((e) => e.src === me && e.radius === 0 && e.tick === cast.tick).map((e) => e.tgt);
    expect(marked.length).toBeGreaterThanOrEqual(3);
    for (const t of marked) expect(d.replay.soldiers[t].side).toBe(1);
    // while taunted, every attack the marked soldiers make is at him
    const attacks = d.events.filter((e) => e.k === 'attack' && marked.includes(e.src) && e.tick > cast.tick + 1 && e.tick < cast.tick + TAUNT_TICKS);
    expect(attacks.length).toBeGreaterThan(0);
    expect(attacks.every((e) => (e as { tgt: number }).tgt === me)).toBe(true);
  });

  it('Drake Rider: Plague Breath dives onto a cluster, strikes it with magic and leaves it festering', () => {
    const d = run(SCENE.drakerider());
    const me = lordOf(d, 0);
    const cast = casts(d, 'plague_breath').find((e) => e.src === me)!;
    expect(cast).toBeTruthy();
    expect(lordRow(d, 0).byCause.plague_breath ?? 0).toBeGreaterThan(0);
    expect(casts(d, 'burn').some((e) => e.src === me && d.replay.soldiers[e.tgt].side === 1)).toBe(true);
    // she lands where she breathed
    const n = d.soldierCount, f = Math.ceil((cast.tick + cast.dur + 1) / d.replay.frameTicks);
    const dx = d.x[f * n + me] - cast.pos[0], dy = d.y[f * n + me] - cast.pos[1];
    expect(dx * dx + dy * dy).toBeLessThan(900 * 900);
  });

  it('Grand Vizier: the Djinn Whirlwind spins for seconds, cutting and slowing what stands in it', () => {
    const d = run(SCENE.vizier());
    const me = lordOf(d, 0);
    expect(casts(d, 'whirlwind').some((e) => e.src === me && e.radius > 0 && e.dur >= 60)).toBe(true);
    expect(lordRow(d, 0).byCause.whirlwind ?? 0).toBeGreaterThan(0);
    expect(casts(d, 'frost').some((e) => e.src === me)).toBe(true);
  });

  it('Rajah: the Stampede tramples along its path and throws the trampled aside', () => {
    const d = run(SCENE.rajah());
    const me = lordOf(d, 0);
    expect(casts(d, 'stampede').some((e) => e.src === me)).toBe(true);
    expect(lordRow(d, 0).byCause.stampede ?? 0).toBeGreaterThan(0);
    expect(casts(d, 'knockback').some((e) => e.src === me)).toBe(true);
  });

  it('Roc Rider: Talon Strike seizes the toughest enemy, strikes it and drops it towards her own lines', () => {
    const d = run(SCENE.rocrider());
    const me = lordOf(d, 0);
    const cast = casts(d, 'talon').find((e) => e.src === me)!;
    expect(cast).toBeTruthy();
    expect(d.replay.soldiers[cast.tgt].type).toBe('knights'); // the toughest that is not Large
    expect(lordRow(d, 0).byCause.talon ?? 0).toBeGreaterThan(0);
    // dropped: the seized soldier is suddenly much nearer seat 0's side of the field
    const n = d.soldierCount, ft = d.replay.frameTicks;
    const f0 = Math.floor((cast.tick + cast.dur - 1) / ft), f1 = Math.ceil((cast.tick + cast.dur + 2) / ft);
    expect(d.y[f0 * n + cast.tgt] - d.y[f1 * n + cast.tgt]).toBeGreaterThan(TALON_THROW / 2);
  });

  it('every ability is deterministic: the same battle twice is the same replay', () => {
    for (const l of NEW) {
      const a = simulateBattle(SCENE[l]()), b = simulateBattle(SCENE[l]());
      expect(b.replay.events, l).toBe(a.replay.events);
      expect(b.replay.frames, l).toBe(a.replay.frames);
      expect(b.result, l).toEqual(a.result);
      expect(casts(decodeReplay(a.replay), LORDS[l].ability).length, l).toBeGreaterThan(0);
    }
  });
});
