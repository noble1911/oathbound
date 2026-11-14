// Seeded, exactly mirrored terrain (DESIGN §6), its 1 m nav grid and the per-side flow fields.
// Only seat 0's half is generated; seat 1's half is its 180-degree mirror, cell for cell.
import { CELL, FIELD_H, FIELD_W, GRID_H, GRID_W } from './constants.ts';
import { Rng } from './rng.ts';
import type { Terrain, TerrainFeature, TerrainKind } from './types.ts';

export const KIND_CODE: Record<TerrainKind, number> = { plain: 0, forest: 1, hill: 2, river: 3, ford: 4, bridge: 5, ruins: 6 };
export const KIND_OF: readonly TerrainKind[] = ['plain', 'forest', 'hill', 'river', 'ford', 'bridge', 'ruins'];
/** Ground move speed percent per terrain code. */
export const MOVE_PCT = [100, 70, 90, 50, 80, 100, 90];
/** Flow-field step cost per terrain code (orthogonal step; diagonal x1.4). */
const STEP_COST = [10, 14, 11, 20, 12, 10, 11];

export const RIVER_Y0 = 5500;
export const RIVER_Y1 = 6499;

function circle(kind: TerrainFeature['kind'], x: number, y: number, r: number): TerrainFeature {
  return { kind, shape: 'circle', x, y, r, w: 0, h: 0 };
}
function rect(kind: TerrainFeature['kind'], x: number, y: number, w: number, h: number): TerrainFeature {
  return { kind, shape: 'rect', x, y, r: 0, w, h };
}
function mirrorFeature(f: TerrainFeature): TerrainFeature {
  if (f.shape === 'circle') return { ...f, x: FIELD_W - 1 - f.x, y: FIELD_H - 1 - f.y };
  return { ...f, x: FIELD_W - f.x - f.w, y: FIELD_H - f.y - f.h };
}

export function genTerrain(seed: number): Terrain {
  const rng = new Rng((seed ^ 0x7e11a1) >>> 0);
  const half: TerrainFeature[] = [];
  const crossings: TerrainFeature[] = [];
  // Crossings: either a central bridge plus a mirrored pair of fords, or just a mirrored pair.
  const central = rng.int(2) === 0;
  if (central) crossings.push(rect('bridge', 3600, RIVER_Y0, 800, 1000));
  const fx = (8 + rng.int(14)) * 100; // 800..2100
  crossings.push(rect(central ? 'ford' : 'bridge', fx, RIVER_Y0, 600 + rng.int(3) * 100, 1000));
  // Forests, hills, ruins in seat 0's half (y in 1200..5000), kept away from the river.
  const placed: { x: number; y: number; r: number }[] = [];
  const tryPlace = (kind: TerrainFeature['kind'], n: number, rlo: number, rhi: number, ylo: number, yhi: number): void => {
    for (let i = 0, tries = 0; i < n && tries < 40; tries++) {
      const r = rlo + rng.int(rhi - rlo + 1);
      const x = 600 + rng.int(FIELD_W - 1200);
      const y = ylo + rng.int(yhi - ylo);
      if (y + r > RIVER_Y0 - 100) continue;
      if (placed.some((p) => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) < (p.r + r + 300) * (p.r + r + 300))) continue;
      placed.push({ x, y, r });
      half.push(circle(kind, x, y, r));
      i++;
    }
  };
  tryPlace('forest', 2 + rng.int(2), 600, 1000, 1800, 5000);
  tryPlace('hill', 1 + rng.int(2), 500, 800, 1500, 4800);
  tryPlace('ruins', 1, 400, 600, 3000, 5000);
  const features: TerrainFeature[] = [rect('river', 0, RIVER_Y0, FIELD_W, RIVER_Y1 - RIVER_Y0 + 1)];
  for (const c of crossings) {
    features.push(c);
    const m = mirrorFeature(c);
    if (m.x !== c.x) features.push(m);
  }
  for (const f of half) features.push(f, mirrorFeature(f));
  return { seed, features };
}

const PRIORITY: Record<TerrainKind, number> = { plain: 0, forest: 1, hill: 2, ruins: 3, river: 4, ford: 5, bridge: 6 };

function rasterHalf(t: Terrain): Uint8Array {
  const g = new Uint8Array(GRID_W * GRID_H);
  const pri = new Uint8Array(GRID_W * GRID_H);
  const rows = GRID_H / 2;
  for (const f of t.features) {
    const code = KIND_CODE[f.kind], p = PRIORITY[f.kind];
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < GRID_W; cx++) {
        // Cell centre in doubled coordinates (stored p means p + 0.5).
        const px = cx * CELL * 2 + CELL, py = cy * CELL * 2 + CELL;
        let inside: boolean;
        if (f.shape === 'circle') {
          const dx = px - (2 * f.x + 1), dy = py - (2 * f.y + 1);
          inside = dx * dx + dy * dy <= 4 * f.r * f.r;
        } else {
          inside = px >= 2 * f.x && px < 2 * (f.x + f.w) && py >= 2 * f.y && py < 2 * (f.y + f.h);
        }
        const i = cy * GRID_W + cx;
        if (inside && p > pri[i]) { pri[i] = p; g[i] = code; }
      }
    }
  }
  // Mirror seat 0's half onto seat 1's.
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < GRID_W; cx++) {
      g[(GRID_H - 1 - cy) * GRID_W + (GRID_W - 1 - cx)] = g[cy * GRID_W + cx];
    }
  }
  return g;
}

export interface NavData {
  grid: Uint8Array;
  /** Per side, per cell: index 0..7 into DIRS of the downhill step towards the ENEMY keep, 8 = at goal. */
  flow: [Uint8Array, Uint8Array];
}
/** 8 directions in circular order, so the mirror of direction i is (i + 4) % 8. Scaled to 1000. */
export const DIRS: readonly [number, number][] = [
  [1000, 0], [707, 707], [0, 1000], [-707, 707], [-1000, 0], [-707, -707], [0, -1000], [707, -707],
];

const cache = new Map<string, NavData>();
export function navFor(t: Terrain): NavData {
  const key = t.seed + ':' + t.features.length + ':' + (t.features[1]?.x ?? 0);
  let n = cache.get(key);
  if (!n) {
    const grid = rasterHalf(t);
    const f0 = flowTowards(grid);
    const f1 = new Uint8Array(f0.length);
    for (let i = 0; i < f0.length; i++) {
      const d = f0[f0.length - 1 - i];
      f1[i] = d === 8 ? 8 : (d + 4) & 7;
    }
    n = { grid, flow: [f0, f1] };
    if (cache.size > 64) cache.clear();
    cache.set(key, n);
  }
  return n;
}

/** Dijkstra from seat 1's keep area (the goal for seat 0's soldiers). */
function flowTowards(grid: Uint8Array): Uint8Array {
  const N = GRID_W * GRID_H;
  const dist = new Int32Array(N).fill(0x3fffffff);
  const heap: number[] = [];
  const push = (d: number, i: number): void => {
    heap.push(d * 16384 + i);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p] <= heap[k]) break;
      const tmp = heap[p]; heap[p] = heap[k]; heap[k] = tmp; k = p;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && heap[l] < heap[m]) m = l;
        if (r < heap.length && heap[r] < heap[m]) m = r;
        if (m === k) break;
        const tmp = heap[m]; heap[m] = heap[k]; heap[k] = tmp; k = m;
      }
    }
    return top;
  };
  for (let cy = GRID_H - 4; cy < GRID_H; cy++) {
    for (let cx = 30; cx < 50; cx++) { const i = cy * GRID_W + cx; dist[i] = 0; push(0, i); }
  }
  while (heap.length) {
    const v = pop();
    const d = Math.trunc(v / 16384), i = v % 16384;
    if (d > dist[i]) continue;
    const cx = i % GRID_W, cy = (i - cx) / GRID_W;
    for (let k = 0; k < 8; k++) {
      const nx = cx + Math.sign(DIRS[k][0]), ny = cy + Math.sign(DIRS[k][1]);
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
      const j = ny * GRID_W + nx;
      const c = STEP_COST[grid[j]] * (k & 1 ? 14 : 10);
      if (d + c < dist[j]) { dist[j] = d + c; push(d + c, j); }
    }
  }
  const flow = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (dist[i] === 0) { flow[i] = 8; continue; }
    const cx = i % GRID_W, cy = (i - cx) / GRID_W;
    let best = -1, bd = dist[i];
    for (let k = 0; k < 8; k++) {
      const nx = cx + Math.sign(DIRS[k][0]), ny = cy + Math.sign(DIRS[k][1]);
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
      const j = ny * GRID_W + nx;
      if (dist[j] < bd) { bd = dist[j]; best = k; }
    }
    flow[i] = best < 0 ? 2 : best;
  }
  return flow;
}

export function cellOf(x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= FIELD_W ? GRID_W - 1 : (x / CELL) | 0;
  const cy = y < 0 ? 0 : y >= FIELD_H ? GRID_H - 1 : (y / CELL) | 0;
  return cy * GRID_W + cx;
}

/** Terrain kind at a point (cm). */
export function terrainAt(t: Terrain, x: number, y: number): TerrainKind {
  return KIND_OF[navFor(t).grid[cellOf(x, y)]];
}
