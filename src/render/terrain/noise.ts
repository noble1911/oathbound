// Small deterministic noise / RNG helpers for building the battlefield on the CPU (render side
// only: Math.* is fine here, nothing feeds back into the sim).

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);

/** Value noise in [0,1]. `period` > 0 wraps the lattice (tileable textures). */
export function vnoise(x: number, y: number, seed = 0, period = 0, periodY = period): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = fade(x - xi);
  const fy = fade(y - yi);
  let x0 = xi;
  let y0 = yi;
  let x1 = xi + 1;
  let y1 = yi + 1;
  if (period > 0) {
    x0 = ((x0 % period) + period) % period;
    x1 = ((x1 % period) + period) % period;
    y0 = ((y0 % periodY) + periodY) % periodY;
    y1 = ((y1 % periodY) + periodY) % periodY;
  }
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** fbm in ~[0,1]. With `period` the result tiles over [0, period). */
export function fbm(x: number, y: number, seed = 0, octaves = 5, period = 0): number {
  let s = 0;
  let amp = 0.5;
  let norm = 0;
  let p = period;
  for (let i = 0; i < octaves; i++) {
    s += amp * vnoise(x, y, seed + i * 131, p);
    norm += amp;
    x *= 2;
    y *= 2;
    if (p > 0) p *= 2;
    amp *= 0.5;
  }
  return s / norm;
}

/** Periodic Worley (cellular) noise: F1, F2 distances (cell units) and the nearest cell's id hash. */
export function worley(x: number, y: number, cells: number, seed = 0): { f1: number; f2: number; id: number } {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const px = cx + hash2(wx, wy, seed);
      const py = cy + hash2(wx, wy, seed + 77);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash2(wx, wy, seed + 999);
      } else if (d < f2) f2 = d;
    }
  }
  return { f1, f2, id };
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
