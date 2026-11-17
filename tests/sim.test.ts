import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  newMatch, applyIntent, simulateBattle, applyBattle, nextRound, viewFor, botPlan, allReady, forceReady,
  decodeReplay, sampleReplay, makeTransforms, replayHash, itemName, itemLines, rollLoot, income, deployZone, levelUpCost,
  UNITS, LORDS, LEGENDARIES, mirrorPos, KEEP_HP, ARMY_CAP, ANIM_STATES, KEEP_SRC_BASE, BASIC_POOL, UNIT_TYPES, lootSchedule, lootRarity, itemPower, itemBudget, legendaryFits,
} from '../src/sim/index.ts';
import type { Item, MatchState, Seat } from '../src/sim/types.ts';
import { isqrt, angleOf, isin, icos } from '../src/sim/fixed.ts';
import { rollItem } from '../src/sim/loot.ts';
import { AFFIXES } from '../src/sim/data/items.ts';
import { squadSize } from '../src/sim/battle.ts';
import { KEEP_DMG_BASE_PER_ROUND, KEEP_DMG_PER_TIER, LORD_KEEP_DMG } from '../src/sim/match.ts';
import { Rng } from '../src/sim/rng.ts';
import { genTerrain, navFor } from '../src/sim/terrain.ts';
import { GRID_H, GRID_W } from '../src/sim/constants.ts';

/** Play `rounds` rounds with bots; returns the state in the planning phase of the next round. */
function playRounds(seed: number, rounds: number, strats: [string, string] = ['best', 'rush']): MatchState {
  const s = newMatch(seed, ['marshal', 'skylady']);
  for (let r = 0; r < rounds && s.phase === 'planning'; r++) {
    botPlan(s, 0, strats[0] as never, 1);
    botPlan(s, 1, strats[1] as never, 2);
    applyBattle(s, simulateBattle(s, { record: false }).result);
    if ((s.phase as string) !== 'results') break;
    nextRound(s);
  }
  return s;
}

describe('fixed-point maths', () => {
  it('isqrt is exact floor(sqrt)', () => {
    for (let n = 0; n < 20000; n++) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1) * (r + 1) > n).toBe(true);
    }
    for (const n of [2 ** 31 - 1, 2 ** 31, 2 ** 32 + 5, 208_000_000, 1e12]) {
      const r = isqrt(n);
      expect(r * r <= n && (r + 1) * (r + 1) > n).toBe(true);
    }
  });
  it('trig tables and angleOf are mirror-symmetric', () => {
    for (let a = 0; a < 256; a++) {
      expect(isin(a + 128) + isin(a)).toBe(0);
      expect(icos(a + 128) + icos(a)).toBe(0);
    }
    for (let i = 0; i < 2000; i++) {
      const dx = ((i * 7919) % 2001) - 1000, dy = ((i * 104729) % 2001) - 1000;
      if (!dx && !dy) continue;
      expect(angleOf(-dx, -dy)).toBe((angleOf(dx, dy) + 128) & 255);
    }
    expect(angleOf(1, 0)).toBe(0);
    expect(angleOf(0, 1)).toBe(64);
    expect(angleOf(-1, 0)).toBe(128);
    expect(angleOf(0, -1)).toBe(192);
  });
  it('src/sim uses no Math.random, Date or float transcendental maths', () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(__dirname, '../src/sim'));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src, f).not.toMatch(/Math\.random|Date\.|new Date|performance\.now|Math\.(sin|cos|tan|hypot|sqrt|pow|exp|log|atan|atan2|cbrt)\b|\*\*/);
    }
  });
});

describe('terrain', () => {
  it('is seeded and exactly mirrored cell for cell', () => {
    for (const seed of [1, 2, 3, 99, 12345]) {
      const t = genTerrain(seed);
      expect(genTerrain(seed)).toEqual(t);
      const nav = navFor(t);
      for (let cy = 0; cy < GRID_H; cy++) {
        for (let cx = 0; cx < GRID_W; cx++) {
          expect(nav.grid[cy * GRID_W + cx]).toBe(nav.grid[(GRID_H - 1 - cy) * GRID_W + (GRID_W - 1 - cx)]);
        }
      }
      // A river with 2-3 crossings.
      expect(t.features.filter((f) => f.kind === 'river').length).toBe(1);
      const crossings = t.features.filter((f) => f.kind === 'bridge' || f.kind === 'ford').length;
      expect(crossings).toBeGreaterThanOrEqual(2);
      expect(crossings).toBeLessThanOrEqual(3);
      expect(t.features.some((f) => f.kind === 'forest')).toBe(true);
    }
  });
});

describe('match rules', () => {
  it('starts with 300 gold, the Lord placed, signature units + a free choice of 1 basic unit', () => {
    const s = newMatch(5, ['marshal', 'archmage']);
    expect(s.phase).toBe('planning');
    expect(s.round).toBe(1);
    for (const p of s.players) {
      expect(p.gold).toBe(300);
      expect(p.squads.length).toBe(1);
      expect(p.squads[0].type).toBe('lord');
      expect(p.unlocked).toEqual(LORDS[p.lord!].signature);
      expect(p.draftOptions).toEqual(BASIC_POOL.filter((u) => !LORDS[p.lord!].signature.includes(u))); // the whole basic pool, not a random 3
      expect(p.draftPicks).toBe(1);
      expect(p.keepHp).toBe(KEEP_HP);
    }
    // Deploy points: 4, the Marshal 6.
    expect(s.players[0].deployLimit).toBe(6); // Marshal
    expect(s.players[1].deployLimit).toBe(4);
    expect(income(2)).toBe(250);
    expect(income(20)).toBe(500);
    // A level-up costs the same at every level: LEVEL_COST_PCT of the unit's cost.
    expect(levelUpCost('knights', 1)).toBe(80);
    expect(levelUpCost('knights', 4)).toBe(80);
  });

  it('lord pick phase', () => {
    const s = newMatch(5, null);
    expect(s.phase).toBe('lordPick');
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'militia', pos: [4000, 2000] }).ok).toBe(false);
    expect(applyIntent(s, 0, { t: 'pickLord', lord: 'warden' }).ok).toBe(true);
    expect(viewFor(s, 1).enemy.lord).toBe(null); // hidden until both pick
    expect(applyIntent(s, 0, { t: 'pickLord', lord: 'marshal' }).ok).toBe(false);
    expect(applyIntent(s, 1, { t: 'pickLord', lord: 'warden' }).ok).toBe(true);
    expect(s.phase).toBe('planning');
    expect(s.players[0].keepMax).toBe(KEEP_HP + 800);
  });

  it('validates deploys: zone, unlocks, gold, deployment limit, army cap', () => {
    const s = newMatch(7, ['warden', 'marshal']);
    const p0 = s.players[0];
    const z0 = deployZone(0), z1 = deployZone(1);
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'militia', pos: [4000, 2000] }).ok).toBe(false); // not unlocked
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4000, z0.y1 + 1] }).ok).toBe(false); // outside zone
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4000, 9000] }).ok).toBe(false); // enemy half
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4000.5, 2000] }).ok).toBe(false); // non-int
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [z0.x0 - 1, 2000] }).ok).toBe(false);
    expect(applyIntent(s, 1, { t: 'deploy', unit: 'militia', pos: [4000, 2000] }).ok).toBe(false); // seat 1 in seat 0's zone
    expect(applyIntent(s, 1, { t: 'deploy', unit: 'militia', pos: [4000, z1.y0] }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4000, 2000], facing: 300 }).ok).toBe(false);
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4000, 2000] }).ok).toBe(true);
    expect(p0.gold).toBe(150);
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'knights', pos: [3000, 2000] }).ok).toBe(false); // gold
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [3000, 2000] }).ok).toBe(true);
    p0.gold = 10000;
    const r = applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [3500, 2000] });
    expect(r).toEqual({ ok: false, error: 'deployment limit reached' });
    // The Marshal gets 6 points: Militia weigh 1 each, so six in all, and then a Cavalier (2) no longer fits.
    s.players[1].gold = 10000;
    for (let i = 0; i < 4; i++) expect(applyIntent(s, 1, { t: 'deploy', unit: 'militia', pos: [1000 + i * 1000, 9000] }).ok).toBe(true);
    expect(s.players[1].deploysUsed).toBe(5);
    expect(applyIntent(s, 1, { t: 'deploy', unit: 'cavaliers', pos: [2000, 10500] })).toEqual({ ok: false, error: 'not enough deploy points left for that unit' });
    expect(applyIntent(s, 1, { t: 'deploy', unit: 'militia', pos: [5500, 10500] }).ok).toBe(true);
    expect(applyIntent(s, 1, { t: 'deploy', unit: 'militia', pos: [2000, 10500] })).toEqual({ ok: false, error: 'deployment limit reached' });
    // Army cap.
    p0.deployLimit = 99;
    for (let i = 0; i < ARMY_CAP - 2; i++) expect(applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [500 + (i % 7) * 1100, i < 7 ? 600 : 3000] }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [500, 1200] })).toEqual({ ok: false, error: 'army cap reached' });
  });

  it('sell refunds everything (an undo) only in the round deployed; level-ups and the item slot rules', () => {
    const s = newMatch(7, ['warden', 'marshal']);
    const p = s.players[0];
    applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4000, 2000] });
    const sq = p.squads[1];
    expect(applyIntent(s, 0, { t: 'sell', squad: p.squads[0].id }).ok).toBe(false); // the Lord
    expect(applyIntent(s, 0, { t: 'levelUp', squad: sq.id }).ok).toBe(true);
    expect(sq.level).toBe(2);
    expect(p.gold).toBe(300 - 150 - 60);
    expect(applyIntent(s, 0, { t: 'sell', squad: sq.id }).ok).toBe(true);
    expect(p.gold).toBe(300); // the cost and the level-up, in full
    expect(p.deploysUsed).toBe(0);
    applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4000, 2000] });
    applyIntent(s, 0, { t: 'ready' });
    applyIntent(s, 1, { t: 'ready' });
    expect(allReady(s)).toBe(true);
    applyBattle(s, simulateBattle(s).result);
    nextRound(s);
    const sq2 = p.squads[1];
    const before = p.gold;
    // Items: weapon and armor at Lv1, relic at Lv3; Lord has all.
    const mk = (slot: Item['slot'], id: number): Item => {
      const it = rollItem(new Rng(id), id, 2, 'magic');
      return { ...it, slot, base: slot === 'weapon' ? 'steel_blade' : slot === 'armor' ? 'mail_hauberk' : 'oath_ring' };
    };
    p.stash.push(mk('weapon', 900), mk('armor', 901), mk('relic', 902));
    expect(applyIntent(s, 0, { t: 'equip', item: 900, squad: sq2.id }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'equip', item: 902, squad: sq2.id }).ok).toBe(false);
    expect(applyIntent(s, 0, { t: 'equip', item: 902, squad: p.squads[0].id }).ok).toBe(true); // Lord relic
    expect(applyIntent(s, 0, { t: 'moveItem', item: 902, squad: sq2.id }).ok).toBe(false);
    expect(applyIntent(s, 0, { t: 'moveItem', item: 900, squad: p.squads[0].id }).ok).toBe(true);
    expect(sq2.items.weapon).toBe(null);
    expect(p.squads[0].items.weapon?.id).toBe(900);
    expect(applyIntent(s, 0, { t: 'unequip', item: 900 }).ok).toBe(true);
    expect(p.stash.some((i) => i.id === 900)).toBe(true);
    if (p.lootOffer) {
      expect(applyIntent(s, 0, { t: 'pickLoot', index: 9 }).ok).toBe(false);
      expect(applyIntent(s, 0, { t: 'pickLoot', index: 0 }).ok).toBe(true);
      expect(p.lootOffer).toBe(null);
    }
    // Selling in a later round refunds nothing; items go to the stash.
    p.gold = before;
    applyIntent(s, 0, { t: 'equip', item: 900, squad: sq2.id });
    expect(applyIntent(s, 0, { t: 'sell', squad: sq2.id }).ok).toBe(true);
    expect(p.gold).toBe(before);
    expect(p.stash.some((i) => i.id === 900)).toBe(true);
    // Ready locks intents.
    applyIntent(s, 0, { t: 'ready' });
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'berserkers', pos: [4000, 2000] }).ok).toBe(false);
    expect(applyIntent(s, 0, { t: 'unready' }).ok).toBe(true);
    forceReady(s);
    expect(allReady(s)).toBe(true);
  });

  it('income and one free unlock each round', () => {
    const s = playRounds(3, 2);
    expect(s.round).toBe(3);
    for (const p of s.players) {
      expect(p.draftPicks).toBe(1);
      expect(p.draftOptions).toEqual(UNIT_TYPES.filter((u) => UNITS[u].faction === 'kingdom' && !p.unlocked.includes(u) && UNITS[u].minRound <= 3)); // every locked unit of the faction, no dragon yet
      expect(p.draftOptions).not.toContain('dragon');
      expect(p.lootOffer?.length).toBe(p.lord === 'skylady' ? 4 : 3);
      expect(p.unlocked.length).toBe(2 + 2); // signature units + one unlock in each of rounds 1 and 2
      for (const u of p.draftOptions) expect(p.unlocked).not.toContain(u);
    }
  });
});

describe('hidden information', () => {
  it('viewFor never shows the enemy current-round deploys, moves, levels, items, gold or offers', () => {
    const s = playRounds(11, 3);
    expect(s.phase).toBe('planning');
    const before = viewFor(s, 0);
    expect(before.enemy.lastArmy).not.toBe(null);
    expect(JSON.stringify(before)).not.toContain('"stash"'.repeat(2));
    // Seat 1 does everything it can this round.
    const p1 = s.players[1];
    p1.gold += 3000;
    botPlan(s, 1, 'random', 9);
    applyIntent(s, 1, { t: 'unready' });
    for (const q of p1.squads) if (q.type !== 'lord') applyIntent(s, 1, { t: 'levelUp', squad: q.id });
    applyIntent(s, 1, { t: 'move', squad: p1.squads[0].id, pos: [1000, 10000] });
    const after = viewFor(s, 0);
    expect(after).toEqual(before);
    // The enemy block contains only public fields.
    expect(Object.keys(after.enemy).sort()).toEqual(['faction', 'keepHp', 'keepMax', 'lastArmy', 'lord', 'ready', 'seat']);
    expect(JSON.stringify(after.enemy.lastArmy)).toBe(JSON.stringify(s.players[1].lastArmy));
    // Mutating the view cannot touch the state.
    after.you!.gold = -1;
    after.enemy.lastArmy![0].level = 99;
    expect(s.players[0].gold).not.toBe(-1);
    expect(s.players[1].lastArmy![0].level).not.toBe(99);
    // Round 1 shows nothing.
    expect(viewFor(newMatch(1, ['warden', 'warden']), 1).enemy.lastArmy).toBe(null);
    // Spectators see both public views and no private state.
    const spec = viewFor(s, null);
    expect(spec.you).toBe(null);
    expect(spec.enemies!.length).toBe(2);
  });
});

describe('loot', () => {
  it('is reproducible per (seed, round), one item per slot, on a fixed rarity schedule', () => {
    let id = 1;
    const a = rollLoot(42, 4, 3, () => id++);
    id = 1;
    expect(rollLoot(42, 4, 3, () => id++)).toEqual(a);
    id = 1;
    expect(rollLoot(43, 4, 3, () => id++)).not.toEqual(a);
    // one rarity for the whole offer: Magic, then Rare, and every 3rd round all Legendary
    expect(lootSchedule(1)).toEqual(['magic', 'magic', 'magic']);
    expect(lootSchedule(2)).toEqual(['magic', 'magic', 'magic']);
    expect(lootSchedule(3)).toEqual(['legendary', 'legendary', 'legendary']);
    expect(lootSchedule(4)).toEqual(['rare', 'rare', 'rare']);
    expect(lootSchedule(6)).toEqual(['legendary', 'legendary', 'legendary']);
    expect(lootSchedule(8)).toEqual(['rare', 'rare', 'rare']);
    expect(lootSchedule(9)).toEqual(['legendary', 'legendary', 'legendary']);
    expect(lootSchedule(10)).toEqual(['rare', 'rare', 'rare']);
    expect(lootSchedule(12)).toEqual(['legendary', 'legendary', 'legendary']);
    for (let seed = 0; seed < 200; seed++) {
      for (const round of [1, 2, 3, 4, 5, 6, 8, 9, 12, 13]) {
        const offer = rollLoot(seed, round, 3, () => 0);
        // always one weapon, one armor, one relic: something is usable whatever the army
        expect(offer.map((it) => it.slot)).toEqual(['weapon', 'armor', 'relic']);
        // the rarities are the schedule's, exactly: nothing is rolled, and all three share one
        expect(offer.map((it) => it.rarity)).toEqual(lootSchedule(round));
        for (const it of offer) {
          expect(it.ilvl).toBe(round);
          const n = it.affixes.length;
          if (it.rarity === 'magic') expect(n).toBe(2);
          if (it.rarity === 'rare') expect(n + (it.skill ? 1 : 0)).toBe(3); // a granted skill takes an affix's place
          if (it.rarity === 'legendary') { expect(n).toBe(2); expect(LEGENDARIES[it.legendary!].slot).toBe(it.slot); }
          if (it.affixes.some((x) => x.id === 'command')) { expect(it.slot).toBe('relic'); expect(['rare', 'legendary']).toContain(it.rarity); }
          // each slot is one kind: every line of a weapon is offence, of an armor defence, of a relic utility
          for (const x of [it.implicit, ...it.affixes]) expect(AFFIXES[x.id].slots).toEqual([it.slot]);
        }
        // equal power: every item of the offer is worth its rarity's budget (within rounding)
        const budget = itemBudget(lootRarity(round), round);
        for (const it of offer) expect(Math.abs(itemPower(it) - budget)).toBeLessThanOrEqual(1);
        // one offer never repeats a legendary power
        const legs = offer.map((it) => it.legendary).filter(Boolean);
        expect(new Set(legs).size).toBe(legs.length);
        // Skylady's fourth item is of the same rarity and budget, and the first three are unchanged
        const four = rollLoot(seed, round, 4, () => 0);
        expect(four.slice(0, 3)).toEqual(offer);
        expect(four[3].rarity).toBe(lootRarity(round));
        expect(Math.abs(itemPower(four[3]) - budget)).toBeLessThanOrEqual(1);
      }
    }
  });
  it('legendary powers work only on the wheel classes they are built for', () => {
    for (const L of Object.values(LEGENDARIES)) {
      expect(L.best.length).toBeGreaterThan(0);
      expect(L.power).toBe(LEGENDARIES.stormcaller.power);
      for (const u of UNIT_TYPES) expect(legendaryFits(L.id, u, null)).toBe(L.best.includes(UNITS[u].class));
      for (const l of Object.keys(LORDS) as (keyof typeof LORDS)[]) expect(legendaryFits(L.id, 'lord', l)).toBe(L.best.includes(LORDS[l].class));
    }
    // every class has a legendary built for it
    const covered = new Set(Object.values(LEGENDARIES).flatMap((L) => L.best));
    for (const c of ['swarm', 'giant', 'line', 'cavalry', 'ranged', 'air', 'siege', 'magic'] as const) expect(covered.has(c)).toBe(true);
    // the tooltip says what it is built for
    const leg: Item = { id: 1, base: 'ironbark_bow', slot: 'weapon', rarity: 'legendary', ilvl: 3, implicit: { id: 'vicious', value: 9 }, affixes: [], legendary: 'hydra_volley' };
    expect(itemLines(leg).some((l) => l.text.startsWith('Best on: Ranged, Siege'))).toBe(true);
  });
  it('a dormant legendary changes nothing in battle', () => {
    // Warhorn on a Swarm squad adds soldiers; on a Ranged squad it sleeps.
    const horn: Item = { id: 1, base: 'war_banner', slot: 'relic', rarity: 'legendary', ilvl: 3, implicit: { id: 'fleet', value: 1 }, affixes: [], legendary: 'warhorn' };
    const swarm = UNIT_TYPES.find((u) => UNITS[u].class === 'swarm')!;
    const ranged = UNIT_TYPES.find((u) => UNITS[u].class === 'ranged')!;
    const none = { weapon: null, armor: null, relic: null };
    expect(squadSize({ type: swarm, items: { ...none, relic: horn } })).toBe(squadSize({ type: swarm, items: none }) + 4);
    expect(squadSize({ type: ranged, items: { ...none, relic: horn } })).toBe(squadSize({ type: ranged, items: none }));
  });
  it('affix values scale with item level', () => {
    let lo = 0, hi = 0;
    for (let i = 0; i < 300; i++) {
      lo += rollItem(new Rng(i), 1, 1, 'rare').implicit.value;
      hi += rollItem(new Rng(i), 1, 12, 'rare').implicit.value;
    }
    expect(hi).toBeGreaterThan(lo);
  });
  it('has ARPG names and tooltips', () => {
    const it: Item = {
      id: 1, base: 'ironbark_bow', slot: 'weapon', rarity: 'magic', ilvl: 4, implicit: { id: 'farreach', value: 250 },
      affixes: [{ id: 'vicious', value: 9 }, { id: 'haste', value: 7 }], legendary: null,
    };
    expect(itemName(it)).toBe('Vicious Ironbark Bow of Haste');
    const lines = itemLines(it);
    expect(lines[0]).toEqual({ text: 'Vicious Ironbark Bow of Haste', style: 'name' });
    expect(lines.map((l) => l.text)).toContain('+9% damage');
    expect(lines.map((l) => l.text)).toContain('+7% attack speed');
    const leg: Item = { ...it, rarity: 'legendary', legendary: 'stormcaller', base: 'war_axe', implicit: { id: 'haste', value: 8 } };
    expect(itemName(leg)).toBe('Stormcaller War Axe');
    expect(itemLines(leg).some((l) => l.style === 'legendary')).toBe(true);
    expect(itemLines(leg).some((l) => l.style === 'flavor')).toBe(true);
    expect(Object.keys(LEGENDARIES).length).toBeGreaterThanOrEqual(12);
  });
});

describe('battle', () => {
  it('is deterministic (identical replay hash) and pure', () => {
    const s = playRounds(21, 4);
    const snap = structuredClone(s);
    const a = simulateBattle(s);
    expect(s).toEqual(snap);
    const b = simulateBattle(structuredClone(s));
    expect(replayHash(b.replay)).toBe(replayHash(a.replay));
    expect(b.result).toEqual(a.result);
    // Non-recording mode gives the same result.
    expect(simulateBattle(s, { record: false }).result).toEqual(a.result);
  });

  it('produces a decodable replay the client can sample', () => {
    const s = playRounds(8, 5);
    const { replay, result } = simulateBattle(s);
    const d = decodeReplay(replay);
    expect(d.soldierCount).toBe(replay.soldiers.length);
    expect(d.events.length).toBe(replay.eventCount);
    expect(d.frameCount).toBe(Math.floor(replay.ticks / replay.frameTicks) + 1 + (replay.ticks % replay.frameTicks ? 1 : 0));
    const kinds = new Set(d.events.map((e) => e.k));
    for (const k of ['attack', 'hit', 'death']) expect(kinds.has(k as never)).toBe(true);
    // Events are tick-ordered, soldiers referenced exist.
    for (let i = 1; i < d.events.length; i++) expect(d.events[i].tick).toBeGreaterThanOrEqual(d.events[i - 1].tick);
    for (const e of d.events) if (e.k === 'hit' || e.k === 'death') expect(e.tgt).toBeLessThan(d.soldierCount);
    // Projectile impacts match spawns.
    const spawned = new Map(d.events.filter((e) => e.k === 'projectile').map((e) => [(e as { id: number }).id, e]));
    for (const e of d.events) if (e.k === 'impact') expect(spawned.has(e.id)).toBe(true);
    // ...and every projectile has exactly one impact, at its landing tick.
    const impacts = d.events.filter((e) => e.k === 'impact');
    expect(impacts.length).toBe(spawned.size);
    expect(new Set(impacts.map((e) => (e as { id: number }).id)).size).toBe(spawned.size);
    // Attacks carry hitTick; melee hits from that attacker land exactly then (unless the swing was cancelled).
    const hitsAt = new Set(d.events.filter((e) => e.k === 'hit').map((e) => `${(e as { src: number }).src}@${e.tick}`));
    let melee = 0, synced = 0;
    for (const e of d.events) {
      if (e.k !== 'attack') continue;
      expect(e.hitTick).toBeGreaterThan(e.tick);
      if (e.projectile === 'none' && e.tgt < d.soldierCount) { melee++; if (hitsAt.has(`${e.src}@${e.hitTick}`)) synced++; }
    }
    expect(synced).toBeGreaterThan(melee * 0.6); // the rest: target or attacker died during the windup
    expect(KEEP_SRC_BASE).toBe(1_000_000);
    // Keep damage in events sums to the result.
    for (const seat of [0, 1] as Seat[]) {
      const sum = d.events.filter((e) => e.k === 'keepHit' && e.seat === seat).reduce((a, e) => a + (e as { dmg: number }).dmg, 0);
      expect(sum).toBe(Math.min(result.keepDamage[seat], s.players[seat].keepHp));
    }
    const tf = makeTransforms(d.soldierCount);
    for (const t of [0, 123, 5000, 20000, replay.ticks * 50, 1e9]) {
      sampleReplay(d, t, tf);
      for (let i = 0; i < d.soldierCount; i++) {
        if (!tf.visible[i]) continue;
        expect(Number.isFinite(tf.x[i]) && Number.isFinite(tf.y[i]) && Number.isFinite(tf.facing[i])).toBe(true);
        expect(tf.x[i]).toBeGreaterThanOrEqual(0);
        expect(tf.x[i]).toBeLessThanOrEqual(8000);
        expect(ANIM_STATES[tf.anim[i]]).toBeDefined();
      }
    }
    // Header rows are complete.
    for (const so of replay.soldiers) {
      expect(so.modelId).toBeTruthy();
      if (so.type !== 'lord' && so.type !== 'skeleton') expect(so.modelId).toBe(UNITS[so.type].modelId);
    }
  });

  it('keep damage follows the formula: winner gets survivors + 50 x round, timeout halves', () => {
    const s = newMatch(3, ['warden', 'warden']);
    s.players[0].unlocked.push('knights');
    s.players[0].gold = 1000;
    applyIntent(s, 0, { t: 'deploy', unit: 'knights', pos: [4000, 3000] });
    applyIntent(s, 0, { t: 'deploy', unit: 'knights', pos: [3000, 3000] });
    s.players[1].squads = []; // no army at all: instant wipe
    for (const q of s.players[0].squads) q.pos = [q.pos[0], 8500]; // start close to the enemy keep (test only)
    const { result, replay } = simulateBattle(s);
    expect(result.winner).toBe(0);
    expect(result.survivors[0].length).toBe(3);
    expect(result.keepDamage[1]).toBe(KEEP_DMG_BASE_PER_ROUND * 1 + 2 * KEEP_DMG_PER_TIER * 2 + LORD_KEEP_DMG);
    expect(result.keepDamage[0]).toBe(0);
    const d = decodeReplay(replay);
    expect(d.events.some((e) => e.k === 'keepHit' && !e.final)).toBe(true);
  });

  it('a full bot match ends with a winner', () => {
    const s = newMatch(77, ['archmage', 'warden']);
    while (s.phase === 'planning') {
      botPlan(s, 0, 'counter');
      botPlan(s, 1, 'armor');
      applyBattle(s, simulateBattle(s, { record: false }).result);
      if ((s.phase as string) !== 'results') break;
      nextRound(s);
    }
    expect(s.phase).toBe('over');
    expect(s.winner === 0 || s.winner === 1 || s.winner === 'draw').toBe(true);
    expect(s.round).toBeGreaterThan(3);
    expect(Math.min(s.players[0].keepHp, s.players[1].keepHp)).toBe(0);
    expect(mirrorPos([0, 0])).toEqual([7999, 11999]);
  });
});
