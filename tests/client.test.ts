// Client-side pure helpers (src/ui/gamedata.ts, hud.ts) and the local dev-harness match
// (src/ui/local.ts) driving the real sim through RoomView snapshots like the server does.
import { describe, expect, it, vi } from 'vitest';
import { compareItems, counters, effectiveStats, formation, itemStats, soldierStats, squadRadius, slotOpen, wheelText, deployRefusal, levelGainText, rarityRank } from '../src/ui/gamedata.ts';
import { niceError } from '../src/ui/hud.ts';
import { LocalMatch } from '../src/ui/local.ts';
import type { Item, LordId, Replay, Seat, Squad, UnitType } from '../src/sim/types.ts';
import { buildStats } from '../src/sim/battle.ts';
import { sheetOf } from '../src/sim/sheet.ts';
import { TICK_HZ } from '../src/sim/constants.ts';
import { LORDS } from '../src/sim/data/lords.ts';
import { squadTooltip, unitTooltip } from '../src/ui/units.ts';
import type { RoomView } from '../src/net/protocol.ts';
import { UNITS, UNIT_TYPES } from '../src/sim/data/units.ts';
import { applyIntent, newMatch } from '../src/sim/match.ts';
import { decodeReplay, mirrorPos, simulateBattle } from '../src/sim/index.ts';
import { formationOf } from '../src/ui/formation.ts';
import { SLOT_UNLOCK_LEVEL } from '../src/sim/data/items.ts';

const item = (over: Partial<Item> = {}): Item => ({
  id: 1, base: 'steel_blade', slot: 'weapon', rarity: 'magic', ilvl: 3,
  implicit: { id: 'vicious', value: 10 }, affixes: [{ id: 'haste', value: 6 }], legendary: null, ...over,
});

describe('unit readings', () => {
  it('reads the counter wheel: every unit has a class it beats and one it is weak to', () => {
    expect(wheelText('pikemen')).toBe('Line · Beats Cavalry · Weak to Giant');
    expect(wheelText('lord', 'rajah')).toBe('Giant · Beats Line · Weak to Swarm');
    for (const u of UNIT_TYPES) {
      const c = counters(u);
      expect(c.threats.length, u).toBeGreaterThan(0);
      for (const x of c.threats) expect(UNITS[x].class).toBe(c.weakTo);
    }
    expect(counters('pikemen').prey).toContain('cavaliers');
    expect(counters('archers').prey).toContain('pegasus');
    expect(counters('clerics').prey).toEqual([]); // healers hunt nothing
  });
  it('says why a unit does not fit the deploy points left, and what a level gives', () => {
    expect(deployRefusal('militia', 3, 4)).toBeNull();
    expect(deployRefusal('golem', 2, 4)).toBe('Needs 3 deploy points, 2 left');
    expect(deployRefusal('knights', 4, 4)).toMatch(/No deploy points left/);
    expect(levelGainText('militia', 1)).toBe('+3 soldiers');
    expect(levelGainText('knights', 1)).toMatch(/life/);
  });
  it('formation has one offset per soldier, centred; wide is a line, deep a column, mirrored for seat 1', () => {
    for (const u of UNIT_TYPES) {
      const f = formation(u, 0);
      expect(f.length).toBe(UNITS[u].squadSize);
      const cx = f.reduce((a, p) => a + p[0], 0) / f.length;
      expect(Math.abs(cx)).toBeLessThan(UNITS[u].radius * 2 + 50);
    }
    const span = (f: [number, number][], i: 0 | 1) => Math.max(...f.map((p) => p[i])) - Math.min(...f.map((p) => p[i]));
    const wide = formation('militia', 0, 'wide'), deep = formation('militia', 0, 'deep');
    expect(span(wide, 0)).toBeGreaterThan(span(wide, 1));
    expect(span(deep, 1)).toBeGreaterThan(span(deep, 0));
    // the front rank is nearest the enemy: up the field for seat 0, down it for seat 1
    expect(formation('militia', 1, 'deep')).toEqual(deep.map(([x, y]) => [0 - x + 0, 0 - y + 0]));
    expect(deep[0]![1]).toBeGreaterThan(0);
    // one or two soldiers (and the Lord) have no formation: deep is ignored
    expect(formation('ballista', 0, 'deep')).toEqual(formation('ballista', 0, 'wide'));
    expect(squadRadius('militia')).toBeGreaterThan(squadRadius('lord'));
  });

  it('planning draws every soldier exactly where the battle starts it, wide and deep, both seats (no jump at the hand-over)', () => {
    const s = newMatch(31, ['marshal', 'warden']);
    const types: UnitType[] = ['militia', 'knights', 'archers', 'berserkers'];
    for (const seat of [0, 1] as Seat[]) {
      const p = s.players[seat];
      p.gold = 9000;
      p.deployLimit = 99;
      for (const u of types) if (!p.unlocked.includes(u)) p.unlocked.push(u);
      types.forEach((u, i) => {
        const pos: [number, number] = [1500 + i * 1700, 3300];
        expect(applyIntent(s, seat, { t: 'deploy', unit: u, pos: seat === 0 ? pos : mirrorPos(pos), formation: i % 2 ? 'deep' : 'wide' })).toEqual({ ok: true });
      });
    }
    const d = decodeReplay(simulateBattle(s).replay);
    for (const seat of [0, 1] as Seat[]) for (const q of s.players[seat].squads) {
      const mem = d.replay.soldiers.map((o, k) => (o.side === seat && o.squad === q.id ? k : -1)).filter((k) => k >= 0);
      const offs = formation(q.type, seat, formationOf(q), mem.length);
      expect(offs.length).toBe(mem.length);
      mem.forEach((k, i) => {
        expect(d.x[k]).toBe(q.pos[0] + offs[i]![0]);
        expect(d.y[k]).toBe(q.pos[1] + offs[i]![1]);
      });
    }
  });
  it('shown stats are the battle stats of the sim (power multipliers, damage scale, levels, Lord passive)', () => {
    const none = { weapon: null, armor: null, relic: null };
    const lords = [null, ...(Object.keys(LORDS) as LordId[])];
    for (const u of UNIT_TYPES) for (const level of [1, 2, 3]) for (const lord of lords) {
      const s = soldierStats(u, level, lord);
      const st = buildStats({ type: u, level, items: none }, lord);
      const sheet = sheetOf({ id: 0, type: u, level, items: none }, lord);
      const line = (k: string): number => sheet.stats.find((l) => l.key === k)!.value;
      expect(s.hp).toBe(Math.ceil(st.hp / 100));
      expect(s.hp).toBe(line('hp'));
      expect(s.dmg).toBe(line('damage'));
      expect(s.squadDps).toBe(line('dps'));
      expect(s.size).toBe(line('soldiers'));
      expect(s.dps).toBeCloseTo(((st.dmg / 100) * TICK_HZ) / st.atk, 6);
    }
    for (const lord of Object.keys(LORDS) as LordId[]) {
      expect(soldierStats('lord', 2, lord).hp).toBe(Math.ceil(buildStats({ type: 'lord', level: 2, items: none }, lord).hp / 100));
    }
    // the tooltips print those numbers, not the raw table
    const m = soldierStats('militia', 1);
    expect(unitTooltip('militia')).toContain(`<b>${m.hp}</b>`);
    expect(unitTooltip('militia')).toContain(`<b>${m.squadDps}</b>`);
    // a squad on the field: its items count too
    const sq = { id: 1, type: 'knights' as const, level: 3, items: { weapon: item(), armor: null, relic: null }, pos: [0, 0], facing: 0, owner: 0 } as unknown as Squad;
    const eff = effectiveStats(sq, 'warden');
    expect(eff.hp).toBe(sheetOf(sq, 'warden').stats.find((l) => l.key === 'hp')!.value);
    expect(squadTooltip(sq, 'warden')).toContain(`${eff.hp}</span>`);
    expect(squadTooltip(sq, 'warden')).toContain(`${eff.dps.toFixed(1)} dps`);
  });
  it('level stats grow with level', () => {
    const l1 = soldierStats('knights', 1);
    const l3 = soldierStats('knights', 3);
    expect(l3.hp).toBeGreaterThan(l1.hp);
    expect(l3.dmg).toBeGreaterThan(l1.dmg);
    expect(l1.size).toBe(UNITS.knights.squadSize);
  });
  it('slots open at the unlock levels of the sim; the Lord has all three', () => {
    const { armor, relic } = SLOT_UNLOCK_LEVEL;
    expect(slotOpen({ type: 'archers', level: 1 }, 'weapon')).toBe(true);
    expect(slotOpen({ type: 'archers', level: armor - 1 }, 'armor')).toBe(false);
    expect(slotOpen({ type: 'archers', level: armor }, 'armor')).toBe(true);
    expect(slotOpen({ type: 'archers', level: relic - 1 }, 'relic')).toBe(false);
    expect(slotOpen({ type: 'archers', level: relic }, 'relic')).toBe(true);
    expect(slotOpen({ type: 'lord', level: 1 }, 'relic')).toBe(true);
  });
});

describe('item comparison', () => {
  it('sums implicit + affixes by stat', () => {
    const m = itemStats(item({ affixes: [{ id: 'vicious', value: 5 }] }));
    expect(m.get('vicious')).toBe(15);
  });
  it('green for gains, red for losses, legendary powers named', () => {
    const next = item({ id: 2, affixes: [{ id: 'keen', value: 7 }], rarity: 'legendary', legendary: 'stormcaller' });
    const cur = item({ id: 3 });
    const d = compareItems(next, cur);
    expect(d.find((x) => /critical/.test(x.text))?.good).toBe(true);
    expect(d.find((x) => /attack speed/.test(x.text))?.good).toBe(false);
    expect(d.some((x) => x.good && /Stormcaller/.test(x.text))).toBe(true);
    expect(compareItems(cur, cur)).toEqual([]);
    expect(d[0]!.good).toBe(true);
  });
  it('rarity order', () => {
    expect(rarityRank('legendary')).toBeGreaterThan(rarityRank('rare'));
    expect(rarityRank('magic')).toBeGreaterThan(rarityRank('common'));
  });
  it('rejections read as sentences', () => {
    expect(niceError('deployment limit reached')).toMatch(/No deploys left/);
    expect(niceError('something odd')).toBe('Something odd');
  });
});

describe('local match (dev harness)', () => {
  it('plays lord pick -> planning -> battle -> results with hidden-info views', () => {
    vi.useFakeTimers();
    const rooms: RoomView[] = [];
    let replay: Replay | null = null;
    const m = new LocalMatch(
      {
        onRoom: (r: RoomView, _s: Seat | null) => void rooms.push(r),
        onBattle: (r: Replay) => void (replay = r),
        onRejected: () => {},
        onChat: () => {},
      },
      { route: 'match', seed: 99, timers: false },
    );
    m.begin();
    expect(rooms.at(-1)!.phase).toBe('lordPick');
    m.intent({ t: 'pickLord', lord: 'warden' });
    const plan = rooms.at(-1)!;
    expect(plan.phase).toBe('planning');
    expect(plan.view!.you!.lord).toBe('warden');
    // the enemy's current army never shows; round 1 has no last army
    expect(plan.view!.enemy.lastArmy).toBeNull();
    expect((plan.view!.enemy as unknown as Record<string, unknown>).squads).toBeUndefined();
    const me = plan.view!.you!;
    for (const u of me.draftOptions.slice(0, me.draftPicks)) m.intent({ t: 'draft', unit: u });
    const unit = rooms.at(-1)!.view!.you!.unlocked[0]!;
    m.intent({ t: 'deploy', unit, pos: [4000, 2500] });
    expect(rooms.at(-1)!.view!.you!.squads.length).toBe(2);
    m.intent({ t: 'ready' });
    vi.advanceTimersByTime(500);
    expect(replay).not.toBeNull();
    expect(rooms.at(-1)!.phase).toBe('battle');
    m.battleDone();
    expect(['results', 'over']).toContain(rooms.at(-1)!.phase);
    vi.advanceTimersByTime(7000);
    const r2 = rooms.at(-1)!;
    expect(r2.phase).toBe('planning');
    expect(r2.view!.round).toBe(2);
    expect(r2.view!.enemy.lastArmy?.length).toBeGreaterThan(0);
    m.dispose();
    vi.useRealTimers();
  });
});

describe('audio bank', () => {
  it('every sound and music file the bank references is shipped', async () => {
    const { existsSync, statSync } = await import('node:fs');
    const { bankFiles, MUSIC } = await import('../src/audio/bank.ts');
    const files = [...bankFiles().map((f) => `public/audio/${f}`), ...Object.values(MUSIC).map((f) => `public/${f}`)];
    for (const f of files) expect(existsSync(f), f).toBe(true);
    // the effects stay within the download budget (music streams separately)
    const sfx = bankFiles().reduce((n, f) => n + statSync(`public/audio/${f}`).size, 0);
    expect(sfx).toBeLessThan(3.2e6);
  });
  it('battle sounds have variants, limits and cooldowns (no machine-gunning)', async () => {
    const { BANK } = await import('../src/audio/bank.ts');
    for (const id of ['clash', 'clashHeavy', 'death', 'volleySmall', 'volleyLarge', 'arrowHit', 'boom', 'stone'] as const) {
      const d = BANK[id];
      expect(d.files.length, id).toBeGreaterThanOrEqual(3);
      expect(d.limit, id).toBeGreaterThan(0);
      expect(d.cooldown, id).toBeGreaterThan(0);
    }
  });
  it('distance attenuation falls off smoothly and never fully silences the field', async () => {
    const { attenuate, distanceCutoff } = await import('../src/audio/bank.ts');
    expect(attenuate(0, 60)).toBe(1);
    let last = 1;
    for (let d = 0; d <= 200; d += 10) {
      const g = attenuate(d, 60);
      expect(g).toBeLessThanOrEqual(last);
      last = g;
    }
    expect(attenuate(500, 60)).toBeGreaterThan(0);
    // zoomed out, the same distance is louder (more of the field is in view)
    expect(attenuate(60, 140)).toBeGreaterThan(attenuate(60, 40));
    expect(distanceCutoff(1)).toBe(20000);
    expect(distanceCutoff(0.1)).toBeLessThan(5000);
  });
});
