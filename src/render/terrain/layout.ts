// The battlefield layout in world metres, derived from the sim's Terrain features, and the
// analytic height function it implies. The Heightfield bakes it to a 1 m grid; heightAt() is a
// bilinear sample of that grid plus bridge decks (which are analytic).
import type { Terrain, TerrainFeature, KeepInfo } from '../../sim/types.ts';
import { worldX, worldZ } from '../core/coords.ts';
import { fbm, vnoise, smoothstep, lerp, clamp01 } from './noise.ts';

export const WORLD = { x0: -130, x1: 130, z0: -150, z1: 150 };
export const FIELD = { x0: -40, x1: 40, z0: -60, z1: 60 };
export const WATER_LEVEL = -0.35;
export const TEAM_COLORS = ['#3b6fd8', '#d8453b'] as const;

export interface WRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
export interface WCircle {
  x: number;
  z: number;
  r: number;
}
export type WShape = { rect: WRect; circle?: undefined } | { circle: WCircle; rect?: undefined };

export interface Crossing extends WRect {
  kind: 'bridge' | 'ford';
  cx: number;
}

export interface KeepPlace {
  seat: 0 | 1;
  /** Keep position (world, ground plane). */
  x: number;
  z: number;
  /** Direction towards the field centre (+1/-1 in z). */
  dir: 1 | -1;
  towers: { x: number; z: number }[];
}

export interface Feature {
  kind: TerrainFeature['kind'];
  shape: WShape;
  /** Seed shared with the feature's mirror (so mirrored props are identical). */
  pairSeed: number;
  /** True for the seat-1 half copy (props rotate 180°). */
  mirrored: boolean;
  cx: number;
  cz: number;
}

function toShape(f: TerrainFeature): WShape {
  if (f.shape === 'circle') return { circle: { x: worldX(f.x + 0.5), z: worldZ(f.y + 0.5), r: f.r / 100 } };
  // rect: (x, y) min corner in field cm; world z flips
  return { rect: { x0: worldX(f.x), x1: worldX(f.x + f.w), z0: worldZ(f.y + f.h), z1: worldZ(f.y) } };
}

export function sdShape(s: WShape, x: number, z: number): number {
  if (s.circle) return Math.hypot(x - s.circle.x, z - s.circle.z) - s.circle.r;
  return sdRect(s.rect, x, z);
}
export function sdRect(r: WRect, x: number, z: number): number {
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const dx = Math.abs(x - cx) - (r.x1 - r.x0) / 2;
  const dz = Math.abs(z - cz) - (r.z1 - r.z0) / 2;
  const ox = Math.max(dx, 0);
  const oz = Math.max(dz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(dx, dz), 0);
}

export function defaultKeeps(): KeepInfo[] {
  return [
    { seat: 0, pos: [4000, 0], hpBefore: 4000, hpMax: 4000, towers: [[2300, 500], [5699, 500]] },
    { seat: 1, pos: [3999, 11999], hpBefore: 4000, hpMax: 4000, towers: [[5699, 11499], [2300, 11499]] },
  ];
}

export class Layout {
  readonly seed: number;
  readonly features: Feature[] = [];
  readonly rivers: WRect[] = [];
  readonly crossings: Crossing[] = [];
  readonly keeps: KeepPlace[] = [];
  /** Path polylines (dirt), as segment list [ax, az, bx, bz]. */
  readonly paths: number[][] = [];

  constructor(t: Terrain, keeps: KeepInfo[]) {
    this.seed = t.seed | 0;
    for (const f of t.features) {
      const shape = toShape(f);
      const cx = shape.circle ? shape.circle.x : (shape.rect.x0 + shape.rect.x1) / 2;
      const cz = shape.circle ? shape.circle.z : (shape.rect.z0 + shape.rect.z1) / 2;
      // pair seed from the seat-0 copy's coordinates
      const m = cz < -0.01 || (Math.abs(cz) <= 0.01 && cx < 0);
      const px = Math.round(m ? -cx : cx);
      const pz = Math.round(m ? -cz : cz);
      const feat: Feature = { kind: f.kind, shape, pairSeed: (px * 7919 + pz * 104729 + this.seed) | 0, mirrored: cz < -0.01, cx, cz };
      this.features.push(feat);
      if (f.kind === 'river' && shape.rect) {
        const r = { ...shape.rect };
        // a river touching the field sides keeps flowing through the whole world
        if (r.x0 <= FIELD.x0 + 0.5) r.x0 = WORLD.x0 - 10;
        if (r.x1 >= FIELD.x1 - 0.5) r.x1 = WORLD.x1 + 10;
        this.rivers.push(r);
      }
      if ((f.kind === 'bridge' || f.kind === 'ford') && shape.rect) {
        this.crossings.push({ kind: f.kind, ...shape.rect, cx: (shape.rect.x0 + shape.rect.x1) / 2 });
      }
    }
    for (const k of keeps) {
      const x = worldX(k.pos[0] + 0.5);
      const z = worldZ(k.pos[1] + 0.5);
      const dir = z > 0 ? -1 : 1;
      this.keeps.push({
        seat: k.seat,
        x,
        z,
        dir: dir as 1 | -1,
        towers: k.towers.map((p) => ({ x: worldX(p[0] + 0.5), z: worldZ(p[1] + 0.5) })),
      });
    }
    this.buildPaths();
    this.bakeGrids();
  }

  // 1 m caches of the expensive fields (path distance, forest cover)
  private gw = 0;
  private gh = 0;
  private pathGrid: Float32Array | null = null;
  private forestGrid: Float32Array | null = null;
  private bakeGrids(): void {
    this.gw = WORLD.x1 - WORLD.x0 + 1;
    this.gh = WORLD.z1 - WORLD.z0 + 1;
    const pg = new Float32Array(this.gw * this.gh);
    for (let j = 0; j < this.gh; j++)
      for (let i = 0; i < this.gw; i++) pg[j * this.gw + i] = this.rawPathDist(WORLD.x0 + i, WORLD.z0 + j);
    this.pathGrid = pg;
    const fg = new Float32Array(this.gw * this.gh);
    for (let j = 0; j < this.gh; j++)
      for (let i = 0; i < this.gw; i++) fg[j * this.gw + i] = this.rawOutskirtsForest(WORLD.x0 + i, WORLD.z0 + j);
    this.forestGrid = fg;
  }
  private sampleGrid(g: Float32Array, x: number, z: number): number {
    const fx = Math.min(this.gw - 1.001, Math.max(0, x - WORLD.x0));
    const fz = Math.min(this.gh - 1.001, Math.max(0, z - WORLD.z0));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const k = j * this.gw + i;
    const a = g[k];
    const b = g[k + 1];
    const c = g[k + this.gw];
    const e = g[k + this.gw + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + e) * u * v;
  }

  private buildPaths(): void {
    const seg = (pts: [number, number][]) => {
      for (let i = 0; i + 1 < pts.length; i++) this.paths.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
    };
    const bez = (a: [number, number], c: [number, number], b: [number, number], n = 14): [number, number][] => {
      const out: [number, number][] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
      }
      return out;
    };
    for (const k of this.keeps) {
      const gate: [number, number] = [k.x, k.z + k.dir * 3];
      for (const c of this.crossings) {
        const nearZ = k.dir < 0 ? c.z1 + 2.5 : c.z0 - 2.5;
        const end: [number, number] = [c.cx, nearZ];
        const ctrl: [number, number] = [lerp(gate[0], end[0], 0.75), lerp(gate[1], end[1], 0.4)];
        seg(bez(gate, ctrl, end));
        if (c.kind === 'ford') seg([end, [c.cx, k.dir < 0 ? c.z0 - 2.5 : c.z1 + 2.5]]);
      }
      // the road out of the castle's back gate into the hills
      const back: [number, number] = [k.x, k.z - k.dir * 15];
      seg(bez(back, [k.x + k.dir * 12, k.z - k.dir * 40], [k.x + k.dir * 30, k.z - k.dir * 95]));
    }
  }

  /** Signed distance to the river (negative in the water), with noise-wobbled banks. */
  riverSd(x: number, z: number): number {
    let d = 1e9;
    for (const r of this.rivers) d = Math.min(d, sdRect(r, x, z));
    if (d > 30) return d;
    const side = z > (this.rivers[0] ? (this.rivers[0].z0 + this.rivers[0].z1) / 2 : 0) ? 0 : 50;
    const wob = (vnoise(x * 0.05 + side, 3.1, this.seed + 5) - 0.5) * 2.6 + (vnoise(x * 0.21 + side, z * 0.2, this.seed + 6) - 0.5) * 0.8;
    return d + wob;
  }
  pathDist(x: number, z: number): number {
    const base = this.pathGrid ? this.sampleGrid(this.pathGrid, x, z) : this.rawPathDist(x, z);
    return base + (vnoise(x * 0.35, z * 0.35, this.seed + 9) - 0.5) * 0.7;
  }
  private rawPathDist(x: number, z: number): number {
    let best = 1e9;
    for (const s of this.paths) {
      const vx = s[2] - s[0];
      const vz = s[3] - s[1];
      const l2 = vx * vx + vz * vz || 1;
      const t = clamp01(((x - s[0]) * vx + (z - s[1]) * vz) / l2);
      const dx = s[0] + vx * t - x;
      const dz = s[1] + vz * t - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
  /** Distance outside the 80×120 field (0 inside). */
  outDist(x: number, z: number): number {
    const dx = Math.max(FIELD.x0 - x, x - FIELD.x1, 0);
    const dz = Math.max(FIELD.z0 - z, z - FIELD.z1, 0);
    return Math.hypot(dx, dz);
  }
  keepDist(x: number, z: number): number {
    let d = 1e9;
    for (const k of this.keeps) d = Math.min(d, Math.hypot((x - k.x) * 0.85, z - (k.z - k.dir * 5)));
    return d;
  }
  /** 0..1: how much of a forest this point is in (field forests + outskirts woodland). */
  forestAt(x: number, z: number): number {
    let f = 0;
    for (const ft of this.features) if (ft.kind === 'forest') f = Math.max(f, smoothstep(1.5, -2.5, sdShape(ft.shape, x, z)));
    return Math.max(f, this.outskirtsForest(x, z));
  }
  outskirtsForest(x: number, z: number): number {
    return this.forestGrid ? this.sampleGrid(this.forestGrid, x, z) : this.rawOutskirtsForest(x, z);
  }
  private rawOutskirtsForest(x: number, z: number): number {
    const od = this.outDist(x, z);
    if (od < 5) return 0;
    const n = fbm(x * 0.022, z * 0.022, this.seed + 21, 4);
    const v = smoothstep(0.42, 0.52, n + smoothstep(8, 70, od) * 0.22 - 0.06);
    const river = smoothstep(7, 14, this.riverSd(x, z));
    const road = smoothstep(4, 7, this.pathDist(x, z));
    const keep = smoothstep(24, 32, this.keepDist(x, z));
    return v * smoothstep(5, 12, od) * river * road * keep;
  }

  /** Analytic ground height (no bridges). */
  height(x: number, z: number): number {
    const seed = this.seed;
    const sd = this.riverSd(x, z);
    const od = this.outDist(x, z);
    // gentle rolling ground, calmer near the river and the keeps
    const nearRiver = smoothstep(2.5, 14, sd);
    let h = (fbm(x * 0.028, z * 0.028, seed + 1, 4) - 0.5) * 1.4 * nearRiver;
    h += (vnoise(x * 0.11, z * 0.11, seed + 2) - 0.5) * 0.25 * nearRiver;
    // hills
    for (const f of this.features) {
      if (f.kind !== 'hill') continue;
      const rad = f.shape.circle ? f.shape.circle.r : Math.min(f.shape.rect.x1 - f.shape.rect.x0, f.shape.rect.z1 - f.shape.rect.z0) / 2;
      const amp = Math.min(4, Math.max(2, rad * 0.42));
      const d = sdShape(f.shape, x, z) + rad; // distance from the centre (circle) / inner
      const R = rad * 1.75;
      const t = clamp01(d / R);
      const bump = 0.5 + 0.5 * Math.cos(Math.PI * t);
      h += amp * bump * bump * (0.85 + 0.3 * vnoise(x * 0.2, z * 0.2, seed + 3));
    }
    // framing hills outside the field, opening into a valley along the river
    if (od > 0) {
      const valley = smoothstep(6, 45, Math.abs(sd));
      const big = fbm(x * 0.011 + 3, z * 0.011 - 7, seed + 4, 5);
      let rise = smoothstep(3, 60, od) * (4 + 16 * big) + smoothstep(40, 120, od) * 14;
      rise *= lerp(0.12, 1, valley);
      h += rise;
    }
    // level ground around the castles
    const kd = this.keepDist(x, z);
    h = lerp(0.05, h, smoothstep(17, 27, kd));
    // worn paths sit a little low
    const pd = this.pathDist(x, z);
    h -= 0.1 * smoothstep(2.2, 0.4, pd);
    // carve the river: bank slopes down to the water line, bed below
    if (sd < 3.5) {
      let target: number;
      if (sd >= 0) target = lerp(WATER_LEVEL + 0.04, Math.max(h, WATER_LEVEL + 0.2), smoothstep(0, 3.5, sd));
      else target = WATER_LEVEL - 0.08 - 1.0 * smoothstep(0, 3.8, -sd) - 0.15 * vnoise(x * 0.3, z * 0.3, seed + 8);
      h = Math.min(h, target);
      // fords lift the bed to a wadeable gravel bar
      for (const c of this.crossings) {
        if (c.kind !== 'ford') continue;
        const fd = sdRect(c, x, z) + (vnoise(x * 0.5, z * 0.5, seed + 11) - 0.5) * 0.8;
        const m = smoothstep(1.8, -0.6, fd);
        if (m > 0) h = lerp(h, Math.max(h, WATER_LEVEL - 0.22 + 0.06 * vnoise(x * 1.3, z * 1.3, seed + 12)), m);
      }
    }
    return h;
  }
}
