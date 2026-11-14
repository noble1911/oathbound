// Viewer-relative sides. The renderer paints seat 0 blue and seat 1 red, and the field is its own
// 180-degree mirror (Terrain: "for every feature there is its mirror"). So a seat-1 viewer is shown
// the whole match rotated half a turn with the owners swapped: their army is then blue, at the near
// end, exactly like a seat-0 viewer's. These are the pure maps for that rotation (no DOM, no three);
// src/ui/engine-scene.ts applies them at the adapter seam, so screens keep talking sim coordinates.
import type { DecodedReplay, KeepInfo, ReplayEvent, ReplaySoldier, Seat, SkillEvent, SoldierTransforms, Terrain, Vec2 } from '../sim/types.ts';
import { KEEP_SRC_BASE } from '../sim/replay.ts';

export const FIELD_W = 8000;
export const FIELD_H = 12000;

export function flipPos(p: Vec2): Vec2 {
  return [FIELD_W - p[0], FIELD_H - p[1]];
}

/** Binary angle (0..255) turned half a circle. */
export function flipFacing(f: number): number {
  return (f + 128) & 255;
}

export function flipSeat(s: Seat): Seat {
  return (1 - s) as Seat;
}

/** Soldier refs stay; keep refs (KEEP_SRC_BASE + seat * 4 + n) change seat. */
export function flipRef(id: number): number {
  if (id < KEEP_SRC_BASE) return id;
  const k = id - KEEP_SRC_BASE;
  return KEEP_SRC_BASE + (1 - (k >> 2)) * 4 + (k & 3);
}

export function flipEvent(e: ReplayEvent): ReplayEvent {
  switch (e.k) {
    case 'attack': return { ...e, src: flipRef(e.src), tgt: flipRef(e.tgt) };
    case 'projectile': return { ...e, src: flipRef(e.src), tgt: flipRef(e.tgt), from: flipPos(e.from), to: flipPos(e.to) };
    case 'impact': return { ...e, pos: flipPos(e.pos) };
    case 'hit': return { ...e, src: flipRef(e.src), tgt: flipRef(e.tgt) };
    case 'heal': return e;
    case 'death': return { ...e, src: flipRef(e.src), tgt: flipRef(e.tgt) };
    case 'ability': return { ...e, pos: flipPos(e.pos) };
    case 'keepHit': return { ...e, seat: flipSeat(e.seat), src: flipRef(e.src) };
    case 'keepStage': return { ...e, seat: flipSeat(e.seat) };
    case 'revive': return e;
    case 'summon': return { ...e, pos: flipPos(e.pos) };
  }
}

/**
 * An item-skill cast (DecodedReplay.skills) rotated: only the target point is a field position.
 * `src` / `tgt` are soldier indices and `squad` / `tgtSquad` are rows of Replay.squads, and none of
 * those change with the viewer (the side of a soldier or a row is flipped where it is read).
 */
export function flipSkill(e: SkillEvent): SkillEvent {
  return { ...e, pos: flipPos(e.pos) };
}

function flipKeep(k: KeepInfo): KeepInfo {
  return { ...k, seat: flipSeat(k.seat), pos: flipPos(k.pos), towers: [flipPos(k.towers[0]), flipPos(k.towers[1])] };
}

/** What the renderer's `BattleSource` needs (structurally the same; no import from src/render here). */
export interface FlippedSource {
  soldiers: ReplaySoldier[];
  keeps: [KeepInfo, KeepInfo];
  terrain: Terrain;
  durationMs: number;
  events: ReplayEvent[];
  /** Item-skill casts (DecodedReplay.skills), rotated like the events. */
  skills: SkillEvent[];
  sample(ms: number, out: SoldierTransforms): void;
  makeTransforms(): SoldierTransforms;
  /** The sim's own event for a rotated one (the screens and the audio work in sim coordinates). */
  original: Map<ReplayEvent, ReplayEvent>;
}

/** A replay rotated half a turn with the sides swapped, for a seat-1 viewer. */
export function flippedSource(
  d: DecodedReplay,
  sample: (d: DecodedReplay, ms: number, out: SoldierTransforms) => SoldierTransforms,
  make: (n: number) => SoldierTransforms,
): FlippedSource {
  const r = d.replay;
  const original = new Map<ReplayEvent, ReplayEvent>();
  const events = d.events.map((e) => {
    const f = flipEvent(e);
    original.set(f, e);
    return f;
  });
  const TAU = Math.PI * 2;
  return {
    soldiers: r.soldiers.map((s) => ({ ...s, side: flipSeat(s.side) })),
    keeps: [flipKeep(r.keeps[1]), flipKeep(r.keeps[0])],
    terrain: r.terrain,
    durationMs: r.ticks * 50,
    events,
    skills: (d.skills ?? []).map(flipSkill),
    sample: (ms, out) => {
      sample(d, ms, out);
      const n = out.count;
      for (let i = 0; i < n; i++) {
        out.x[i] = FIELD_W - out.x[i]!;
        out.y[i] = FIELD_H - out.y[i]!;
        const f = out.facing[i]! + Math.PI;
        out.facing[i] = f >= TAU ? f - TAU : f;
      }
    },
    makeTransforms: () => make(d.soldierCount),
    original,
  };
}
