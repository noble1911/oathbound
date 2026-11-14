// CPU-simulated solid VFX: projectiles in flight (instanced meshes oriented along velocity) and
// debris chunks (gravity, ground bounce, tumbling). Lit materials are registered with the shadow
// system via `engine.patch` (CSM replaces the light chunks globally).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Engine } from '../core/engine.ts';
import { LAYER_VFX } from '../core/post.ts';

export type ProjectileKind = 'arrow' | 'bolt' | 'stone' | 'fireball' | 'firebreath' | 'lightning' | 'tower_arrow';
export type ArcType = 'line' | 'arc' | 'high_arc';
type Ground = (wx: number, wz: number) => number;

function lit(engine: Engine, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial(params);
  engine.patch(m, 'vfx-std');
  return m;
}

function arrowGeo(len: number, shaftR: number, headR: number, fletch: number): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(shaftR, shaftR, len, 5, 1).rotateX(Math.PI / 2);
  const head = new THREE.ConeGeometry(headR, len * 0.14, 5).rotateX(Math.PI / 2).translate(0, 0, len / 2 + len * 0.06);
  const f1 = new THREE.PlaneGeometry(fletch * 0.5, fletch).rotateX(Math.PI / 2).translate(0, 0, -len / 2 + fletch * 0.55);
  const f2 = f1.clone().rotateZ(Math.PI / 2);
  for (const g of [shaft, head, f1, f2]) g.deleteAttribute('uv');
  // per-vertex colour: wood shaft, iron head, pale fletching
  const paint = (g: THREE.BufferGeometry, c: THREE.Color) => {
    const n = g.attributes.position.count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  paint(shaft, new THREE.Color('#7a5534'));
  paint(head, new THREE.Color('#9aa2ab'));
  paint(f1, new THREE.Color('#e9e2d0'));
  paint(f2, new THREE.Color('#e9e2d0'));
  return mergeGeometries([shaft.toNonIndexed(), head.toNonIndexed(), f1.toNonIndexed(), f2.toNonIndexed()])!;
}

interface Flying {
  kind: ProjectileKind;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  flight: number;
  arcH: number;
  spin: number;
  onImpact?: () => void;
}

export interface ProjectileHooks {
  /** Called every frame per projectile (trail emission). */
  trail(kind: ProjectileKind, pos: THREE.Vector3, dir: THREE.Vector3, dt: number): void;
  /** Called when a projectile lands. */
  land(kind: ProjectileKind, pos: THREE.Vector3, dir: THREE.Vector3): void;
}

const MAX_PER_KIND = 768;

export class Projectiles {
  readonly group = new THREE.Group();
  private meshes = new Map<ProjectileKind, THREE.InstancedMesh>();
  private live: Flying[] = [];
  private hooks: ProjectileHooks;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private qs = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private d = new THREE.Vector3();
  private s = new THREE.Vector3();
  private fwd = new THREE.Vector3(0, 0, 1);
  private counts = new Map<ProjectileKind, number>();

  constructor(engine: Engine, hooks: ProjectileHooks) {
    this.hooks = hooks;
    const wood = lit(engine, { vertexColors: true, roughness: 0.7, metalness: 0.1 });
    const stone = lit(engine, { color: '#8d8578', roughness: 0.95, flatShading: true });
    const add = (kind: ProjectileKind, geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const m = new THREE.InstancedMesh(geo, mat, MAX_PER_KIND);
      m.count = 0;
      m.frustumCulled = false;
      m.layers.set(LAYER_VFX);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.meshes.set(kind, m);
      this.group.add(m);
    };
    // exaggerated ~1.5× so volleys read from RTS height
    const arrow = arrowGeo(1.15, 0.022, 0.05, 0.16);
    add('arrow', arrow, wood);
    add('tower_arrow', arrow, wood);
    add('bolt', arrowGeo(2.2, 0.05, 0.12, 0.34), wood);
    add('stone', new THREE.DodecahedronGeometry(0.42, 0), stone);
    const core = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.9, 0.5), fog: false });
    add('fireball', new THREE.IcosahedronGeometry(0.24, 2), core);
  }

  get active(): number {
    return this.live.length;
  }

  launch(kind: ProjectileKind, from: THREE.Vector3, to: THREE.Vector3, flight: number, arc: ArcType, onImpact?: () => void): void {
    const dist = from.distanceTo(to);
    const arcH = arc === 'line' ? (kind === 'stone' ? dist * 0.05 : 0) : arc === 'arc' ? Math.min(14, dist * 0.16) : Math.min(35, dist * 0.42);
    this.live.push({ kind, from: from.clone(), to: to.clone(), t: 0, flight: Math.max(0.05, flight), arcH, spin: Math.random() * 6, onImpact });
  }

  private at(f: Flying, s: number, out: THREE.Vector3): THREE.Vector3 {
    out.lerpVectors(f.from, f.to, s);
    out.y += 4 * f.arcH * s * (1 - s);
    return out;
  }

  update(dt: number): void {
    this.counts.clear();
    for (const m of this.meshes.values()) m.count = 0;
    let w = 0;
    for (let i = 0; i < this.live.length; i++) {
      const f = this.live[i];
      f.t += dt;
      const s = Math.min(1, f.t / f.flight);
      this.at(f, s, this.p);
      // direction = derivative of the path
      this.d.subVectors(f.to, f.from);
      this.d.y += 4 * f.arcH * (1 - 2 * s);
      this.d.normalize();
      if (s >= 1) {
        this.hooks.land(f.kind, this.p, this.d);
        f.onImpact?.();
        continue;
      }
      this.hooks.trail(f.kind, this.p, this.d, dt);
      const mesh = this.meshes.get(f.kind);
      if (mesh) {
        const n = this.counts.get(f.kind) ?? 0;
        if (n < MAX_PER_KIND) {
          this.q.setFromUnitVectors(this.fwd, this.d);
          if (f.kind === 'stone' || f.kind === 'fireball') {
            this.qs.setFromAxisAngle(this.s.set(1, 0.3, 0.2).normalize(), f.t * (4 + f.spin));
            this.q.multiply(this.qs);
          }
          const sc = f.kind === 'fireball' ? 1 + 0.15 * Math.sin(f.t * 40) : 1;
          this.m4.compose(this.p, this.q, this.s.set(sc, sc, sc));
          mesh.setMatrixAt(n, this.m4);
          this.counts.set(f.kind, n + 1);
        }
      }
      this.live[w++] = f;
    }
    this.live.length = w;
    for (const [k, m] of this.meshes) {
      m.count = this.counts.get(k) ?? 0;
      if (m.count) m.instanceMatrix.needsUpdate = true;
    }
  }

  clear(): void {
    this.live.length = 0;
    for (const m of this.meshes.values()) m.count = 0;
  }
}

// ------------------------------------------------------------------ debris

const MAX_DEBRIS = 700;

export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private px = new Float32Array(MAX_DEBRIS);
  private py = new Float32Array(MAX_DEBRIS);
  private pz = new Float32Array(MAX_DEBRIS);
  private vx = new Float32Array(MAX_DEBRIS);
  private vy = new Float32Array(MAX_DEBRIS);
  private vz = new Float32Array(MAX_DEBRIS);
  private ax = new Float32Array(MAX_DEBRIS * 3);
  private ang = new Float32Array(MAX_DEBRIS);
  private spin = new Float32Array(MAX_DEBRIS);
  private size = new Float32Array(MAX_DEBRIS);
  private age = new Float32Array(MAX_DEBRIS);
  private life = new Float32Array(MAX_DEBRIS);
  private stretch = new Float32Array(MAX_DEBRIS);
  private col = new Float32Array(MAX_DEBRIS * 3);
  private ground: Ground;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  /** Called when a chunk first hits the ground hard (dust puff). */
  onBounce: ((x: number, y: number, z: number, size: number) => void) | null = null;

  constructor(engine: Engine, ground: Ground) {
    this.ground = ground;
    const geo = new THREE.DodecahedronGeometry(0.5, 0);
    const mat = lit(engine, { color: '#ffffff', roughness: 0.92, metalness: 0, flatShading: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_DEBRIS);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  get active(): number {
    return this.n;
  }

  /** `stretch` > 1 makes splinters (long along one axis). */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, color: THREE.ColorRepresentation, stretch = 1): void {
    let i = this.n;
    if (i >= MAX_DEBRIS) {
      // replace the oldest-ish (random) chunk
      i = Math.floor(Math.random() * MAX_DEBRIS);
    } else this.n++;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.ax[i * 3] = this.v.x;
    this.ax[i * 3 + 1] = this.v.y;
    this.ax[i * 3 + 2] = this.v.z;
    this.ang[i] = Math.random() * 6.28;
    this.spin[i] = (Math.random() * 2 - 1) * 12;
    this.size[i] = size;
    this.age[i] = 0;
    this.life[i] = life;
    this.stretch[i] = stretch;
    this.c.set(color);
    const k = 0.8 + Math.random() * 0.35;
    this.col[i * 3] = this.c.r * k;
    this.col[i * 3 + 1] = this.c.g * k;
    this.col[i * 3 + 2] = this.c.b * k;
  }

  update(dt: number): void {
    const g = -15;
    let w = 0;
    const cols = this.mesh.instanceColor!.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) continue;
      this.vy[i] += g * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      const gy = this.ground(this.px[i], this.pz[i]) + this.size[i] * 0.3;
      if (this.py[i] < gy) {
        this.py[i] = gy;
        if (this.vy[i] < -4 && this.size[i] > 0.25) this.onBounce?.(this.px[i], gy, this.pz[i], this.size[i]);
        this.vy[i] = Math.abs(this.vy[i]) > 1.5 ? -this.vy[i] * 0.32 : 0;
        this.vx[i] *= 0.55;
        this.vz[i] *= 0.55;
        this.spin[i] *= 0.5;
      }
      this.ang[i] += this.spin[i] * dt;
      // compact into slot w
      if (w !== i) {
        this.px[w] = this.px[i]; this.py[w] = this.py[i]; this.pz[w] = this.pz[i];
        this.vx[w] = this.vx[i]; this.vy[w] = this.vy[i]; this.vz[w] = this.vz[i];
        this.ax[w * 3] = this.ax[i * 3]; this.ax[w * 3 + 1] = this.ax[i * 3 + 1]; this.ax[w * 3 + 2] = this.ax[i * 3 + 2];
        this.ang[w] = this.ang[i]; this.spin[w] = this.spin[i]; this.size[w] = this.size[i];
        this.age[w] = this.age[i]; this.life[w] = this.life[i]; this.stretch[w] = this.stretch[i];
        this.col[w * 3] = this.col[i * 3]; this.col[w * 3 + 1] = this.col[i * 3 + 1]; this.col[w * 3 + 2] = this.col[i * 3 + 2];
      }
      const left = this.life[w] - this.age[w];
      const sc = this.size[w] * Math.min(1, left / 0.6);
      this.q.setFromAxisAngle(this.v.set(this.ax[w * 3], this.ax[w * 3 + 1], this.ax[w * 3 + 2]), this.ang[w]);
      this.m4.compose(this.v.set(this.px[w], this.py[w], this.pz[w]), this.q, this.s.set(sc, sc, sc * this.stretch[w]));
      this.mesh.setMatrixAt(w, this.m4);
      cols[w * 3] = this.col[w * 3];
      cols[w * 3 + 1] = this.col[w * 3 + 1];
      cols[w * 3 + 2] = this.col[w * 3 + 2];
      w++;
    }
    this.n = w;
    this.mesh.count = w;
    if (w) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor!.needsUpdate = true;
    }
  }

  clear(): void {
    this.n = 0;
    this.mesh.count = 0;
  }
}
