// Stone arch bridges, built per crossing (the deck follows deckCurve, which the heightfield also
// uses for the soldiers walking over it): a humped two-arch bridge with a central pier and pointed
// cutwaters, raised voussoir rings around the arches (stones laid radially), spandrel walls,
// a string course, parapets with coping stones and capped end posts, a cobbled deck.
// Masonry is a scanned CC0 wall / cobble set (tools/art/env.py -> public/textures/env/stone_*),
// mapped at real scale (blocks ~45 cm) with a normal map; vertex colours add the weathering:
// damp, dark stone and moss towards the water line, lighter dressed stone for copings and rings.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Heightfield, Deck } from './heightfield.ts';
import { deckCurve } from './heightfield.ts';
import { WATER_LEVEL } from './layout.ts';
import { vnoise } from './noise.ts';
import { assetUrl, loadAssetVersions } from '../../assets.ts';

/** Metres per texture tile: the wall scan covers 2 m with ~25 cm blocks; stretched to ~40 cm stones. */
const WALL_TILE = 2.4;
const DECK_TILE = 2.6;

class Mesh {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private n = new THREE.Vector3();

  /** A quad a-b-c-d (counter-clockwise seen from outside) with per-corner uv and a flat normal. */
  quad(p: number[][], uv: number[][], tone: number): void {
    this.a.set(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]);
    this.b.set(p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]);
    this.n.crossVectors(this.a, this.b);
    if (this.n.lengthSq() < 1e-12) {
      this.b.set(p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]);
      this.n.crossVectors(this.a, this.b);
    }
    this.n.normalize();
    for (const i of [0, 1, 2, 0, 2, 3]) {
      this.pos.push(p[i][0], p[i][1], p[i][2]);
      this.nor.push(this.n.x, this.n.y, this.n.z);
      this.uv.push(uv[i][0], uv[i][1]);
      this.col.push(tone, tone, tone);
    }
  }

  /** Planar quad with box-mapped uv (by the dominant axis of its normal). */
  face(p: number[][], tone: number, tile = WALL_TILE): void {
    this.a.set(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]);
    this.b.set(p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]);
    this.n.crossVectors(this.a, this.b);
    if (this.n.lengthSq() < 1e-12) {
      this.b.set(p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]);
      this.n.crossVectors(this.a, this.b);
    }
    const ax = Math.abs(this.n.x);
    const ay = Math.abs(this.n.y);
    const az = Math.abs(this.n.z);
    const uv = p.map((q) => (ay >= ax && ay >= az ? [q[0] / tile, q[2] / tile] : ax >= az ? [q[2] / tile, q[1] / tile] : [q[0] / tile, q[1] / tile]));
    this.quad(p, uv, tone);
  }

  /** An axis-aligned box (x0..x1, y0..y1, z0..z1), all six faces. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, tone: number): void {
    this.face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], tone);
    this.face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], tone);
    this.face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], tone);
    this.face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], tone);
    this.face([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], tone);
    this.face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], tone);
  }

  /**
   * A wall running along z: between `bottom(t)` and `top(t)`, from x = xa to xb, sampled at `ts`.
   * Faces: both sides, the top, optionally the underside and the two ends.
   */
  wall(ts: number[], zAt: (t: number) => number, xa: number, xb: number, bottom: (t: number) => number, top: (t: number) => number, tone: number, o: { under?: boolean; ends?: boolean; topTile?: number } = {}): void {
    for (let i = 0; i < ts.length - 1; i++) {
      const t0 = ts[i];
      const t1 = ts[i + 1];
      const z0 = zAt(t0);
      const z1 = zAt(t1);
      if (Math.abs(z1 - z0) < 1e-6) continue;
      const b0 = bottom(t0);
      const b1 = bottom(t1);
      const h0 = top(t0);
      const h1 = top(t1);
      this.face([[xa, b0, z0], [xa, b1, z1], [xa, h1, z1], [xa, h0, z0]], tone);
      this.face([[xb, b1, z1], [xb, b0, z0], [xb, h0, z0], [xb, h1, z1]], tone);
      this.face([[xa, h0, z0], [xa, h1, z1], [xb, h1, z1], [xb, h0, z0]], tone, o.topTile ?? WALL_TILE);
      if (o.under) this.face([[xa, b1, z1], [xa, b0, z0], [xb, b0, z0], [xb, b1, z1]], tone);
    }
    if (o.ends !== false) {
      const s = ts[0];
      const e = ts[ts.length - 1];
      this.face([[xb, bottom(s), zAt(s)], [xa, bottom(s), zAt(s)], [xa, top(s), zAt(s)], [xb, top(s), zAt(s)]], tone);
      this.face([[xa, bottom(e), zAt(e)], [xb, bottom(e), zAt(e)], [xb, top(e), zAt(e)], [xa, top(e), zAt(e)]], tone);
    }
  }

  build(weather: (x: number, y: number, z: number, up: number, c: THREE.Color) => void): THREE.BufferGeometry {
    const c = new THREE.Color();
    for (let i = 0; i < this.pos.length; i += 3) {
      c.setRGB(this.col[i], this.col[i + 1], this.col[i + 2]);
      weather(this.pos[i], this.pos[i + 1], this.pos[i + 2], this.nor[i + 1], c);
      this.col[i] = c.r;
      this.col[i + 1] = c.g;
      this.col[i + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

/** Wall (masonry) and deck (cobbles) geometry of one bridge, in world space. */
export function buildBridge(hf: Heightfield, d: Deck): { wall: THREE.BufferGeometry; deck: THREE.BufferGeometry } {
  const c = d.c;
  const len = d.z1 - d.z0;
  const zAt = (t: number) => d.z0 + len * t;
  const tOf = (z: number) => (z - d.z0) / len;
  const deck = (t: number) => deckCurve(d, t);
  const m = new Mesh();
  const x0 = c.x0;
  const x1 = c.x1;
  const DRESSED = 1.16; // copings, rings, string course: lighter dressed stone
  const BODY = 0.96;

  // two arches over the water with a pier in mid-stream
  const spring = WATER_LEVEL + 0.12;
  const pierHalf = 0.62;
  const zc = (c.z0 + c.z1) / 2;
  const edge0 = c.z0 - 0.25;
  const edge1 = c.z1 + 0.25;
  const arches = [
    { za: edge0, zb: zc - pierHalf },
    { za: zc + pierHalf, zb: edge1 },
  ].map((a) => {
    const mid = (a.za + a.zb) / 2;
    const half = (a.zb - a.za) / 2;
    // the crown stays 0.62 m under the lowest deck point above the arch's middle third
    const crown = Math.min(deck(tOf(mid - half * 0.3)), deck(tOf(mid + half * 0.3))) - 0.62;
    return { ...a, mid, half, rise: Math.max(0.5, crown - spring) };
  });
  const archAt = (z: number): number | null => {
    for (const a of arches) {
      if (z <= a.za || z >= a.zb) continue;
      const s = (z - a.mid) / a.half;
      return spring + a.rise * Math.sqrt(Math.max(0, 1 - s * s));
    }
    return null;
  };
  const footing = (t: number) => Math.min(hf.ground(c.cx, zAt(t)), WATER_LEVEL) - 0.6;
  const under = (t: number) => archAt(zAt(t)) ?? footing(t);

  // samples: even along the deck, dense on the arch curves, doubled at the springings (vertical jambs)
  const set = new Set<number>();
  for (let i = 0; i <= 36; i++) set.add(i / 36);
  for (const a of arches) {
    for (let k = 0; k <= 20; k++) set.add(tOf(a.mid - a.half * Math.cos((Math.PI * k) / 20)));
    for (const z of [a.za, a.zb]) {
      set.add(tOf(z - 1e-4));
      set.add(tOf(z + 1e-4));
    }
  }
  const ts = [...set].filter((t) => t >= 0 && t <= 1).sort((p, q) => p - q);

  // body: spandrel walls + arch barrels (the deck surface is a separate cobbled mesh)
  const bodyTop = (t: number) => deck(t) - 0.02;
  m.wall(ts, zAt, x0, x1, under, bodyTop, BODY, { under: true });

  // voussoir rings: a raised band around each arch on both faces, stones laid radially
  const ringW = 0.36;
  const proud = 0.07;
  for (const a of arches) {
    const n = 22;
    for (const side of [-1, 1]) {
      const xf = side < 0 ? x0 - proud : x1 + proud;
      const xw = side < 0 ? x0 : x1;
      for (let k = 0; k < n; k++) {
        const th0 = (Math.PI * k) / n;
        const th1 = (Math.PI * (k + 1)) / n;
        const P = (th: number, w: number) => [xf, spring + (a.rise + w) * Math.sin(th), a.mid - (a.half + w) * Math.cos(th)];
        const u0 = (a.half * th0) / WALL_TILE;
        const u1 = (a.half * th1) / WALL_TILE;
        const in0 = P(th0, 0);
        const in1 = P(th1, 0);
        const out0 = P(th0, ringW);
        const out1 = P(th1, ringW);
        const quad = side < 0 ? [in0, in1, out1, out0] : [in1, in0, out0, out1];
        const uvs = side < 0 ? [[u0, 0], [u1, 0], [u1, ringW / WALL_TILE], [u0, ringW / WALL_TILE]] : [[u1, 0], [u0, 0], [u0, ringW / WALL_TILE], [u1, ringW / WALL_TILE]];
        m.quad(quad, uvs, DRESSED);
        // the band's outer rim back to the wall
        const w0 = [xw, out0[1], out0[2]];
        const w1 = [xw, out1[1], out1[2]];
        m.quad(side < 0 ? [out0, out1, w1, w0] : [out1, out0, w0, w1], [[u0, 0], [u1, 0], [u1, 0.03], [u0, 0.03]], DRESSED * 0.9);
      }
    }
  }

  // string course under the parapet, parapets, coping stones
  const course = (t: number) => deck(t) - 0.2;
  const parapetTop = (t: number) => deck(t) + 0.82;
  const copeTop = (t: number) => parapetTop(t) + 0.13;
  const even: number[] = [];
  for (let i = 0; i <= 28; i++) even.push(i / 28);
  for (const side of [-1, 1]) {
    const xo = side < 0 ? x0 : x1; // outer face
    const xi = xo - side * 0.4; // inner face
    m.wall(even, zAt, Math.min(xo + side * 0.09, xo), Math.max(xo + side * 0.09, xo), course, deck, DRESSED);
    m.wall(even, zAt, Math.min(xo, xi), Math.max(xo, xi), deck, parapetTop, BODY * 1.04);
    m.wall(even, zAt, Math.min(xo + side * 0.08, xi - side * 0.08), Math.max(xo + side * 0.08, xi - side * 0.08), parapetTop, copeTop, DRESSED);
    // end posts with a cap slab and a low pyramid
    for (const t of [0.012, 0.988]) {
      const z = zAt(t);
      const y = deck(t) - 0.3;
      const cx = (xo + xi) / 2;
      const h = 0.38;
      m.box(cx - h, cx + h, y, y + 1.55, z - h, z + h, BODY * 1.04);
      m.box(cx - h - 0.08, cx + h + 0.08, y + 1.55, y + 1.69, z - h - 0.08, z + h + 0.08, DRESSED);
      const top = [cx, y + 1.95, z];
      const r = h + 0.02;
      const cs = [[cx - r, y + 1.69, z + r], [cx + r, y + 1.69, z + r], [cx + r, y + 1.69, z - r], [cx - r, y + 1.69, z - r]];
      for (let k = 0; k < 4; k++) m.face([cs[k], cs[(k + 1) % 4], top, top], DRESSED);
    }
  }

  // pier cutwaters: pointed noses up- and downstream, with a sloped cap dying into the wall
  {
    const bed = hf.ground(c.cx, zc) - 0.4;
    const topY = spring + 0.95;
    const capY = topY + 0.75;
    const hw = pierHalf + 0.12;
    for (const side of [-1, 1]) {
      const xw = side < 0 ? x0 : x1;
      const nose = xw + side * 1.25;
      const A = [xw, bed, zc - hw];
      const B = [xw, bed, zc + hw];
      const N = [nose, bed, zc];
      const A1 = [xw, topY, zc - hw];
      const B1 = [xw, topY, zc + hw];
      const N1 = [nose, topY, zc];
      const cap = [xw, capY, zc];
      if (side < 0) {
        m.face([B, N, N1, B1], BODY);
        m.face([N, A, A1, N1], BODY);
        m.face([B1, N1, cap, cap], DRESSED);
        m.face([N1, A1, cap, cap], DRESSED);
      } else {
        m.face([N, B, B1, N1], BODY);
        m.face([A, N, N1, A1], BODY);
        m.face([N1, B1, cap, cap], DRESSED);
        m.face([A1, N1, cap, cap], DRESSED);
      }
    }
  }

  // weathering: damp dark stone and moss towards the water, lichen patches, soot under the arches
  const moss = new THREE.Color('#566332');
  const wall = m.build((x, y, z, up, col) => {
    const n = vnoise(x * 0.9 + y * 0.6, z * 0.9, 17);
    const n2 = vnoise(z * 0.35, y * 1.3 + x * 0.2, 23);
    col.multiplyScalar(0.86 + 0.26 * n);
    const h = y - WATER_LEVEL;
    const damp = THREE.MathUtils.clamp(1 - h / (0.9 + n2 * 0.9), 0, 1);
    col.multiplyScalar(1 - 0.5 * damp);
    const green = THREE.MathUtils.clamp(1 - h / (1.5 + n2 * 1.2), 0, 1) * (0.35 + 0.65 * n2) + Math.max(0, up) * 0.22 * n2;
    col.lerp(moss, Math.min(0.75, green * 0.9));
    // under the barrels
    if (up < -0.3) col.multiplyScalar(0.62);
    // rain streaks down the spandrels
    col.multiplyScalar(0.9 + 0.1 * vnoise(z * 2.2, 0.5, 5));
  });

  // cobbled deck between the parapets
  const dm = new Mesh();
  for (let i = 0; i < even.length - 1; i++) {
    const t0 = even[i];
    const t1 = even[i + 1];
    const p = [[x0 + 0.38, deck(t0), zAt(t0)], [x0 + 0.38, deck(t1), zAt(t1)], [x1 - 0.38, deck(t1), zAt(t1)], [x1 - 0.38, deck(t0), zAt(t0)]];
    dm.quad(p, p.map((q) => [q[0] / DECK_TILE, q[2] / DECK_TILE]), 1);
  }
  const deckGeo = dm.build((x, _y, z, _up, col) => {
    // worn lighter along the middle, dirt and moss at the kerbs
    const k = Math.abs((x - (x0 + x1) / 2) / ((x1 - x0) / 2));
    col.multiplyScalar((0.82 + 0.3 * vnoise(x * 0.8, z * 0.8, 31)) * (1.05 - 0.3 * k * k));
    col.lerp(moss, Math.max(0, k - 0.8) * 1.2 * vnoise(z * 1.1, x, 37));
  });
  return { wall, deck: deckGeo };
}

function stoneTex(name: string, srgb: boolean, onLoad: () => void): THREE.Texture {
  const t = new THREE.Texture();
  void loadAssetVersions().then(() => new THREE.ImageLoader().load(assetUrl(`textures/env/${name}.webp`), (img) => {
    t.image = img;
    t.needsUpdate = true;
    onLoad();
  }));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

/** The bridges of a field: two meshes (masonry, cobbles) and their materials. */
export class Bridges {
  readonly meshes: THREE.Mesh[] = [];
  private mats: THREE.MeshStandardMaterial[] = [];

  constructor(hf: Heightfield, onLoad: () => void) {
    if (!hf.decks.length) return;
    const parts = hf.decks.map((d) => buildBridge(hf, d));
    const mk = (name: string, geos: THREE.BufferGeometry[], tex: string, rough: number): void => {
      const g = mergeGeometries(geos, false)!;
      for (const x of geos) x.dispose();
      g.computeBoundingSphere();
      const mat = new THREE.MeshStandardMaterial({
        map: stoneTex(`${tex}_a`, true, onLoad),
        normalMap: stoneTex(`${tex}_n`, false, onLoad),
        normalScale: new THREE.Vector2(1.1, 1.1),
        vertexColors: true,
        roughness: rough,
        metalness: 0,
        side: THREE.DoubleSide,
      });
      mat.envMapIntensity = 0.8;
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.meshes.push(mesh);
      this.mats.push(mat);
    };
    mk('bridge', parts.map((p) => p.wall), 'stone_wall', 0.92);
    mk('bridge-deck', parts.map((p) => p.deck), 'stone_deck', 0.86);
  }

  dispose(): void {
    for (const m of this.meshes) m.geometry.dispose();
    for (const m of this.mats) {
      m.map?.dispose();
      m.normalMap?.dispose();
      m.dispose();
    }
  }
}
