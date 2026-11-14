// Client-side pure helpers (src/ui/gamedata.ts, hud.ts) and the local dev-harness match
// (src/ui/local.ts) driving the real sim through RoomView snapshots like the server does.
import { describe, expect, it, vi } from 'vitest';
import { compareItems, counters, formation, itemStats, soldierStats, squadRadius, triangle, slotOpen, rarityRank } from '../src/ui/gamedata.ts';
import { niceError } from '../src/ui/hud.ts';
import { LocalMatch } from '../src/ui/local.ts';
import type { Item, Replay, Seat } from '../src/sim/types.ts';
import type { RoomView } from '../src/net/protocol.ts';
import { UNITS, UNIT_TYPES } from '../src/sim/data/units.ts';
import { SLOT_UNLOCK_LEVEL } from '../src/sim/data/items.ts';

const item = (over: Partial<Item> = {}): Item => ({
  id: 1, base: 'steel_blade', slot: 'weapon', rarity: 'magic', ilvl: 3,
  implicit: { id: 'vicious', value: 10 }, affixes: [{ id: 'haste', value: 6 }], legendary: null, ...over,
});

describe('unit readings', () => {
  it('weapon triangle: sword > axe > lance > sword', () => {
    expect(triangle('sword', 'axe')).toBe(1);
    expect(triangle('axe', 'lance')).toBe(1);
    expect(triangle('lance', 'sword')).toBe(1);
    expect(triangle('axe', 'sword')).toBe(-1);
    expect(triangle('bow', 'sword')).toBe(0);
  });
  it('every unit has at least one listed counter, and pikemen counter cavalry', () => {
    for (const u of UNIT_TYPES) expect(counters(u).weakTo.length, u).toBeGreaterThan(0);
    expect(counters('pikemen').strongVs).toContain('cavaliers');
    expect(counters('archers').bonuses.join()).toMatch(/Flier/);
  });
  it('formation has one offset per soldier, centred, and turns with facing', () => {
    for (const u of UNIT_TYPES) {
      const f = formation(u, 64);
      expect(f.length).toBe(UNITS[u].squadSize);
      const cx = f.reduce((a, p) => a + p[0], 0) / f.length;
      expect(Math.abs(cx)).toBeLessThan(5);
    }
    const a = formation('militia', 64);
    const b = formation('militia', 0);
    expect(Math.max(...a.map((p) => Math.abs(p[0])))).toBeCloseTo(Math.max(...b.map((p) => Math.abs(p[1]))), -1);
    expect(squadRadius('militia')).toBeGreaterThan(squadRadius('lord'));
  });
  it('level stats: +25% life and +20% damage per level', () => {
    const l1 = soldierStats('knights', 1);
    const l3 = soldierStats('knights', 3);
    expect(l3.hp).toBe(Math.round(UNITS.knights.hp * 1.5));
    expect(l3.dmg).toBe(Math.round(UNITS.knights.dmg * 1.4));
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
