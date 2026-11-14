// The battle inspector's data mapping (src/ui/inspect-data.ts) on real replays from the sim: the
// model agrees with the ledger, ranks are consistent, causes add up, abilities carry their totals,
// the pair view matches squadDamagePairs, picks map to rows, and the sparkline stays in its box.
import { describe, expect, it } from 'vitest';
import * as sim from '../src/sim/index.ts';
import type { DecodedReplay, Seat } from '../src/sim/types.ts';
import { SKILLS } from '../src/sim/data/skills.ts';
import { castEvents, causeLabel, causeShares, cycleRows, inspectModel, inspectRow, ordinal, pairModel, rankHint, rowOfSoldier, rowOfSquad, sparkPath, tickClock, SPARK_MIN_S } from '../src/ui/inspect-data.ts';
import { draftLines, draftOrder } from '../src/ui/loot.ts';
import { UNITS, UNIT_TYPES } from '../src/sim/data/units.ts';

function battle(seed: number, lords: [sim.LordId, sim.LordId] = ['archmage', 'warden']): DecodedReplay {
  const s = sim.newMatch(seed, lords);
  sim.botPlan(s, 0, 'best', 1);
  sim.botPlan(s, 1, 'best', 1);
  return sim.decodeReplay(sim.simulateBattle(s).replay);
}

const led0 = (dd: DecodedReplay, row: number) => sim.squadStatsAt(dd, dd.replay.ticks).squads[row]!;

describe('inspector data', () => {
  const d = battle(9001);
  const end = d.replay.ticks;
  const st = sim.squadStatsAt(d, end);
  const real = d.replay.squads.filter((q) => !q.summoned && q.type !== 'skeleton');

  it('ordinals and clocks', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
    expect(tickClock(0)).toBe('0:00');
    expect(tickClock(20 * 83)).toBe('1:23');
  });

  it('the model of every squad agrees with the ledger row', () => {
    for (const q of real) {
      const m = inspectModel(d, st, q.row, 0, ['A', 'B'])!;
      const r = st.squads[q.row]!;
      expect(m).not.toBeNull();
      expect(m).toMatchObject({ row: q.row, squad: q.id, side: q.side, type: q.type, level: q.level, dealt: r.dealt, taken: r.taken, mitigated: r.mitigated, kills: r.kills, losses: r.losses, keepDamage: r.keepDamage, hp: r.hp, hpMax: r.hpMax });
      expect(m.alive).toBeGreaterThanOrEqual(0);
      expect(m.alive).toBeLessThanOrEqual(m.soldiers);
      expect(m.wipedAt >= 0).toBe(m.alive === 0);
      expect(m.series.length).toBeGreaterThan(0);
      expect(m.series[0]).toBe(m.hpMax);
      // the sheet is there, with three slots and the squad's abilities
      expect(m.sheet).not.toBeNull();
      expect(m.sheet!.items.length).toBe(3);
      expect(m.skills.length).toBe(m.sheet!.skills.length);
      expect(m.name.length).toBeGreaterThan(0);
    }
  });

  it('a Lord is named by title, and its ability counts its casts from the replay', () => {
    const lord = real.find((q) => q.type === 'lord' && q.side === 0)!;
    const m = inspectModel(d, st, lord.row, 0)!;
    expect(m.name).toBe(`${sim.LORDS.archmage.title} ${sim.LORDS.archmage.name}`);
    expect(m.lord).toBe('archmage');
    const abil = m.skills.find((k) => k.info.source === 'lord' && k.info.kind === 'active')!;
    expect(abil.info.id).toBe('meteor');
    const casts = d.events.filter((e) => e.k === 'ability' && e.ability === 'meteor' && d.replay.soldiers[e.src]?.side === 0).length;
    expect(abil.casts).toBe(casts);
    expect(abil.damage).toBe(st.squads[lord.row]!.byCause.meteor ?? 0);
    // passives carry no cast count
    expect(m.skills.filter((k) => k.info.kind === 'passive').every((k) => k.casts === null)).toBe(true);
    // earlier in the battle it has cast no more than at the end
    const early = inspectModel(d, sim.squadStatsAt(d, Math.floor(end / 3)), lord.row, 0)!;
    expect(early.skills.find((k) => k.info.id === 'meteor')!.casts!).toBeLessThanOrEqual(abil.casts!);
    expect(early.dealt).toBeLessThanOrEqual(m.dealt);
  });

  it('causes are sorted, add up to the damage dealt and are named', () => {
    for (const q of real) {
      const m = inspectModel(d, st, q.row, 0)!;
      const sum = m.causes.reduce((a, c) => a + c.value, 0);
      // per-cause rounding: one point per cause at most
      expect(Math.abs(sum - m.dealt)).toBeLessThanOrEqual(Object.keys(st.squads[q.row]!.byCause).length + 1);
      for (let i = 1; i < m.causes.length; i++) if (m.causes[i]!.cause !== 'other') expect(m.causes[i - 1]!.value).toBeGreaterThanOrEqual(m.causes[i]!.value);
      if (m.causes.length) expect(m.causes.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1, 5);
      for (const c of m.causes) expect(c.label).not.toBe('');
    }
    expect(causeLabel('attack')).toBe('Attacks');
    expect(causeLabel('fireball')).toBe(SKILLS.fireball.name);
    const many = causeShares({ attack: 50, burn: 20, meteor: 10, thorns: 8, chain: 6, sunfire: 4, skyfall: 2 });
    expect(many.length).toBe(6);
    expect(many.at(-1)).toMatchObject({ cause: 'other', value: 6 });
    expect(causeShares({})).toEqual([]);
  });

  it('ranks: one squad per side is the highest, places are consistent, idle squads have none', () => {
    for (const side of [0, 1] as Seat[]) {
      const mine = real.filter((q) => q.side === side && st.squads[q.row]!.dealt > 0 && st.squads[q.row]!.healingDone <= st.squads[q.row]!.dealt);
      const top = mine.filter((q) => /^Highest damage/.test(rankHint(st, q.row, 0, ['A', 'B'])));
      const best = Math.max(...mine.map((q) => st.squads[q.row]!.dealt));
      expect(top.length).toBe(mine.filter((q) => st.squads[q.row]!.dealt === best).length);
      for (const q of mine) {
        const hint = rankHint(st, q.row, 0, ['A', 'B']);
        expect(hint).toMatch(side === 0 ? /your side|the field/ : /the enemy side|the field/);
        const place = 1 + mine.filter((x) => st.squads[x.row]!.dealt > st.squads[q.row]!.dealt).length;
        if (place > 1) expect(hint.startsWith(`${ordinal(place)}-highest damage`)).toBe(true);
      }
    }
    // exactly one squad (or a tie) is the highest on the field
    expect(real.some((q) => rankHint(st, q.row, 0, ['A', 'B']) === 'Highest damage on the field')).toBe(true);
    // nothing has happened at tick 0
    const st0 = sim.squadStatsAt(d, 0);
    for (const q of real) expect(rankHint(st0, q.row, 0, ['A', 'B'])).toBe('');
    // a spectator reads the commanders' names
    const any = real.find((q) => st.squads[q.row]!.dealt > 0)!;
    expect(rankHint(st, any.row, null, ['Ann', 'Bob'])).toMatch(/Ann's side|Bob's side|the field/);
  });

  it('the pair view matches the ledger, both ways', () => {
    const pairs = sim.squadDamagePairs(d, end);
    let checked = 0;
    for (const a of real.filter((q) => q.side === 0)) {
      for (const b of real.filter((q) => q.side === 1)) {
        const p = pairModel(d, st, a.row, b.row);
        expect(p.aToB).toBeGreaterThanOrEqual(pairs.get(a.row)?.get(b.row) ?? 0);
        expect(p.bToA).toBeGreaterThanOrEqual(pairs.get(b.row)?.get(a.row) ?? 0);
        const q = pairModel(d, st, b.row, a.row);
        expect(q.aToB).toBe(p.bToA);
        expect(q.bToA).toBe(p.aToB);
        expect(p.aToBShare).toBeCloseTo(p.aToB / Math.max(1, st.squads[b.row]!.hpMax), 6);
        if (p.aToB || p.bToA) checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    // what a squad took from every enemy squad cannot exceed what it took in all
    for (const b of real.filter((q) => q.side === 1)) {
      const from = real.filter((q) => q.side === 0).reduce((acc, a) => acc + pairModel(d, st, a.row, b.row).aToB, 0);
      expect(from).toBeLessThanOrEqual(st.squads[b.row]!.taken + real.length);
    }
  });

  it('picks map to rows: soldiers, squad ids, the Tab order', () => {
    for (const q of real) {
      for (const i of q.soldiers) expect(rowOfSoldier(d, i)).toBe(q.row);
      expect(rowOfSquad(d, q.id, q.side)).toBe(q.row);
      expect(inspectRow(d, q.row)).toBe(q.row);
    }
    expect(rowOfSoldier(d, -1)).toBe(-1);
    expect(rowOfSoldier(d, 1e6)).toBe(-1);
    expect(rowOfSquad(d, 987654)).toBe(-1);
    expect(inspectRow(d, 1e6)).toBe(-1);
    for (const viewer of [0, 1, null] as (Seat | null)[]) {
      const order = cycleRows(d, viewer);
      expect([...order].sort((a, b) => a - b)).toEqual(real.map((q) => q.row).sort((a, b) => a - b));
      const me = viewer ?? 0;
      // own side first, each side led by its Lord
      expect(d.replay.squads[order[0]!]).toMatchObject({ side: me, type: 'lord' });
      const firstFoe = order.findIndex((r) => d.replay.squads[r]!.side !== me);
      expect(order.slice(0, firstFoe).every((r) => d.replay.squads[r]!.side === me)).toBe(true);
      expect(order.slice(firstFoe).every((r) => d.replay.squads[r]!.side !== me)).toBe(true);
      expect(d.replay.squads[order[firstFoe]!]!.type).toBe('lord');
    }
  });

  it('a raised band is inspected as the squad that raised it', () => {
    const band = d.replay.squads.find((q) => q.summoned);
    if (!band) return; // no skeletons in this battle
    const owner = inspectRow(d, band.row);
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(d.replay.squads[owner]).toMatchObject({ id: band.id, side: band.side, summoned: false });
    for (const i of band.soldiers) expect(rowOfSoldier(d, i)).toBe(owner);
    expect(inspectModel(d, st, band.row, 0)).toBeNull();
  });

  it('cast events are in tick order and point at inspectable rows', () => {
    const casts = castEvents(d);
    expect(casts).toBe(castEvents(d)); // cached
    for (let i = 1; i < casts.length; i++) expect(casts[i]!.tick).toBeGreaterThanOrEqual(casts[i - 1]!.tick);
    for (const c of casts) {
      expect(inspectRow(d, c.row)).toBe(c.row);
      expect(c.name.length).toBeGreaterThan(0);
    }
    const lordCasts = casts.filter((c) => c.lord).length;
    expect(lordCasts).toBe(d.events.filter((e) => e.k === 'ability' && ['rally', 'meteor', 'bulwark', 'skyfall'].includes(e.ability)).length);
    expect(casts.filter((c) => !c.lord).length).toBe((d.skills ?? []).length);
  });

  it('an item skill shows up with its ledger totals', () => {
    // give a Lord an item that grants a skill its class may use, and fight until it casts
    let found: { d: DecodedReplay; row: number; skill: string } | null = null;
    let id = 9000;
    search: for (let seed = 1; seed < 400; seed++) {
      for (const round of [4, 6, 8]) {
        for (const item of sim.rollLoot(seed, round, 3, () => id++)) {
          if (!item.skill) continue;
          const lord = sim.LORD_IDS.find((L) => sim.canEquip(item, 'lord', L));
          if (!lord) continue;
          const s = sim.newMatch(seed, [lord, 'warden']);
          sim.botPlan(s, 0, 'best', 1);
          sim.botPlan(s, 1, 'best', 1);
          const mine = s.players[0].squads.find((q) => q.type === 'lord')!;
          mine.items[item.slot] = item;
          const dd = sim.decodeReplay(sim.simulateBattle(s).replay);
          const cast = (dd.skills ?? []).find((e) => e.skill === item.skill);
          if (!cast) continue;
          found = { d: dd, row: inspectRow(dd, cast.squad), skill: item.skill };
          break search;
        }
      }
    }
    expect(found).not.toBeNull();
    const stE = sim.squadStatsAt(found!.d, found!.d.replay.ticks);
    const m = inspectModel(found!.d, stE, found!.row, 0)!;
    expect(m.type).toBe('lord');
    const row = m.skills.find((k) => k.info.skill === found!.skill)!;
    expect(row).toBeTruthy();
    const led = stE.squads[found!.row]!.skills.find((x) => x.skill === found!.skill)!;
    expect(row.casts).toBe(led.casts);
    expect(row.casts!).toBeGreaterThan(0);
    expect(row.damage).toBe(led.damage);
    expect(row.healing).toBe(led.healing);
    expect(row.hits).toBe(led.hits);
    expect(row.info.cooldown).toBeGreaterThan(0);
    expect(row.info.source).toBe('item');
    // the item is on the sheet, and the cast is in the cast list for the log
    expect(m.sheet!.items.some((x) => x.item?.skill === found!.skill)).toBe(true);
    expect(castEvents(found!.d).some((c) => !c.lord && c.row === found!.row && c.id === found!.skill)).toBe(true);
    // before the first cast the row reads zero
    const first = (found!.d.skills ?? []).find((e) => e.skill === found!.skill)!.tick;
    const before = inspectModel(found!.d, sim.squadStatsAt(found!.d, Math.max(0, first - 1)), found!.row, 0)!;
    expect(before.skills.find((k) => k.info.skill === found!.skill)!.casts).toBe(0);
  });

  it('a Lord that fights shows it: the mapping follows the raw hits, tick by tick', () => {
    // QA saw both Lords at 0 dealt / 0 taken seventeen seconds into a melee and suspected the row mapping.
    // The Lords stand behind the line and join late; this pins the mapping to the replay's own hit events.
    for (const seed of [7, 9001, 4242]) {
      const dd = battle(seed, ['marshal', 'warden']);
      for (const L of dd.replay.squads.filter((q) => q.type === 'lord')) {
        const mine = new Set(L.soldiers);
        const hits = dd.events.filter((e) => e.k === 'hit' && !e.miss) as Extract<(typeof dd.events)[number], { k: 'hit' }>[];
        const firstDealt = hits.find((e) => mine.has(e.src))?.tick ?? Infinity;
        const firstTaken = hits.find((e) => mine.has(e.tgt))?.tick ?? Infinity;
        const first = Math.min(firstDealt, firstTaken);
        expect(first).toBeLessThan(Infinity); // every Lord gets into this fight
        // before its first blow either way: zero, and flagged as not in the fight yet (not a mapping hole)
        const before = inspectModel(dd, sim.squadStatsAt(dd, Math.max(0, first - 1)), L.row, 0)!;
        expect(before).toMatchObject({ dealt: 0, taken: 0, kills: 0, losses: 0, idle: true, rank: '' });
        expect(before.series.every((v) => v === before.hpMax)).toBe(true);
        // one ledger window (TALLY_TICKS) after its first blow the numbers are there
        const after = inspectModel(dd, sim.squadStatsAt(dd, Math.min(dd.replay.ticks, first + 2 * sim.TALLY_TICKS)), L.row, 0)!;
        expect(after.dealt + after.taken).toBeGreaterThan(0);
        expect(after.idle).toBe(false);
        // at the end: it dealt and (if it was ever hit) took damage, never more than the raw hits (the ledger drops overkill)
        const end2 = inspectModel(dd, sim.squadStatsAt(dd, dd.replay.ticks), L.row, 0)!;
        const rawDealt = hits.filter((e) => mine.has(e.src)).reduce((acc, e) => acc + e.dmg, 0);
        const rawTaken = hits.filter((e) => mine.has(e.tgt)).reduce((acc, e) => acc + e.dmg, 0);
        if (firstDealt < Infinity) expect(end2.dealt).toBeGreaterThan(0);
        if (firstTaken < Infinity) expect(end2.taken).toBeGreaterThan(0);
        // attacks alone cannot exceed the raw hits (the ledger drops overkill); burns and abilities come on top
        expect(led0(dd, L.row).byCause.attack ?? 0).toBeLessThanOrEqual(rawDealt + 2);
        expect(end2.taken).toBeLessThanOrEqual(rawTaken + 2);
        expect(end2.taken).toBeGreaterThanOrEqual(Math.min(rawTaken, end2.hpMax) * 0.5);
        // the model is the ledger row of that very squad
        const led = sim.squadStatsAt(dd, dd.replay.ticks).squads[L.row]!;
        expect(led.type).toBe('lord');
        expect(led.squad).toBe(L.id);
        expect(end2).toMatchObject({ dealt: led.dealt, taken: led.taken, type: 'lord', side: L.side });
        // and the life line falls once it has been hurt
        if (end2.taken > 0) expect(Math.min(...end2.series)).toBeLessThan(end2.hpMax);
      }
    }
  });

  it('the sparkline stays inside its box, off its edges, and ends at "now"', () => {
    const lord = real.find((q) => q.type === 'lord')!;
    const m = inspectModel(d, st, lord.row, 0)!;
    const pad = 2.5;
    const { line, area } = sparkPath(m.series, m.hpMax, 100, 26, Math.max(SPARK_MIN_S, m.series.length - 1), pad);
    expect(line.startsWith(`M0.0,${pad.toFixed(1)}`)).toBe(true); // full life at the start, clear of the top edge
    expect(area.endsWith('Z')).toBe(true);
    const pts = [...line.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((x) => [Number(x[1]), Number(x[2])]);
    expect(pts.length).toBe(m.series.length);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(pad - 0.05);
      expect(y).toBeLessThanOrEqual(26 - pad + 0.05);
    }
    for (let i = 1; i < pts.length; i++) expect(pts[i]![0]).toBeGreaterThanOrEqual(pts[i - 1]![0]!);
    expect(pts.at(-1)![0]).toBeCloseTo(100, 0); // a battle longer than the minimum window fills the width
    // few samples: the window never shrinks below SPARK_MIN_S, so 6 seconds are a visible stroke, not a stub or a stretched point
    const few = sparkPath([100, 100, 100, 90, 80, 70], 100, 100, 26, Math.max(SPARK_MIN_S, 5), pad);
    const fp = [...few.line.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((x) => [Number(x[1]), Number(x[2])]);
    expect(fp.length).toBe(6);
    expect(fp.at(-1)![0]).toBeCloseTo(25, 0);
    expect(fp[0]![1]).toBeCloseTo(pad, 5);
    expect(fp.at(-1)![1]).toBeGreaterThan(fp[0]![1]!);
    // one sample is still a drawn stroke; none is nothing; a span shorter than the data cannot run past the box
    const one = sparkPath([5], 10, 100, 26, SPARK_MIN_S, pad);
    expect(one.line).toBe('M0.0,13.0L5.0,13.0');
    expect(sparkPath([], 10, 100, 26)).toEqual({ line: '', area: '' });
    const long = sparkPath(Array.from({ length: 40 }, () => 10), 10, 100, 26, 5);
    expect([...long.line.matchAll(/[ML](-?[\d.]+),/g)].every((x) => Number(x[1]) <= 100)).toBe(true);
    // an untouched squad is a level line at the top inset, an empty one sits at the bottom inset
    expect(sparkPath([10, 10, 10], 10, 100, 26, 20, pad).line).toBe('M0.0,2.5L5.0,2.5L10.0,2.5');
    expect(sparkPath([10, 0], 10, 100, 26, 20, pad).line).toBe('M0.0,2.5L5.0,23.5');
  });
});

describe('recruit cards', () => {
  it('no unit card has an empty line: what it beats or supports, and what it fears', () => {
    for (const u of UNIT_TYPES) {
      const [first, second] = draftLines(u);
      expect(first.text.trim().length, `${u} first line`).toBeGreaterThan(0);
      expect(second.text.trim().length, `${u} second line`).toBeGreaterThan(0);
      expect(first.tip.length).toBeGreaterThan(0);
      expect(second.label).toBe('Fears');
      expect(first.text).not.toBe('–');
    }
  });
  it('a healer supports, Archers answer fliers', () => {
    expect(draftLines('clerics')[0]).toMatchObject({ label: 'Supports', text: 'Heals nearby squads' });
    const arch = draftLines('archers')[0];
    expect(arch.label).toBe('Beats');
    expect(arch.text).toMatch(/Flier/);
    expect(arch.text).toContain(`×${((UNITS.archers.effective?.flier ?? 100) / 100).toFixed((UNITS.archers.effective?.flier ?? 100) % 100 ? 1 : 0)}`);
    expect(draftLines('pikemen')[0].text).toMatch(/Cavaliers/);
  });
  it('the picker order groups classes and keeps every option', () => {
    const opts = UNIT_TYPES.slice();
    const order = draftOrder(opts);
    expect([...order].sort()).toEqual([...opts].sort());
    expect(draftOrder(order)).toEqual(order);
  });
});
