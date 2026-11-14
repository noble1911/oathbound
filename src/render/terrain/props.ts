// Rocks (instanced), ruins (merged stonework per feature), stone arch bridges (deck height feeds
// heightAt) and ford stepping stones. Field props are generated for seat 0's half and mirrored.
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';
import type { Heightfield } from './heightfield.ts';
import { FIELD, WATER_LEVEL, type Feature } from './layout.ts';
import { mulberry32, vnoise } from './noise.ts';
import type { TerrainTextures } from './textures.ts';
import { Bridges } from './bridge.ts';
import { bare, boxPiece, boxUV, cylPiece, merge, tint } from './build.ts';

export function masonryMaterial(tex: TerrainTextures): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: tex.bricks,
    bumpMap: tex.bricksBump,
    bumpScale: 0.6,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
  });
}

function rockGeometry(seed: number, angular: boolean): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, angular ? 0 : 1);
  const p = g.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + (vnoise(v.x * 1.7 + seed, v.y * 1.7 + v.z * 1.3, seed) - 0.5) * (angular ? 0.7 : 0.5);
    v.multiplyScalar(k);
    if (v.y < 0) v.y *= 0.5;
    p.setXYZ(i, v.x, v.y * 0.7, v.z);
  }
  const ng = bare(g);
  ng.computeVertexNormals(); // non-indexed → flat facets
  boxUV(ng, 1.6);
  return tint(ng, new THREE.Color('#d2cec2'), { moss: 0.45, seed, groundY: -0.3 });
}

export class Props {
  readonly group = new THREE.Group();
  readonly masonry: THREE.MeshStandardMaterial;
  private bridges: Bridges | null = null;
  private rockMat: THREE.MeshStandardMaterial;
  private geos: THREE.BufferGeometry[] = [];

  constructor(engine: Engine, hf: Heightfield, tex: TerrainTextures) {
    this.group.name = 'props';
    this.masonry = masonryMaterial(tex);
    this.rockMat = new THREE.MeshStandardMaterial({ map: tex.rock, vertexColors: true, roughness: 0.88, metalness: 0 });
    this.buildRocks(hf);
    for (const f of hf.layout.features) if (f.kind === 'ruins') this.addMesh(this.buildRuin(hf, f), this.masonry, 'ruin');
    // bridges: scanned masonry on real arch geometry (bridge.ts), one mesh per material for all crossings
    this.bridges = new Bridges(hf, () => engine.wake());
    for (const mesh of this.bridges.meshes) this.group.add(mesh);
    engine.prepare(this.group);
  }

  private addMesh(g: THREE.BufferGeometry | null, m: THREE.Material, name: string): void {
    if (!g) return;
    this.geos.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------- rocks

  private buildRocks(hf: Heightfield): void {
    const L = hf.layout;
    const rnd = mulberry32(L.seed * 5 + 1);
    const items: { x: number; z: number; s: number; flat?: boolean; angular: boolean }[] = [];
    const fieldItem = (x: number, z: number, s: number, angular: boolean, flat = false) => {
      items.push({ x, z, s, angular, flat }, { x: -x, z: -z, s, angular, flat });
    };
    // scattered field stones (seat 0 half, mirrored)
    for (let i = 0; i < 160 && items.length < 90; i++) {
      const x = FIELD.x0 + rnd() * (FIELD.x1 - FIELD.x0);
      const z = 4 + rnd() * 56;
      if (L.riverSd(x, z) < 1.5 || L.pathDist(x, z) < 2 || L.keepDist(x, z) < 18) continue;
      if (rnd() > 0.35) continue;
      fieldItem(x, z, 0.25 + rnd() * rnd() * 0.7, rnd() < 0.5);
    }
    // boulders on hills
    for (const f of L.features) {
      if (f.kind !== 'hill' || f.mirrored) continue;
      const fr = mulberry32(f.pairSeed);
      const r = f.shape.circle ? f.shape.circle.r : 4;
      const n = 2 + Math.floor(fr() * 3);
      for (let i = 0; i < n; i++) {
        const a = fr() * Math.PI * 2;
        const d = (0.3 + fr() * 0.9) * r;
        fieldItem(f.cx + Math.cos(a) * d, f.cz + Math.sin(a) * d, 0.5 + fr() * 0.9, fr() < 0.6);
      }
    }
    // river-bank stones
    for (let i = 0; i < 2000 && items.length < 400; i++) {
      const x = -125 + rnd() * 250;
      const z = -8 + rnd() * 16;
      const sd = L.riverSd(x, z);
      if (sd < -0.8 || sd > 1.2) continue;
      if (hf.deckAt(x, z, -1) > -Infinity) continue;
      items.push({ x, z, s: 0.2 + rnd() * rnd() * 0.6, angular: rnd() < 0.3 });
    }
    // ford stepping stones
    for (const c of L.crossings) {
      if (c.kind !== 'ford') continue;
      for (let z = c.z0 - 0.3; z <= c.z1 + 0.3; z += 1.7) {
        for (let x = c.x0 + 0.8; x <= c.x1 - 0.8; x += 2.2 + rnd() * 1.4) {
          if (rnd() < 0.35) continue;
          items.push({ x: x + (rnd() - 0.5) * 0.9, z: z + (rnd() - 0.5) * 0.7, s: 0.22 + rnd() * 0.22, flat: true, angular: rnd() < 0.5 });
        }
      }
    }
    // outskirts boulders in rocky ground
    for (let i = 0; i < 12000 && items.length < 900; i++) {
      const x = -128 + rnd() * 256;
      const z = -148 + rnd() * 296;
      if (L.outDist(x, z) < 6) continue;
      const [, rock] = hf.splatAt(x, z);
      if (rock < 0.4 || rnd() > rock * 0.5) continue;
      items.push({ x, z, s: 0.8 + rnd() * 2.4, angular: rnd() < 0.6 });
    }
    const variants = [rockGeometry(3, false), rockGeometry(9, true)];
    for (let v = 0; v < 2; v++) {
      const list = items.filter((it) => it.angular === (v === 1));
      const mesh = new THREE.InstancedMesh(variants[v], this.rockMat, Math.max(1, list.length));
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      const c = new THREE.Color();
      list.forEach((it, i) => {
        const y = hf.ground(it.x, it.z);
        q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.3, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.3));
        if (it.flat) s.set(it.s * 1.15, it.s * 0.6, it.s);
        else s.set(it.s * (0.8 + rnd() * 0.5), it.s * (0.6 + rnd() * 0.5), it.s * (0.8 + rnd() * 0.5));
        p.set(it.x, y + (it.flat ? Math.max(0, WATER_LEVEL + 0.05 - y) * 0.6 : -it.s * 0.15), it.z);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
        c.setScalar(0.8 + rnd() * 0.35);
        mesh.setColorAt(i, c);
      });
      mesh.count = list.length;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `rocks-${v}`;
      mesh.computeBoundingSphere();
      this.geos.push(variants[v]);
      this.group.add(mesh);
    }
  }

  // ---------------------------------------------------------------- ruins

  private buildRuin(hf: Heightfield, f: Feature): THREE.BufferGeometry | null {
    const rnd = mulberry32(f.pairSeed);
    const r = Math.max(3.5, f.shape.circle ? f.shape.circle.r : 4.5);
    const rot = (f.mirrored ? Math.PI : 0) + rnd() * 0.0;
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const pieces: THREE.BufferGeometry[] = [];
    const stone = new THREE.Color('#b0a794');
    const world = (lx: number, lz: number) => {
      const x = f.cx + lx * cs + lz * sn;
      const z = f.cz - lx * sn + lz * cs;
      return { x, z, y: hf.ground(x, z) };
    };
    const block = (lx: number, lz: number, w: number, h: number, d: number, yaw: number, base = 0, opts: { roll?: number; pitch?: number } = {}) => {
      const p = world(lx, lz);
      pieces.push(boxPiece(w, h, d, p.x, p.y + base + h / 2 - 0.15, p.z, yaw + rot, stone, { moss: 0.55, grime: 0.6, seed: pieces.length, groundY: p.y, ...opts }));
    };
    // broken L-shaped wall, built from jagged columns of blocks
    const wallZ = -r * 0.45;
    for (let lx = -r * 0.75; lx < r * 0.25; lx += 0.9) {
      const h = 0.5 + Math.pow(rnd(), 0.7) * 3.2 * (1 - Math.abs(lx + r * 0.25) / (r * 1.1));
      block(lx, wallZ, 0.92, Math.max(0.4, h), 0.85, 0);
      if (rnd() < 0.3) block(lx + (rnd() - 0.5) * 0.3, wallZ + 0.9 + rnd(), 0.6, 0.4, 0.5, rnd() * 3, 0, { roll: rnd() * 0.4 });
    }
    for (let lz = wallZ + 0.9; lz < wallZ + r * 0.8; lz += 0.9) {
      const h = 0.4 + rnd() * 2.2 * (1 - (lz - wallZ) / (r * 0.9));
      block(-r * 0.75, lz, 0.85, Math.max(0.35, h), 0.92, 0);
    }
    // arch: two pillars and a broken voussoir ring
    const ax = r * 0.35;
    const az = r * 0.2;
    const span = 1.4;
    for (const s of [-1, 1]) block(ax + s * span, az, 0.8, 3.0, 0.8, 0);
    const ring = 9;
    for (let i = 0; i < ring - 2; i++) {
      const a = Math.PI - (i / (ring - 1)) * Math.PI;
      const p = world(ax + Math.cos(a) * span, az);
      const y = p.y + 3.0 + Math.sin(a) * span;
      pieces.push(boxPiece(0.6, 0.45, 0.75, p.x, y, p.z, rot, stone, { roll: a - Math.PI / 2, moss: 0.4, seed: 50 + i, groundY: p.y }));
    }
    // column stumps + one fallen column
    for (let i = 0; i < 3; i++) {
      const lx = -r * 0.2 + i * 1.8;
      const lz = r * 0.55;
      const p = world(lx, lz);
      const h = 0.8 + rnd() * 2.2;
      pieces.push(boxPiece(1.0, 0.35, 1.0, p.x, p.y + 0.05, p.z, rot, stone, { moss: 0.6, seed: 70 + i, groundY: p.y }));
      pieces.push(cylPiece(0.34, 0.31, h, p.x, p.y + 0.2 + h / 2, p.z, stone, { seg: 12, moss: 0.5, grime: 0.5, seed: 80 + i, groundY: p.y }));
    }
    {
      const p = world(-r * 0.1, r * 0.05);
      pieces.push(cylPiece(0.32, 0.32, 3.4, p.x, p.y + 0.22, p.z, stone, { seg: 12, moss: 0.6, seed: 90, groundY: p.y, tilt: new THREE.Euler(0, rot + 0.7, Math.PI / 2 - 0.05, 'YXZ') }));
    }
    // scattered fallen blocks
    for (let i = 0; i < 10; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * r;
      const s = 0.3 + rnd() * 0.45;
      block(Math.cos(a) * d, Math.sin(a) * d, s * 1.3, s, s, rnd() * 3, -s * 0.3, { roll: (rnd() - 0.5) * 0.5, pitch: (rnd() - 0.5) * 0.4 });
    }
    return merge(pieces);
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    this.masonry.dispose();
    this.bridges?.dispose();
    this.rockMat.dispose();
  }
}

/** A solid swept along z between bottom(t) and top(t) for x in [xa, xb], with UVs and tint. */
