// The baked heightfield (1 m grid over the whole world), the splat map (2 px per metre:
// R dirt/paths, G rock, B mud/wet, A forest floor) and bridge decks.
import * as THREE from 'three';
import { Layout, WORLD, WATER_LEVEL, type Crossing } from './layout.ts';
import { fbm, smoothstep, clamp01 } from './noise.ts';

export interface Deck {
  c: Crossing;
  /** Deck ends (world z), z0 < z1, and the bank heights there. */
  z0: number;
  z1: number;
  h0: number;
  h1: number;
  arch: number;
}

export class Heightfield {
  readonly step = 1;
  readonly nx: number;
  readonly nz: number;
  readonly data: Float32Array;
  readonly decks: Deck[] = [];
  splat!: THREE.DataTexture;
  /** CPU copy of the splat (RGBA8) for prop placement. */
  splatData!: Uint8Array;
  readonly splatRes = 2;
  splatW = 0;
  splatH = 0;

  readonly layout: Layout;
  constructor(layout: Layout) {
    this.layout = layout;
    this.nx = Math.round((WORLD.x1 - WORLD.x0) / this.step) + 1;
    this.nz = Math.round((WORLD.z1 - WORLD.z0) / this.step) + 1;
    this.data = new Float32Array(this.nx * this.nz);
    for (let j = 0; j < this.nz; j++) {
      const z = WORLD.z0 + j * this.step;
      for (let i = 0; i < this.nx; i++) this.data[j * this.nx + i] = layout.height(WORLD.x0 + i * this.step, z);
    }
    for (const c of layout.crossings) {
      if (c.kind !== 'bridge') continue;
      const z0 = c.z0 - 2.2;
      const z1 = c.z1 + 2.2;
      this.decks.push({ c, z0, z1, h0: this.ground(c.cx, z0), h1: this.ground(c.cx, z1), arch: 1.05 });
    }
    this.bakeSplat();
  }

  /** Bilinear ground (riverbed included, no bridges). */
  ground(x: number, z: number): number {
    const fx = Math.min(this.nx - 1.001, Math.max(0, (x - WORLD.x0) / this.step));
    const fz = Math.min(this.nz - 1.001, Math.max(0, (z - WORLD.z0) / this.step));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const k = j * this.nx + i;
    const d = this.data;
    const a = d[k];
    const b = d[k + 1];
    const c = d[k + this.nx];
    const e = d[k + this.nx + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + e) * u * v;
  }

  /** Deck top at (x, z) or -Infinity when not on a bridge. */
  deckAt(x: number, z: number, margin = 0.3): number {
    for (const d of this.decks) {
      if (x < d.c.x0 + margin || x > d.c.x1 - margin || z < d.z0 || z > d.z1) continue;
      return deckCurve(d, (z - d.z0) / (d.z1 - d.z0));
    }
    return -Infinity;
  }

  heightAt(x: number, z: number): number {
    const g = this.ground(x, z);
    if (this.decks.length === 0) return g;
    return Math.max(g, this.deckAt(x, z));
  }

  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 0.75;
    const hx = this.ground(x + e, z) - this.ground(x - e, z);
    const hz = this.ground(x, z + e) - this.ground(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** Splat sample (0..1 per channel) at world (x, z). */
  splatAt(x: number, z: number): [number, number, number, number] {
    const i = Math.min(this.splatW - 1, Math.max(0, Math.round((x - WORLD.x0) * this.splatRes)));
    const j = Math.min(this.splatH - 1, Math.max(0, Math.round((z - WORLD.z0) * this.splatRes)));
    const k = (j * this.splatW + i) * 4;
    const s = this.splatData;
    return [s[k] / 255, s[k + 1] / 255, s[k + 2] / 255, s[k + 3] / 255];
  }

  private bakeSplat(): void {
    const L = this.layout;
    const w = Math.round((WORLD.x1 - WORLD.x0) * this.splatRes) + 1;
    const h = Math.round((WORLD.z1 - WORLD.z0) * this.splatRes) + 1;
    this.splatW = w;
    this.splatH = h;
    const out = new Uint8Array(w * h * 4);
    const n = new THREE.Vector3();
    const seed = L.seed;
    // paths are expensive to evaluate: sample at 1 m and bilinear-free nearest lookup is fine
    for (let j = 0; j < h; j++) {
      const z = WORLD.z0 + j / this.splatRes;
      for (let i = 0; i < w; i++) {
        const x = WORLD.x0 + i / this.splatRes;
        const k = (j * w + i) * 4;
        const od = L.outDist(x, z);
        const sd = L.riverSd(x, z);
        this.normalAt(x, z, n);
        const slope = 1 - n.y;
        const noise = fbm(x * 0.06, z * 0.06, seed + 31, 4);
        const fine = fbm(x * 0.3, z * 0.3, seed + 32, 3);
        // dirt: paths, worn patches, castle yards, crossing approaches
        const pd = L.pathDist(x, z);
        let dirt = smoothstep(2.0, 0.5, pd) * (0.75 + 0.25 * fine);
        dirt = Math.max(dirt, smoothstep(0.66, 0.78, noise) * 0.75 * (od < 1 ? 1 : 0.4));
        dirt = Math.max(dirt, smoothstep(22, 15, L.keepDist(x, z)) * (0.55 + 0.45 * fine));
        for (const c of L.crossings) {
          const cd = Math.hypot(Math.max(c.x0 - x, x - c.x1, 0), Math.max(c.z0 - 3 - z, z - c.z1 - 3, 0));
          dirt = Math.max(dirt, smoothstep(3.2, 0.5, cd) * 0.85);
        }
        // ruins: rubble floor
        for (const f of L.features) {
          if (f.kind !== 'ruins') continue;
          const r = f.shape.circle ? f.shape.circle.r : 4;
          const d = Math.hypot(x - f.cx, z - f.cz);
          dirt = Math.max(dirt, smoothstep(r + 2.5, r * 0.4, d) * (0.4 + 0.5 * fine));
        }
        // rock: steep slopes and outcrops in the hills
        let rock = smoothstep(0.2, 0.42, slope + (fine - 0.5) * 0.12);
        rock = Math.max(rock, smoothstep(0.7, 0.8, fbm(x * 0.045, z * 0.045, seed + 33, 4)) * smoothstep(8, 30, od));
        // wet mud / gravel near and under the river
        const mud = smoothstep(2.6, -0.6, sd + (fine - 0.5) * 1.2);
        const forest = L.forestAt(x, z);
        out[k] = Math.round(clamp01(dirt) * 255);
        out[k + 1] = Math.round(clamp01(rock) * 255);
        out[k + 2] = Math.round(clamp01(mud) * 255);
        out[k + 3] = Math.round(clamp01(forest) * 255);
      }
    }
    this.splatData = out;
    const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    this.splat = t;
  }

  /** March a ray against the heightfield (and bridge decks). */
  raycast(ray: THREE.Ray, maxDist = 900): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    let prevT = 0;
    let prevD = ray.origin.y - this.heightAt(ray.origin.x, ray.origin.z);
    if (prevD < 0) return null;
    for (let t = 0.5; t < maxDist; t += t < 60 ? 0.5 : 1.5) {
      ray.at(t, p);
      if (p.x < WORLD.x0 || p.x > WORLD.x1 || p.z < WORLD.z0 || p.z > WORLD.z1) {
        if (ray.direction.y >= 0) return null;
        prevT = t;
        continue;
      }
      const d = p.y - this.heightAt(p.x, p.z);
      if (d <= 0) {
        let a = prevT;
        let b = t;
        for (let k = 0; k < 18; k++) {
          const m = (a + b) / 2;
          ray.at(m, p);
          if (p.y - this.heightAt(p.x, p.z) > 0) a = m;
          else b = m;
        }
        ray.at(b, p);
        p.y = this.heightAt(p.x, p.z);
        return p;
      }
      prevT = t;
      prevD = d;
    }
    void prevD;
    return null;
  }

  isWater(x: number, z: number): boolean {
    if (this.ground(x, z) >= WATER_LEVEL - 0.03) return false;
    return this.deckAt(x, z, 0) === -Infinity;
  }
}

export function deckCurve(d: Deck, t: number): number {
  const s = Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
  return d.h0 + (d.h1 - d.h0) * t + 0.08 + d.arch * Math.pow(s, 0.7);
}
