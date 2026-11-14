// Integer maths: isqrt, a 256-step sine table and an integer atan2 (binary angle 0..255).
// Tables are built once from Taylor series using only + - * / (IEEE-exact, so identical on every platform).
// Every function here is sign-symmetric (f(-v) mirrors f(v)), which the mirror-fairness test relies on.

/** floor(sqrt(n)) for 0 <= n < 2^52. */
export function isqrt(n: number): number {
  if (n < 2) return n < 0 ? 0 : n;
  let x = n < 4294967296 ? 1 << ((33 - Math.clz32(n)) >> 1) : 67108864;
  if (x <= 0) x = 65536;
  for (;;) {
    const y = Math.trunc((x + Math.trunc(n / x)) / 2);
    if (y >= x) return x;
    x = y;
  }
}

/** Truncating integer division (symmetric under negation, unlike >> or floor). */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

export const TRIG_ONE = 4096;
/** SIN[a] = round(4096 * sin(2*pi*a/256)), exact quarter-wave symmetry. */
export const SIN = new Int32Array(256);
(() => {
  const PI = 3.141592653589793;
  for (let a = 0; a <= 64; a++) {
    const x = (a / 256) * 2 * PI;
    // Taylor series of sin around 0, accurate to < 1e-9 on [0, pi/2].
    let term = x, sum = x;
    for (let k = 1; k < 12; k++) {
      term = (-term * x * x) / ((2 * k) * (2 * k + 1));
      sum += term;
    }
    const v = Math.round(sum * TRIG_ONE);
    SIN[a] = v;
    SIN[128 - a] = v;
    SIN[(128 + a) & 255] = -v;
    SIN[(256 - a) & 255] = -v;
  }
  SIN[0] = 0;
  SIN[128] = 0;
})();
export function isin(a: number): number {
  return SIN[a & 255];
}
export function icos(a: number): number {
  return SIN[(a + 64) & 255];
}

// ATAN_T[i] for i in 0..64 = tan(i/256 turn) * 65536, used for a binary search in the first octant (0..32).
const TAN_FINE = new Int32Array(33);
(() => {
  for (let a = 0; a <= 32; a++) {
    const s = SIN[a], c = SIN[64 - a];
    TAN_FINE[a] = Math.round((s * 65536) / c);
  }
})();

/** Angle of (dx, dy) as a binary angle 0..255 (0 = +x, 64 = +y). angleOf(-dx, -dy) = angleOf(dx, dy) + 128 (mod 256). */
export function angleOf(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  const ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
  let a: number; // first-quadrant angle 0..64
  if (ay <= ax) a = octant(ay, ax);
  else a = 64 - octant(ax, ay);
  if (dx >= 0 && dy >= 0) return a & 255;
  if (dx < 0 && dy >= 0) return (128 - a) & 255;
  if (dx < 0) return (128 + a) & 255;
  return (256 - a) & 255;
}
/** Angle (0..32) whose tangent is num/den, num <= den. Nearest table entry. */
function octant(num: number, den: number): number {
  const t = Math.trunc((num * 65536) / den);
  let lo = 0, hi = 32;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (TAN_FINE[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && t - TAN_FINE[lo - 1] < TAN_FINE[lo] - t) lo--;
  return lo;
}

/** Fast integer hash of four ints -> uint32 (stateless RNG for the battle). */
export function mix4(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h ^ b, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h ^ c, 0x27d4eb2f);
  h ^= h >>> 16;
  h = Math.imul(h ^ d, 0x165667b1);
  h ^= h >>> 15;
  return h >>> 0;
}
