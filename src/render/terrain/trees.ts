// Procedural vegetation geometry (generated once at startup, a few ms): real branch geometry
// (tapered, bent bark tubes) plus alpha-tested leaf-cluster cards from the vegetation atlas
// (env-textures.ts). Three levels per tree species:
//   LOD0  trunk + primary + secondary branches, ~35 dome-bent cluster cards        (~300 tris)
//   LOD1  trunk + primary stubs, ~15 larger dome-bent cards                         (~110 tris)
//   far   camera-facing impostor quads built in the vertex shader (attribute aCorner) (4-10 tris)
// Vertex attributes: uv (atlas), color (baked canopy occlusion x tint), normal (bent away from the
// canopy centre so a crown shades as one soft volume), aSway (wind weight), aLeaf (1 = leaf card).
import * as THREE from 'three';
import { cellUv, type VegCell } from './env-textures.ts';
import { mulberry32 } from './noise.ts';

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  sway: number[] = [];
  leaf: number[] = [];
  corner: number[] = [];
  idx: number[] = [];
  private v = new THREE.Vector3();

  get count(): number {
    return this.pos.length / 3;
  }
  vert(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, c: [number, number, number], sway: number, leaf: number): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    this.sway.push(sway);
    this.leaf.push(leaf);
    return this.count - 1;
  }

  /** A tapered bark tube along `pts` (radius per point); `sway(y)` gives the wind weight. */
  tube(pts: { p: THREE.Vector3; r: number }[], seg: number, cell: VegCell, tint: [number, number, number], sway: (p: THREE.Vector3) => number): void {
    const [u0, v0, u1, v1] = cellUv(cell, 1);
    const t = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const n = new THREE.Vector3();
    const base = this.count;
    for (let i = 0; i < pts.length; i++) {
      t.subVectors(pts[Math.min(pts.length - 1, i + 1)].p, pts[Math.max(0, i - 1)].p).normalize();
      a.set(1, 0, 0);
      if (Math.abs(t.x) > 0.9) a.set(0, 0, 1);
      a.cross(t).normalize();
      b.crossVectors(t, a);
      // consecutive rings mirror the bark column (v 0 -> 1 -> 0 ...): seamless without wrapping
      const vv = i % 2 ? v1 : v0;
      const shade = i === 0 ? 0.62 : 1;
      for (let j = 0; j <= seg; j++) {
        const ang = (j / seg) * Math.PI * 2;
        n.copy(a).multiplyScalar(Math.cos(ang)).addScaledVector(b, Math.sin(ang));
        this.v.copy(pts[i].p).addScaledVector(n, pts[i].r);
        this.vert(this.v, n, u0 + (u1 - u0) * (j / seg), vv, [tint[0] * shade, tint[1] * shade, tint[2] * shade], sway(this.v), 0);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      for (let j = 0; j < seg; j++) {
        const p0 = base + i * (seg + 1) + j;
        const p1 = p0 + seg + 1;
        this.idx.push(p0, p0 + 1, p1, p0 + 1, p1 + 1, p1);
      }
    }
  }

  /**
   * A leaf-cluster card centred at `c`, facing `n`, `w` x `h` metres, rolled about `n`. `bend` > 0
   * adds a centre vertex pushed along `n` (a shallow dome: parallax, no paper look). Normals lean
   * away from `crown`; `shade(p)` is the baked occlusion at a corner.
   */
  card(c: THREE.Vector3, n: THREE.Vector3, w: number, h: number, roll: number, cell: VegCell, crown: THREE.Vector3, tint: [number, number, number], bend: number, shade: (p: THREE.Vector3) => number, sway: (p: THREE.Vector3) => number, flat = 0.3): void {
    const [u0, v0, u1, v1] = cellUv(cell, 2);
    const a = new THREE.Vector3(0, 1, 0);
    if (Math.abs(n.y) > 0.92) a.set(1, 0, 0);
    a.cross(n).normalize().applyAxisAngle(n, roll);
    const b = new THREE.Vector3().crossVectors(n, a);
    const bn = new THREE.Vector3();
    const put = (sx: number, sy: number, k: number, u: number, v: number): number => {
      this.v.copy(c).addScaledVector(a, sx * w * 0.5).addScaledVector(b, sy * h * 0.5).addScaledVector(n, k);
      bn.subVectors(this.v, crown).normalize().lerp(n, flat).normalize();
      const s = shade(this.v);
      return this.vert(this.v, bn, u, v, [tint[0] * s, tint[1] * s, tint[2] * s], sway(this.v), 1);
    };
    const i0 = put(-1, -1, 0, u0, v0);
    const i1 = put(1, -1, 0, u1, v0);
    const i2 = put(1, 1, 0, u1, v1);
    const i3 = put(-1, 1, 0, u0, v1);
    if (bend > 0) {
      const ic = put(0, 0, bend, (u0 + u1) / 2, (v0 + v1) / 2);
      this.idx.push(i0, i1, ic, i1, i2, ic, i2, i3, ic, i3, i0, ic);
    } else this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /**
   * An impostor quad: all four vertices sit at `pivot`; the vertex shader offsets them by
   * aCorner.xy metres along the camera's right / up (aCorner.z: 0 = fully camera-facing, 1 = upright,
   * turning about the vertical axis with a partial lean towards the camera).
   */
  billboard(pivot: THREE.Vector3, x0: number, x1: number, y0: number, y1: number, upright: number, cell: VegCell, tintLo: [number, number, number], tintHi: [number, number, number], sway: number, leaf: number, nk = 1): void {
    const [u0, v0, u1, v1] = cellUv(cell, 2);
    const base = this.count;
    const cs: [number, number, number, number, [number, number, number], number][] = [
      [x0, y0, u0, v0, tintLo, -1],
      [x1, y0, u1, v0, tintLo, -1],
      [x1, y1, u1, v1, tintHi, 1],
      [x0, y1, u0, v1, tintHi, 1],
    ];
    cs.forEach(([x, y, u, v, c, ny], i) => {
      this.pos.push(pivot.x, pivot.y, pivot.z);
      // "normal" carries the hemisphere coordinates of the corner (view space, see the impostor shader)
      this.nor.push((i === 0 || i === 3 ? -1 : 1) * nk, ny * nk, 0);
      this.uv.push(u, v);
      this.col.push(c[0], c[1], c[2]);
      this.sway.push(y > 0.5 ? sway : 0);
      this.leaf.push(leaf);
      this.corner.push(x, y, upright);
    });
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(this.leaf, 1));
    if (this.corner.length) g.setAttribute('aCorner', new THREE.Float32BufferAttribute(this.corner, 3));
    g.setIndex(this.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
type RGB = [number, number, number];

/** Species: 0 oak, 1 broad oak, 2 pine (tall, narrow), 3 fir (wider), 4 birch. */
export const TREE_SPECIES = 5;
export type TreeLod = 0 | 1;

interface Broadleaf {
  seed: number;
  trunkH: number;
  trunkR: number;
  lean: number;
  bark: VegCell;
  barkTint: RGB;
  leaf: VegCell;
  /** Crown centre height above the trunk top, radii (horizontal, vertical). */
  crownUp: number;
  rx: number;
  ry: number;
  branches: number;
  /** Branch angle from vertical (rad) and length. */
  spread: number;
  reach: number;
  cardSize: number;
  tint: RGB;
}

const OAK: Broadleaf = { seed: 11, trunkH: 4.3, trunkR: 0.34, lean: 0.25, bark: 'barkOak', barkTint: [0.8, 0.74, 0.66], leaf: 'oak', crownUp: 1.7, rx: 3.3, ry: 2.5, branches: 5, spread: 0.95, reach: 2.9, cardSize: 2.7, tint: [1.12, 1.2, 0.96] };
const OAK_B: Broadleaf = { ...OAK, seed: 23, trunkH: 3.7, trunkR: 0.4, crownUp: 1.5, rx: 3.7, ry: 2.3, branches: 6, spread: 1.08, reach: 3.2, tint: [1.16, 1.2, 0.9] };
const BIRCH: Broadleaf = { seed: 53, trunkH: 6.4, trunkR: 0.15, lean: 0.5, bark: 'barkBirch', barkTint: [1.05, 1.05, 1.02], leaf: 'birch', crownUp: 0.5, rx: 1.9, ry: 2.9, branches: 4, spread: 0.5, reach: 1.9, cardSize: 2.0, tint: [1.16, 1.2, 0.96] };

function broadleaf(s: Broadleaf, lod: TreeLod): THREE.BufferGeometry {
  const rnd = mulberry32(s.seed);
  const b = new Builder();
  const top = s.trunkH + s.crownUp + s.ry;
  const swayH = (p: THREE.Vector3) => Math.min(1, Math.max(0, p.y / top)) ** 1.5;
  const lx = (rnd() - 0.5) * s.lean * 2;
  const lz = (rnd() - 0.5) * s.lean * 2;
  const at = (t: number) => V(lx * t * t + Math.sin(t * 5 + s.seed) * 0.07, s.trunkH * t, lz * t * t + Math.cos(t * 4 + s.seed) * 0.07);
  // trunk: root flare, slight bends, continuing as a leader into the crown
  const rings = lod === 0 ? [0, 0.08, 0.35, 0.68, 1] : [0, 0.12, 1];
  const trunk = rings.map((t) => ({ p: at(t), r: s.trunkR * (t === 0 ? 1.55 : 1 - 0.5 * t) }));
  trunk.push({ p: at(1).add(V(lx * 0.4, s.crownUp + s.ry * 0.3, lz * 0.4)), r: s.trunkR * 0.16 });
  b.tube(trunk, lod === 0 ? 7 : 5, s.bark, s.barkTint, swayH);
  const crown = at(1).add(V(lx * 0.3, s.crownUp, lz * 0.3));
  // baked occlusion: the crown's underside and core are darker than its sunlit shell
  const shade = (p: THREE.Vector3) => {
    const d = Math.hypot((p.x - crown.x) / s.rx, (p.y - crown.y) / s.ry, (p.z - crown.z) / s.rx);
    const up = (p.y - crown.y) / s.ry;
    return (0.6 + 0.4 * Math.min(1, d)) * (0.78 + 0.22 * Math.min(1, Math.max(0, up * 0.7 + 0.6)));
  };
  const swayL = (p: THREE.Vector3) => Math.min(1, swayH(p) + 0.08);
  const tintOf = (): RGB => {
    const k = 0.88 + rnd() * 0.24;
    const warm = rnd() < 0.18 ? 1.12 : 1;
    return [s.tint[0] * k * warm, s.tint[1] * k, s.tint[2] * k * (2 - warm)];
  };
  const bend = lod === 0 ? 0.22 : 0.26;
  const size = s.cardSize * (lod === 0 ? 1 : 1.25);
  const place = (c: THREE.Vector3, k = 1) => {
    const n = c.clone().sub(crown);
    n.x /= s.rx;
    n.y /= s.ry;
    n.z /= s.rx;
    // cards lean more up than out: from the RTS camera a crown reads as overlapping clusters, not edge-on fans
    n.normalize().multiplyScalar(lod === 0 ? 0.6 : 0.45).add(V((rnd() - 0.5) * 0.6, (lod === 0 ? 0.55 : 0.8) + rnd() * 0.3, (rnd() - 0.5) * 0.6)).normalize();
    const sz = size * k * (0.85 + rnd() * 0.3);
    b.card(c, n, sz, sz, rnd() * Math.PI * 2, s.leaf, crown, tintOf(), bend * sz, shade, swayL);
  };
  // primary branches: leave the upper trunk, curve upward, end inside the crown shell
  for (let i = 0; i < s.branches; i++) {
    const az = (i / s.branches) * Math.PI * 2 + rnd() * 0.7;
    const t0 = 0.58 + 0.4 * ((i * 0.618) % 1);
    const o = at(t0);
    const dir = V(Math.cos(az) * Math.sin(s.spread), Math.cos(s.spread), Math.sin(az) * Math.sin(s.spread));
    const len = s.reach * (0.8 + rnd() * 0.4);
    const mid = o.clone().addScaledVector(dir, len * 0.55);
    const end = mid.clone().addScaledVector(dir, len * 0.4).add(V(0, len * 0.22, 0));
    const r0 = s.trunkR * 0.42;
    b.tube(lod === 0 ? [{ p: o, r: r0 }, { p: mid, r: r0 * 0.6 }, { p: end, r: r0 * 0.2 }] : [{ p: o, r: r0 }, { p: end, r: r0 * 0.25 }], lod === 0 ? 5 : 3, s.bark, s.barkTint, swayH);
    place(end.clone().add(V(0, 0.2, 0)));
    if (lod === 0) {
      // secondary twigs with their own clusters
      for (let k = 0; k < 2; k++) {
        const a2 = az + (k ? 1 : -1) * (0.7 + rnd() * 0.5);
        const d2 = V(Math.cos(a2) * 0.8, 0.45 + rnd() * 0.3, Math.sin(a2) * 0.8).normalize();
        const e2 = mid.clone().addScaledVector(d2, len * (0.4 + rnd() * 0.2));
        b.tube([{ p: mid, r: r0 * 0.38 }, { p: e2, r: r0 * 0.12 }], 3, s.bark, s.barkTint, swayH);
        place(e2, 0.9);
      }
    }
  }
  // shell fill: clusters spread over the crown ellipsoid (upper hemisphere dense, underside sparse)
  const fill = lod === 0 ? 17 : 9;
  for (let i = 0; i < fill; i++) {
    const y = 1 - (i + 0.5) / fill * 1.45; // 1 .. -0.45
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const az = i * 2.39996 + rnd() * 0.4;
    const k = 0.78 + rnd() * 0.14;
    place(V(crown.x + Math.cos(az) * r * s.rx * k, crown.y + y * s.ry * k, crown.z + Math.sin(az) * r * s.rx * k));
  }
  // one cluster right on top closes the crown from above (the planning camera looks down)
  place(V(crown.x, crown.y + s.ry * 0.82, crown.z), 1.1);
  return b.build();
}

interface Conifer {
  seed: number;
  h: number;
  /** Bottom whorl radius. */
  r: number;
  tint: RGB;
  bare: number;
}
const PINE: Conifer = { seed: 31, h: 12.5, r: 2.3, tint: [1.14, 1.14, 0.94], bare: 2.6 };
const FIR: Conifer = { seed: 47, h: 10.5, r: 2.9, tint: [0.98, 1.12, 1.06], bare: 1.5 };

function conifer(s: Conifer, lod: TreeLod): THREE.BufferGeometry {
  const rnd = mulberry32(s.seed);
  const b = new Builder();
  const swayH = (p: THREE.Vector3) => Math.min(1, Math.max(0, p.y / s.h)) ** 1.6;
  const barkTint: RGB = [0.78, 0.7, 0.62];
  b.tube([{ p: V(0, 0, 0), r: 0.34 }, { p: V(0, 0.5, 0), r: 0.24 }, { p: V(0.05, s.h * 0.5, 0.03), r: 0.14 }, { p: V(0, s.h * 0.97, 0), r: 0.02 }], lod === 0 ? 6 : 4, 'barkPine', barkTint, swayH);
  const levels = lod === 0 ? 7 : 4;
  const per = lod === 0 ? 5 : 4;
  const axis = V(0, 0, 0);
  for (let l = 0; l < levels; l++) {
    const t = l / levels;
    const y = s.bare + (s.h - 2.2 - s.bare) * t;
    const len = s.r * (1 - 0.72 * t) * (lod === 0 ? 1 : 1.12);
    const droop = 0.5 - 0.35 * t;
    for (let k = 0; k < per; k++) {
      const az = ((k + (l % 2) * 0.5) / per) * Math.PI * 2 + (rnd() - 0.5) * 0.35;
      const out = V(Math.cos(az), 0, Math.sin(az));
      const dir = out.clone().multiplyScalar(Math.cos(droop)).add(V(0, -Math.sin(droop), 0));
      const c = V(0, y, 0).addScaledVector(dir, len * 0.5);
      // card plane: `dir` (cell up = bough tip) x a tangent rolled either way, so side views see area too
      const tan = V(-Math.sin(az), 0, Math.cos(az));
      const roll = (k % 2 ? 1 : -1) * (0.35 + rnd() * 0.3);
      const n = new THREE.Vector3().crossVectors(tan, dir).normalize().applyAxisAngle(dir, roll);
      const k0 = 0.86 + rnd() * 0.22;
      const tint: RGB = [s.tint[0] * k0, s.tint[1] * k0, s.tint[2] * k0];
      axis.set(0, y - len * 0.9, 0);
      // card(): "up" of the cell must run along dir: find the roll that aligns the card's b axis with dir
      const a0 = new THREE.Vector3(0, 1, 0);
      if (Math.abs(n.y) > 0.92) a0.set(1, 0, 0);
      a0.cross(n).normalize();
      const b0 = new THREE.Vector3().crossVectors(n, a0);
      const ang = Math.atan2(dir.dot(a0), dir.dot(b0));
      const shade = (p: THREE.Vector3) => (0.5 + 0.5 * Math.min(1, Math.hypot(p.x, p.z) / (len * 0.9))) * (0.78 + 0.22 * t);
      b.card(c, n, len * 0.95, len, -ang, 'fir', axis, tint, lod === 0 ? len * 0.12 : 0, shade, (p) => Math.min(1, swayH(p) + 0.05), 0.15);
    }
  }
  // a core: two crossed full-height silhouettes (the fir cell is a whole little tree), darker than
  // the boughs, so the gaps between whorls show foliage instead of stacked cards with sky between
  const ch = s.h - s.bare * 0.6;
  for (let k = 0; k < 2; k++) {
    const n = V(Math.cos(k * 1.57 + 1.1), 0, Math.sin(k * 1.57 + 1.1));
    axis.set(0, s.h * 0.2, 0);
    const core: RGB = [s.tint[0] * 0.62, s.tint[1] * 0.62, s.tint[2] * 0.62];
    b.card(V(0, s.bare * 0.6 + ch * 0.5, 0), n, s.r * 1.25, ch, 0, 'fir', axis, core, 0, (p) => 0.75 + 0.25 * Math.min(1, p.y / s.h), (p) => swayH(p), 0.1);
  }
  // the tip: two crossed upright boughs
  const th = 3.2;
  for (let k = 0; k < 2; k++) {
    const n = V(Math.cos(k * 1.57 + 0.4), 0, Math.sin(k * 1.57 + 0.4));
    axis.set(0, s.h - th - 1.5, 0);
    b.card(V(0, s.h - th * 0.5 + 0.25, 0), n, th * 0.62, th, 0, 'fir', axis, s.tint, 0, () => 1, (p) => swayH(p), 0.1);
  }
  return b.build();
}

/** Near geometry of a species at a LOD. */
export function treeGeometry(species: number, lod: TreeLod): THREE.BufferGeometry {
  if (species === 0) return broadleaf(OAK, lod);
  if (species === 1) return broadleaf(OAK_B, lod);
  if (species === 2) return conifer(PINE, lod);
  if (species === 3) return conifer(FIR, lod);
  return broadleaf(BIRCH, lod);
}

/** Far impostor of a species: camera-facing quads (see Builder.billboard). */
export function treeImpostor(species: number): THREE.BufferGeometry {
  const b = new Builder();
  let h: number;
  let r: number;
  if (species === 2 || species === 3) {
    const s = species === 2 ? PINE : FIR;
    h = s.h;
    r = s.r;
    const lo: RGB = [s.tint[0] * 0.62, s.tint[1] * 0.62, s.tint[2] * 0.62];
    b.billboard(V(0, 0, 0), -r * 1.05, r * 1.05, s.bare * 0.4, s.h + 0.3, 1, 'fir', lo, s.tint, 0.8, 1, 0.9);
  } else {
    const s = species === 0 ? OAK : species === 1 ? OAK_B : BIRCH;
    const rnd = mulberry32(s.seed + 5);
    const cy = s.trunkH + s.crownUp;
    h = cy + s.ry;
    r = s.rx;
    b.billboard(V(0, 0, 0), -s.trunkR * 1.1, s.trunkR * 1.1, 0, cy, 1, s.bark, [s.barkTint[0] * 0.6, s.barkTint[1] * 0.6, s.barkTint[2] * 0.6], s.barkTint, 0.2, 0, 0.3);
    // the crown: overlapping camera-facing clusters, lower ones darker
    const lobes = 5;
    for (let i = 0; i < lobes; i++) {
      const az = (i / (lobes - 1)) * Math.PI * 2;
      const centre = i === lobes - 1;
      const p = centre ? V(0, cy + s.ry * 0.35, 0) : V(Math.cos(az) * s.rx * 0.5, cy + (rnd() - 0.5) * s.ry * 0.7, Math.sin(az) * s.rx * 0.5);
      const sz = s.cardSize * (centre ? 0.95 : 0.8) * (s === BIRCH ? 0.95 : 1.05);
      const k = 0.8 + rnd() * 0.25;
      const hi: RGB = [s.tint[0] * k, s.tint[1] * k, s.tint[2] * k];
      const lo: RGB = [hi[0] * 0.5, hi[1] * 0.5, hi[2] * 0.5];
      b.billboard(p, -sz, sz, -sz, sz, 0, s.leaf, lo, hi, 0.7, 1);
    }
  }
  const g = b.build();
  // the quads are expanded in the vertex shader: give culling / the canopy grid the real extents
  g.boundingBox = new THREE.Box3(V(-r, 0, -r), V(r, h, r));
  g.boundingSphere = new THREE.Sphere(V(0, h / 2, 0), Math.max(h / 2, r) * 1.5);
  return g;
}

/** A low bush: a dome of leaf clusters (no trunk). */
export function bushGeometry(): THREE.BufferGeometry {
  const rnd = mulberry32(71);
  const b = new Builder();
  const crown = V(0, 0.15, 0);
  const shade = (p: THREE.Vector3) => 0.55 + 0.45 * Math.min(1, Math.max(0, p.y / 1.1));
  const sway = (p: THREE.Vector3) => Math.min(1, Math.max(0, p.y / 1.4)) * 0.6;
  for (let i = 0; i < 6; i++) {
    const top = i === 5;
    const az = (i / 5) * Math.PI * 2 + rnd() * 0.5;
    const c = top ? V(0, 0.95, 0) : V(Math.cos(az) * 0.55, 0.5 + rnd() * 0.2, Math.sin(az) * 0.55);
    const n = top ? V(0.1, 1, 0.05).normalize() : V(Math.cos(az) * 0.8, 0.6, Math.sin(az) * 0.8).normalize();
    const sz = 1.25 + rnd() * 0.35;
    const k = 0.85 + rnd() * 0.25;
    b.card(c, n, sz, sz, rnd() * 6.28, 'bush', crown, [k, k, k * 0.92], 0, shade, sway);
  }
  return b.build();
}

/** A reed clump: three crossed upright cards. */
export function reedsGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  const crown = V(0, -2, 0);
  for (let i = 0; i < 3; i++) {
    const az = (i / 3) * Math.PI + 0.3;
    const n = V(Math.cos(az), 0, Math.sin(az));
    b.card(V(Math.cos(az + 1.57) * 0.08, 0.78, Math.sin(az + 1.57) * 0.08), n, 0.62, 1.6, 0, 'reeds', crown, [1, 1, 1], 0, (p) => 0.6 + 0.4 * Math.min(1, p.y / 1.2), (p) => Math.min(1, Math.max(0, p.y / 1.6)), 0.5);
  }
  return b.build();
}
