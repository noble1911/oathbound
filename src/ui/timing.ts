// Planning-side formation maths: the march preview (when each squad reaches the river and the enemy's
// last-round front line), the "sync by speed" helper, group placement (drag / rotate / mirror) and the
// ordering of the move intents that carry it out. Everything that decides a march is read from the sim
// (src/sim: unit stats through buildStats, the flow field, terrain speed factors, the macro targeting
// bias), so the preview follows the battle's own rules instead of a copy of its numbers.
//
// The march is the sim's squad-anchor walk (BattleSim.squadPass) replayed for one squad against a
// standing enemy: the enemy is where it stood last round (the ghosts), because that is all a player
// can know. It ignores the straggler gate and fights on the way, so it is a forecast, not a replay.
import { AGGRO, T_FLIER, buildStats } from '../sim/battle.ts';
import { FIELD_H, FIELD_W, TICK_HZ } from '../sim/constants.ts';
import { deployZone, freeSpotNear, overlappingSquad, squadFootprint } from '../sim/match.ts';
import { DIRS, MOVE_PCT, RIVER_Y0, RIVER_Y1, cellOf, navFor } from '../sim/terrain.ts';
import type { Intent, LordId, Seat, Squad, SquadType, Terrain, Vec2 } from '../sim/types.ts';

/** What the march needs to know about one enemy squad (as it stood last round). */
export interface MarchFoe {
  pos: Vec2;
  tags: number;
  backline: boolean;
  /** Wheel class index (buildStats' wc), for the ranged aim bias. */
  wc?: number;
}

export interface MarchPoint {
  sec: number;
  pos: Vec2;
}

export interface March {
  /** The anchor's route, sampled every half second (start first). */
  pts: Vec2[];
  /** First tick on the river's near bank (null: it stops before the river). */
  river: MarchPoint | null;
  /** Where it crosses the enemy's last-round front line (null: it never gets there). */
  front: MarchPoint | null;
  /** A ranged squad stops to shoot once its target is in range. */
  hold: MarchPoint | null;
  /** Open-ground march speed, m/s. */
  speed: number;
  ranged: boolean;
  flier: boolean;
}

export type MarchSquad = Pick<Squad, 'type' | 'level' | 'items' | 'pos'>;

/** The longest march the preview follows (s). */
const MAX_SEC = 45;
const SAMPLE_TICKS = 10;

export function marchFoes(army: readonly Squad[] | null | undefined, lord: LordId | null): MarchFoe[] {
  if (!army) return [];
  return army.map((s) => {
    const st = buildStats(s, s.type === 'lord' ? lord : null);
    return { pos: s.pos, tags: st.tags, backline: st.backline, wc: st.wc };
  });
}

/**
 * The enemy's front line as it stood last round: the y of its squad nearest the river (the Lord
 * included). With no intel, the front edge of the enemy's deploy zone.
 */
export function frontLine(seat: Seat, foes: readonly MarchFoe[]): number {
  const z = deployZone((1 - seat) as Seat);
  if (!foes.length) return seat === 0 ? z.y0 : z.y1;
  let y = seat === 0 ? FIELD_H : 0;
  for (const f of foes) y = seat === 0 ? Math.min(y, f.pos[1]) : Math.max(y, f.pos[1]);
  return y;
}

/** The squad's march from `sq.pos`, tick by tick as the sim walks a squad anchor. */
export function marchOf(sq: MarchSquad, lord: LordId | null, seat: Seat, terrain: Terrain, foes: readonly MarchFoe[], front: number): March {
  const st = buildStats(sq, sq.type === 'lord' ? lord : null);
  const nav = navFor(terrain);
  const flow = nav.flow[seat];
  const flier = (st.tags & T_FLIER) !== 0;
  const fwd = seat === 0 ? 1 : -1;
  let ax = sq.pos[0];
  let ay = sq.pos[1];
  const pts: Vec2[] = [[ax, ay]];
  let river: MarchPoint | null = null;
  let frontAt: MarchPoint | null = null;
  let hold: MarchPoint | null = null;
  let macro: MarchFoe | null = null;
  const across = (a: number, b: number) => (a < RIVER_Y0 && b > RIVER_Y1) || (a > RIVER_Y1 && b < RIVER_Y0);
  const atRiver = (y: number) => (seat === 0 ? y >= RIVER_Y0 : y <= RIVER_Y1);
  const pastFront = (y: number) => (y - front) * fwd >= 0;
  const max = MAX_SEC * TICK_HZ;
  let t = 0;
  for (; t < max; t++) {
    if (t % 10 === 0) {
      // the sim's macro target: the nearest enemy squad, biased as squadPass biases it
      macro = null;
      let best = 0;
      for (const e of foes) {
        if (e.tags & T_FLIER && !st.canHitAir) continue;
        let score = Math.trunc(Math.hypot(e.pos[0] - ax, e.pos[1] - ay));
        if (st.prefCls && e.wc === st.beats) score -= 2000;
        if (st.raider && e.backline) score -= 4000;
        if (!macro || score < best) {
          macro = e;
          best = score;
        }
      }
    }
    let tx: number;
    let ty: number;
    if (macro) {
      const dx = macro.pos[0] - ax;
      const dy = macro.pos[1] - ay;
      const d = Math.trunc(Math.hypot(dx, dy));
      if (st.ranged && d <= st.range - 300) {
        hold = { sec: t / TICK_HZ, pos: [ax, ay] };
        break;
      }
      // a melee squad that reaches its target fights there (its soldiers break formation at aggro range)
      if (!st.ranged && d <= AGGRO / 2) {
        // contact before the line was crossed (its target stood at the front): that is its front
        if (!frontAt) frontAt = { sec: t / TICK_HZ, pos: [ax, ay] };
        break;
      }
      if (!flier && across(ay, macro.pos[1])) {
        const f = flow[cellOf(ax, ay)]!;
        if (f === 8) break;
        [tx, ty] = DIRS[f]!;
      } else {
        tx = Math.trunc((dx * 1000) / (d || 1));
        ty = Math.trunc((dy * 1000) / (d || 1));
      }
    } else {
      const f = flow[cellOf(ax, ay)]!;
      if (f === 8) break;
      [tx, ty] = DIRS[f]!;
    }
    const sp = flier ? st.speed : Math.max(1, Math.trunc((st.speed * MOVE_PCT[nav.grid[cellOf(ax, ay)]!]!) / 100));
    ax = Math.min(FIELD_W - 1, Math.max(0, ax + Math.trunc((tx * sp) / 1000)));
    ay = Math.min(FIELD_H - 1, Math.max(0, ay + Math.trunc((ty * sp) / 1000)));
    const sec = (t + 1) / TICK_HZ;
    if (!river && atRiver(ay)) river = { sec, pos: [ax, ay] };
    if (!frontAt && pastFront(ay)) {
      frontAt = { sec, pos: [ax, ay] };
      pts.push([ax, ay]);
      break;
    }
    if ((t + 1) % SAMPLE_TICKS === 0) pts.push([ax, ay]);
  }
  const last = pts[pts.length - 1]!;
  if (last[0] !== ax || last[1] !== ay) pts.push([ax, ay]);
  return { pts, river, front: frontAt, hold, speed: (st.speed * TICK_HZ) / 100, ranged: st.ranged, flier };
}

// ---------------------------------------------------------------- placement helpers

/** Round a position to a `step` cm grid (0 = off), staying inside the seat's deploy zone. */
export function snapPos(p: Vec2, step: number, seat: Seat): Vec2 {
  if (step <= 0) return p;
  const z = deployZone(seat);
  const one = (v: number, lo: number, hi: number) => {
    let r = Math.round(v / step) * step;
    if (r > hi) r -= step;
    if (r < lo) r += step;
    return Math.min(hi, Math.max(lo, r));
  };
  return [one(p[0], z.x0, z.x1), one(p[1], z.y0, z.y1)];
}

export interface Placed {
  pos: Vec2;
  facing: number;
}

type Body = Pick<Squad, 'id' | 'type' | 'pos' | 'facing'>;

/** A phantom squad standing on a target (for overlap checks against spots already handed out). */
function phantom(id: number, type: SquadType, pos: Vec2): Squad {
  return { id, owner: 0, type, level: 1, pos, facing: 0, items: { weapon: null, armor: null, relic: null }, deployedRound: 0, spent: 0 };
}

/**
 * Settle a set of wanted spots: each squad goes where it was asked if the ground is free (of `others`,
 * which do not move, and of the spots already settled), otherwise to the nearest free ground. Squads
 * are settled in `order`. Null when one of them finds no room at all.
 */
export function settle(order: readonly Body[], want: Map<number, Placed>, others: readonly Squad[], seat: Seat): Map<number, Placed> | null {
  const taken: Squad[] = [...others];
  const out = new Map<number, Placed>();
  for (const b of order) {
    const w = want.get(b.id);
    if (!w) continue;
    let pos = w.pos;
    const z = deployZone(seat);
    pos = [Math.min(z.x1, Math.max(z.x0, Math.round(pos[0]))), Math.min(z.y1, Math.max(z.y0, Math.round(pos[1])))];
    if (overlappingSquad(taken, b.type, pos, b.id)) {
      const near = freeSpotNear(taken, seat, b.type, pos, b.id);
      if (!near) return null;
      pos = near;
    }
    out.set(b.id, { pos, facing: w.facing & 255 });
    taken.push(phantom(b.id, b.type, pos));
  }
  return out;
}

/**
 * A group moved by `delta` and turned `steps` (0..255 binary angle) about its centroid: relative
 * positions kept, clamped so every centre stays in the deploy zone, snapped, and settled clear of
 * the squads outside the group.
 */
export function groupPlace(group: readonly Body[], others: readonly Squad[], seat: Seat, delta: Vec2, steps: number, snap: number): Map<number, Placed> | null {
  if (!group.length) return new Map();
  let cx = 0;
  let cy = 0;
  for (const b of group) {
    cx += b.pos[0];
    cy += b.pos[1];
  }
  cx /= group.length;
  cy /= group.length;
  const a = (steps / 256) * Math.PI * 2;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const raw = group.map((b) => {
    const ox = b.pos[0] - cx;
    const oy = b.pos[1] - cy;
    return [cx + delta[0] + ox * c - oy * s, cy + delta[1] + ox * s + oy * c] as Vec2;
  });
  // clamp the whole group into the zone (keeps the shape while it fits)
  const z = deployZone(seat);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of raw) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  }
  const shift = (lo: number, hi: number, zlo: number, zhi: number) => (lo < zlo ? zlo - lo : hi > zhi ? zhi - hi : 0);
  const sx = shift(x0, x1, z.x0, z.x1);
  const sy = shift(y0, y1, z.y0, z.y1);
  const want = new Map<number, Placed>();
  group.forEach((b, i) => {
    const p = raw[i]!;
    want.set(b.id, { pos: snapPos([Math.round(p[0] + sx), Math.round(p[1] + sy)], snap, seat), facing: (b.facing + steps) & 255 });
  });
  // settle the group's leading edge first, so the squads that move into new ground keep their spots
  const fwd = seat === 0 ? 1 : -1;
  const order = [...group].sort((p, q) => (want.get(q.id)!.pos[1] - want.get(p.id)!.pos[1]) * fwd || p.id - q.id);
  return settle(order, want, others, seat);
}

/** Every squad mirrored left-right inside the deploy zone (the zone is symmetric about its centre line). */
export function mirrorPlace(squads: readonly Body[], seat: Seat): Map<number, Placed> {
  const z = deployZone(seat);
  const out = new Map<number, Placed>();
  for (const s of squads) out.set(s.id, { pos: [z.x0 + z.x1 - s.pos[0], s.pos[1]], facing: (128 - s.facing) & 255 });
  return out;
}

/**
 * Sync by speed: the slowest squad of the group stands at the front edge of the zone and every faster
 * one is held back until all of them reach the river at the same moment. Each keeps its x. Returns the
 * new spots (settled clear of everything else) and the shared river time.
 */
export function syncBySpeed(
  group: readonly (Body & Pick<Squad, 'level' | 'items'>)[],
  others: readonly Squad[],
  seat: Seat,
  lord: LordId | null,
  terrain: Terrain,
  foes: readonly MarchFoe[],
  snap: number,
): { spots: Map<number, Placed>; sec: number; early: { id: number; sec: number }[] } | null {
  if (!group.length) return null;
  const z = deployZone(seat);
  const front = frontLine(seat, foes);
  const fwd = seat === 0 ? 1 : -1;
  // a squad's centre may stand on the zone edge, but its soldiers spread a footprint around it
  const edge = (fp: number, forward: boolean) => (forward === (seat === 0) ? z.y1 - fp : z.y0 + fp);
  const riverAt = (b: (typeof group)[number], y: number) => marchOf({ ...b, pos: [b.pos[0], y] }, lord, seat, terrain, foes, front).river?.sec ?? Infinity;
  const fp = (b: Body) => Math.min(600, squadFootprint(b.type));
  const atFront = group.map((b) => riverAt(b, edge(fp(b), true)));
  const T = Math.max(...atFront.filter(Number.isFinite));
  if (!Number.isFinite(T)) return null;
  const want = new Map<number, Placed>();
  // squads so fast that even the back edge is too close: they wait there and still arrive early
  const early: { id: number; sec: number }[] = [];
  group.forEach((b, i) => {
    const yf = edge(fp(b), true);
    const yb = edge(fp(b), false);
    let y = yf;
    if (atFront[i]! < T - 0.05) {
      const back = riverAt(b, yb);
      if (back <= T) {
        y = yb;
        if (back < T - 0.5) early.push({ id: b.id, sec: T - back });
      }
      else {
        // riverAt grows as the squad stands further back: find where it equals T
        let lo = yf;
        let hi = yb;
        for (let k = 0; k < 14; k++) {
          const mid = Math.round((lo + hi) / 2);
          if (riverAt(b, mid) < T) lo = mid;
          else hi = mid;
        }
        y = lo;
      }
    }
    want.set(b.id, { pos: snapPos([b.pos[0], y], snap, seat), facing: b.facing });
  });
  // front squads settle first: they hold the line, the held-back ones fit around them
  const order = [...group].sort((p, q) => (want.get(q.id)!.pos[1] - want.get(p.id)!.pos[1]) * fwd || p.id - q.id);
  const spots = settle(order, want, others, seat);
  return spots ? { spots, sec: T, early } : null;
}

/**
 * The move intents that take `squads` to `targets` one at a time, each legal when the server applies it
 * (no squad ever overlaps another in between). A squad whose spot is still held by one that has not
 * moved yet waits; a cycle (two squads swapping, a mirror) is broken by parking one on free ground first.
 */
export function planMoves(squads: readonly Squad[], targets: Map<number, Placed>, seat: Seat): Intent[] {
  const cur = squads.map((s) => ({ ...s, pos: [s.pos[0], s.pos[1]] as Vec2 }));
  const byId = new Map(cur.map((s) => [s.id, s]));
  const left = [...targets.entries()].filter(([id, t]) => {
    const s = byId.get(id);
    return s && (s.pos[0] !== t.pos[0] || s.pos[1] !== t.pos[1] || s.facing !== t.facing);
  });
  const out: Intent[] = [];
  let guard = left.length * 3 + 8;
  while (left.length && guard-- > 0) {
    const i = left.findIndex(([id, t]) => !overlappingSquad(cur, byId.get(id)!.type, t.pos, id));
    if (i >= 0) {
      const [id, t] = left.splice(i, 1)[0]!;
      const s = byId.get(id)!;
      s.pos = [t.pos[0], t.pos[1]];
      s.facing = t.facing;
      out.push({ t: 'move', squad: id, pos: s.pos, facing: t.facing });
      continue;
    }
    // every remaining squad is blocked by another one that still has to move: park the first aside,
    // on ground that is free now and that no remaining target needs
    const [id] = left[0]!;
    const s = byId.get(id)!;
    const blockers = [...cur, ...left.map(([oid, t]) => phantom(-1 - oid, byId.get(oid)!.type, t.pos))];
    const park = freeSpotNear(blockers, seat, s.type, s.pos, id) ?? freeSpotNear(cur, seat, s.type, s.pos, id);
    if (!park) break;
    s.pos = park;
    out.push({ t: 'move', squad: id, pos: park, facing: s.facing });
  }
  return out;
}

/** A stable key for a squad's equipment (the march speed reads its items). */
export function itemsKey(items: Squad['items']): string {
  return `${items.weapon?.id ?? 0}.${items.armor?.id ?? 0}.${items.relic?.id ?? 0}`;
}
