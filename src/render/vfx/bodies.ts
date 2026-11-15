// CPU-simulated solid VFX: projectiles in flight (instanced meshes oriented along velocity) and
// debris chunks (gravity, ground bounce, tumbling). Lit materials are registered with the shadow
// system via `engine.patch` (CSM replaces the light chunks globally).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Engine } from '../core/engine.ts';
import { LAYER_VFX } from '../core/post.ts';

export type ProjectileKind =
  | 'arrow' | 'bolt' | 'stone' | 'fireball' | 'firebreath' | 'lightning' | 'tower_arrow'
  /** Skill variants: burning arrows, heavy pinning arrows, a burning pitch pot, an empowered fireball. */
  | 'fire_arrow' | 'pin_shot' | 'fire_pot' | 'skill_fireball'
  /** Faction shots: the Corpse Catapult's plague bundle, a Djinn-Binder's whirlwind. */
  | 'plague' | 'sand_bolt';
/** Which instanced mesh draws a kind, and at what scale (skill variants reuse the base meshes: no extra draws). */
const MESH_OF: Partial<Record<ProjectileKind, [ProjectileKind, number]>> = { fire_arrow: ['arrow', 1.1], pin_shot: ['arrow', 1.5], fire_pot: ['stone', 0.75], skill_fireball: ['fireball', 1.7], plague: ['stone', 0.9] };
export type ArcType = 'line' | 'arc' | 'high_arc';
type Ground = (wx: number, wz: number) => number;

function lit(engine: Engine, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial(params);
  engine.patch(m, 'vfx-std');
  return m;
}

export const ARROW_LEN = 1.25;

/** An arrow along +Z (tip forward): shaft, flat broadhead, nock and three fletching vanes. */
export function arrowGeo(len: number, shaftR: number, headR: number, fletch: number): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(shaftR, shaftR, len, 5, 1).rotateX(Math.PI / 2);
  const headL = len * 0.13;
  const head = new THREE.ConeGeometry(headR, headL, 4).rotateX(Math.PI / 2).scale(1, 0.45, 1).translate(0, 0, len / 2 + headL * 0.45);
  const nock = new THREE.CylinderGeometry(shaftR * 1.5, shaftR * 1.5, len * 0.03, 5, 1).rotateX(Math.PI / 2).translate(0, 0, -len / 2);
  const parts: THREE.BufferGeometry[] = [shaft, head, nock];
  const colors = ['#6b4a2c', '#aab2bb', '#3a2a1c'];
  // vanes: swept quads standing off the shaft, 120° apart (one cock feather in red)
  for (let k = 0; k < 3; k++) {
    const g = new THREE.BufferGeometry();
    const z0 = -len / 2 + len * 0.04;
    const z1 = z0 + fletch;
    const h = fletch * 0.34;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, shaftR, z0, 0, shaftR + h, z0 + fletch * 0.12, 0, shaftR + h * 0.7, z1 - fletch * 0.3, 0, shaftR, z1]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.rotateZ((k * Math.PI * 2) / 3);
    parts.push(g);
    colors.push(k === 0 ? '#b8322a' : '#ece4d2');
  }
  const out: THREE.BufferGeometry[] = [];
  parts.forEach((g, i) => {
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    const ni = g.index ? g.toNonIndexed() : g;
    ni.computeVertexNormals();
    const c = new THREE.Color(colors[i]);
    const n = ni.attributes.position.count;
    const a = new Float32Array(n * 3);
    for (let j = 0; j < n; j++) a.set([c.r, c.g, c.b], j * 3);
    ni.setAttribute('color', new THREE.BufferAttribute(a, 3));
    out.push(ni);
  });
  return mergeGeometries(out)!;
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
  follow?: Follow;
}

/** Position of a moving body an arrow can stay stuck in (null once it is gone). */
export type Follow = () => THREE.Vector3 | null;

export interface ProjectileHooks {
  /** Called every frame per projectile (trail emission). */
  trail(kind: ProjectileKind, pos: THREE.Vector3, dir: THREE.Vector3, dt: number): void;
  /** Called when a projectile lands. */
  land(kind: ProjectileKind, pos: THREE.Vector3, dir: THREE.Vector3, follow?: Follow): void;
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
  readonly arrow: THREE.BufferGeometry;
  readonly wood: THREE.Material;

  constructor(engine: Engine, hooks: ProjectileHooks) {
    this.hooks = hooks;
    const wood = lit(engine, { vertexColors: true, roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide });
    this.wood = wood;
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
    const arrow = arrowGeo(ARROW_LEN, 0.02, 0.06, 0.24);
    this.arrow = arrow;
    add('arrow', arrow, wood);
    add('tower_arrow', arrow, wood);
    add('bolt', arrowGeo(2.4, 0.05, 0.14, 0.42), wood);
    add('stone', new THREE.DodecahedronGeometry(0.55, 1), stone);
    const core = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 6.5, 3.2), fog: false });
    add('fireball', new THREE.IcosahedronGeometry(0.13, 2), core);
  }

  get active(): number {
    return this.live.length;
  }

  launch(kind: ProjectileKind, from: THREE.Vector3, to: THREE.Vector3, flight: number, arc: ArcType, onImpact?: () => void, follow?: Follow): void {
    const dist = from.distanceTo(to);
    const arcH = arc === 'line' ? (kind === 'stone' ? dist * 0.05 : 0) : arc === 'arc' ? Math.min(14, dist * 0.16) : Math.min(35, dist * 0.42);
    this.live.push({ kind, from: from.clone(), to: to.clone(), t: 0, flight: Math.max(0.05, flight), arcH, spin: Math.random() * 6, onImpact, follow });
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
        this.hooks.land(f.kind, this.p, this.d, f.follow);
        f.onImpact?.();
        continue;
      }
      this.hooks.trail(f.kind, this.p, this.d, dt);
      const alias = MESH_OF[f.kind];
      const mk = alias ? alias[0] : f.kind;
      const mesh = this.meshes.get(mk);
      if (mesh) {
        const n = this.counts.get(mk) ?? 0;
        if (n < MAX_PER_KIND) {
          this.q.setFromUnitVectors(this.fwd, this.d);
          if (mk === 'stone' || mk === 'fireball') {
            this.qs.setFromAxisAngle(this.s.set(1, 0.3, 0.2).normalize(), f.t * (4 + f.spin));
            this.q.multiply(this.qs);
          }
          const sc = (mk === 'fireball' ? 1 + 0.15 * Math.sin(f.t * 40) : 1) * (alias ? alias[1] : 1);
          this.m4.compose(this.p, this.q, this.s.set(sc, sc, sc));
          mesh.setMatrixAt(n, this.m4);
          this.counts.set(mk, n + 1);
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
    // an irregular chunk: a low-poly ball with its corners pushed about (flat shaded)
    const geo = new THREE.IcosahedronGeometry(0.5, 1);
    const gp = geo.attributes.position;
    for (let i = 0; i < gp.count; i++) {
      const x = gp.getX(i);
      const y = gp.getY(i);
      const z = gp.getZ(i);
      const h = Math.sin(x * 37.1 + y * 17.3 + z * 29.7) * 43758.5453;
      const k = 0.72 + 0.5 * (h - Math.floor(h));
      gp.setXYZ(i, x * k, y * k * 0.8, z * k);
    }
    // (the base colour scales the per-chunk instance colour: rubble must not out-shine the wall it fell from)
    const mat = lit(engine, { color: '#8a8a8a', roughness: 0.95, metalness: 0, flatShading: true });
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
      this.m4.compose(this.v.set(this.px[w], this.py[w], this.pz[w]), this.q, this.s.set(sc * (0.7 + 0.6 * Math.abs(this.ax[w * 3])), sc * (0.6 + 0.5 * Math.abs(this.ax[w * 3 + 1])), sc * this.stretch[w]));
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

// ------------------------------------------------------------------ stuck arrows

interface StuckFollow {
  slot: number;
  follow: Follow;
  off: THREE.Vector3;
}

/**
 * Arrows and bolts left standing where they landed: in the ground for a while, or riding on a
 * soldier until he falls. One InstancedMesh; static ones cost nothing per frame.
 */
export class StuckArrows {
  readonly mesh: THREE.InstancedMesh;
  private cap: number;
  private head = 0;
  private until: Float32Array;
  private followers: StuckFollow[] = [];
  private m4 = new THREE.Matrix4();
  private quats: THREE.Quaternion[] = [];
  private scales: Float32Array;
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private fwd = new THREE.Vector3(0, 0, 1);
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private time = 0;
  private sweep = 0;
  maxFollowers: number;

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number, maxFollowers: number) {
    this.cap = capacity;
    this.maxFollowers = maxFollowers;
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_VFX);
    this.mesh.name = 'vfx.stuck';
    this.until = new Float32Array(capacity).fill(-1);
    this.scales = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) this.quats.push(new THREE.Quaternion());
  }

  /** Stick an arrow whose tip is at `tip`, flying along `dir`. `follow` rides a moving body. */
  add(tip: THREE.Vector3, dir: THREE.Vector3, scale: number, life: number, follow?: Follow): void {
    if (follow && this.followers.length >= this.maxFollowers) return;
    const i = this.head++ % this.cap;
    this.followers = this.followers.filter((f) => f.slot !== i);
    // a little scatter so a volley doesn't land as parallel lines
    this.s.set(dir.x + (Math.random() - 0.5) * 0.25, dir.y + (Math.random() - 0.5) * 0.2, dir.z + (Math.random() - 0.5) * 0.25).normalize();
    this.quats[i].setFromUnitVectors(this.fwd, this.s);
    this.scales[i] = scale;
    // the geometry is centred: back the centre off so about a quarter of the shaft is buried
    this.p.copy(tip).addScaledVector(this.s, -ARROW_LEN * scale * (0.26 + Math.random() * 0.12));
    this.m4.compose(this.p, this.quats[i], this.s.set(scale, scale, scale));
    this.mesh.setMatrixAt(i, this.m4);
    this.until[i] = this.time + life;
    if (follow) {
      const base = follow();
      if (base) this.followers.push({ slot: i, follow, off: this.p.clone().sub(base) });
    }
    this.mesh.count = Math.min(this.cap, Math.max(this.mesh.count, i + 1));
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    this.time += dt;
    let dirty = false;
    if (this.followers.length) {
      let w = 0;
      for (const f of this.followers) {
        const base = f.follow();
        if (!base || this.until[f.slot] < this.time) {
          this.mesh.setMatrixAt(f.slot, this.zero);
          this.until[f.slot] = -1;
        } else {
          const sc = this.scales[f.slot];
          this.m4.compose(this.p.copy(base).add(f.off), this.quats[f.slot], this.s.set(sc, sc, sc));
          this.mesh.setMatrixAt(f.slot, this.m4);
          this.followers[w++] = f;
        }
        dirty = true;
      }
      this.followers.length = w;
    }
    this.sweep += dt;
    if (this.sweep > 0.5) {
      this.sweep = 0;
      for (let i = 0; i < this.mesh.count; i++) {
        if (this.until[i] >= 0 && this.until[i] < this.time) {
          this.mesh.setMatrixAt(i, this.zero);
          this.until[i] = -1;
          dirty = true;
        }
      }
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.followers.length = 0;
    this.until.fill(-1);
    this.mesh.count = 0;
    this.head = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
