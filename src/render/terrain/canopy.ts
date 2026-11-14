// Obstacle-top height grid (2 m cells over the world): the top of every tree crown, ruin, tower and
// castle that could swallow the camera. Built from the instanced props' matrices (cheap, CPU, once
// per layout / tier change). The camera rig keeps itself and its near view above it.
import * as THREE from 'three';
import { WORLD } from './layout.ts';

const CELL = 2;

export class CanopyGrid {
  private readonly w = Math.ceil((WORLD.x1 - WORLD.x0) / CELL);
  private readonly h = Math.ceil((WORLD.z1 - WORLD.z0) / CELL);
  private top = new Float32Array(this.w * this.h).fill(-1e9);

  clear(): void {
    this.top.fill(-1e9);
  }

  /** Stamp a disc of radius r (m) with top height y. */
  disc(x: number, z: number, r: number, y: number): void {
    const cx0 = Math.max(0, Math.floor((x - r - WORLD.x0) / CELL));
    const cx1 = Math.min(this.w - 1, Math.floor((x + r - WORLD.x0) / CELL));
    const cz0 = Math.max(0, Math.floor((z - r - WORLD.z0) / CELL));
    const cz1 = Math.min(this.h - 1, Math.floor((z + r - WORLD.z0) / CELL));
    const r2 = (r + CELL * 0.7) ** 2;
    for (let j = cz0; j <= cz1; j++) {
      const zz = WORLD.z0 + (j + 0.5) * CELL - z;
      for (let i = cx0; i <= cx1; i++) {
        const xx = WORLD.x0 + (i + 0.5) * CELL - x;
        if (xx * xx + zz * zz > r2) continue;
        const k = j * this.w + i;
        if (y > this.top[k]) this.top[k] = y;
      }
    }
  }

  /** Stamp a world-space box (top = box.max.y). */
  box(b: THREE.Box3): void {
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
    this.disc(cx, cz, r, b.max.y);
  }

  /** Every visible instance of an instanced mesh, as a crown disc. */
  instanced(mesh: THREE.InstancedMesh, radiusK = 0.8): void {
    if (!mesh.visible || mesh.count === 0) return;
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox!;
    const hr = Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z) * radiusK;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.decompose(p, q, s);
      this.disc(p.x, p.z, hr * Math.max(s.x, s.z), p.y + bb.max.y * s.y);
    }
  }

  /** Highest obstacle top at a world point (−1e9 when open ground). */
  at(x: number, z: number): number {
    const i = Math.floor((x - WORLD.x0) / CELL);
    const j = Math.floor((z - WORLD.z0) / CELL);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1e9;
    return this.top[j * this.w + i];
  }
}
