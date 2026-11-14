// Field geometry and timing constants (see types.ts header for units).
import type { Vec2 } from './types.ts';

export const FIELD_W = 8000;
export const FIELD_H = 12000;
export const TICK_HZ = 20;
export const TICK_MS = 50;
export const KEYFRAME_TICKS = 4;
/** 90 s of fighting. */
export const MAX_BATTLE_TICKS = 1800;
/** After a wipe, survivors march (at double speed) on the keep for at most this many ticks (15 s) before the remainder is settled. */
export const MARCH_TICKS = 400;

/** Nav grid: 1 m cells. */
export const CELL = 100;
export const GRID_W = FIELD_W / CELL;
export const GRID_H = FIELD_H / CELL;

/** Exact 180-degree mirror (stored ints represent p + 0.5 cm). */
export function mirrorPos(p: Vec2): Vec2 {
  return [FIELD_W - 1 - p[0], FIELD_H - 1 - p[1]];
}
export function mirrorFacing(f: number): number {
  return (f + 128) & 255;
}
