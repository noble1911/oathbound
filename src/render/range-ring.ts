// Attack-range rings: a terrain-conforming glowing circle (plus a faint fill) around a squad or a
// field point. Rebuilt only when the centre moves; drawn on the VFX layer (after AO, blooms softly).
import * as THREE from 'three';
import { LAYER_VFX } from './core/post.ts';

export interface RangeRingHandle {
  /** Move to a field point (cm) or keep following the squad. */
  setCenter(xcm: number, ycm: number): void;
  setRadius(radiusCm: number): void;
  dispose(): void;
}

const SEG = 160;

export class RangeRing {
  readonly group = new THREE.Group();
  private ring: THREE.Mesh;
  private fill: THREE.Mesh;
  private cx = NaN;
  private cz = NaN;
  private r: number;
  private readonly ground: (x: number, z: number) => number;

  constructor(ground: (x: number, z: number) => number, radiusM: number, color: THREE.ColorRepresentation) {
    this.ground = ground;
    this.r = radiusM;
    const c = new THREE.Color(color);
    const ringMat = new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(2.2), transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    const fillMat = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.07, depthWrite: false, fog: false, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.BufferGeometry(), ringMat);
    this.fill = new THREE.Mesh(new THREE.BufferGeometry(), fillMat);
    for (const m of [this.ring, this.fill]) {
      m.layers.set(LAYER_VFX);
      m.frustumCulled = false;
      m.renderOrder = 4;
      this.group.add(m);
    }
    this.group.layers.set(LAYER_VFX);
  }

  /** World centre; rebuilds the conforming geometry when it moved more than 20 cm. */
  place(x: number, z: number, force = false): boolean {
    if (!force && Math.abs(x - this.cx) < 0.2 && Math.abs(z - this.cz) < 0.2) return false;
    this.cx = x;
    this.cz = z;
    const r = this.r;
    const w = Math.max(0.12, r * 0.012);
    const ring: number[] = [];
    const fill: number[] = [x, this.ground(x, z) + 0.2, z];
    const idxR: number[] = [];
    const idxF: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (const rr of [r - w, r + w]) {
        const px = x + ca * rr;
        const pz = z + sa * rr;
        ring.push(px, this.ground(px, pz) + 0.25, pz);
      }
      const fx = x + ca * (r - w);
      const fz = z + sa * (r - w);
      fill.push(fx, this.ground(fx, fz) + 0.2, fz);
      if (i < SEG) {
        const k = i * 2;
        idxR.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        idxF.push(0, i + 1, i + 2);
      }
    }
    // interior of the fill: a coarse polar grid so it follows hills
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(ring, 3));
    g.setIndex(idxR);
    this.ring.geometry.dispose();
    this.ring.geometry = g;
    const f = new THREE.BufferGeometry();
    const fp: number[] = [];
    const fi: number[] = [];
    const RINGS = 8;
    const S2 = 48;
    fp.push(x, this.ground(x, z) + 0.2, z);
    for (let k = 1; k <= RINGS; k++) {
      const rr = ((r - w) * k) / RINGS;
      for (let i = 0; i < S2; i++) {
        const a = (i / S2) * Math.PI * 2;
        const px = x + Math.cos(a) * rr;
        const pz = z + Math.sin(a) * rr;
        fp.push(px, this.ground(px, pz) + 0.2, pz);
      }
    }
    for (let i = 0; i < S2; i++) fi.push(0, 1 + i, 1 + ((i + 1) % S2));
    for (let k = 1; k < RINGS; k++) {
      const a0 = 1 + (k - 1) * S2;
      const a1 = 1 + k * S2;
      for (let i = 0; i < S2; i++) {
        const j = (i + 1) % S2;
        fi.push(a0 + i, a1 + i, a1 + j, a0 + i, a1 + j, a0 + j);
      }
    }
    void fill;
    void idxF;
    f.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
    f.setIndex(fi);
    this.fill.geometry.dispose();
    this.fill.geometry = f;
    return true;
  }

  setRadius(m: number): void {
    this.r = m;
    this.place(this.cx, this.cz, true);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of [this.ring, this.fill]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
