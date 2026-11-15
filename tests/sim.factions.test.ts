// Factions: the pick at match start, per-faction unlock pools, faction identity mechanics, classes and bots.
import { describe, expect, it } from 'vitest';
import {
  applyBattle, applyIntent, botPlan, canEquip, classesOf, decodeReplay, newMatch, nextRound, simulateBattle, squadSheet, squadStatsAt, unitSkills, lordSkills,
  viewFor, FACTIONS, FACTION_IDS, LORDS, LORD_IDS, UNITS, UNIT_CLASS, UNIT_TYPES, factionOfLord, like, unlockOptions,
} from '../src/sim/index.ts';
import { income } from '../src/sim/match.ts';
import { RAISE_BASE } from '../src/sim/battle.ts';
import { UNIT_POWER, LORD_POWER } from '../src/sim/data/balance.ts';
import type { BotStrategy, DecodedReplay, FactionId, Item, LordId, MatchState, Seat, UnitType, Vec2 } from '../src/sim/types.ts';

type Spec = [unit: UnitType, level: number, pos: Vec2];
/** A hand-built battle (positions in each seat's own frame); Lords parked in a corner unless `lordsFight`. */
function arena(mine: Spec[], theirs: Spec[], lords: [LordId, LordId], lordsFight = false): MatchState {
  const s = newMatch(7, lords);
  s.round = 6;
  for (const seat of [0, 1] as Seat[]) {
    const p = s.players[seat];
    if (!lordsFight) p.squads[0].pos = seat === 0 ? [300, 500] : [7699, 11499];
    for (const [unit, level, pos] of seat === 0 ? mine : theirs) {
      const at: Vec2 = seat === 0 ? pos : [7999 - pos[0], 11999 - pos[1]];
      p.squads.push({ id: s.nextId++, owner: seat, type: unit, level, pos: at, facing: seat === 0 ? 64 : 192, items: { weapon: null, armor: null, relic: null }, deployedRound: 1, spent: UNITS[unit].cost * level });
    }
  }
  return s;
}
const run = (s: MatchState): DecodedReplay => decodeReplay(simulateBattle(s).replay);

describe('faction data', () => {
  it('three factions, every unit and Lord in exactly one, with the canonical ids', () => {
    expect(FACTION_IDS).toEqual(['kingdom', 'ashen', 'caliphate']);
    expect(FACTIONS.kingdom.units.length).toBe(14);
    expect(FACTIONS.kingdom.lords).toEqual(['marshal', 'archmage', 'warden', 'skylady']);
    expect(FACTIONS.ashen.units).toEqual(['skeleton', 'grave_knight', 'bone_archer', 'wraith_rider', 'grave_acolyte', 'bone_drake', 'corpse_catapult', 'bone_golem']);
    expect(FACTIONS.ashen.lords).toEqual(['lich']);
    expect(FACTIONS.caliphate.units).toEqual(['spear_levy', 'scimitar', 'camel_archer', 'mamluk', 'djinn_binder', 'sun_priest', 'djinn', 'war_elephant', 'sand_golem']);
    expect(FACTIONS.caliphate.lords).toEqual(['sultana']);
    expect(LORDS.lich.modelId).toBe('lord_lich');
    expect(LORDS.sultana.modelId).toBe('lord_sultana');
    const all = FACTION_IDS.flatMap((f) => FACTIONS[f].units);
    expect(all.slice().sort()).toEqual(UNIT_TYPES.slice().sort());
    expect(FACTION_IDS.flatMap((f) => FACTIONS[f].lords).sort()).toEqual(LORD_IDS.slice().sort());
    for (const u of UNIT_TYPES) {
      const d = UNITS[u];
      expect(d.modelId).toBe(u); // the art pipeline builds models with exactly these ids
      expect(UNITS[like(u)].faction).toBe('kingdom');
      expect(UNIT_CLASS[u]).toBeTruthy();
      expect(UNIT_POWER[u]).toBeGreaterThan(0);
      expect(d.name && d.role).toBeTruthy();
    }
    for (const l of LORD_IDS) {
      expect(LORD_POWER[l]).toBeGreaterThan(0);
      // a Lord's signature units are of its own faction, and basic
      for (const u of LORDS[l].signature) { expect(UNITS[u].faction).toBe(factionOfLord(l)); expect(UNITS[u].basic).toBe(true); }
      expect(lordSkills(l, 3).filter((s) => s.kind === 'active').length).toBe(1);
    }
    for (const f of FACTION_IDS) {
      const F = FACTIONS[f];
      expect(F.name && F.short && F.blurb && F.identity).toBeTruthy();
      expect(F.basic.length).toBeGreaterThanOrEqual(5);
      // every faction can answer fliers from round 1, has a flier, a giant, artillery or a caster, and anti-cavalry
      expect(F.basic.some((u) => UNITS[u].range > 400 && UNITS[u].weapon !== 'stone')).toBe(true);
      expect(F.units.some((u) => UNITS[u].tags.includes('flier'))).toBe(true);
      expect(F.units.some((u) => UNITS[u].tags.includes('large'))).toBe(true);
      expect(F.units.some((u) => (UNITS[u].effective.mounted ?? 0) > 100)).toBe(true);
      expect(F.units.some((u) => UNITS[u].damageType === 'magic')).toBe(true);
    }
  });

  it('new units map onto the existing skill classes', () => {
    expect(classesOf('grave_acolyte', null)).toEqual(['caster']);
    expect(classesOf('camel_archer', null)).toEqual(['ranged']);
    expect(classesOf('war_elephant', null)).toEqual(['giant']);
    expect(classesOf('lord', 'lich')).toEqual(['lord', 'caster']);
    expect(classesOf('lord', 'sultana')).toEqual(['lord', 'infantry']);
    expect(canEquip({ skill: 'fireball' }, 'djinn_binder', null)).toBe(true);
    expect(canEquip({ skill: 'fireball' }, 'grave_knight', null)).toBe(false);
    expect(canEquip({ skill: 'fire_arrows' }, 'bone_archer', null)).toBe(true);
    expect(canEquip({ skill: 'thunderous_charge' }, 'mamluk', null)).toBe(true);
    expect(canEquip({ skill: 'dive_strike' }, 'djinn', null)).toBe(true);
    expect(canEquip({ skill: 'incendiary_payload' }, 'corpse_catapult', null)).toBe(true);
    // every skill has a user in every faction except where the roster has no such class
    expect(unitSkills('grave_acolyte').map((s) => s.id)).toEqual(expect.arrayContaining(['raise', 'lifesteal', 'magic']));
    expect(unitSkills('wraith_rider').map((s) => s.id)).toEqual(expect.arrayContaining(['ethereal', 'charge']));
    expect(unitSkills('sun_priest').map((s) => s.id)).toEqual(expect.arrayContaining(['heal', 'bless']));
    expect(unitSkills('sand_golem').map((s) => s.id)).toContain('regen');
    expect(unitSkills('corpse_catapult').map((s) => s.id)).toContain('plague');
    expect(unitSkills('djinn_binder').map((s) => s.id)).toContain('slowing');
    expect(unitSkills('war_elephant').map((s) => s.id)).toContain('howdah');
  });
});

describe('picking a faction and a Lord', () => {
  it('pickFaction is optional, changeable until the Lord is picked, and the Lord must belong to it', () => {
    const s = newMatch(1, null);
    expect(s.players[0].faction).toBe(null);
    expect(applyIntent(s, 0, { t: 'pickFaction', faction: 'ashen' })).toEqual({ ok: true });
    expect(s.players[0].faction).toBe('ashen');
    expect(applyIntent(s, 0, { t: 'pickFaction', faction: 'nope' as FactionId }).ok).toBe(false);
    // the enemy cannot see the choice during the pick
    expect(viewFor(s, 1).enemy.faction).toBe(null);
    expect(viewFor(s, 0).you!.faction).toBe('ashen');
    expect(applyIntent(s, 0, { t: 'pickLord', lord: 'marshal' })).toEqual({ ok: false, error: 'Marshal Aldric does not lead The Ashen Covenant' });
    expect(applyIntent(s, 0, { t: 'pickFaction', faction: 'caliphate' }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'pickLord', lord: 'sultana' }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'pickFaction', faction: 'ashen' }).ok).toBe(false); // too late
    // seat 1 skips pickFaction: the Lord implies the faction; both may pick the same faction and Lord
    expect(applyIntent(s, 1, { t: 'pickLord', lord: 'sultana' }).ok).toBe(true);
    expect(s.phase).toBe('planning');
    expect(s.players.map((p) => p.faction)).toEqual(['caliphate', 'caliphate']);
    expect(viewFor(s, 0).enemy.faction).toBe('caliphate');
    expect(applyIntent(s, 0, { t: 'pickFaction', faction: 'ashen' }).ok).toBe(false);
    for (const [l, f] of [['marshal', 'kingdom'], ['lich', 'ashen'], ['sultana', 'caliphate']] as const) expect(newMatch(1, [l, l]).players[1].faction).toBe(f);
  });

  it('a player unlocks and deploys only units of the chosen faction; the rule is the same for both', () => {
    const s = newMatch(3, ['lich', 'sultana']);
    const [a, b] = s.players;
    expect(a.unlocked).toEqual(['skeleton', 'grave_acolyte']);
    expect(b.unlocked).toEqual(['spear_levy', 'camel_archer']);
    expect(a.draftOptions).toEqual(['grave_knight', 'bone_archer', 'wraith_rider']);
    expect(b.draftOptions).toEqual(['scimitar', 'mamluk', 'djinn_binder', 'sun_priest']);
    expect(a.draftPicks).toBe(1);
    expect(applyIntent(s, 0, { t: 'draft', unit: 'knights' }).ok).toBe(false);
    expect(applyIntent(s, 0, { t: 'draft', unit: 'scimitar' }).ok).toBe(false);
    expect(applyIntent(s, 0, { t: 'draft', unit: 'wraith_rider' }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'wraith_rider', pos: [4000, 3000] }).ok).toBe(true);
    a.unlocked.push('knights'); // even if it got there somehow
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'knights', pos: [2000, 3000] })).toEqual({ ok: false, error: 'that unit belongs to another faction' });
    a.unlocked.pop();
    applyIntent(s, 0, { t: 'ready' });
    applyIntent(s, 1, { t: 'ready' });
    applyBattle(s, simulateBattle(s, { record: false }).result);
    nextRound(s);
    // from round 2: every locked unit of the faction whose minRound has come
    expect(a.draftOptions).toEqual(['grave_knight', 'bone_archer', 'bone_drake', 'corpse_catapult', 'bone_golem']);
    expect(b.draftOptions).toEqual(unlockOptions(b, 2));
    expect(b.draftOptions).toContain('sand_golem');
    expect(b.draftOptions).not.toContain('war_elephant'); // minRound 3
    expect(unlockOptions(b, 3)).toContain('war_elephant');
    // identical conditions whatever the faction
    expect(a.gold - (300 - 200)).toBe(income(2));
    expect(a.deployLimit).toBe(b.deployLimit);
    const strip = (items: Item[] | null): unknown => (items ?? []).map((it) => ({ ...it, id: 0 }));
    expect(strip(a.lootOffer)).toEqual(strip(b.lootOffer));
    expect(a.keepMax).toBe(b.keepMax);
  });

  it('fairness across factions: every round both players get the same loot offer, income and deploy limit', () => {
    for (const [seed, lords] of [[21, ['lich', 'sultana']], [22, ['sultana', 'warden']], [23, ['archmage', 'lich']], [24, ['lich', 'lich']], [25, ['sultana', 'sultana']]] as const) {
      const s = newMatch(seed, [...lords] as [LordId, LordId]);
      let rounds = 0;
      while (s.phase === 'planning' && rounds < 10) {
        const [a, b] = s.players;
        const strip = (items: Item[] | null): unknown => (items ?? []).map((it) => ({ ...it, id: 0 }));
        expect(strip(b.lootOffer), `loot ${lords} round ${s.round}`).toEqual(strip(a.lootOffer));
        expect(b.deployLimit).toBe(a.deployLimit);
        expect(b.draftPicks <= 1 && a.draftPicks <= 1).toBe(true);
        for (const p of s.players) {
          expect(p.draftOptions).toEqual(unlockOptions(p, s.round));
          for (const u of [...p.unlocked, ...p.draftOptions]) expect(UNITS[u].faction).toBe(p.faction);
        }
        botPlan(s, 0, 'hard', 1);
        botPlan(s, 1, 'normal', 2);
        for (const p of s.players) for (const q of p.squads) if (q.type !== 'lord') expect(UNITS[q.type].faction).toBe(p.faction);
        applyBattle(s, simulateBattle(s, { record: false }).result);
        if ((s.phase as string) !== 'results') break;
        const before = [a.gold, b.gold];
        nextRound(s);
        expect(a.gold - before[0]).toBe(income(s.round));
        expect(b.gold - before[1]).toBe(income(s.round));
        rounds++;
      }
      expect(rounds).toBeGreaterThan(3);
    }
  }, 120_000);
});

describe('faction mechanics', () => {
  it('Ashen: Grave Acolytes raise the fallen as skeletons, up to their quota, and drain life', () => {
    const s = arena([['grave_acolyte', 2, [4000, 3000]], ['grave_knight', 2, [4000, 3900]]], [['militia', 1, [4000, 3900]], ['militia', 1, [4600, 3900]]], ['lich', 'warden']);
    const d = run(s);
    const aco = d.replay.squads.find((q) => q.type === 'grave_acolyte')!;
    const band = d.replay.squads.find((q) => q.summoned && q.id === aco.id && q.side === 0)!;
    expect(band).toBeTruthy();
    expect(band.type).toBe('skeleton');
    expect(band.soldiers.length).toBeGreaterThan(0);
    expect(band.soldiers.length).toBeLessThanOrEqual(RAISE_BASE + 2);
    for (const i of band.soldiers) { expect(d.replay.soldiers[i].summoned).toBe(true); expect(d.replay.soldiers[i].modelId).toBe('skeleton'); }
    expect(d.events.filter((e) => e.k === 'summon').length).toBe(d.replay.soldiers.filter((x) => x.summoned).length);
    expect(d.events.some((e) => e.k === 'ability' && e.ability === 'necromancy' && aco.soldiers.includes(e.src))).toBe(true);
    const st = squadStatsAt(d, d.replay.ticks);
    expect(st.squads[band.row].dealt).toBeGreaterThan(0); // the skeletons fight
    // life drain: acolytes that are being hit heal themselves with their attacks
    const d2 = run(arena([['grave_acolyte', 3, [4000, 3900]]], [['archers', 3, [4000, 3900]], ['archers', 3, [4600, 3900]]], ['lich', 'warden']));
    expect(squadStatsAt(d2, d2.replay.ticks).squads.find((q) => q.type === 'grave_acolyte')!.healingDone).toBeGreaterThan(0);
    // skeletons rise where a soldier fell
    const first = d.events.find((e) => e.k === 'summon') as { pos: Vec2; tick: number };
    expect(d.events.some((e) => e.k === 'death' && e.tick <= first.tick)).toBe(true);
  });

  it('Ashen: the Lich-Priest raises skeletons with Necromancy; Wraith Riders shrug off steel but burn to magic', () => {
    const s = arena([['skeleton', 2, [4000, 3900]]], [['militia', 1, [4000, 3900]], ['militia', 1, [4500, 3900]]], ['lich', 'warden'], true);
    s.players[0].squads[0].pos = [4000, 3000];
    s.players[1].squads[0].pos = [7699, 11499];
    const d = run(s);
    const lich = d.replay.squads.find((q) => q.type === 'lord' && q.side === 0)!;
    expect(d.events.some((e) => e.k === 'ability' && e.ability === 'necromancy' && e.src === lich.soldiers[0] && e.radius > 0)).toBe(true);
    expect(d.replay.squads.some((q) => q.summoned && q.id === lich.id && q.soldiers.length >= 3)).toBe(true);
    // ethereal: the same riders lose less to swords than to magic of equal listed damage
    const sheet = squadSheet(viewFor(arena([['wraith_rider', 1, [4000, 3000]]], [], ['lich', 'lich']), 0), 3)!;
    expect(sheet.stats.find((x) => x.key === 'armor')!.value).toBe(45);
    expect(sheet.stats.find((x) => x.key === 'magicResist')!.value).toBe(-40);
    const lost = (enemy: UnitType): number => {
      const dd = run(arena([['wraith_rider', 3, [4000, 3900]]], [[enemy, 1, [4000, 3900]]], ['lich', 'warden']));
      const q = squadStatsAt(dd, dd.replay.ticks).squads.find((x) => x.type === 'wraith_rider')!;
      return q.mitigated / Math.max(1, q.taken + q.mitigated);
    };
    expect(lost('militia')).toBeGreaterThan(0.35); // steel: nearly half is shrugged off
    expect(lost('mages')).toBeLessThan(0.2); // magic: nothing is (only terrain cover can still help)
  });

  it('negative resistance never corrupts the replay (Sunfire Mantle against ethereal Wraith Riders)', () => {
    const s = arena([['knights', 3, [4000, 3900]]], [['wraith_rider', 2, [4000, 3900]], ['wraith_rider', 2, [4600, 3900]]], ['warden', 'lich']);
    s.players[0].squads[1].items.armor = { id: 9100, base: 'mail_hauberk', slot: 'armor', rarity: 'legendary', ilvl: 6, implicit: { id: 'stalwart', value: 10 }, affixes: [], legendary: 'sunfire' };
    const d = run(s);
    const st = squadStatsAt(d, d.replay.ticks);
    expect(st.squads.find((q) => q.type === 'knights')!.byCause.sunfire ?? 0).toBeGreaterThan(0);
    for (const e of d.tallies!) { expect(e.mit).toBeGreaterThanOrEqual(0); expect(e.dmg).toBeGreaterThanOrEqual(0); expect(e.heal).toBeGreaterThanOrEqual(0); }
    expect(d.events.length).toBe(d.replay.eventCount);
  });

  it('Ashen: the Corpse Catapult spreads plague', () => {
    const d = run(arena([['corpse_catapult', 2, [4000, 1500]], ['grave_knight', 2, [4000, 3900]]], [['militia', 1, [4000, 3900]], ['militia', 1, [4600, 3900]]], ['lich', 'warden']));
    const q = squadStatsAt(d, d.replay.ticks).squads.find((x) => x.type === 'corpse_catapult')!;
    expect(q.byCause.burn ?? 0).toBeGreaterThan(0);
    // the debuff window is an event: one 'burn' when the plague takes hold of a soldier, from the catapult, for 3 s
    const cat = d.replay.squads.find((x) => x.type === 'corpse_catapult')!.soldiers[0];
    const starts = d.events.filter((e) => e.k === 'ability' && e.ability === 'burn') as { src: number; tgt: number; dur: number; tick: number }[];
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.every((e) => e.src === cat && e.dur === 60 && d.replay.soldiers[e.tgt].side === 1)).toBe(true);
    // one event per debuff window, not per refresh: the same soldier is not re-announced within the window
    const seen = new Map<number, number>();
    for (const e of starts) { if (seen.has(e.tgt)) expect(e.tick - seen.get(e.tgt)!).toBeGreaterThanOrEqual(60); seen.set(e.tgt, e.tick); }
  });

  it('debuff windows: slows are announced once as frost events with their source and duration', () => {
    const d = run(arena([['djinn_binder', 2, [4000, 3000]], ['scimitar', 2, [4000, 3900]]], [['militia', 1, [4000, 3900]], ['militia', 1, [4600, 3900]]], ['sultana', 'warden']));
    const binders = d.replay.squads.find((x) => x.type === 'djinn_binder')!.soldiers;
    const slows = d.events.filter((e) => e.k === 'ability' && e.ability === 'frost') as { src: number; tgt: number; dur: number }[];
    expect(slows.length).toBeGreaterThan(0);
    expect(slows.every((e) => binders.includes(e.src) && e.dur === 40 && d.replay.soldiers[e.tgt].side === 1)).toBe(true);
  });

  it('Caliphate: Sun Priests heal and bless, Sand Golems regenerate, Djinn-Binders slow, the Sultana shines', () => {
    const s = arena([['sun_priest', 2, [4000, 3000]], ['scimitar', 2, [4000, 3900]], ['sand_golem', 1, [5200, 3900]], ['djinn_binder', 1, [3000, 3000]]],
      [['berserkers', 2, [4000, 3900]], ['militia', 1, [5200, 3900]], ['militia', 1, [3000, 3900]]], ['sultana', 'warden'], true);
    s.players[0].squads[0].pos = [4600, 3700];
    s.players[1].squads[0].pos = [7699, 11499];
    const d = run(s);
    const st = squadStatsAt(d, d.replay.ticks);
    const of = (t: string) => st.squads.find((x) => x.type === t && x.side === 0)!;
    expect(of('sun_priest').healingDone).toBeGreaterThan(0);
    const priests = d.replay.squads.find((q) => q.type === 'sun_priest')!.soldiers;
    expect(d.events.some((e) => e.k === 'ability' && e.ability === 'war_cry' && priests.includes(e.src))).toBe(true); // the blessing
    // regeneration is attributed to the golem itself
    const dg = run(arena([['sand_golem', 1, [5200, 3900]]], [['militia', 1, [5200, 3900]]], ['sultana', 'warden']));
    const golem = squadStatsAt(dg, dg.replay.ticks).squads.find((x) => x.type === 'sand_golem')!;
    expect(dg.tallies!.some((e) => e.cause === 'regen' && e.src === golem.row && e.tgt === golem.row && e.heal > 0)).toBe(true);
    expect(golem.healingReceived).toBeGreaterThan(golem.hpMax / 20);
    expect(of('djinn_binder').dealt).toBeGreaterThan(0);
    const lord = of('lord');
    expect(d.events.some((e) => e.k === 'ability' && e.ability === 'radiance')).toBe(true);
    expect(lord.byCause.radiance ?? 0).toBeGreaterThan(0);
    // ...and mends wounded allies around her: seen over a bot match
    const m = newMatch(77, ['sultana', 'warden']);
    let healed = false;
    for (let r = 0; r < 8 && m.phase === 'planning' && !healed; r++) {
      botPlan(m, 0, 'hard', 1);
      botPlan(m, 1, 'hard', 2);
      const o = simulateBattle(m);
      healed = decodeReplay(o.replay).tallies!.some((e) => e.cause === 'radiance' && e.heal > 0);
      applyBattle(m, o.result);
      if ((m.phase as string) !== 'results') break;
      nextRound(m);
    }
    expect(healed).toBe(true);
  });

  it("Caliphate: the War Elephant's howdah archers can strike fliers; a Kingdom golem cannot", () => {
    const fight = (giant: UnitType, lord: LordId): number => {
      const d = run(arena([[giant, 2, [4000, 3900]]], [['pegasus', 1, [4000, 3900]]], [lord, 'skylady']));
      return squadStatsAt(d, d.replay.ticks).squads.find((x) => x.type === 'pegasus')!.taken;
    };
    expect(fight('war_elephant', 'sultana')).toBeGreaterThan(0);
    expect(fight('golem', 'warden')).toBe(0);
  });

  it('Lord passives: the Lich-Priest adds damage, the Sultana attack speed', () => {
    const sheet = (lord: LordId, unit: UnitType, key: string): number => {
      const s = arena([[unit, 1, [4000, 3000]]], [], [lord, lord]);
      return squadSheet(viewFor(s, 0), s.players[0].squads[1].id)!.stats.find((x) => x.key === key)!.value;
    };
    // (the same unit under another Lord is only possible in a test: it shows the passive in isolation)
    expect(sheet('lich', 'skeleton', 'damage')).toBeGreaterThan(sheet('warden', 'skeleton', 'damage'));
    expect(sheet('sultana', 'scimitar', 'attackInterval')).toBeLessThan(sheet('warden', 'scimitar', 'attackInterval'));
  });
});

describe('bots play every faction', () => {
  it('all levels finish matches with every Lord, fielding only their faction', () => {
    const strats: BotStrategy[] = ['easy', 'normal', 'hard', 'rush', 'air', 'ranged'];
    let k = 0;
    for (const lord of ['lich', 'sultana'] as LordId[]) {
      for (const strat of strats) {
        const other = LORD_IDS[k % LORD_IDS.length];
        const s = newMatch(40 + k++, [lord, other]);
        const seen = new Set<UnitType>();
        while (s.phase === 'planning') {
          botPlan(s, 0, strat, 1);
          botPlan(s, 1, 'normal', 2);
          for (const q of s.players[0].squads) if (q.type !== 'lord') { seen.add(q.type); expect(UNITS[q.type].faction).toBe(LORDS[lord].faction); }
          expect(s.players[0].ready).toBe(true);
          applyBattle(s, simulateBattle(s, { record: false }).result);
          if ((s.phase as string) !== 'results') break;
          nextRound(s);
        }
        expect(s.phase).toBe('over');
        expect(s.round).toBeLessThan(20);
        expect(seen.size).toBeGreaterThanOrEqual(strat === 'easy' ? 2 : 3);
      }
    }
  }, 180_000);

  it("Normal moves its archers (camel archers too) under the enemy's last-round fliers, and leaves the rest in lane", () => {
    const plan = (theirs: Spec[], enemyLord: LordId): MatchState => {
      const s = arena([['camel_archer', 1, [3999, 2100]], ['scimitar', 1, [3999, 3500]]], theirs, ['sultana', enemyLord]);
      s.players[1].lastArmy = structuredClone(s.players[1].squads);
      s.players[0].gold = 0;
      botPlan(s, 0, 'normal', 1);
      return s;
    };
    const at = (s: MatchState, u: UnitType): Vec2 => s.players[0].squads.find((q) => q.type === u)!.pos;
    // A Wyvern on the far side (x 1300 in seat 1's frame is x 6699 in seat 0's).
    const s = plan([['wyvern', 1, [1300, 3000]], ['knights', 1, [3999, 3500]]], 'warden');
    expect(at(s, 'camel_archer')[0]).toBeGreaterThan(5500);
    expect(at(s, 'scimitar')).toEqual([3999, 3500]);
    // No flier squads (a flying Lord alone does not count): nothing moves.
    const t = plan([['knights', 1, [1300, 3500]]], 'skylady');
    expect(at(t, 'camel_archer')).toEqual([3999, 2100]);
  });

  it("Normal's Warden gives a weapon to a squad, where any other Normal Lord keeps it for the hero", () => {
    const holder = (lord: LordId): string => {
      const s = arena([['knights', 1, [3999, 3500]]], [], [lord, 'marshal']);
      s.players[0].gold = 0;
      s.players[0].stash.push({ id: 9001, base: 'steel_blade', slot: 'weapon', rarity: 'magic', ilvl: 6, implicit: { id: 'vicious', value: 6 }, affixes: [], legendary: null });
      botPlan(s, 0, 'normal', 1);
      return s.players[0].squads.find((q) => q.items.weapon?.id === 9001)!.type;
    };
    expect(holder('warden')).toBe('knights');
    expect(holder('marshal')).toBe('lord');
  });

  it('a bot left to pick its own Lord may pick any of the six', () => {
    const picked = new Set<LordId>();
    for (let seed = 0; seed < 60; seed++) {
      const s = newMatch(seed, null);
      botPlan(s, 0, 'hard', 1);
      botPlan(s, 1, 'easy', 2);
      expect(s.phase).toBe('planning');
      for (const p of s.players) { picked.add(p.lord!); expect(p.faction).toBe(LORDS[p.lord!].faction); }
    }
    expect(picked.size).toBe(6);
  });
});
