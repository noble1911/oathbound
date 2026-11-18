// The Lord's battle stance (DESIGN §4): advance (the default), hold, or follow an own squad. Chosen in planning with
// {t:'stance'}, validated by the sim, hidden from the enemy until the battle, and obeyed deterministically.
import { describe, expect, it } from 'vitest';
import {
  FOLLOW_BEHIND, HOLD_LEASH, applyBattle, applyIntent, botPlan, decodeReplay, forceReady, lordStance, mirrorPos, newMatch, nextRound, replayHash, simulateBattle, viewFor, UNITS,
} from '../src/sim/index.ts';
import type { DecodedReplay, LordId, MatchState, Seat, Squad, UnitType, Vec2 } from '../src/sim/types.ts';

const at = (seat: Seat, p: Vec2): Vec2 => (seat === 0 ? p : mirrorPos(p));
const lordOf = (s: MatchState, seat: Seat): Squad => s.players[seat].squads.find((q) => q.type === 'lord')!;

/** Round 1 planning with `units` deployed in a line for both seats (seat-local x from 1500, y 3400) and the Lords at `lordAt`. */
function setup(lords: [LordId, LordId], units: [UnitType[], UnitType[]], lordAt: Vec2 = [3999, 1200]): MatchState {
  const s = newMatch(21, lords);
  for (const seat of [0, 1] as Seat[]) {
    const p = s.players[seat];
    p.gold = 9000; p.deployLimit = 99;
    for (const u of units[seat]) if (!p.unlocked.includes(u)) p.unlocked.push(u);
    expect(applyIntent(s, seat, { t: 'move', squad: p.squads[0].id, pos: at(seat, lordAt) })).toEqual({ ok: true });
    units[seat].forEach((u, i) => expect(applyIntent(s, seat, { t: 'deploy', unit: u, pos: at(seat, [1500 + i * 1300, 3400]) })).toEqual({ ok: true }));
  }
  return s;
}

/** Per keyframe: the seat's Lord position (null once dead) and the centre of squad `id` (null once dead). */
function track(d: DecodedReplay, seat: Seat, id: number): { lord: Vec2 | null; squad: Vec2 | null }[] {
  const n = d.soldierCount, out: { lord: Vec2 | null; squad: Vec2 | null }[] = [];
  const li = d.replay.soldiers.findIndex((o) => o.side === seat && o.type === 'lord');
  const mem = d.replay.soldiers.map((o, i) => (o.side === seat && o.squad === id && !o.summoned ? i : -1)).filter((i) => i >= 0);
  for (let f = 0; f < d.frameCount; f++) {
    const k = f * n;
    const lord: Vec2 | null = d.hp[k + li] > 0 ? [d.x[k + li], d.y[k + li]] : null;
    let sx = 0, sy = 0, c = 0;
    for (const i of mem) if (d.hp[k + i] > 0) { sx += d.x[k + i]; sy += d.y[k + i]; c++; }
    out.push({ lord, squad: c ? [sx / c, sy / c] : null });
  }
  return out;
}

describe('Lord stance: the intent', () => {
  it('defaults to advance and is set, changed and cleared with {t:"stance"}', () => {
    const s = setup(['marshal', 'warden'], [['militia'], ['knights']]);
    expect(lordStance(s.players[0])).toEqual({ t: 'advance' });
    expect(lordOf(s, 0).stance).toBeUndefined();
    expect(applyIntent(s, 0, { t: 'stance', stance: 'hold' })).toEqual({ ok: true });
    expect(lordStance(s.players[0])).toEqual({ t: 'hold' });
    const sq = s.players[0].squads[1];
    expect(applyIntent(s, 0, { t: 'stance', stance: 'follow', squad: sq.id })).toEqual({ ok: true });
    expect(lordStance(s.players[0])).toEqual({ t: 'follow', squad: sq.id });
    expect(applyIntent(s, 0, { t: 'stance', stance: 'advance' })).toEqual({ ok: true });
    expect(lordOf(s, 0).stance).toBeUndefined();
    // the other seat is untouched
    expect(lordStance(s.players[1])).toEqual({ t: 'advance' });
  });

  it('refuses what is not a stance, a squad that is not yours, the Lord himself, and anything once ready', () => {
    const s = setup(['marshal', 'warden'], [['militia'], ['knights']]);
    const mine = s.players[0].squads[1], theirs = s.players[1].squads[1];
    const bad = (i: unknown): void => { expect(applyIntent(s, 0, i as never).ok).toBe(false); expect(lordOf(s, 0).stance).toBeUndefined(); };
    bad({ t: 'stance', stance: 'charge' });
    bad({ t: 'stance' });
    bad({ t: 'stance', stance: 'follow' });
    bad({ t: 'stance', stance: 'follow', squad: 'x' });
    bad({ t: 'stance', stance: 'follow', squad: 1.5 });
    bad({ t: 'stance', stance: 'follow', squad: theirs.id });
    bad({ t: 'stance', stance: 'follow', squad: lordOf(s, 0).id });
    bad({ t: 'stance', stance: 'follow', squad: 99999 });
    expect(applyIntent(s, 0, { t: 'ready' }).ok).toBe(true);
    bad({ t: 'stance', stance: 'hold' });
    expect(applyIntent(s, 0, { t: 'unready' }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'stance', stance: 'follow', squad: mine.id })).toEqual({ ok: true });
  });

  it('is refused outside planning', () => {
    const s = newMatch(5, null);
    expect(applyIntent(s, 0, { t: 'stance', stance: 'hold' }).ok).toBe(false);
  });

  it('selling the followed squad puts the Lord back on advance; the stance otherwise lasts from round to round', () => {
    const s = setup(['marshal', 'warden'], [['militia', 'militia'], ['knights']]);
    const [a, b] = s.players[0].squads.slice(1);
    expect(applyIntent(s, 0, { t: 'stance', stance: 'follow', squad: a.id }).ok).toBe(true);
    expect(applyIntent(s, 0, { t: 'sell', squad: b.id }).ok).toBe(true);
    expect(lordStance(s.players[0])).toEqual({ t: 'follow', squad: a.id });
    expect(applyIntent(s, 0, { t: 'sell', squad: a.id }).ok).toBe(true);
    expect(lordOf(s, 0).stance).toBeUndefined();
    expect(applyIntent(s, 1, { t: 'stance', stance: 'hold' }).ok).toBe(true);
    forceReady(s);
    applyBattle(s, simulateBattle(s, { record: false }).result);
    nextRound(s);
    expect(lordStance(s.players[1])).toEqual({ t: 'hold' });
  });
});

describe('Lord stance: hidden until the battle', () => {
  it('the enemy sees the stance of the last battle, never this round\'s', () => {
    const s = setup(['marshal', 'warden'], [['militia'], ['knights']]);
    const lead = s.players[1].squads[1].id;
    expect(applyIntent(s, 1, { t: 'stance', stance: 'follow', squad: lead }).ok).toBe(true);
    // round 1: nothing of the enemy is visible, and no part of the view names the stance
    const v1 = viewFor(s, 0);
    expect(v1.enemy.lastArmy).toBeNull();
    expect(JSON.stringify(v1.enemy)).not.toMatch(/stance|follow/);
    expect(JSON.stringify(viewFor(s, null))).not.toMatch(/stance|follow/);
    // the owner sees it
    expect(viewFor(s, 1).you!.squads[0].stance).toEqual({ t: 'follow', squad: lead });
    forceReady(s);
    applyBattle(s, simulateBattle(s, { record: false }).result);
    nextRound(s);
    // round 2: the ghosts carry the stance the Lord fought with
    expect(viewFor(s, 0).enemy.lastArmy!.find((q) => q.type === 'lord')!.stance).toEqual({ t: 'follow', squad: lead });
    // a change this round stays hidden
    expect(applyIntent(s, 1, { t: 'stance', stance: 'hold' }).ok).toBe(true);
    expect(viewFor(s, 0).enemy.lastArmy!.find((q) => q.type === 'lord')!.stance).toEqual({ t: 'follow', squad: lead });
    expect(JSON.stringify(viewFor(s, 0).enemy)).not.toMatch(/"hold"/);
    expect(JSON.stringify(viewFor(s, null))).not.toMatch(/"hold"/);
  });
});

describe('Lord stance: the battle obeys it', () => {
  it('advance is the battle of a Lord with no stance (nothing changes for a player who ignores it)', () => {
    const s = setup(['marshal', 'warden'], [['militia', 'archers'], ['knights', 'berserkers']]);
    const base = replayHash(simulateBattle(s).replay);
    expect(applyIntent(s, 0, { t: 'stance', stance: 'hold' }).ok).toBe(true);
    expect(replayHash(simulateBattle(s).replay)).not.toBe(base);
    expect(applyIntent(s, 0, { t: 'stance', stance: 'advance' }).ok).toBe(true);
    expect(replayHash(simulateBattle(s).replay)).toBe(base);
  });

  it('hold: the Lord stays within the leash of his post while his army stands, then joins the battle', () => {
    const post: Vec2 = [3999, 1200];
    const s = setup(['marshal', 'warden'], [['militia', 'militia'], ['knights', 'knights', 'berserkers', 'berserkers']], post);
    expect(applyIntent(s, 0, { t: 'stance', stance: 'hold' }).ok).toBe(true);
    const out = simulateBattle(s);
    const d = decodeReplay(out.replay);
    const ids = s.players[0].squads.slice(1).map((q) => q.id);
    const tr = ids.map((id) => track(d, 0, id));
    let held = 0, left = false;
    for (let f = 0; f < d.frameCount; f++) {
      const lord = tr[0][f].lord;
      if (!lord) break;
      const armyUp = tr.some((t) => t[f].squad);
      const off = Math.hypot(lord[0] - post[0], lord[1] - post[1]);
      // one keyframe of slack: the release is decided at the start of a tick, the frame is sampled after
      if (armyUp && (f + 1 >= d.frameCount || tr.some((t) => t[f + 1].squad))) { expect(off).toBeLessThanOrEqual(HOLD_LEASH + 200); held++; }
      if (!armyUp && off > HOLD_LEASH + 400) left = true;
    }
    expect(held).toBeGreaterThan(5);
    // his two Militia squads fall to four heavier squads; the Marshal then leaves his post and fights
    expect(left).toBe(true);
  });

  it('hold is deterministic and the default Lord would have left the spot', () => {
    const s = setup(['marshal', 'warden'], [['militia', 'militia'], ['knights', 'knights']]);
    const walk = track(decodeReplay(simulateBattle(s).replay), 0, s.players[0].squads[1].id);
    expect(Math.max(...walk.map((w) => (w.lord ? w.lord[1] : 0)))).toBeGreaterThan(1200 + HOLD_LEASH + 500);
    expect(applyIntent(s, 0, { t: 'stance', stance: 'hold' }).ok).toBe(true);
    expect(replayHash(simulateBattle(s).replay)).toBe(replayHash(simulateBattle(structuredClone(s)).replay));
  });

  it('follow: the Lord stays behind the squad he follows, on his own side of it, until it falls', () => {
    // a fast flying Lord told to follow slow infantry: without the order she is at the enemy long before them
    const s = setup(['drakerider', 'warden'], [['skeleton', 'skeleton'], ['knights', 'knights']], [1500, 1200]);
    const lead = s.players[0].squads[1];
    const free = track(decodeReplay(simulateBattle(s).replay), 0, lead.id);
    expect(applyIntent(s, 0, { t: 'stance', stance: 'follow', squad: lead.id }).ok).toBe(true);
    const tr = track(decodeReplay(simulateBattle(s).replay), 0, lead.id);
    // once she has caught up (frame 22 = 11 s) and until the first blows, she is FOLLOW_BEHIND behind the squad's centre
    let n = 0, ahead = 0;
    for (let f = 22; f < tr.length; f++) {
      const { lord, squad } = tr[f];
      if (!lord || !squad || squad[1] > 5200) break;
      expect(Math.abs(lord[0] - squad[0])).toBeLessThan(250);
      expect(squad[1] - lord[1]).toBeGreaterThan(FOLLOW_BEHIND - 250);
      expect(squad[1] - lord[1]).toBeLessThan(FOLLOW_BEHIND + 250);
      n++;
    }
    expect(n).toBeGreaterThan(5);
    for (let f = 12; f < free.length; f++) if (free[f].lord && free[f].squad && free[f].lord![1] > free[f].squad![1]) ahead++;
    expect(ahead).toBeGreaterThan(0); // on advance she overtakes them
  });

  it('follow: a squad that is not in the army (sold, or a stale id) means advance', () => {
    const s = setup(['marshal', 'warden'], [['militia'], ['knights']]);
    const base = replayHash(simulateBattle(s).replay);
    lordOf(s, 0).stance = { t: 'follow', squad: 424242 };
    expect(lordStance(s.players[0])).toEqual({ t: 'advance' });
    expect(replayHash(simulateBattle(s).replay)).toBe(base);
    // nor may it name an enemy squad
    lordOf(s, 0).stance = { t: 'follow', squad: s.players[1].squads[1].id };
    expect(replayHash(simulateBattle(s).replay)).toBe(base);
  });

  it('whole bot matches with stances set every round end, and replay identically', () => {
    for (const [seed, lords] of [[3, ['archmage', 'rajah']], [4, ['lich', 'skylady']]] as [number, [LordId, LordId]][]) {
      const run = (): string => {
        const s = newMatch(seed, lords);
        const hashes: string[] = [];
        let guard = 0;
        while (s.phase === 'planning' && guard++ < 30) {
          botPlan(s, 0, 'hard', 1);
          botPlan(s, 1, 'normal', 2);
          for (const seat of [0, 1] as Seat[]) {
            applyIntent(s, seat, { t: 'unready' });
            const others = s.players[seat].squads.filter((q) => q.type !== 'lord');
            const r = applyIntent(s, seat, seat === 0 || !others.length ? { t: 'stance', stance: 'hold' } : { t: 'stance', stance: 'follow', squad: others[s.round % others.length].id });
            expect(r).toEqual({ ok: true });
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
    }
  }, 120_000);
});

// keep the unit table import honest (setup deploys by id)
void UNITS;
