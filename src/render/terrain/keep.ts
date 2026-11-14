// A fantasy castle per seat: curtain walls with merlons, four round corner towers with conical
// team-coloured roofs, a gatehouse, a tall central keep with turrets, banners and lit windows,
// and the seat's two arrow towers. Destruction stages 0..4: pieces carry a [showFrom, hideFrom)
// stage range and are merged per (material, range) bucket, so a stage change just toggles a few
// meshes; pieces that disappear drop into the ground over ~1 s (the VFX dust hides the cut).
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';
import { globalUniforms } from '../core/engine.ts';
import { WIND_GLSL, after } from '../core/glsl.ts';
import type { Heightfield } from './heightfield.ts';
import type { KeepPlace } from './layout.ts';
import { TEAM_COLORS } from './layout.ts';
import { mulberry32, vnoise } from './noise.ts';
import type { TerrainTextures } from './textures.ts';
import { bare, boxPiece, boxUV, cylPiece, cylUV, merge, tint } from './build.ts';

export interface KeepView {
  readonly seat: 0 | 1;
  readonly group: THREE.Group;
  /** World position of the castle's base centre. */
  readonly position: THREE.Vector3;
  /** World positions of the arrow-tower tops (arrow spawn points). */
  readonly towers: THREE.Vector3[];
  /** A random world point on the walls facing the field (for impacts). */
  hitPoint(): THREE.Vector3;
  /** 0 intact … 4 destroyed. */
  setStage(stage: number): void;
  readonly stage: number;
  /** Replace the procedural castle with the art keep (child nodes stage0..stage3). */
  useModel(model: THREE.Object3D | null): void;
  /** Replace the procedural arrow towers with the art tower (geometry base at y=0, team material). */
  useTowerModel(geometry: THREE.BufferGeometry | null, material: THREE.Material | null, height: number): void;
}

type MatKey = 'stone' | 'roof' | 'cloth' | 'wood' | 'glow';

interface Bucket {
  mesh: THREE.Mesh;
  show: number;
  hide: number;
  /** Arrow-tower geometry (kept when the castle is replaced by the art model). */
  tower: boolean;
  /** Collapse animation progress (0..1) when it just got hidden. */
  falling: number;
}

export class Keep implements KeepView {
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly towers: THREE.Vector3[] = [];
  readonly seat: 0 | 1;
  stage = 0;
  private buckets: Bucket[] = [];
  private rnd: () => number;
  private team: THREE.Color;
  private gold = new THREE.Color('#d9a93a');
  private readonly engine: Engine;
  private model: { root: THREE.Object3D; stages: THREE.Object3D[]; box: THREE.Box3 } | null = null;

  constructor(engine: Engine, hf: Heightfield, place: KeepPlace, mats: Record<MatKey, THREE.Material>) {
    this.seat = place.seat;
    this.engine = engine;
    this.rnd = mulberry32(911 + place.seat);
    this.team = new THREE.Color(TEAM_COLORS[place.seat]);
    const cz = place.z - place.dir * 6;
    const gy = hf.ground(place.x, cz);
    this.group.position.set(place.x, gy, cz);
    // local front = -Z; seat 1's castle faces +Z in the world
    this.group.rotation.y = place.dir < 0 ? 0 : Math.PI;
    this.group.name = `keep-${place.seat}`;
    this.position.copy(this.group.position);
    this.group.updateMatrixWorld();

    const P: Record<string, THREE.BufferGeometry[]> = {};
    const add = (mat: MatKey, g: THREE.BufferGeometry, show = 0, hide = 5) => {
      const k = `${mat}|${show}|${hide}`;
      (P[k] ??= []).push(g);
    };
    this.buildCastle(add);
    // arrow towers live at their own field positions, in castle-local coordinates
    const inv = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
    for (const t of place.towers) {
      const wy = hf.ground(t.x, t.z);
      const lp = new THREE.Vector3(t.x, wy, t.z).applyMatrix4(inv);
      this.buildArrowTower((m, g, show, hide) => add((m + '#t') as MatKey, g, show, hide), lp);
      this.towers.push(new THREE.Vector3(t.x, wy + 7.6, t.z));
    }

    for (const [k, list] of Object.entries(P)) {
      const [matT, show, hide] = k.split('|');
      const tower = matT.endsWith('#t');
      const mat = matT.replace('#t', '');
      const g = merge(list);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, mats[mat as MatKey]);
      mesh.castShadow = mat !== 'glow';
      mesh.receiveShadow = true;
      mesh.name = `keep-${place.seat}-${k}`;
      this.group.add(mesh);
      this.buckets.push({ mesh, show: +show, hide: +hide, falling: -1, tower });
    }
    engine.prepare(this.group);
    this.applyStage(false);
  }

  // ---------------------------------------------------------------- construction

  private buildCastle(add: (m: MatKey, g: THREE.BufferGeometry, show?: number, hide?: number) => void): void {
    const rnd = this.rnd;
    const stone = new THREE.Color('#b3aa98');
    const dark = new THREE.Color('#2a2622');
    const wood = new THREE.Color('#5a4030');
    const HX = 11;
    const HZ = 8;
    const WH = 5.5;
    const T = 1.4;
    const st = (g: THREE.BufferGeometry, show = 0, hide = 5) => add('stone', g, show, hide);
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, opts: Parameters<typeof boxPiece>[8] = {}) => boxPiece(w, h, d, x, y, z, 0, stone, { moss: 0.25, grime: 0.7, ...opts });

    // foundation plinth (sinks into uneven ground)
    st(box(2 * HX + 3, 2.0, 2 * HZ + 3, 0, -0.6, 0, { grime: 0.2 }));

    // curtain walls (segments so breaches can replace pieces)
    const wallSeg = (x0: number, z0: number, x1: number, z1: number, show = 0, hide = 5, h = WH) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const yaw = Math.atan2(x1 - x0, z1 - z0);
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      st(boxPiece(T, h + 1.5, len, cx, h / 2 - 0.75, cz, yaw, stone, { moss: 0.25, grime: 0.8, seed: Math.round(cx * 10 + cz) }), show, hide);
      // walkway lip + merlons
      const n = Math.floor(len / 1.15);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const mx = x0 + (x1 - x0) * t;
        const mz = z0 + (z1 - z0) * t;
        const r = rnd();
        const mh = r < 0.25 ? 1 : r < 0.5 ? 2 : 3;
        st(boxPiece(0.55, 0.75, 0.6, mx, h + 0.37, mz, yaw, stone, { moss: 0.2, seed: i }), show, Math.min(hide, mh));
      }
    };
    // front (with the gatehouse gap), sides, back
    wallSeg(-HX, -HZ, -2.2, -HZ);
    wallSeg(2.2, -HZ, HX, -HZ);
    wallSeg(-HX, -HZ, -HX, 0);
    wallSeg(-HX, 0, -HX, HZ);
    wallSeg(HX, -HZ, HX, -2.5);
    wallSeg(HX, -2.5, HX, 2.5, 0, 2); // breach at stage 2
    wallSeg(HX, 2.5, HX, HZ);
    wallSeg(-HX, HZ, HX, HZ);
    // breached piece: jagged low stub + rubble
    for (let z = -2.3; z < 2.5; z += 0.8) st(box(T, 0.6 + rnd() * 2.2, 0.82, HX, 0.4, z), 2);
    this.rubble(add, HX + 1.8, 0, 3.5, 2, 14);
    this.rubble(add, HX - 1.5, 0, 2.5, 2, 8);

    // window slits along the walls
    for (const x of [-7, -4.5, 4.5, 7]) add('wood', boxPiece(0.35, 0.9, 0.2, x, 3.2, -HZ - 0.68, 0, dark), 0, 4);

    // corner towers
    const corners: [number, number][] = [[-HX, -HZ], [HX, -HZ], [-HX, HZ], [HX, HZ]];
    const roofHide = [1, 2, 3, 3];
    corners.forEach(([x, z], i) => {
      const R = 2.4;
      st(cylPiece(R + 0.15, R, 7.5, x, 3.75 - 1.5, z, stone, { seg: 16, moss: 0.3, grime: 0.8, seed: i }), 0, 4);
      st(cylPiece(R, R, 3, x, 7.5, z, stone, { seg: 16, moss: 0.2, seed: i + 10 }), 0, 3);
      // corbel ring + merlons
      st(cylPiece(R + 0.35, R + 0.35, 0.45, x, 9.2, z, stone, { seg: 16, seed: i + 20 }), 0, 3);
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        st(boxPiece(0.6, 0.7, 0.45, x + Math.cos(a) * (R + 0.15), 9.75, z + Math.sin(a) * (R + 0.15), -a + Math.PI / 2, stone, { seed: k }), 0, roofHide[i]);
      }
      add('roof', this.roof(R + 0.55, 5, x, 9.45, z, 16), 0, roofHide[i]);
      this.flag(add, x, 14.4, z, 1.6, 0, roofHide[i]);
      // jagged stumps
      st(this.jaggedTower(R, 7.5, x, z, i), 3, 4);
      st(this.jaggedTower(R + 0.1, 3.2, x, z, i + 5), 4);
      // arrow slits
      for (let k = 0; k < 3; k++) {
        const a = -Math.PI / 2 + (k - 1) * 0.9 + (z > 0 ? Math.PI : 0);
        add('wood', boxPiece(0.25, 1.0, 0.25, x + Math.cos(a) * (R - 0.05), 5 + (k % 2) * 1.2, z + Math.sin(a) * (R - 0.05), -a, dark), 0, 3);
      }
    });
    this.rubble(add, -HX - 1, -HZ - 1, 3, 1, 8);

    // gatehouse
    for (const s of [-1, 1]) {
      st(box(3.0, 8.5, 3.4, s * 2.7, 3.0, -HZ), 0, 3);
      for (let k = 0; k < 3; k++) st(box(0.6, 0.7, 0.6, s * 2.7 + (k - 1) * 1.1, 7.6, -HZ - 1.4), 0, 2);
      add('roof', this.roof(2.35, 3.2, s * 2.7, 7.3, -HZ, 4, Math.PI / 4), 0, 2);
      st(box(3.0, 3.0, 3.4, s * 2.7, 0.0, -HZ), 3, 5);
      this.banner(add, s * 2.7, 6.2, -HZ - 1.75, 1.3, 2.8, 0, 3);
    }
    st(box(2.6, 1.6, 2.4, 0, 5.6, -HZ), 0, 3); // lintel over the gate
    add('wood', boxPiece(2.4, 4.4, 0.3, 0, 2.0, -HZ + 0.4, 0, wood), 0, 4); // the gate
    this.rubble(add, 0, -HZ - 2, 3.5, 3, 16);

    // central keep
    const KX = 4.5;
    const KZ = 4.5;
    const kz = 1.5;
    st(box(2 * KX, 11.5, 2 * KZ, 0, 4.25, kz, { moss: 0.15 }), 0, 4);
    st(box(2 * KX - 0.6, 5, 2 * KZ - 0.6, 0, 12.5, kz, { moss: 0.1 }), 0, 3);
    // corbel band and merlons
    st(box(2 * KX + 0.6, 0.5, 2 * KZ + 0.6, 0, 15.2, kz), 0, 3);
    for (let s = 0; s < 4; s++) {
      for (let k = 0; k < 7; k++) {
        const t = (k + 0.5) / 7 - 0.5;
        const along = t * (2 * KX);
        const [x, z] = s === 0 ? [along, kz - KZ - 0.1] : s === 1 ? [along, kz + KZ + 0.1] : s === 2 ? [-KX - 0.1, kz + along] : [KX + 0.1, kz + along];
        st(boxPiece(0.6, 0.8, 0.6, x, 15.8, z, 0, stone, { seed: k + s * 7 }), 0, 2);
      }
    }
    add('roof', this.roof(5.6, 7.5, 0, 15.5, kz, 4, Math.PI / 4), 0, 2);
    this.flag(add, 0, 23.5, kz, 2.4, 0, 2);
    // turrets
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = sx * KX;
      const z = kz + sz * KZ;
      st(cylPiece(1.0, 1.05, 5, x, 14.0, z, stone, { seg: 12, seed: x + z }), 0, 3);
      add('roof', this.roof(1.35, 3, x, 16.5, z, 12), 0, sz < 0 ? 2 : 3);
    }
    // lit windows and a big hanging banner on the keep's front
    for (const [x, y] of [[-2.6, 7], [2.6, 7], [-2.6, 11.5], [2.6, 11.5], [0, 13]]) add('glow', boxPiece(0.55, 1.1, 0.15, x, y, kz - KZ - 0.05, 0, new THREE.Color(1, 1, 1)), 0, 3);
    this.banner(add, 0, 10.4, kz - KZ - 0.12, 2.4, 6.2, 0, 3);
    // keep ruins
    st(this.jaggedBlockRing(KX, KZ, kz, 9.5, 14.5, 1), 3, 4);
    st(this.jaggedBlockRing(KX, KZ, kz, 1.5, 5.5, 2), 4);
    this.rubble(add, 0, kz - KZ - 2.5, 4, 3, 18);
    this.rubble(add, 0, kz, 6, 4, 30);
    this.rubble(add, -HX * 0.6, -HZ - 2, 5, 4, 18);
    this.rubble(add, HX * 0.5, HZ * 0.3, 4, 4, 14);
  }

  private buildArrowTower(add: (m: MatKey, g: THREE.BufferGeometry, show?: number, hide?: number) => void, p: THREE.Vector3): void {
    const stone = new THREE.Color('#ada593');
    const st = (g: THREE.BufferGeometry, show = 0, hide = 5) => add('stone', g, show, hide);
    st(boxPiece(3.0, 6.5, 3.0, p.x, p.y + 2.25, p.z, 0, stone, { moss: 0.3, grime: 0.9, groundY: p.y }), 0, 4);
    st(boxPiece(3.5, 0.5, 3.5, p.x, p.y + 5.6, p.z, 0, stone, {}), 0, 3);
    for (let k = 0; k < 8; k++) {
      const s = Math.floor(k / 2);
      const o = (k % 2 ? 0.75 : -0.75);
      const [x, z] = s === 0 ? [o, -1.55] : s === 1 ? [o, 1.55] : s === 2 ? [-1.55, o] : [1.55, o];
      st(boxPiece(0.6, 0.7, 0.6, p.x + x, p.y + 6.2, p.z + z, 0, stone, { seed: k }), 0, 2);
    }
    add('roof', this.roof(2.5, 3.2, p.x, p.y + 6.6, p.z, 4, Math.PI / 4), 0, 2);
    this.flag(add, p.x, p.y + 9.6, p.z, 1.1, 0, 2);
    st(boxPiece(3.0, 2.4, 3.0, p.x, p.y + 0.4, p.z, 0, stone, { moss: 0.3, grime: 0.9 }), 4);
    this.rubble(add, p.x + 1.5, p.z - 1, 2.2, 3, 9, p.y);
  }

  private roof(r: number, h: number, x: number, y: number, z: number, seg: number, rot = 0): THREE.BufferGeometry {
    const g = bare(new THREE.ConeGeometry(r, h, seg, 3, true));
    g.rotateY(rot);
    // slight concave flare like a real spire
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const yy = p.getY(i);
      const t = (yy + h / 2) / h; // 0 bottom .. 1 tip
      const k = 1 - 0.12 * Math.sin(Math.PI * t);
      p.setXYZ(i, p.getX(i) * k, yy, p.getZ(i) * k);
    }
    g.computeVertexNormals();
    // uv: around × slant, tile ~1.5 m
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      uv[i * 2] = ((Math.atan2(p.getZ(i), p.getX(i)) + Math.PI) / (Math.PI * 2)) * ((2 * Math.PI * r) / 1.6);
      uv[i * 2 + 1] = (p.getY(i) + h / 2) / 1.6;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.translate(x, y + h / 2, z);
    return tint(g, new THREE.Color(1, 1, 1), { seed: x });
  }

  /** A pennant on a pole (cloth sways in the wind). */
  private flag(add: (m: MatKey, g: THREE.BufferGeometry, show?: number, hide?: number) => void, x: number, y: number, z: number, size: number, show: number, hide: number): void {
    add('wood', cylPiece(0.05, 0.05, size * 1.8, x, y - size * 0.2, z, new THREE.Color('#3a2e24'), { seg: 5 }), show, hide);
    const g = new THREE.PlaneGeometry(size * 1.5, size * 0.75, 6, 2);
    g.translate(size * 0.75, 0, 0);
    const p = g.getAttribute('position');
    const sway = new Float32Array(p.count);
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / (size * 1.5);
      sway[i] = u * 1.6;
      // swallow-tail: pull the middle of the far edge in
      if (u > 0.95 && Math.abs(p.getY(i)) < 0.01) p.setX(i, p.getX(i) - size * 0.3);
      const trim = Math.abs(p.getY(i)) > size * 0.3;
      const c = trim ? this.gold : this.team;
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    g.translate(x, y + size * 0.4, z);
    add('cloth', g.toNonIndexed(), show, hide);
  }

  /** A long hanging banner (team colour with a gold border and chevron). */
  private banner(add: (m: MatKey, g: THREE.BufferGeometry, show?: number, hide?: number) => void, x: number, y: number, z: number, w: number, h: number, show: number, hide: number): void {
    const g = new THREE.PlaneGeometry(w, h, 4, 10);
    const p = g.getAttribute('position');
    const sway = new Float32Array(p.count);
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / w + 0.5;
      const v = p.getY(i) / h + 0.5; // 1 top
      // pointed bottom
      if (v < 0.01) p.setY(i, p.getY(i) + Math.abs(u - 0.5) * h * 0.25);
      sway[i] = (1 - v) * 0.5;
      const border = u < 0.13 || u > 0.87 || v > 0.93;
      const chevron = Math.abs(Math.abs(u - 0.5) * 1.2 - (0.62 - v)) < 0.06 && v > 0.25 && v < 0.65;
      const c = border || chevron ? this.gold : this.team;
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    g.translate(x, y, z);
    add('cloth', g.toNonIndexed(), show, hide);
    add('wood', boxPiece(w + 0.4, 0.12, 0.12, x, y + h / 2 + 0.05, z - 0.05, 0, new THREE.Color('#3a2e24')), show, hide);
  }

  private jaggedTower(R: number, h: number, x: number, z: number, seed: number): THREE.BufferGeometry {
    const g = bare(new THREE.CylinderGeometry(R, R + 0.15, h + 1.5, 16, 1, false));
    const p = g.getAttribute('position');
    const top = (h + 1.5) / 2;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) > top - 0.01) {
        const a = Math.atan2(p.getZ(i), p.getX(i));
        p.setY(i, top - vnoise(a * 2.5 + 4, seed * 1.3, seed) * 2.4);
      }
    }
    g.computeVertexNormals();
    cylUV(g, R);
    g.translate(x, (h + 1.5) / 2 - 1.5, z);
    return tint(g, new THREE.Color('#a89f8d'), { moss: 0.3, grime: 1, seed });
  }

  private jaggedBlockRing(KX: number, KZ: number, kz: number, h0: number, h1: number, seed: number): THREE.BufferGeometry {
    const rnd = mulberry32(seed * 101);
    const stone = new THREE.Color('#a69d8b');
    const pieces: THREE.BufferGeometry[] = [];
    const per = 9;
    for (let s = 0; s < 4; s++) {
      for (let k = 0; k < per; k++) {
        const t = (k + 0.5) / per - 0.5;
        const h = h0 + (h1 - h0) * Math.pow(rnd(), 1.5);
        const along = t * 2 * KX;
        const [x, z, w, d] = s < 2 ? [along, kz + (s ? KZ : -KZ), (2 * KX) / per + 0.02, 1.2] : [s === 2 ? -KX : KX, kz + along, 1.2, (2 * KZ) / per + 0.02];
        pieces.push(boxPiece(w, h + 1.5, d, x, (h + 1.5) / 2 - 1.5, z, 0, stone, { moss: 0.2, grime: 1, seed: k + s * per }));
      }
    }
    // the floor inside is a dark heap
    pieces.push(boxPiece(2 * KX - 1, 1.2, 2 * KZ - 1, 0, 0.2, kz, 0, new THREE.Color('#5a5248')));
    return merge(pieces)!;
  }

  private rubble(add: (m: MatKey, g: THREE.BufferGeometry, show?: number, hide?: number) => void, x: number, z: number, r: number, show: number, n: number, y = 0): void {
    const rnd = this.rnd;
    const stone = new THREE.Color('#9c9381');
    const pieces: THREE.BufferGeometry[] = [];
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const d = Math.sqrt(rnd()) * r;
      const s = 0.35 + rnd() * 0.7;
      const heap = (1 - d / r) * r * 0.35;
      pieces.push(boxPiece(s * 1.4, s * 0.8, s, x + Math.cos(a) * d, y + heap * rnd() + s * 0.2, z + Math.sin(a) * d, rnd() * 3, stone, { roll: (rnd() - 0.5) * 1.2, pitch: (rnd() - 0.5) * 1.2, moss: 0.1, grime: 0.6, seed: i }));
    }
    const g = merge(pieces);
    if (g) {
      boxUV(g);
      add('stone', g, show, 5);
    }
  }

  // ---------------------------------------------------------------- API

  private towerMeshes: THREE.Mesh[] = [];
  private towerBase: THREE.Vector3[] | null = null;
  useTowerModel(geometry: THREE.BufferGeometry | null, material: THREE.Material | null, height: number): void {
    for (const m of this.towerMeshes) this.group.remove(m);
    this.towerMeshes = [];
    this.towerBase ??= this.towers.map((t) => t.clone().setY(t.y - 7.6));
    const art = !!(geometry && material);
    for (const b of this.buckets) if (b.tower) b.mesh.visible = !art && this.stage >= b.show && this.stage < b.hide;
    this.towerArt = art;
    this.towerBase.forEach((base, i) => {
      this.towers[i].copy(base).setY(base.y + (art ? height * 0.86 : 7.6));
      if (!art) return;
      const m = new THREE.Mesh(geometry!, material!);
      this.group.updateMatrixWorld();
      m.position.copy(this.group.worldToLocal(base.clone()));
      m.rotation.y = Math.PI; // art faces +Z; the castle's local front is -Z
      m.castShadow = true;
      m.receiveShadow = true;
      m.name = `arrow-tower-${i}`;
      this.group.add(m);
      this.towerMeshes.push(m);
    });
    this.engine.markShadows();
    this.engine.wake();
  }
  private towerArt = false;

  useModel(model: THREE.Object3D | null): void {
    if (this.model) {
      this.group.remove(this.model.root);
      this.model = null;
    }
    if (model) {
      const root = model.clone(true);
      // the art faces +Z; the castle's local front is -Z
      root.rotation.y = Math.PI;
      const stages = [0, 1, 2, 3].map((i) => root.getObjectByName(`stage${i}`)).filter((o): o is THREE.Object3D => !!o);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
          // masonry is not metal: the generated MR maps read as near-black metal, so cap metalness
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats as THREE.MeshStandardMaterial[]) if (mat.isMeshStandardMaterial && mat.metalness > 0.2) mat.metalness = 0.08;
        }
      });
      this.group.add(root);
      root.updateMatrixWorld(true);
      if (stages[0]) stages.forEach((s, i) => (s.visible = i === 0));
      const box = new THREE.Box3().setFromObject(stages[0] ?? root);
      box.applyMatrix4(new THREE.Matrix4().copy(this.group.matrixWorld).invert());
      this.engine.prepare(root);
      this.model = { root, stages, box };
    }
    this.applyStage(false);
    this.engine.markShadows();
    this.engine.wake();
  }

  hitPoint(): THREE.Vector3 {
    if (this.model) {
      // a random point on the front face of the art keep's current silhouette
      const b = this.model.box;
      const r = this.rnd;
      const hk = [1, 0.85, 0.6, 0.4, 0.25][this.stage] ?? 0.3;
      const lp = new THREE.Vector3(b.min.x + (b.max.x - b.min.x) * (0.15 + r() * 0.7), b.min.y + (b.max.y - b.min.y) * hk * (0.1 + r() * 0.8), b.min.z + r() * 1.5);
      this.group.updateMatrixWorld();
      return lp.applyMatrix4(this.group.matrixWorld);
    }
    const r = this.rnd;
    const k = r();
    let lp: THREE.Vector3;
    if (this.stage >= 4) lp = new THREE.Vector3((r() - 0.5) * 18, 0.5 + r() * 2.5, -8.8 + r() * 4);
    else if (k < 0.5) lp = new THREE.Vector3((r() - 0.5) * 20, 1 + r() * 4, -8.75);
    else if (k < 0.75) lp = new THREE.Vector3((r() - 0.5) * 8, 3 + r() * (this.stage >= 3 ? 5 : 10), -3.1);
    else lp = new THREE.Vector3((r() < 0.5 ? -1 : 1) * (11 + (r() - 0.5) * 3), 1 + r() * 6, -8 - r() * 1.6);
    this.group.updateMatrixWorld();
    return lp.applyMatrix4(this.group.matrixWorld);
  }

  setStage(stage: number): void {
    const s = Math.max(0, Math.min(4, Math.round(stage)));
    if (s === this.stage) return;
    const up = s > this.stage;
    this.stage = s;
    this.applyStage(up);
  }

  private applyStage(animate: boolean): void {
    if (this.model) {
      // sim stages 0..4 (intact, <75%, <50%, <25%, destroyed) -> art nodes stage0..stage3
      const node = [0, 1, 2, 2, 3][this.stage] ?? 3;
      this.model.stages.forEach((s, i) => (s.visible = i === node));
    }
    for (const b of this.buckets) {
      const vis = this.stage >= b.show && this.stage < b.hide;
      if ((this.model && !b.tower) || (this.towerArt && b.tower)) {
        b.mesh.visible = false;
        b.falling = -1;
        continue;
      }
      if (!vis && b.mesh.visible && animate) {
        b.falling = 0;
        continue;
      }
      b.falling = -1;
      b.mesh.visible = vis;
      b.mesh.position.y = 0;
    }
  }

  /** Advance collapse animations; true while any is running. */
  update(dt: number): boolean {
    let busy = false;
    for (const b of this.buckets) {
      if (b.falling < 0) continue;
      b.falling += dt / 1.1;
      const t = Math.min(1, b.falling);
      b.mesh.position.y = -t * t * 9;
      if (t >= 1) {
        b.falling = -1;
        b.mesh.visible = false;
        b.mesh.position.y = 0;
      } else busy = true;
    }
    return busy;
  }

  dispose(): void {
    for (const b of this.buckets) b.mesh.geometry.dispose();
  }
}

/** Shared castle materials for one seat. */
export function keepMaterials(engine: Engine, tex: TerrainTextures, masonry: THREE.Material, seat: 0 | 1): Record<MatKey, THREE.Material> {
  const team = new THREE.Color(TEAM_COLORS[seat]);
  const slate = team.clone().lerp(new THREE.Color('#4a4e58'), 0.35).multiplyScalar(0.75);
  const roof = new THREE.MeshStandardMaterial({ map: tex.tiles, color: slate, roughness: 0.62, metalness: 0.05, vertexColors: true });
  // cloth colours (team + gold trim) live in the vertex colours
  const cloth = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, vertexColors: true, side: THREE.DoubleSide });
  engine.patch(cloth, 'ob-cloth', (shader) => {
    Object.assign(shader.uniforms, globalUniforms);
    shader.vertexShader = after(shader.vertexShader, '#include <common>', `attribute float aSway;\n${WIND_GLSL}`);
    shader.vertexShader = after(
      shader.vertexShader,
      '#include <begin_vertex>',
      /* glsl */ `
vec3 obW = (modelMatrix * vec4(position, 1.0)).xyz;
vec3 obOff = ob_wind(obW, 1.0, 1.0) * aSway * 2.2;
obOff.y += sin(uTime * 4.3 + obW.x * 2.1 + obW.y) * 0.08 * aSway;
transformed += obOff;
`,
    );
  });
  const wood = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x1a1008, emissive: new THREE.Color('#ffae55'), emissiveIntensity: 2.2, roughness: 1 });
  return { stone: masonry, roof, cloth, wood, glow };
}
