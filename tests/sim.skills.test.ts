// Skills (class-gated skill items, auto-cast in battle), the replay's skill / ledger streams, per-squad battle
// statistics (squadStatsAt) and the squad sheet.
import { describe, expect, it } from 'vitest';
import {
  applyBattle, applyIntent, botPlan, canEquip, classesOf, decodeReplay, itemLines, itemName, lordSkills, newMatch, nextRound, replaySquadSheet, rollLoot,
  simulateBattle, squadDamagePairs, squadSheet, squadSkills, squadStatsAt, squadStatsOf, unitSkills, viewFor, KEEP_SRC_BASE, LORD_IDS, SKILLS, SKILL_IDS, TICK_HZ, UNITS, UNIT_CLASS,
  UNIT_TYPES,
} from '../src/sim/index.ts';
import { SKILL_CODES, STAT_CAUSES, TALLY_TICKS } from '../src/sim/replay.ts';
import { armyClasses } from '../src/sim/match.ts';
import { FLIER_EVADE_PCT } from '../src/sim/battle.ts';
import { FLIER_EVADE } from '../src/sim/data/skills.ts';
import { METEOR_BASE, METEOR_PER_LEVEL } from '../src/sim/data/lords.ts';
import { rollItem, skillFits } from '../src/sim/loot.ts';
import { Rng } from '../src/sim/rng.ts';
import { bigBattle } from '../src/sim/fixtures.ts';
import type { DecodedReplay, Item, LordId, MatchState, Seat, SkillId, Slot, UnitType, Vec2 } from '../src/sim/types.ts';

const BASE_FOR: Record<Slot, Item['base']> = { weapon: 'steel_blade', armor: 'mail_hauberk', relic: 'oath_ring' };
let nextItem = 5000;
function skillItem(skill: SkillId, ilvl = 6): Item {
  const slot = SKILLS[skill].slot;
  return { id: nextItem++, base: BASE_FOR[slot], slot, rarity: 'rare', ilvl, implicit: { id: slot === 'armor' ? 'stalwart' : slot === 'relic' ? 'haste' : 'vicious', value: 1 }, affixes: [], legendary: null, skill };
}

type Spec = [unit: UnitType, level: number, pos: Vec2, skill?: SkillId];
/** A hand-built battle: seat 0's `mine` against seat 1's `theirs` (positions in each seat's own frame, y = distance from own keep). */
function arena(mine: Spec[], theirs: Spec[], lords: [LordId, LordId] = ['warden', 'warden'], seed = 7): MatchState {
  const s = newMatch(seed, lords);
  s.round = 6;
  for (const seat of [0, 1] as Seat[]) {
    const p = s.players[seat];
    // Lords out of the way, in a corner.
    p.squads[0].pos = seat === 0 ? [300, 500] : [7699, 11499];
    for (const [unit, level, pos, skill] of seat === 0 ? mine : theirs) {
      const at: Vec2 = seat === 0 ? pos : [7999 - pos[0], 11999 - pos[1]];
      const items = { weapon: null, armor: null, relic: null } as { weapon: Item | null; armor: Item | null; relic: Item | null };
      if (skill) items[SKILLS[skill].slot] = skillItem(skill);
      p.squads.push({ id: s.nextId++, owner: seat, type: unit, level, pos: at, facing: seat === 0 ? 64 : 192, items, deployedRound: 1, spent: UNITS[unit].cost * level });
    }
  }
  return s;
}

function run(s: MatchState): DecodedReplay {
  return decodeReplay(simulateBattle(s).replay);
}

describe('unit classes and class gating', () => {
  it('every unit type has one class, and Lords have a class of their own plus their fighting style', () => {
    for (const u of UNIT_TYPES) expect(UNIT_CLASS[u]).toBeTruthy();
    expect(classesOf('knights', 'marshal')).toEqual(['infantry']);
    expect(classesOf('mages', null)).toEqual(['caster']);
    expect(classesOf('lord', 'archmage')).toEqual(['lord', 'caster']);
    expect(classesOf('lord', 'skylady')).toEqual(['lord', 'flier']);
    // every skill is usable by somebody, and every class but 'lord'-only has a skill
    for (const k of SKILL_IDS) expect(UNIT_TYPES.some((u) => canEquip({ skill: k }, u, null)) || SKILLS[k].classes.includes('lord')).toBe(true);
    expect(SKILL_IDS.length).toBeGreaterThanOrEqual(10);
    expect(SKILL_IDS.length).toBeLessThanOrEqual(14);
  });

  it('knights do not cast fireballs: applyIntent refuses a skill item on the wrong class, with a clear error', () => {
    const s = newMatch(3, ['warden', 'archmage']);
    const p = s.players[0];
    p.gold = 5000;
    p.unlocked.push('mages');
    applyIntent(s, 0, { t: 'deploy', unit: 'knights', pos: [3000, 3000] });
    applyIntent(s, 0, { t: 'deploy', unit: 'mages', pos: [5000, 2000] });
    const knights = p.squads[1], mages = p.squads[2];
    const fb = skillItem('fireball'), cleave = skillItem('cleave'), cry = skillItem('war_cry');
    p.stash.push(fb, cleave, cry);
    expect(applyIntent(s, 0, { t: 'equip', item: fb.id, squad: knights.id })).toEqual({ ok: false, error: 'only Casters can use Fireball' });
    expect(knights.items.weapon).toBe(null);
    expect(p.stash).toContain(fb);
    expect(applyIntent(s, 0, { t: 'equip', item: fb.id, squad: mages.id }).ok).toBe(true);
    expect(mages.items.weapon).toBe(fb);
    expect(applyIntent(s, 0, { t: 'equip', item: cleave.id, squad: mages.id }).ok).toBe(false);
    expect(applyIntent(s, 0, { t: 'equip', item: cleave.id, squad: knights.id }).ok).toBe(true);
    // moving a skill item between squads obeys the same gate, and nothing is lost on a refusal
    expect(applyIntent(s, 0, { t: 'moveItem', item: fb.id, squad: knights.id }).ok).toBe(false);
    expect(mages.items.weapon).toBe(fb);
    expect(knights.items.weapon).toBe(cleave);
    // the Warden (infantry Lord) may shout a War Cry but not throw a Fireball
    const lord = p.squads[0];
    expect(applyIntent(s, 0, { t: 'equip', item: cry.id, squad: lord.id }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'moveItem', item: fb.id, squad: lord.id })).toEqual({ ok: false, error: 'only Casters can use Fireball' });
    // the Archmage is a caster
    const s2 = newMatch(3, ['archmage', 'warden']);
    const fb2 = skillItem('fireball');
    s2.players[0].stash.push(fb2);
    expect(applyIntent(s2, 0, { t: 'equip', item: fb2.id, squad: s2.players[0].squads[0].id }).ok).toBe(true);
  });

  it('a skill smuggled onto the wrong class never fires in battle', () => {
    const s = arena([['knights', 2, [4000, 3800]]], [['militia', 1, [4000, 3800]]]);
    s.players[0].squads[1].items.weapon = skillItem('fireball');
    const d = run(s);
    expect(d.skills!.length).toBe(0);
  });
});

describe('skill loot', () => {
  it('only Rare items grant skills, in the skill\'s slot, in place of an affix; rarity tiers keep their affix counts', () => {
    let rares = 0, withSkill = 0;
    const seen = new Set<string>();
    for (let seed = 0; seed < 600; seed++) {
      for (const it of rollLoot(seed, 9, 3, () => 0)) {
        const n = it.affixes.length;
        if (it.rarity !== 'rare') { expect(it.skill ?? null).toBe(null); continue; }
        rares++;
        if (it.skill) {
          withSkill++;
          seen.add(it.skill);
          expect(SKILLS[it.skill].slot).toBe(it.slot);
          expect(n >= 2 && n <= 3).toBe(true);
        } else expect(n >= 3 && n <= 4).toBe(true);
      }
    }
    expect(withSkill / rares).toBeGreaterThan(0.3);
    expect(withSkill / rares).toBeLessThan(0.6);
    expect(seen.size).toBe(SKILL_IDS.length);
  });

  it('skill items reach both players alike: the offer does not look at the army', () => {
    const s = newMatch(5, ['marshal', 'marshal']);
    const p = s.players[0];
    p.squads.push({ id: 99, owner: 0, type: 'archers', level: 4, pos: [2000, 2000], facing: 64, items: { weapon: null, armor: null, relic: null }, deployedRound: 1, spent: 100 });
    expect(armyClasses(p).sort()).toEqual(['infantry', 'lord', 'ranged']);
    expect(skillFits({ skill: 'fireball' }, armyClasses(p))).toBe(false);
    expect(skillFits({ skill: 'cleave' }, armyClasses(p))).toBe(true);
    applyIntent(s, 0, { t: 'ready' });
    applyIntent(s, 1, { t: 'ready' });
    applyBattle(s, simulateBattle(s, { record: false }).result);
    const strip = (items: Item[] | null): unknown => (items ?? []).map((it) => ({ ...it, id: 0 }));
    expect(strip(s.players[1].lootOffer)).toEqual(strip(p.lootOffer));
  });

  it('tooltips show the skill block and who can use it', () => {
    const it = skillItem('fireball', 5);
    it.affixes = [{ id: 'vicious', value: 9 }];
    expect(itemName(it)).toMatch(/Vicious Steel Blade of Fireball$/);
    const lines = itemLines(it);
    const text = lines.map((l) => l.text);
    expect(text).toContain('Grants Fireball (10 s cooldown)');
    expect(text.some((t) => t.includes('66 magic damage within 3.5 m') && t.includes('5 damage per second') && t.includes('Cast when:'))).toBe(true);
    expect(text).toContain('Usable by: Casters');
    expect(lines.find((l) => l.kind === 'skill')).toBeTruthy();
    expect(lines.find((l) => l.kind === 'usable')!.style).toBe('meta');
    expect(itemLines(skillItem('shield_wall')).map((l) => l.text)).toContain('Usable by: Infantry and Giants');
    // numbers grow with item level
    const lo = itemLines(skillItem('fireball', 1)).map((l) => l.text).join('|'), hi = itemLines(skillItem('fireball', 10)).map((l) => l.text).join('|');
    expect(lo).toContain('42 magic damage');
    expect(hi).toContain('96 magic damage');
    // rollItem with a class list only grants usable skills
    for (let i = 0; i < 300; i++) {
      const r = rollItem(new Rng(i), i, 5, 'rare', undefined, ['siege']);
      if (r.skill) expect(r.skill).toBe('incendiary_payload');
    }
  });
});

describe('skill lists (innate, Lord, item)', () => {
  it('unitSkills exposes every trait with real numbers', () => {
    const ids = (u: UnitType): string[] => unitSkills(u).map((s) => s.id);
    expect(ids('pikemen')).toEqual(expect.arrayContaining(['anti_mounted', 'brace']));
    expect(ids('cavaliers')).toEqual(expect.arrayContaining(['charge', 'raider']));
    expect(ids('clerics')).toContain('heal');
    expect(ids('archers')).toEqual(expect.arrayContaining(['anti_flier', 'ranged']));
    expect(ids('ballista')).toEqual(expect.arrayContaining(['anti_large', 'pierce']));
    expect(ids('golem')).toEqual(expect.arrayContaining(['stomp', 'crushing', 'armored']));
    expect(ids('dragon')).toEqual(expect.arrayContaining(['cone', 'flier', 'magic']));
    expect(FLIER_EVADE).toBe(FLIER_EVADE_PCT);
    expect(unitSkills('pegasus').find((s) => s.id === 'flier')!.text).toContain(`${FLIER_EVADE_PCT}% less`);
    expect(ids('berserkers')).toContain('lifesteal');
    const heal = unitSkills('clerics').find((s) => s.id === 'heal')!;
    expect(heal.kind).toBe('active');
    expect(heal.cooldown).toBe(UNITS.clerics.attackTicks / TICK_HZ);
    expect(heal.text).toContain(String(UNITS.clerics.heal));
    expect(unitSkills('pikemen').find((s) => s.id === 'anti_mounted')!.text).toContain('x2.5');
    for (const u of UNIT_TYPES) for (const s of unitSkills(u)) { expect(s.source).toBe('innate'); expect(s.name && s.text).toBeTruthy(); }
  });

  it('lordSkills and squadSkills list the passive, the ability and what items add', () => {
    for (const l of LORD_IDS) {
      const sk = lordSkills(l, 3);
      expect(sk.filter((s) => s.kind === 'active').length).toBe(1);
      expect(sk.find((s) => s.kind === 'active')!.cooldown).toBeGreaterThan(5);
      expect(sk.some((s) => s.kind === 'passive' && s.source === 'lord')).toBe(true);
    }
    expect(lordSkills('archmage', 4).find((s) => s.id === 'meteor')!.text).toContain(`${METEOR_BASE + 4 * METEOR_PER_LEVEL} magic damage`);
    const fb = skillItem('fireball', 4);
    const leg: Item = { id: 1, base: 'warded_robe', slot: 'armor', rarity: 'legendary', ilvl: 4, implicit: { id: 'warding', value: 20 }, affixes: [], legendary: 'sunfire' };
    const sk = squadSkills({ type: 'mages', level: 2, items: { weapon: fb, armor: leg, relic: null } });
    expect(sk.find((s) => s.id === 'fireball')).toMatchObject({ kind: 'active', source: 'item', cooldown: 10, item: fb.id, skill: 'fireball' });
    expect(sk.find((s) => s.id === 'sunfire')).toMatchObject({ kind: 'passive', source: 'item', item: 1 });
    expect(sk.find((s) => s.id === 'sunfire')!.text).toContain('28 damage per second');
    expect(sk.some((s) => s.source === 'innate')).toBe(true);
    expect(squadSkills({ type: 'lord', level: 2, items: { weapon: null, armor: null, relic: null } }, 'marshal').some((s) => s.id === 'rally')).toBe(true);
  });
});

describe('every skill triggers and has its effect', () => {
  const front: Vec2 = [4000, 3900];
  const SCEN: Record<SkillId, { mine: Spec[]; theirs: Spec[] }> = {
    fireball: { mine: [['mages', 2, [4000, 3000], 'fireball'], ['knights', 2, front]], theirs: [['militia', 1, front], ['militia', 1, [4600, 3900]]] },
    chain_lightning: { mine: [['mages', 2, [4000, 3000], 'chain_lightning'], ['knights', 2, front]], theirs: [['militia', 1, front]] },
    frost_nova: { mine: [['mages', 4, front, 'frost_nova']], theirs: [['cavaliers', 2, front]] },
    mending_light: { mine: [['clerics', 4, [4000, 3000], 'mending_light'], ['knights', 2, front]], theirs: [['berserkers', 2, front], ['berserkers', 2, [4600, 3900]]] },
    shield_wall: { mine: [['knights', 2, front, 'shield_wall']], theirs: [['berserkers', 1, front]] },
    war_cry: { mine: [['militia', 4, front, 'war_cry'], ['berserkers', 1, [4700, 3900]]], theirs: [['knights', 2, front], ['knights', 2, [4700, 3900]]] },
    cleave: { mine: [['berserkers', 2, front, 'cleave']], theirs: [['militia', 1, front], ['militia', 1, [4500, 3900]]] },
    fire_arrows: { mine: [['archers', 2, [4000, 3000], 'fire_arrows'], ['knights', 2, front]], theirs: [['knights', 1, front]] },
    pinning_shot: { mine: [['archers', 2, [4000, 3000], 'pinning_shot'], ['knights', 2, front]], theirs: [['cavaliers', 1, front]] },
    rain_of_arrows: { mine: [['archers', 2, [4000, 3000], 'rain_of_arrows'], ['knights', 2, front]], theirs: [['militia', 1, front], ['militia', 1, [4600, 3900]]] },
    thunderous_charge: { mine: [['cavaliers', 2, front, 'thunderous_charge']], theirs: [['militia', 1, front], ['militia', 1, [4600, 3900]]] },
    trample: { mine: [['golem', 2, front, 'trample']], theirs: [['militia', 1, front], ['militia', 1, [4600, 3900]]] },
    dive_strike: { mine: [['pegasus', 2, front, 'dive_strike']], theirs: [['militia', 1, front]] },
    incendiary_payload: { mine: [['trebuchet', 2, [4000, 1500], 'incendiary_payload'], ['knights', 2, front]], theirs: [['militia', 1, front], ['militia', 1, [4600, 3900]]] },
  };

  for (const id of SKILL_IDS) {
    it(`${SKILLS[id].name}`, () => {
      const { mine, theirs } = SCEN[id];
      const s = arena(mine, theirs);
      const d = run(s);
      const casts = d.skills!.filter((e) => e.skill === id);
      expect(casts.length, 'casts').toBeGreaterThan(0);
      const first = casts[0];
      const row = d.replay.squads.findIndex((q) => q.skills.includes(id));
      expect(first.squad).toBe(row);
      expect(d.replay.squads[row].soldiers).toContain(first.src);
      expect(d.replay.soldiers[first.src].skills).toEqual([id]);
      // cooldown respected
      for (let i = 1; i < casts.length; i++) expect(casts[i].tick - casts[i - 1].tick).toBeGreaterThanOrEqual(SKILLS[id].cooldown);
      const st = squadStatsOf(squadStatsAt(d, d.replay.ticks), 0, s.players[0].squads.find((q) => Object.values(q.items).some((it) => it?.skill === id))!.id)!;
      const sk = st.skills.find((k) => k.skill === id)!;
      expect(sk.casts).toBe(casts.length);
      // the same battle without the item, identical up to the first cast
      const plain = structuredClone(s);
      for (const q of plain.players[0].squads) for (const it of Object.values(q.items)) if (it) it.skill = null;
      const d0 = run(plain);
      const hpAt = (dd: DecodedReplay, side: Seat, tick: number): number => squadStatsAt(dd, tick).squads.filter((q) => q.side === side).reduce((a, q) => a + q.hp, 0);
      expect(hpAt(d, 1, first.tick - 4)).toBe(hpAt(d0, 1, first.tick - 4));
      switch (id) {
        case 'mending_light':
          expect(sk.healing).toBeGreaterThan(0);
          expect(d.events.some((e) => e.k === 'heal' && e.src === first.src && e.tick === first.tick)).toBe(true);
          expect(first.tgtSquad).toBeGreaterThanOrEqual(0);
          break;
        case 'shield_wall': {
          expect(d.events.some((e) => e.k === 'ability' && e.ability === 'shield_wall' && e.tick === first.tick)).toBe(true);
          // while the wall is up the squad loses less life than without it
          const lost = (dd: DecodedReplay): number => hpAt(dd, 0, first.tick) - hpAt(dd, 0, first.tick + 100);
          expect(lost(d)).toBeLessThan(lost(d0));
          expect(st.mitigated).toBeGreaterThan(squadStatsAt(d0, d0.replay.ticks).squads[st.row].mitigated * 0.5);
          break;
        }
        case 'war_cry': {
          // allies swing more often while the cry lasts
          const swings = (dd: DecodedReplay): number => dd.events.filter((e) => e.k === 'attack' && e.tick > first.tick && e.tick <= first.tick + 120 && e.src < KEEP_SRC_BASE && dd.replay.soldiers[e.src].side === 0).length;
          expect(swings(d)).toBeGreaterThan(swings(d0));
          expect(first.radius).toBe(1000);
          break;
        }
        case 'frost_nova':
        case 'pinning_shot':
        case 'trample':
          expect(sk.damage).toBeGreaterThan(0);
          expect(sk.hits).toBeGreaterThan(0);
          break;
        case 'thunderous_charge': {
          expect(sk.damage).toBeGreaterThan(0);
          const kb = d.events.filter((e) => e.k === 'ability' && e.ability === 'knockback');
          expect(kb.length).toBeGreaterThan(0);
          // the victim really is thrown: its position jumps by about 2 m between the keyframes around the hit
          const e = kb[0] as { tick: number; tgt: number; pos: Vec2 };
          const f0 = Math.floor(e.tick / 4), f1 = f0 + 1, n = d.soldierCount;
          const dx = d.x[f1 * n + e.tgt] - d.x[f0 * n + e.tgt], dy = d.y[f1 * n + e.tgt] - d.y[f0 * n + e.tgt];
          expect(dx * dx + dy * dy).toBeGreaterThan(100 * 100);
          break;
        }
        default:
          expect(sk.damage, 'skill damage').toBeGreaterThan(0);
          expect(sk.hits).toBeGreaterThan(0);
          expect(st.byCause[id]).toBe(sk.damage);
      }
      // skills that deal damage make the squad deal more than its plain attacks alone
      if (sk.damage > 0) expect(st.dealt).toBeGreaterThan(st.byCause.attack ?? 0);
    });
  }

  it('skill power grows with the item level', () => {
    const dmg = (ilvl: number): number => {
      const s = arena(SCEN.fireball.mine, SCEN.fireball.theirs);
      s.players[0].squads[1].items.weapon = skillItem('fireball', ilvl);
      const d = run(s);
      const st = squadStatsAt(d, 400);
      const sk = st.squads.find((q) => q.skills.length)!.skills[0];
      return sk.damage / Math.max(1, sk.hits);
    };
    expect(dmg(10)).toBeGreaterThan(dmg(1));
  });
});

describe('replay: skill casts and the statistics ledger', () => {
  it('is versioned, round-trips, and keeps the classic event list intact', () => {
    const s = arena([['mages', 2, [4000, 3000], 'fireball'], ['cavaliers', 2, [4000, 3900], 'thunderous_charge'], ['clerics', 4, [3000, 3000], 'mending_light']], [['militia', 1, [4000, 3900]], ['berserkers', 2, [4600, 3900]], ['archers', 1, [4000, 3000]]]);
    const { replay } = simulateBattle(s);
    expect(replay.v).toBe(3);
    const wire = JSON.parse(JSON.stringify(replay));
    const d = decodeReplay(wire), d2 = decodeReplay(replay);
    expect(d.events).toEqual(d2.events);
    expect(d.skills).toEqual(d2.skills);
    expect(d.tallies).toEqual(d2.tallies);
    expect(d.events.length).toBe(replay.eventCount);
    for (const e of d.events) expect(['attack', 'projectile', 'impact', 'hit', 'heal', 'death', 'ability', 'keepHit', 'keepStage', 'revive', 'summon']).toContain(e.k);
    expect(d.skills!.length).toBeGreaterThan(2);
    for (const e of d.skills!) {
      expect(SKILL_CODES).toContain(e.skill);
      expect(e.src).toBeLessThan(d.soldierCount);
      expect(replay.squads[e.squad].soldiers).toContain(e.src);
      expect(e.pos[0]).toBeGreaterThanOrEqual(0);
      expect(e.pos[0]).toBeLessThan(8000);
      if (e.tgtSquad >= 0) expect(replay.squads[e.tgtSquad]).toBeTruthy();
    }
    for (let i = 1; i < d.tallies!.length; i++) expect(d.tallies![i].tick).toBeGreaterThanOrEqual(d.tallies![i - 1].tick);
    for (const e of d.tallies!) { expect(STAT_CAUSES).toContain(e.cause); expect(replay.squads[e.tgt]).toBeTruthy(); }
    // every projectile (skill fireballs included) still has exactly one impact
    const spawned = d.events.filter((e) => e.k === 'projectile').length, impacts = d.events.filter((e) => e.k === 'impact').length;
    expect(impacts).toBe(spawned);
    expect(() => decodeReplay({ ...replay, v: 2 as never })).toThrow(/replay version/);
    expect(SKILL_CODES.slice().sort()).toEqual(SKILL_IDS.slice().sort());
    expect(TALLY_TICKS).toBe(10);
    // header rows
    expect(replay.squads.map((q) => q.row)).toEqual(replay.squads.map((_, i) => i));
    expect(replay.squads.flatMap((q) => q.soldiers).sort((a, b) => a - b)).toEqual(replay.soldiers.map((x) => x.id));
  });

  it('stays inside the replay size budget with skills on every squad', () => {
    const s = bigBattle(1, false);
    for (const p of s.players) {
      for (const q of p.squads) {
        for (const k of SKILL_IDS) {
          if (!canEquip({ skill: k }, q.type, p.lord)) continue;
          if (q.type !== 'lord' && q.level < (SKILLS[k].slot === 'relic' ? 4 : SKILLS[k].slot === 'armor' ? 2 : 1)) continue;
          if (!q.items[SKILLS[k].slot]) q.items[SKILLS[k].slot] = skillItem(k);
        }
      }
    }
    const { replay } = simulateBattle(s);
    const d = decodeReplay(replay);
    expect(d.skills!.length).toBeGreaterThan(20);
    expect(JSON.stringify(replay).length).toBeLessThan(400 * 1024);
  });
});

describe('squadStatsAt', () => {
  /** Bot matches with gear, legendaries and skills in play. */
  function battles(): { s: MatchState; d: DecodedReplay }[] {
    const out: { s: MatchState; d: DecodedReplay }[] = [];
    for (const [seed, lords, strats] of [[31, ['archmage', 'warden'], ['hard', 'rush']], [32, ['skylady', 'marshal'], ['hard', 'hard']]] as const) {
      const s = newMatch(seed, [...lords] as [LordId, LordId]);
      for (let r = 0; r < 9 && s.phase === 'planning'; r++) {
        botPlan(s, 0, strats[0], 1);
        botPlan(s, 1, strats[1], 2);
        const o = simulateBattle(s);
        if (r >= 3) out.push({ s: structuredClone(s), d: decodeReplay(o.replay) });
        applyBattle(s, o.result);
        if ((s.phase as string) !== 'results') break;
        nextRound(s);
      }
    }
    return out;
  }
  const all = battles();

  it('damage dealt by one side is damage taken by the other, kills are losses, keep damage matches the result', () => {
    expect(all.length).toBeGreaterThan(6);
    for (const { d } of all) {
      const end = squadStatsAt(d, d.replay.ticks);
      const sum = (side: Seat, f: (q: (typeof end.squads)[number]) => number): number => end.squads.filter((q) => q.side === side).reduce((a, q) => a + f(q), 0);
      // exact, in ledger units
      const led = [0, 0], took = [0, 0], tower = [0, 0], rout = [0, 0];
      for (const e of d.tallies!) {
        const tgtSide = d.replay.squads[e.tgt].side;
        took[tgtSide] += e.dmg;
        if (e.src >= KEEP_SRC_BASE) tower[tgtSide] += e.dmg;
        else if (e.src < 0) rout[tgtSide] += e.dmg;
        else if (d.replay.squads[e.src].side !== tgtSide) led[d.replay.squads[e.src].side] += e.dmg;
        else expect(e.cause === 'thorns' || e.dmg === 0, `friendly damage via ${e.cause}`).toBe(true);
      }
      for (const side of [0, 1] as Seat[]) {
        const other = (1 - side) as Seat;
        expect(led[side] + tower[other] + rout[other]).toBe(took[other]);
        // the rounded per-squad numbers agree with the ledger to within rounding
        expect(Math.abs(sum(side, (q) => q.dealt) - led[side] / 100)).toBeLessThanOrEqual(end.squads.length);
        expect(end.sides[side].dealt).toBe(Math.round(led[side] / 100));
        // kills by one side (+ the other side's tower kills are none: towers shoot enemies) = the other side's losses
        const deaths = d.events.filter((e) => e.k === 'death' && d.replay.soldiers[e.tgt].side === other);
        expect(sum(other, (q) => q.losses)).toBe(deaths.length);
        expect(sum(side, (q) => q.kills)).toBe(deaths.filter((e) => e.k === 'death' && e.src >= 0 && e.src < KEEP_SRC_BASE).length);
        expect(end.sides[side].keepDamage).toBe(d.replay.result.keepDamage[other]);
        expect(sum(side, (q) => q.keepDamage)).toBeLessThanOrEqual(d.replay.result.keepDamage[other]);
        expect(end.sides[other].losses).toBe(d.replay.result.soldiersLost[other]);
      }
    }
  });

  it('life at the start - damage taken + healing received = life now, for every squad at every moment', () => {
    for (const { d } of all) {
      const n = d.soldierCount;
      for (const tick of [0, 99, 399, 400, 599, 799, d.replay.ticks]) {
        // the ledger is written every TALLY_TICKS: compare on a window boundary, on a keyframe
        const t = Math.min(d.replay.ticks, tick);
        const st = squadStatsAt(d, t);
        expect(st.tick).toBe(t);
        const onBoundary = (t + 1) % TALLY_TICKS === 0 || t === d.replay.ticks;
        for (const q of st.squads) {
          expect(q.alive).toBe(q.soldiers - q.losses);
          // A keyframe shows the field at the start of its tick, i.e. after everything up to the tick before.
          const f = Math.min(d.frameCount - 1, Math.floor((t + 1) / 4));
          let alive = 0;
          for (const i of d.replay.squads[q.row].soldiers) if (d.anim[f * n + i] !== 255 && d.hp[f * n + i] > 0) alive++;
          if ((t + 1) % 4 === 0 && t < d.replay.ticks - 4) expect(q.alive, `alive row ${q.row} tick ${t}`).toBe(alive);
          expect(q.hpMax).toBe(d.replay.squads[q.row].soldiers.reduce((a, i) => a + d.replay.soldiers[i].maxHp, 0));
          if (!onBoundary) continue;
          // spawned life - taken + healed = life now (each soldier's HP is rounded up in the keyframes)
          const spawnedMax = d.replay.squads[q.row].soldiers.filter((i) => d.replay.soldiers[i].spawnTick <= t).reduce((a, i) => a + d.replay.soldiers[i].maxHp, 0);
          const expectNow = spawnedMax - q.taken + q.healingReceived;
          let now = 0;
          for (const i of d.replay.squads[q.row].soldiers) if (d.anim[f * n + i] !== 255) now += d.hp[f * n + i];
          if ((t + 1) % 4 === 0 || t === d.replay.ticks) expect(Math.abs(now - expectNow), `row ${q.row} ${q.type} tick ${t}`).toBeLessThanOrEqual(q.soldiers + 1);
        }
      }
    }
  });

  it('is incremental, seekable and cheap; the HP series is sampled once per second', () => {
    const { d } = all[all.length - 1];
    const end = squadStatsAt(d, d.replay.ticks);
    expect(squadStatsAt(d, d.replay.ticks)).toBe(end); // cached for a repeated tick
    const mid = squadStatsAt(d, 200);
    const again = squadStatsAt(decodeReplay(d.replay), 200); // a fresh decode, no history
    expect(mid).toEqual(again);
    expect(squadStatsAt(d, 1e9)).toEqual(end); // clamped; after seeking back and forth
    let prev = 0;
    for (let t = 0; t <= d.replay.ticks; t += 5) {
      const st = squadStatsAt(d, t);
      const dealt = st.sides[0].dealt + st.sides[1].dealt;
      expect(dealt).toBeGreaterThanOrEqual(prev);
      prev = dealt;
    }
    const q = end.squads[1];
    expect(q.hpSeries.length).toBe(Math.floor(d.replay.ticks / TICK_HZ) + 1);
    expect(q.hpSeries[0]).toBe(q.hpMax);
    expect(squadStatsAt(d, 200).squads[1].hpSeries.length).toBe(11);
    // 4 Hz for a whole battle costs next to nothing
    const t0 = performance.now();
    for (let k = 0; k < 3; k++) for (let t = 0; t <= d.replay.ticks; t += 5) squadStatsAt(d, t);
    const perCall = (performance.now() - t0) / (3 * (d.replay.ticks / 5 + 1));
    expect(perCall).toBeLessThan(2);
    // who hurt whom adds up to the damage dealt; a wiped squad knows when it fell
    const pairs = squadDamagePairs(d, d.replay.ticks);
    for (const s of end.squads) {
      let sum = 0;
      for (const v of (pairs.get(s.row) ?? new Map<number, number>()).values()) sum += v;
      expect(Math.abs(sum - s.dealt)).toBeLessThanOrEqual(end.squads.length);
      expect(s.wipedAt >= 0).toBe(s.alive === 0 && s.soldiers > 0);
    }
    // Lord abilities and skills are attributed to their squads
    const causes = new Set(all.flatMap((b) => squadStatsAt(b.d, b.d.replay.ticks).squads.flatMap((x) => Object.keys(x.byCause))));
    expect(causes.has('attack')).toBe(true);
    expect(causes.has('meteor')).toBe(true);
  });

  it('works without a ledger (hand-built replays): falls back to the hit and heal events', () => {
    const { d } = all[0];
    const bare: DecodedReplay = { ...d, tallies: undefined, skills: undefined, replay: { ...d.replay, squads: [] } };
    const st = squadStatsAt(bare, d.replay.ticks);
    expect(st.squads.length).toBe(d.replay.squads.length);
    expect(st.sides[0].dealt).toBeGreaterThan(0);
    expect(st.squads.reduce((a, q) => a + q.kills, 0)).toBe(squadStatsAt(d, d.replay.ticks).squads.reduce((a, q) => a + q.kills, 0));
  });
});

describe('squadSheet', () => {
  it('shows base -> effective stats, items and skills, for your squads and the enemy\'s last army', () => {
    const s = newMatch(4, ['warden', 'archmage']);
    const p = s.players[0];
    p.gold = 9000;
    p.unlocked.push('mages');
    applyIntent(s, 0, { t: 'deploy', unit: 'mages', pos: [4000, 2000] });
    const sq = p.squads[1];
    for (let i = 0; i < 3; i++) applyIntent(s, 0, { t: 'levelUp', squad: sq.id });
    const fb = skillItem('fireball', 4);
    fb.affixes = [{ id: 'vicious', value: 20 }, { id: 'haste', value: 25 }];
    const robe: Item = { id: 77, base: 'warded_robe', slot: 'armor', rarity: 'magic', ilvl: 3, implicit: { id: 'warding', value: 20 }, affixes: [{ id: 'stalwart', value: 10 }], legendary: null };
    p.stash.push(fb, robe);
    expect(applyIntent(s, 0, { t: 'equip', item: fb.id, squad: sq.id }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'equip', item: robe.id, squad: sq.id }).ok).toBe(true);
    const sheet = squadSheet(viewFor(s, 0), sq.id)!;
    expect(sheet).toMatchObject({ squad: sq.id, type: 'mages', level: 4, name: 'Mages', classes: ['caster'] });
    const stat = (k: string) => sheet.stats.find((x) => x.key === k)!;
    expect(stat('hp').value).toBeGreaterThan(stat('hp').base * 1.8); // +75% from levels, +10% item
    expect(stat('damage').value).toBeGreaterThan(stat('damage').base * 1.8);
    expect(stat('attackInterval').value).toBeLessThan(stat('attackInterval').base);
    expect(stat('attackInterval').higherIsBetter).toBe(false);
    expect(stat('magicResist').value).toBe(stat('magicResist').base + 20);
    expect(stat('range')).toMatchObject({ base: 20, value: 20, unit: 'm' });
    expect(stat('soldiers').value).toBe(4);
    expect(stat('dps').value).toBeGreaterThan(stat('dps').base);
    expect(sheet.items.map((i) => [i.slot, i.item?.id ?? null, i.open])).toEqual([['weapon', fb.id, true], ['armor', 77, true], ['relic', null, true]]);
    expect(sheet.items[0].lines.some((l) => l.kind === 'skill')).toBe(true);
    expect(sheet.skills.some((k) => k.skill === 'fireball' && k.source === 'item')).toBe(true);
    expect(sheet.skills.some((k) => k.id === 'splash')).toBe(true);
    // the Lord's sheet carries the Lord's passive in its base
    const lord = squadSheet(viewFor(s, 0), p.squads[0].id)!;
    expect(lord.name).toBe('Warden Hrolf');
    expect(lord.skills.some((k) => k.id === 'bulwark')).toBe(true);
    expect(lord.items.every((i) => i.open)).toBe(true);
    // the enemy cannot see the squad before it fights...
    expect(squadSheet(viewFor(s, 1), sq.id)).toBe(null);
    applyIntent(s, 0, { t: 'ready' });
    applyIntent(s, 1, { t: 'ready' });
    const { replay, result } = simulateBattle(s);
    // ...the replay shows it during the battle...
    const row = replay.squads.findIndex((q) => q.id === sq.id && q.side === 0);
    expect(replaySquadSheet(replay, row)).toEqual(sheet);
    applyBattle(s, result);
    // ...and afterwards it is in the enemy's view of the last army.
    expect(squadSheet(viewFor(s, 1), sq.id)).toEqual(sheet);
    expect(squadSheet(viewFor(s, null), sq.id)).toEqual(sheet);
  });
});
