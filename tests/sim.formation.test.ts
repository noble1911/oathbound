// Formation (DESIGN §3): every squad of three or more soldiers stands wide (a line, the default) or deep (a column).
// It replaced facing. Chosen with {t:'formation'} or on deploy, free also for a locked squad, hidden until the battle.
import { describe, expect, it } from 'vitest';
import {
  DEEP_GUARD_PCT, DEEP_SPEED_PCT, UNITS, UNIT_TYPES, applyBattle, applyIntent, botPlan, decodeReplay, forceReady, formationGrid, hasFormation, mirrorPos, newMatch, nextRound,
  overlappingSquad, replayHash, simulateBattle, squadFootprint, squadLocked, squadSizeAt, viewFor,
} from '../src/sim/index.ts';
import { buildStats } from '../src/sim/battle.ts';
import type { LordId, MatchState, Seat, Squad, UnitType, Vec2 } from '../src/sim/types.ts';

const at = (seat: Seat, p: Vec2): Vec2 => (seat === 0 ? p : mirrorPos(p));
const NONE = { weapon: null, armor: null, relic: null };

function setup(lords: [LordId, LordId], units: [UnitType[], UnitType[]]): MatchState {
  const s = newMatch(31, lords);
  for (const seat of [0, 1] as Seat[]) {
    const p = s.players[seat];
    p.gold = 9000; p.deployLimit = 99;
    for (const u of units[seat]) if (!p.unlocked.includes(u)) p.unlocked.push(u);
    units[seat].forEach((u, i) => expect(applyIntent(s, seat, { t: 'deploy', unit: u, pos: at(seat, [1500 + i * 1400, 3300]) })).toEqual({ ok: true }));
  }
  return s;
}
const sq = (s: MatchState, seat: Seat, i: number): Squad => s.players[seat].squads.filter((q) => q.type !== 'lord')[i];

describe('formation: the grid', () => {
  it('wide is a line and deep a column of the same soldiers; one or two soldiers have neither', () => {
    for (let n = 1; n <= 40; n++) {
      const w = formationGrid(n, 'wide'), d = formationGrid(n, 'deep');
      for (const g of [w, d]) { expect(g.cols * g.rows).toBeGreaterThanOrEqual(n); expect(g.cols * (g.rows - 1)).toBeLessThan(n); }
      if (n <= 2) { expect(d).toEqual(w); continue; }
      expect(w.cols).toBeGreaterThan(d.cols);
      expect(d.rows).toBeGreaterThan(w.rows);
      expect(w.cols).toBeGreaterThanOrEqual(d.rows); // the line is the longer of the two: it sizes the footprint
      expect(w.rows).toBeLessThanOrEqual(3);
      expect(d.cols).toBeLessThanOrEqual(4);
    }
    expect(formationGrid(4, 'wide')).toEqual({ cols: 4, rows: 1 });
    expect(formationGrid(4, 'deep')).toEqual({ cols: 2, rows: 2 });
    expect(formationGrid(12, 'wide')).toEqual({ cols: 6, rows: 2 });
    expect(formationGrid(12, 'deep')).toEqual({ cols: 3, rows: 4 });
  });

  it('the battle lays the soldiers out on it, facing the enemy, and the footprint covers both formations', () => {
    const types: UnitType[] = ['militia', 'knights', 'archers', 'berserkers'];
    const s = setup(['marshal', 'warden'], [types, types]);
    for (const form of ['wide', 'deep'] as const) {
      for (const seat of [0, 1] as Seat[]) for (let i = 0; i < types.length; i++) expect(applyIntent(s, seat, { t: 'formation', squad: sq(s, seat, i).id, formation: form })).toEqual({ ok: true });
      const d = decodeReplay(simulateBattle(s).replay);
      for (const seat of [0, 1] as Seat[]) for (let i = 0; i < types.length; i++) {
        const q = sq(s, seat, i), def = UNITS[q.type as UnitType];
        const mem = d.replay.soldiers.map((o, k) => (o.side === seat && o.squad === q.id ? k : -1)).filter((k) => k >= 0);
        const xs = mem.map((k) => d.x[k]), ys = mem.map((k) => d.y[k]);
        const g = formationGrid(mem.length, form), sp = def.radius * 2 + 50;
        expect(Math.max(...xs) - Math.min(...xs)).toBe((g.cols - 1) * sp);
        expect(Math.max(...ys) - Math.min(...ys)).toBe((g.rows - 1) * sp);
        // inside the squad's circle
        for (const k of mem) expect(Math.hypot(d.x[k] - q.pos[0], d.y[k] - q.pos[1])).toBeLessThanOrEqual(squadFootprint(q.type) + 1);
      }
    }
  });

  it('a footprint is one circle per unit, whatever the formation: a change never overlaps a neighbour', () => {
    for (const u of UNIT_TYPES) {
      const n = squadSizeAt(u, 5), sp = UNITS[u].radius * 2 + 50;
      const half = (c: number): number => Math.trunc(((c - 1) * sp) / 2) + UNITS[u].radius;
      expect(squadFootprint(u)).toBeGreaterThanOrEqual(half(formationGrid(n, 'wide').cols));
      expect(squadFootprint(u)).toBeGreaterThanOrEqual(half(formationGrid(n, 'deep').rows));
    }
    const s = setup(['marshal', 'warden'], [['militia', 'militia'], ['knights']]);
    const [a, b] = [sq(s, 0, 0), sq(s, 0, 1)];
    // side by side, touching
    const gap = 2 * squadFootprint('militia');
    expect(applyIntent(s, 0, { t: 'move', squad: b.id, pos: [a.pos[0] + gap, a.pos[1]] })).toEqual({ ok: true });
    for (const f of ['deep', 'wide', 'deep'] as const) {
      expect(applyIntent(s, 0, { t: 'formation', squad: a.id, formation: f })).toEqual({ ok: true });
      expect(overlappingSquad(s.players[0].squads, a.type, a.pos, a.id)).toBeNull();
    }
  });
});

describe('formation: the intent', () => {
  it('defaults to wide, is set on deploy or with {t:"formation"}, and is refused for the Lord and for squads of one or two', () => {
    const s = setup(['marshal', 'warden'], [['militia', 'golem', 'wyvern'], ['knights']]);
    const [mil, golem, wyv] = [sq(s, 0, 0), sq(s, 0, 1), sq(s, 0, 2)];
    expect(mil.formation).toBeUndefined();
    expect(applyIntent(s, 0, { t: 'formation', squad: mil.id, formation: 'deep' })).toEqual({ ok: true });
    expect(mil.formation).toBe('deep');
    expect(applyIntent(s, 0, { t: 'formation', squad: mil.id, formation: 'wide' })).toEqual({ ok: true });
    expect(mil.formation).toBeUndefined();
    expect(hasFormation('golem')).toBe(false);
    expect(hasFormation('wyvern')).toBe(false);
    expect(hasFormation('lord')).toBe(false);
    expect(hasFormation('clerics')).toBe(true);
    for (const q of [golem, wyv, s.players[0].squads[0]]) {
      expect(applyIntent(s, 0, { t: 'formation', squad: q.id, formation: 'deep' }).ok).toBe(false);
      expect(q.formation).toBeUndefined();
    }
    const bad = (i: unknown): void => { expect(applyIntent(s, 0, i as never).ok).toBe(false); };
    bad({ t: 'formation', squad: mil.id, formation: 'square' });
    bad({ t: 'formation', squad: mil.id });
    bad({ t: 'formation', squad: 99999, formation: 'deep' });
    bad({ t: 'formation', squad: sq(s, 1, 0).id, formation: 'deep' });
    bad({ t: 'deploy', unit: 'militia', pos: [1500, 1500], formation: 'square' });
    expect(mil.formation).toBeUndefined();
    // on deploy; a golem deployed 'deep' is simply a golem
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'militia', pos: [1500, 1500], formation: 'deep' })).toEqual({ ok: true });
    expect(s.players[0].squads.at(-1)!.formation).toBe('deep');
    expect(applyIntent(s, 0, { t: 'deploy', unit: 'golem', pos: [3500, 1500], formation: 'deep' })).toEqual({ ok: true });
    expect(s.players[0].squads.at(-1)!.formation).toBeUndefined();
    expect(applyIntent(s, 0, { t: 'ready' }).ok).toBe(true);
    bad({ t: 'formation', squad: mil.id, formation: 'deep' });
  });

  it('is free for a squad that is locked in place, and lasts from round to round', () => {
    const s = setup(['marshal', 'warden'], [['militia', 'knights'], ['knights']]);
    forceReady(s);
    applyBattle(s, simulateBattle(s, { record: false }).result);
    nextRound(s);
    const q = sq(s, 0, 0);
    expect(squadLocked(q, s.round)).toBe(true);
    const gold = s.players[0].gold;
    expect(applyIntent(s, 0, { t: 'move', squad: q.id, pos: [q.pos[0] + 500, q.pos[1]] }).ok).toBe(false);
    expect(applyIntent(s, 0, { t: 'formation', squad: q.id, formation: 'deep' })).toEqual({ ok: true });
    expect(s.players[0].gold).toBe(gold);
    forceReady(s);
    applyBattle(s, simulateBattle(s, { record: false }).result);
    if (s.phase === 'results') { nextRound(s); expect(sq(s, 0, 0).formation).toBe('deep'); }
  });

  it('facing is gone: the old field on an intent is ignored and squads always face the enemy', () => {
    const s = newMatch(3, ['marshal', 'warden']);
    expect(applyIntent(s, 0, { t: 'deploy', unit: s.players[0].unlocked[0], pos: [3000, 3000], facing: 300 } as never)).toEqual({ ok: true });
    const q = s.players[0].squads[1];
    const base = replayHash(simulateBattle(s).replay);
    expect(applyIntent(s, 0, { t: 'move', squad: q.id, pos: [q.pos[0], q.pos[1]], facing: 7 } as never)).toEqual({ ok: true });
    expect(replayHash(simulateBattle(s).replay)).toBe(base);
  });
});

describe('formation: hidden until the battle', () => {
  it('the enemy sees the formation of the last battle, never this round\'s', () => {
    const s = setup(['marshal', 'warden'], [['militia'], ['knights', 'berserkers']]);
    const [k, b] = [sq(s, 1, 0), sq(s, 1, 1)];
    expect(applyIntent(s, 1, { t: 'formation', squad: k.id, formation: 'deep' }).ok).toBe(true);
    expect(JSON.stringify(viewFor(s, 0).enemy)).not.toMatch(/deep/);
    expect(JSON.stringify(viewFor(s, null))).not.toMatch(/deep/);
    expect(viewFor(s, 1).you!.squads.find((q) => q.id === k.id)!.formation).toBe('deep');
    forceReady(s);
    applyBattle(s, simulateBattle(s, { record: false }).result);
    nextRound(s);
    const ghosts = viewFor(s, 0).enemy.lastArmy!;
    expect(ghosts.find((q) => q.id === k.id)!.formation).toBe('deep');
    expect(ghosts.find((q) => q.id === b.id)!.formation).toBeUndefined();
    // this round's change stays hidden
    expect(applyIntent(s, 1, { t: 'formation', squad: b.id, formation: 'deep' }).ok).toBe(true);
    expect(applyIntent(s, 1, { t: 'formation', squad: k.id, formation: 'wide' }).ok).toBe(true);
    const again = viewFor(s, 0).enemy.lastArmy!;
    expect(again.find((q) => q.id === k.id)!.formation).toBe('deep');
    expect(again.find((q) => q.id === b.id)!.formation).toBeUndefined();
  });
});

describe('formation: what it does in battle', () => {
  it('deep marches faster and nothing else changes on the sheet; squads without a formation are untouched', () => {
    const wide = buildStats({ type: 'knights', level: 2, items: NONE }, 'marshal');
    const deep = buildStats({ type: 'knights', level: 2, items: NONE, formation: 'deep' }, 'marshal');
    expect(deep.speed).toBe(Math.trunc((wide.speed * (100 + DEEP_SPEED_PCT)) / 100));
    expect(deep.guard).toBe(DEEP_GUARD_PCT);
    expect(wide.guard).toBe(0);
    expect({ ...deep, speed: 0, guard: 0 }).toEqual({ ...wide, speed: 0, guard: 0 });
    expect(buildStats({ type: 'golem', level: 1, items: NONE, formation: 'deep' }, 'marshal')).toEqual(buildStats({ type: 'golem', level: 1, items: NONE }, 'marshal'));
  });

  it('a deep squad reaches the river first', () => {
    const s = setup(['marshal', 'warden'], [['knights', 'knights'], ['archers']]);
    const [a, b] = [sq(s, 0, 0), sq(s, 0, 1)];
    expect(applyIntent(s, 0, { t: 'formation', squad: b.id, formation: 'deep' }).ok).toBe(true);
    const d = decodeReplay(simulateBattle(s).replay), n = d.soldierCount;
    const y = (id: number, f: number): number => { const m = d.replay.soldiers.map((o, k) => (o.side === 0 && o.squad === id ? k : -1)).filter((k) => k >= 0); return m.reduce((acc, k) => acc + d.y[f * n + k], 0) / m.length; };
    expect(y(b.id, 16) - y(a.id, 16)).toBeGreaterThan(40);
  });

  it('melee blows hurt a deep squad less; arrows do not care', () => {
    // one squad of Knights against Berserkers (melee) and against Archers (ranged): damage taken in the first 12 s of contact
    const taken = (foe: UnitType, form: 'wide' | 'deep'): number => {
      const s = setup(['warden', 'warden'], [['knights'], [foe]]);
      for (const seat of [0, 1] as Seat[]) expect(applyIntent(s, seat, { t: 'move', squad: s.players[seat].squads[0].id, pos: at(seat, [7500, 500]) }).ok).toBe(true);
      expect(applyIntent(s, 0, { t: 'formation', squad: sq(s, 0, 0).id, formation: form }).ok).toBe(true);
      // same speed for both runs, so the comparison is the guard alone
      const out = simulateBattle(s);
      return out.result.damageDealt[1];
    };
    expect(taken('berserkers', 'deep')).not.toBe(taken('berserkers', 'wide'));
  });

  it('whole bot matches with mixed formations mirror-replay identically', () => {
    const run = (): string => {
      const s = newMatch(8, ['lich', 'sultana']);
      const hashes: string[] = [];
      let guard = 0;
      while (s.phase === 'planning' && guard++ < 30) {
        botPlan(s, 0, 'hard', 1);
        botPlan(s, 1, 'normal', 2);
        for (const seat of [0, 1] as Seat[]) {
          applyIntent(s, seat, { t: 'unready' });
          s.players[seat].squads.forEach((q, i) => { if (hasFormation(q.type)) expect(applyIntent(s, seat, { t: 'formation', squad: q.id, formation: (i + s.round + seat) % 2 ? 'deep' : 'wide' })).toEqual({ ok: true }); });
          applyIntent(s, seat, { t: 'ready' });
        }
        const out = simulateBattle(s);
        hashes.push(String(replayHash(out.replay)));
        applyBattle(s, out.result);
        if ((s.phase as string) === 'results') nextRound(s);
      }
      expect(s.phase).toBe('over');
      return hashes.join(',');
    };
    expect(run()).toBe(run());
  }, 120_000);
});
