// UX-pass helpers, all pure: the viewer-relative world flip (src/ui/flip.ts), item usefulness and
// dead affixes (src/ui/gamedata.ts), the battle report and its hint lines (src/ui/insights.ts),
// shop hotkeys, round wording and match totals (src/ui/results.ts), and the untimed tutorial match.
import { describe, expect, it, vi } from 'vitest';
import type { DecodedReplay, Item, Replay, ReplayEvent, ReplaySoldier, Seat, Squad } from '../src/sim/types.ts';
import * as sim from '../src/sim/index.ts';
import { KEEP_SRC_BASE, keepSource } from '../src/sim/replay.ts';
import { SLOT_UNLOCK_LEVEL } from '../src/sim/data/items.ts';
import type { RoomView } from '../src/net/protocol.ts';
import { FIELD_H, FIELD_W, flipEvent, flipFacing, flipPos, flipRef, flippedSource } from '../src/ui/flip.ts';
import { affixDead, bestFit, deadLines, itemUse, SHOP_KEYS, slotOpen } from '../src/ui/gamedata.ts';
import { battleHints, battleStats } from '../src/ui/insights.ts';
import { matchTotals, outcomeText, type BattleReport } from '../src/ui/results.ts';
import { LocalMatch } from '../src/ui/local.ts';

const item = (over: Partial<Item> = {}): Item => ({
  id: 1, base: 'steel_blade', slot: 'weapon', rarity: 'magic', ilvl: 3,
  implicit: { id: 'vicious', value: 10 }, affixes: [], legendary: null, ...over,
});
const squad = (id: number, type: Squad['type'], level = 1, items: Partial<Squad['items']> = {}): Squad => ({
  id, owner: 0, type, level, pos: [4000, 2000], facing: 64, items: { weapon: null, armor: null, relic: null, ...items }, deployedRound: 1, spent: 100,
});

describe('viewer-relative flip (seat 1 sees its own army blue, at the bottom)', () => {
  it('positions, facings and keep refs turn half a circle and back', () => {
    expect(flipPos([200, 400])).toEqual([FIELD_W - 200, FIELD_H - 400]);
    expect(flipPos(flipPos([1234, 5678]))).toEqual([1234, 5678]);
    expect(flipFacing(64)).toBe(192);
    expect(flipFacing(flipFacing(17))).toBe(17);
    expect(flipRef(42)).toBe(42);
    expect(flipRef(-1)).toBe(-1);
    expect(flipRef(keepSource(0, 2))).toBe(keepSource(1, 2));
    expect(flipRef(keepSource(1, 0))).toBe(keepSource(0, 0));
    expect(flipRef(KEEP_SRC_BASE + 5)).toBe(KEEP_SRC_BASE + 1);
  });
  it('events swap the Keep seat and mirror their points', () => {
    const hit: ReplayEvent = { k: 'keepHit', tick: 10, seat: 1, src: 3, dmg: 50, hpAfter: 100, final: false };
    expect(flipEvent(hit)).toMatchObject({ seat: 0, src: 3 });
    const proj: ReplayEvent = { k: 'projectile', tick: 1, id: 7, src: keepSource(0, 1), tgt: 4, kind: 'tower_arrow', arc: 'arc', from: [4000, 0], to: [3000, 2000], flight: 10 };
    expect(flipEvent(proj)).toMatchObject({ src: keepSource(1, 1), from: [4000, 12000], to: [5000, 10000] });
  });
  it('a real replay flips to its mirror: sides swapped, soldiers at the far end, events map back', () => {
    const s = sim.newMatch(4242, ['marshal', 'warden']);
    sim.botPlan(s, 0, 'best', 1);
    sim.botPlan(s, 1, 'best', 1);
    const { replay } = sim.simulateBattle(s);
    const d = sim.decodeReplay(replay);
    const f = flippedSource(d, sim.sampleReplay, sim.makeTransforms);
    expect(f.soldiers.length).toBe(replay.soldiers.length);
    f.soldiers.forEach((x, i) => expect(x.side).toBe(1 - replay.soldiers[i]!.side));
    expect(f.keeps[0].seat).toBe(0);
    expect(f.keeps[0].pos).toEqual(flipPos(replay.keeps[1].pos));
    const a = sim.makeTransforms(d.soldierCount);
    const b = f.makeTransforms();
    sim.sampleReplay(d, 0, a);
    f.sample(0, b);
    for (let i = 0; i < d.soldierCount; i++) {
      if (!a.visible[i]) continue;
      expect(b.x[i]).toBeCloseTo(FIELD_W - a.x[i]!, 3);
      expect(b.y[i]).toBeCloseTo(FIELD_H - a.y[i]!, 3);
      expect(Math.cos(b.facing[i]!)).toBeCloseTo(-Math.cos(a.facing[i]!), 4);
    }
    // seat 0's soldiers start near y = 0; flipped, they are the far (red) army
    const i0 = replay.soldiers.findIndex((x) => x.side === 0);
    expect(a.y[i0]!).toBeLessThan(FIELD_H / 2);
    expect(b.y[i0]!).toBeGreaterThan(FIELD_H / 2);
    expect(f.events.length).toBe(d.events.length);
    expect(f.original.get(f.events[0]!)).toBe(d.events[0]);
    expect(f.terrain).toBe(replay.terrain);
  });
});

describe('loot fit: usefulness, not just an open slot', () => {
  const bow = item({ id: 9, base: 'ironbark_bow', implicit: { id: 'farreach', value: 250 }, affixes: [{ id: 'farreach', value: 300 }] });
  it('range does nothing on melee; damage does nothing on healers', () => {
    expect(affixDead({ id: 'farreach', value: 250 }, 'lord', 'marshal')).toMatch(/melee/);
    expect(affixDead({ id: 'farreach', value: 250 }, 'archers')).toBeNull();
    expect(affixDead({ id: 'farreach', value: 250 }, 'lord', 'archmage')).toBeNull();
    expect(affixDead({ id: 'vicious', value: 10 }, 'clerics')).toMatch(/healers/);
    expect(affixDead({ id: 'haste', value: 10 }, 'clerics')).toBeNull();
    expect(affixDead({ id: 'stalwart', value: 10 }, 'clerics')).toBeNull();
    const d = deadLines(bow, 'knights');
    expect(d.affix).toHaveLength(2);
    expect(d.affix.every(Boolean)).toBe(true);
    expect(deadLines(item({ legendary: 'stormcaller', rarity: 'legendary' }), 'clerics').legendary).toMatch(/healers/);
  });
  it('a bow is suggested for the archers, never for a melee Lord', () => {
    const lord = squad(1, 'lord');
    const archers = squad(2, 'archers');
    expect(itemUse(bow, lord, 'marshal')).toBe(0);
    expect(itemUse(bow, archers, 'marshal')).toBeGreaterThan(0);
    expect(bestFit(bow, [lord, archers], 'marshal')?.squad.id).toBe(2);
    // only the melee Lord has the slot: no suggestion at all rather than a misleading one
    expect(bestFit(bow, [lord], 'marshal')).toBeNull();
  });
  it('prefers the bigger gain, and an upgrade over an equal item', () => {
    const blade = item({ id: 5, affixes: [{ id: 'haste', value: 8 }] });
    const worn = squad(3, 'knights', 3, { weapon: item({ id: 6, affixes: [{ id: 'haste', value: 8 }] }) });
    const bare = squad(4, 'militia', 1);
    const fit = bestFit(blade, [worn, bare], 'marshal');
    expect(fit?.squad.id).toBe(4);
    expect(fit?.replaces).toBeNull();
    // armor: nobody below the unlock level has the slot
    const armor = item({ id: 7, base: 'mail_hauberk', slot: 'armor', implicit: { id: 'stalwart', value: 12 } });
    expect(bestFit(armor, [squad(8, 'militia', SLOT_UNLOCK_LEVEL.armor - 1)], 'marshal')).toBeNull();
    expect(bestFit(armor, [squad(8, 'militia', SLOT_UNLOCK_LEVEL.armor)], 'marshal')?.squad.id).toBe(8);
    expect(slotOpen({ type: 'lord', level: 1 }, 'relic')).toBe(true);
  });
  it('shop hotkeys run 1-9, then 0 and -', () => {
    expect(SHOP_KEYS.slice(0, 11).join('')).toBe('1234567890-');
  });
});

// ---------------------------------------------------------------- a hand-made battle for the report
function soldiers(spec: [squad: number, side: Seat, type: string, n: number, hp: number][]): ReplaySoldier[] {
  const out: ReplaySoldier[] = [];
  for (const [sq, side, type, n, hp] of spec)
    for (let i = 0; i < n; i++)
      out.push({ id: out.length, squad: sq, side, type: type as ReplaySoldier['type'], modelId: type, level: 1, maxHp: hp, items: [], flags: [], spawnTick: 0, summoned: false, ...(type === 'lord' ? { lord: side === 0 ? 'marshal' : 'warden' } : {}) } as ReplaySoldier);
  return out;
}
function decoded(sol: ReplaySoldier[], events: ReplayEvent[], result: Partial<Replay['result']> = {}): DecodedReplay {
  const replay = { soldiers: sol, result: { round: 1, winner: 1, timeout: false, keepDamage: [100, 0], survivors: [[], []], lordXp: [0, 0], ticks: 600, damageDealt: [0, 0], soldiersLost: [0, 0], ...result } } as unknown as Replay;
  return { replay, soldierCount: sol.length, frameCount: 0, x: new Int16Array(0), y: new Int16Array(0), facing: new Uint8Array(0), hp: new Uint16Array(0), anim: new Uint8Array(0), events };
}
const first = (sol: ReplaySoldier[], sq: number) => sol.findIndex((s) => s.squad === sq);
const hit = (tick: number, src: number, tgt: number, dmg: number): ReplayEvent => ({ k: 'hit', tick, src, tgt, dmg, crit: false, effective: false, triangle: 0, miss: false });
const death = (tick: number, tgt: number, src: number): ReplayEvent => ({ k: 'death', tick, tgt, src });

describe('battle report and hints', () => {
  it('counts damage dealt / taken, kills and losses per squad for both sides', () => {
    const sol = soldiers([[10, 0, 'militia', 3, 50], [20, 1, 'archers', 2, 40]]);
    const m = first(sol, 10), a = first(sol, 20);
    const st = battleStats(decoded(sol, [hit(1, a, m, 30), hit(2, a, m, 25), death(2, m, a), hit(3, m + 1, a, 12), { k: 'hit', tick: 4, src: a, tgt: m + 1, dmg: 99, crit: false, effective: false, triangle: 0, miss: true }]));
    const mil = st.squads.find((q) => q.id === 10)!;
    const arc = st.squads.find((q) => q.id === 20)!;
    expect(mil).toMatchObject({ side: 0, size: 3, lost: 1, taken: 55, dealt: 12, kills: 0, life: 150, wipedAt: -1 });
    expect(arc).toMatchObject({ side: 1, size: 2, lost: 0, taken: 12, dealt: 55, kills: 1 });
    expect(st.pair.get(20)!.get(10)).toBe(55);
  });
  it("explains fliers nobody could reach: \"your army couldn't reach their flier squads\"", () => {
    const sol = soldiers([[10, 0, 'militia', 4, 50], [11, 0, 'knights', 2, 300], [20, 1, 'pegasus', 3, 150], [21, 1, 'wyvern', 2, 400]]);
    const m = first(sol, 10), p = first(sol, 20);
    const ev: ReplayEvent[] = [];
    for (let i = 0; i < 4; i++) ev.push(hit(10 + i, p, m + i, 50), death(10 + i, m + i, p));
    const hints = battleHints(battleStats(decoded(sol, ev)), 0);
    expect(hints[0]!.tone).toBe('bad');
    expect(hints[0]!.text).toMatch(/couldn't reach their 2 flier squads/);
    expect(hints[0]!.text).toMatch(/Archers/);
    // seen from the other side it is good news
    const theirs = battleHints(battleStats(decoded(sol, ev)), 1);
    expect(theirs.some((h) => h.tone === 'good' && /no answer to your 2 flier squads/.test(h.text))).toBe(true);
  });
  it('names the ranged unit that out-ranged you', () => {
    const sol = soldiers([[10, 0, 'militia', 4, 50], [20, 1, 'archers', 4, 40], [21, 1, 'knights', 2, 300]]);
    const m = first(sol, 10), a = first(sol, 20), k = first(sol, 21);
    const ev: ReplayEvent[] = [];
    for (let i = 0; i < 4; i++) ev.push(hit(5 + i, a, m + i, 40));
    ev.push(hit(20, k, m, 10), death(20, m, k));
    const hints = battleHints(battleStats(decoded(sol, ev)), 0);
    expect(hints.some((h) => /Their Archers out-ranged you/.test(h.text))).toBe(true);
  });
  it('credits a counter that decided a fight, both ways', () => {
    const sol = soldiers([[10, 0, 'pikemen', 4, 60], [20, 1, 'cavaliers', 2, 300]]);
    const p = first(sol, 10), c = first(sol, 20);
    const ev: ReplayEvent[] = [hit(5, p, c, 300), death(5, c, p), hit(6, p + 1, c + 1, 300), death(6, c + 1, p + 1)];
    const st = battleStats(decoded(sol, ev, { winner: 0 }));
    expect(st.squads.find((q) => q.id === 20)!.wipedAt).toBe(6);
    expect(battleHints(st, 0).some((h) => h.tone === 'good' && /Your Pikemen countered their Cavaliers/.test(h.text))).toBe(true);
    expect(battleHints(st, 1).some((h) => h.tone === 'bad' && /Their Pikemen countered your Cavaliers/.test(h.text))).toBe(true);
  });
  it('says so when the clock decided it, when gold sat unspent, and never returns nothing', () => {
    const sol = soldiers([[10, 0, 'militia', 2, 50], [20, 1, 'militia', 2, 50]]);
    const st = battleStats(decoded(sol, [], { winner: null, timeout: true, ticks: 1800 }));
    expect(battleHints(st, 0).some((h) => /Time ran out/.test(h.text))).toBe(true);
    const lost = battleStats(decoded(sol, [], { winner: 1 }));
    expect(battleHints(lost, 0, { gold: 350 }).some((h) => /350 gold unspent/.test(h.text))).toBe(true);
    expect(battleHints(battleStats(decoded(sol, [], { winner: 0 })), 0).length).toBeGreaterThan(0);
    expect(battleHints(lost, 0, { max: 1 })).toHaveLength(1);
  });
  it('match totals add up the viewer\'s side and find the squad of the match', () => {
    const sol = soldiers([[10, 0, 'militia', 2, 50], [11, 0, 'archers', 2, 40], [20, 1, 'militia', 2, 50]]);
    const m = first(sol, 10), a = first(sol, 11), e = first(sol, 20);
    const st = battleStats(decoded(sol, [hit(1, a, e, 30), hit(2, m, e, 10), hit(3, a, e, 20), death(3, e, a)]));
    const rep = (round: number): BattleReport => ({ round, stats: st, hints: [], me: 0, spectator: false, names: ['A', 'B'] });
    const t = matchTotals([rep(1), rep(2)]);
    expect(t).toMatchObject({ dealt: 120, kills: 2, battles: 2 });
    expect(t.mvp).toMatchObject({ type: 'archers', dmg: 100 });
  });
});

describe('round wording', () => {
  it('uses the outcome from the viewer\'s side', () => {
    expect(outcomeText({ winner: 0 }, 0).outcome).toBe('won');
    expect(outcomeText({ winner: 0 }, 1).outcome).toBe('lost');
    expect(outcomeText({ winner: null }, 1).outcome).toBe('draw');
    expect(outcomeText({ winner: 1 }, null).outcome).toBe('lost');
    expect(outcomeText({ winner: 1 }, 1).title).toMatch(/Victory/);
  });
});

describe('tutorial match', () => {
  it('is untimed: no phase deadline, and nothing happens until the player acts', () => {
    vi.useFakeTimers();
    const rooms: RoomView[] = [];
    const m = new LocalMatch({ onRoom: (r) => void rooms.push(r), onBattle: () => {}, onRejected: () => {}, onChat: () => {} }, { route: 'match', seed: 5, timers: false, untimed: true, level: 'easy', strategy: 'easy', name: 'New' });
    m.begin();
    expect(rooms.at(-1)).toMatchObject({ phase: 'lordPick', phaseEndsAt: 0, aiLevel: 'easy' });
    vi.advanceTimersByTime(120_000);
    expect(rooms.at(-1)!.phase).toBe('lordPick');
    m.intent({ t: 'pickLord', lord: 'marshal' });
    expect(rooms.at(-1)).toMatchObject({ phase: 'planning', phaseEndsAt: 0 });
    expect(rooms.at(-1)!.seats[0]!.name).toBe('New');
    vi.advanceTimersByTime(300_000);
    expect(rooms.at(-1)!.phase).toBe('planning');
    m.dispose();
    vi.useRealTimers();
  });
});

describe('hostile names stay text (names and chat arrive raw from the server)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  it('esc() neutralises markup, quotes included', async () => {
    const { esc } = await import('../src/ui/dom.ts');
    expect(esc(evil)).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(esc(`"' &`)).toBe('&quot;&#39; &amp;');
  });
  it('the battle report escapes commander names', async () => {
    const { reportTable, hintsHtml } = await import('../src/ui/results.ts');
    const sol = soldiers([[10, 0, 'militia', 2, 50], [20, 1, 'militia', 2, 50]]);
    const html = reportTable({ round: 1, stats: battleStats(decoded(sol, [])), hints: [], me: 0, spectator: true, names: [evil, evil] });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(hintsHtml([{ tone: 'info', text: evil }])).not.toContain('<img');
  });
  it('no screen builds HTML from a name without esc() or textContent', async () => {
    // a static sweep: every template interpolation of a player name / chat text goes through esc()
    const { readFileSync, readdirSync } = await import('node:fs');
    const bad: string[] = [];
    for (const f of [...readdirSync('src/ui').filter((n) => n.endsWith('.ts') && n !== 'standin-scene.ts').map((n) => `src/ui/${n}`), 'src/main.ts']) {
      readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
        // raw `${...name}` / `${text}` inside markup on the same line
        const m = line.match(/<[a-z][^`]*\$\{(?!esc\()[^}]*(?:\.name\b|names\[[^\]]+\]|\btext\b)[^}]*\}/);
        if (m && !/LORDS\[|UNITS\[|\bL\.name|\bd\.name|def\.name|\.abilityName|esc\(/.test(m[0])) bad.push(`${f}:${i + 1} ${m[0].slice(0, 80)}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
