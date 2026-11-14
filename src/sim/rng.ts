// Seeded random numbers. mulberry32 plus a string/number hash; integer-only outputs where it matters.
// Nothing in src/sim may use Math.random, Date or any wall-clock source.

/** FNV-1a over the parts (numbers are written as decimal strings), finished with an avalanche mix. */
export function hash(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (let p = 0; p < parts.length; p++) {
    const s = String(parts[p]) + '\u0001';
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  /** Raw 32-bit unsigned integer (mulberry32). */
  u32(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  /** Float in [0, 1). Division by 2^32 is exact in IEEE doubles, so this is portable. */
  next(): number {
    return this.u32() / 4294967296;
  }
  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  /** FE-style percentile roll: integer 0..99. */
  pct(): number {
    return this.int(100);
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)];
  }
  shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }
}

export function mulberry32(seed: number): () => number {
  const r = new Rng(seed);
  return () => r.next();
}
