// The VFX system. One `Vfx` per view: pooled GPU particles (additive HDR + alpha dust/smoke),
// CPU-tracked projectiles and debris, terrain-hugging decals, domes, light pillars, ribbons and
// batched damage numbers. Everything lives on LAYER_VFX (rendered after GTAO, before bloom; HDR
// colours > ~1.35 bloom).
//
// Driving: every spawn wakes the engine and registers an animator that calls `update(dt)` until
// nothing is alive, so callers never have to tick it. Calling `update(dt)` yourself as well is
// harmless (a second call in the same engine frame is ignored).
//
// Coordinates are world metres (see core/coords.ts); `ground(x, z)` gives terrain height.
// Teen-friendly: impacts are flashes, sparks, dust and debris; never blood.
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';
import { makeAtlas, CELL } from './atlas.ts';
import { ParticlePool, type Particle } from './particles.ts';
import { GroundDecal, Dome, Pillar, RibbonBatch, type DecalMode, type Ribbon } from './shapes.ts';
import { DamageNumbers, type NumberStyle } from './numbers.ts';
import { Projectiles, Debris, type ProjectileKind, type ArcType } from './bodies.ts';

export type { ProjectileKind, ArcType, NumberStyle };
export type Rarity = 'common' | 'magic' | 'rare' | 'legendary';
export interface LootBeamHandle {
  setPosition(p: THREE.Vector3): void;
  dispose(): void;
}

type RGB = [number, number, number];
const FIRE0: RGB = [4.2, 1.9, 0.45];
const FIRE1: RGB = [0.8, 0.1, 0.015];
const SPARK0: RGB = [9, 6, 2.8];
const SPARK1: RGB = [3, 0.8, 0.1];
const WHITE_HOT: RGB = [8, 7, 5.5];
const MAGIC: RGB = [2.2, 3.4, 10];
const HEAL: RGB = [2.4, 5, 1.3];
const FROST: RGB = [2.2, 4.8, 8.5];
const GOLD: RGB = [6.5, 4.2, 1.3];
const SKY: RGB = [3.2, 5, 9];
const DUST: RGB = [0.32, 0.27, 0.2];
const SMOKE: RGB = [0.2, 0.18, 0.17];
const STONE = '#8b8478';
const WOOD = '#7a5534';

const RARITY_RGB: Record<Rarity, RGB> = {
  common: [2.4, 2.4, 2.6],
  magic: [0.55, 1.25, 6.5],
  rare: [5.5, 3.7, 0.7],
  legendary: [6.5, 2.4, 0.3],
};

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;
const mul = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

interface Actor {
  /** Return false when finished (then `dispose` is called). */
  update(dt: number, time: number): boolean;
  dispose(): void;
}

export class Vfx {
  readonly root = new THREE.Group();
  private engine: Engine;
  private ground: (wx: number, wz: number) => number;
  private atlas: THREE.Texture;
  private add!: ParticlePool;
  private alpha!: ParticlePool;
  private numbers: DamageNumbers;
  private projectiles: Projectiles;
  private debris: Debris;
  private ribbons: RibbonBatch;
  private ribbonList: Ribbon[] = [];
  private actors: Actor[] = [];
  private tasks: { at: number; fn: () => void }[] = [];
  private time = 0;
  private density = 1;
  private lastFrame = -1;
  private busy = false;
  private running = false;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(engine: Engine, ground: (wx: number, wz: number) => number) {
    this.engine = engine;
    this.ground = ground;
    this.root.name = 'vfx';
    this.atlas = makeAtlas();
    this.buildPools(engine.quality.particleBudget);
    this.numbers = new DamageNumbers(1536);
    this.projectiles = new Projectiles(engine, {
      trail: (k, p, d, dt) => this.trail(k, p, d, dt),
      land: () => {},
    });
    this.debris = new Debris(engine, ground);
    this.debris.onBounce = (x, y, z, s) => {
      if (Math.random() < 0.45) this.dustPuff(x, y, z, s * 2.2, 1);
    };
    this.ribbons = new RibbonBatch();
    this.root.add(this.numbers.mesh, this.projectiles.group, this.debris.mesh, this.ribbons.mesh);
    engine.scene.add(this.root);
    engine.onQuality.add((q) => this.buildPools(q.particleBudget));
  }

  private buildPools(budget: number): void {
    this.add?.dispose();
    this.alpha?.dispose();
    this.add = new ParticlePool(Math.max(1000, Math.round(budget * 0.6)), 'add', this.atlas);
    this.alpha = new ParticlePool(Math.max(600, Math.round(budget * 0.4)), 'alpha', this.atlas);
    this.add.time = this.alpha.time = this.time;
    this.alpha.light.setRGB(1.3, 1.24, 1.12);
    this.root.add(this.alpha.mesh, this.add.mesh);
    this.density = THREE.MathUtils.clamp(budget / 12000, 0.35, 1.25);
  }

  /** Scale a particle count by the tier's density. */
  private n(x: number): number {
    return Math.max(1, Math.round(x * this.density));
  }

  /** Tint for alpha particles (dust/smoke): sun + sky light. */
  setLight(c: THREE.ColorRepresentation): void {
    this.alpha.light.set(c);
  }

  // ------------------------------------------------------------------ loop

  private kick(): void {
    this.busy = true;
    if (this.running) return;
    this.running = true;
    this.engine.animate((dt) => {
      const b = this.update(dt);
      if (!b) this.running = false;
      return b;
    });
  }

  private later(sec: number, fn: () => void): void {
    this.tasks.push({ at: this.time + sec, fn });
    this.kick();
  }

  private actor(a: Actor): void {
    this.actors.push(a);
    this.kick();
  }

  /** Advance everything; true while anything is alive. Safe to call more than once per frame. */
  update(dt: number): boolean {
    if (this.lastFrame === this.engine.frames) return this.busy;
    this.lastFrame = this.engine.frames;
    this.time += dt;
    if (this.tasks.length) {
      const due = this.tasks.filter((t) => t.at <= this.time);
      if (due.length) {
        this.tasks = this.tasks.filter((t) => t.at > this.time);
        for (const t of due) t.fn();
      }
    }
    this.ribbonList.length = 0;
    let w = 0;
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      if (a.update(dt, this.time)) this.actors[w++] = a;
      else a.dispose();
    }
    this.actors.length = w;
    this.projectiles.update(dt);
    this.debris.update(dt);
    this.ribbons.build(this.ribbonList, this.engine.camera.position);
    this.add.tick(dt);
    this.alpha.tick(dt);
    this.numbers.tick(dt);
    this.busy =
      this.add.alive || this.alpha.alive || this.numbers.alive || this.actors.length > 0 || this.projectiles.active > 0 || this.debris.active > 0 || this.tasks.length > 0;
    return this.busy;
  }

  clear(): void {
    for (const a of this.actors) a.dispose();
    this.actors.length = 0;
    this.tasks.length = 0;
    this.add.clear();
    this.alpha.clear();
    this.numbers.clear();
    this.projectiles.clear();
    this.debris.clear();
    this.ribbons.build([], this.engine.camera.position);
  }

  /** Live counts (stats overlay). */
  get counts(): { projectiles: number; debris: number; actors: number } {
    return { projectiles: this.projectiles.active, debris: this.debris.active, actors: this.actors.length };
  }

  dispose(): void {
    this.clear();
    this.add.dispose();
    this.alpha.dispose();
    this.numbers.dispose();
    this.ribbons.dispose();
    this.root.removeFromParent();
    this.atlas.dispose();
  }

  // ------------------------------------------------------------------ low-level helpers

  private emitA(p: Particle): void {
    this.add.emit(p);
    if (!this.running) this.kick();
  }
  private emitB(p: Particle): void {
    this.alpha.emit(p);
    if (!this.running) this.kick();
  }

  private flash(pos: THREE.Vector3, size: number, color: RGB, life = 0.12): void {
    this.emitA({ x: pos.x, y: pos.y, z: pos.z, life, size, size1: size * 0.3, r: color[0], g: color[1], b: color[2], cell: CELL.star, rot: Math.random() * TAU });
    this.emitA({ x: pos.x, y: pos.y, z: pos.z, life: life * 1.6, size: size * 1.0, size1: size * 1.4, r: color[0] * 0.15, g: color[1] * 0.15, b: color[2] * 0.15, cell: CELL.dot });
  }

  private sparks(pos: THREE.Vector3, count: number, speed: number, c0: RGB = SPARK0, c1: RGB = SPARK1, up = 0.4, size = 0.07): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const e = rnd(-0.2, 1) * up + (1 - up) * rnd(-0.6, 0.6);
      const s = speed * rnd(0.45, 1);
      const ce = Math.cos(e);
      this.emitA({
        x: pos.x, y: pos.y, z: pos.z,
        vx: Math.cos(a) * ce * s, vy: Math.sin(e) * s + speed * 0.25, vz: Math.sin(a) * ce * s,
        life: rnd(0.22, 0.5), size: size * rnd(0.7, 1.3), size1: size * 0.4, gravity: -11, drag: 2.2,
        r: c0[0], g: c0[1], b: c0[2], r1: c1[0], g1: c1[1], b1: c1[2], cell: CELL.spark, stretch: 0.045,
      });
    }
  }

  private dustPuff(x: number, y: number, z: number, size: number, count: number, color: RGB = DUST, alpha = 0.45): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const s = rnd(0.3, 1.2);
      this.emitB({
        x: x + Math.cos(a) * size * 0.2, y: y + size * 0.15, z: z + Math.sin(a) * size * 0.2,
        vx: Math.cos(a) * s, vy: rnd(0.2, 0.9), vz: Math.sin(a) * s,
        life: rnd(1.0, 1.8), size: size * 0.5, size1: size * 1.6, gravity: 0.15, drag: 1.8, spin: rnd(-0.6, 0.6),
        r: color[0], g: color[1], b: color[2], alpha, cell: CELL.smoke, fadeIn: 0.12,
      });
    }
  }

  /** Radial ground-hugging dust ring (stones, stomps, collapses). */
  private dustRing(pos: THREE.Vector3, count: number, speed: number, size: number, life = 1.8, color: RGB = DUST, alpha = 0.55): void {
    const gy = this.ground(pos.x, pos.z);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + rnd(-0.2, 0.2);
      const s = speed * rnd(0.6, 1.1);
      this.emitB({
        x: pos.x + Math.cos(a) * 0.4, y: gy + size * 0.55, z: pos.z + Math.sin(a) * 0.4,
        vx: Math.cos(a) * s, vy: rnd(0.3, 1.2), vz: Math.sin(a) * s,
        life: life * rnd(0.75, 1.2), size: size * 0.5, size1: size * 1.7, gravity: 0.3, drag: 2.4, spin: rnd(-0.5, 0.5),
        r: color[0] * rnd(0.85, 1.1), g: color[1] * rnd(0.85, 1.1), b: color[2] * rnd(0.85, 1.1), alpha, cell: CELL.smoke, fadeIn: 0.06,
      });
    }
  }

  private fireBurst(pos: THREE.Vector3, radius: number, count: number, rise = 2): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const e = rnd(0.05, 1.2);
      const s = radius * rnd(1.2, 3.2);
      this.emitA({
        x: pos.x, y: pos.y + 0.2, z: pos.z,
        vx: Math.cos(a) * Math.cos(e) * s, vy: Math.sin(e) * s * 0.7, vz: Math.sin(a) * Math.cos(e) * s,
        life: rnd(0.35, 0.8), size: radius * rnd(0.35, 0.6), size1: radius * rnd(0.7, 1.1), gravity: rise, drag: 3.2, spin: rnd(-2, 2),
        r: FIRE0[0], g: FIRE0[1], b: FIRE0[2], r1: FIRE1[0], g1: FIRE1[1], b1: FIRE1[2], cell: Math.random() < 0.5 ? CELL.flame : CELL.dot, fadeIn: 0.05,
      });
    }
  }

  private embers(pos: THREE.Vector3, count: number, speed: number, gravity = -6): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const s = speed * rnd(0.3, 1);
      this.emitA({
        x: pos.x, y: pos.y + 0.3, z: pos.z,
        vx: Math.cos(a) * s * 0.7, vy: rnd(0.4, 1.2) * speed, vz: Math.sin(a) * s * 0.7,
        life: rnd(0.7, 1.6), size: rnd(0.05, 0.1), size1: 0.02, gravity, drag: 1.2,
        r: 7, g: 2.8, b: 0.6, r1: 2, g1: 0.3, b1: 0.05, cell: CELL.ember, stretch: 0.03,
      });
    }
  }

  private smokeColumn(pos: THREE.Vector3, count: number, size: number, rise: number, life: number, color: RGB = SMOKE, alpha = 0.5): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const r = rnd(0, size * 0.5);
      this.emitB({
        x: pos.x + Math.cos(a) * r, y: pos.y + size * 0.5 + rnd(0, size * 0.4), z: pos.z + Math.sin(a) * r,
        vx: Math.cos(a) * rnd(0.2, 1), vy: rise * rnd(0.6, 1.2), vz: Math.sin(a) * rnd(0.2, 1),
        life: life * rnd(0.7, 1.2), size: size * 0.5, size1: size * 1.8, gravity: 0.2, drag: 0.9, spin: rnd(-0.4, 0.4),
        r: color[0], g: color[1], b: color[2], alpha, cell: CELL.smoke, fadeIn: 0.15, delay: rnd(0, 0.15),
      });
    }
  }

  private decal(mode: DecalMode, color: RGB, pos: THREE.Vector3, radius: number, life: number, opts: { fadeIn?: number; grow?: boolean; alpha?: number } = {}): void {
    const d = new GroundDecal(mode, color, radius, this.ground);
    d.place(pos.x, pos.z, radius);
    this.root.add(d.mesh);
    let t = 0;
    const a0 = opts.alpha ?? 1;
    this.actor({
      update: (dt, time) => {
        t += dt;
        const k = Math.min(1, t / life);
        d.time = time;
        d.progress = opts.grow === false ? k : 1 - Math.pow(1 - k, 2.2);
        const fin = opts.fadeIn ? Math.min(1, t / opts.fadeIn) : 1;
        d.alpha = a0 * fin * (mode === 'shockwave' || mode === 'warn' ? 1 : 1 - k * k);
        return t < life;
      },
      dispose: () => d.dispose(),
    });
  }

  private debrisBurst(pos: THREE.Vector3, count: number, speed: number, size: number, color: THREE.ColorRepresentation = STONE, up = 1, stretch = 1): void {
    this.kick();
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const s = speed * rnd(0.3, 1);
      this.debris.spawn(pos.x, pos.y + 0.3, pos.z, Math.cos(a) * s, rnd(0.6, 1.4) * speed * up, Math.sin(a) * s, size * rnd(0.4, 1.2), rnd(2.2, 4), color, stretch);
    }
  }

  // ------------------------------------------------------------------ projectiles

  /**
   * Launch a projectile. If `onImpact` is given it is called on landing INSTEAD of the default
   * impact visual (so playback driven by sim 'impact' events doesn't double up); without it the
   * projectile plays `impact(kind, to, 0)` itself.
   */
  projectile(kind: ProjectileKind, from: THREE.Vector3, to: THREE.Vector3, flightSec: number, arc: ArcType, onImpact?: () => void): void {
    if (kind === 'lightning') {
      this.lightning(from, to);
      const dst = to.clone();
      this.later(Math.min(flightSec, 0.05), () => (onImpact ? onImpact() : this.impact('lightning', dst, 0)));
      return;
    }
    if (kind === 'fireball') this.flash(from, 1.2, mul(FIRE0, 0.7), 0.1);
    const dst = to.clone();
    this.projectiles.launch(kind, from, to, flightSec, arc, () => (onImpact ? onImpact() : this.impact(kind, dst, 0)));
    this.kick();
  }

  private trail(kind: ProjectileKind, p: THREE.Vector3, d: THREE.Vector3, _dt: number): void {
    switch (kind) {
      case 'arrow':
      case 'tower_arrow':
        if (Math.random() < this.density * 0.8) this.emitA({ x: p.x - d.x * 0.5, y: p.y - d.y * 0.5, z: p.z - d.z * 0.5, life: 0.16, size: 0.07, size1: 0.02, r: 0.45, g: 0.43, b: 0.38, alpha: 0.8, cell: CELL.dot });
        break;
      case 'bolt':
        this.emitA({ x: p.x - d.x, y: p.y - d.y, z: p.z - d.z, life: 0.22, size: 0.16, size1: 0.04, r: 0.8, g: 0.75, b: 0.65, alpha: 0.8, cell: CELL.dot });
        break;
      case 'stone':
        if (Math.random() < 0.6) this.emitB({ x: p.x, y: p.y, z: p.z, vx: rnd(-0.3, 0.3), vy: rnd(-0.2, 0.3), vz: rnd(-0.3, 0.3), life: rnd(0.5, 0.9), size: 0.35, size1: 1.1, drag: 1, r: DUST[0], g: DUST[1], b: DUST[2], alpha: 0.35, cell: CELL.smoke });
        break;
      case 'fireball':
      case 'firebreath': {
        const big = kind === 'firebreath' ? 1.8 : 1;
        this.emitA({ x: p.x, y: p.y, z: p.z, life: 0.06, size: 0.75 * big, size1: 0.6 * big, r: 5, g: 2.4, b: 0.7, alpha: 0.85, cell: CELL.dot });
        for (let i = 0; i < (big > 1 ? 2 : 1); i++)
          this.emitA({
            x: p.x + rnd(-0.08, 0.08), y: p.y + rnd(-0.08, 0.08), z: p.z + rnd(-0.08, 0.08),
            vx: -d.x * 1.5 + rnd(-0.4, 0.4), vy: -d.y * 1.5 + rnd(0, 0.6), vz: -d.z * 1.5 + rnd(-0.4, 0.4),
            life: rnd(0.16, 0.28), size: 0.32 * big, size1: 0.08, gravity: 1.5, drag: 2, spin: rnd(-3, 3),
            r: FIRE0[0], g: FIRE0[1], b: FIRE0[2], r1: FIRE1[0], g1: FIRE1[1], b1: FIRE1[2], cell: CELL.flame,
          });
        if (Math.random() < 0.3) this.embers(p, 1, 1.2, -2);
        if (Math.random() < 0.35 * this.density) this.emitB({ x: p.x, y: p.y, z: p.z, vy: 0.6, life: 0.9, size: 0.4 * big, size1: 1.2 * big, drag: 1, r: SMOKE[0], g: SMOKE[1], b: SMOKE[2], alpha: 0.3, cell: CELL.smoke, delay: 0.08 });
        break;
      }
      default:
        break;
    }
  }

  /** Landing visual for a projectile kind (or a sim 'impact' event). */
  impact(kind: ProjectileKind, pos: THREE.Vector3, splashMetres: number): void {
    const gy = this.ground(pos.x, pos.z);
    const onGround = pos.y - gy < 0.6;
    switch (kind) {
      case 'arrow':
      case 'tower_arrow':
        this.flash(pos, 0.35, [3, 2.6, 2], 0.07);
        this.sparks(pos, this.n(3), 3, SPARK0, SPARK1, 0.6, 0.04);
        if (onGround) this.dustPuff(pos.x, gy, pos.z, 0.5, 1, DUST, 0.35);
        break;
      case 'bolt':
        this.flash(pos, 0.9, WHITE_HOT, 0.09);
        this.sparks(pos, this.n(8), 5);
        this.debrisBurst(pos, 5, 4, 0.12, WOOD, 0.8, 4);
        this.dustPuff(pos.x, gy, pos.z, 1, this.n(3));
        break;
      case 'stone': {
        const r = Math.max(3, splashMetres || 6);
        const g = this.tmp.set(pos.x, gy, pos.z);
        this.flash(this.tmp2.set(pos.x, gy + 0.5, pos.z), 2.2, [4, 3.2, 2.2], 0.1);
        this.dustRing(g, this.n(26), r * 1.4, r * 0.55, 1.9);
        this.smokeColumn(g, this.n(8), r * 0.45, 2.2, 1.8, DUST, 0.5);
        this.debrisBurst(g, this.n(12), 7, 0.28);
        this.decal('shockwave', [2.2, 1.9, 1.5], g, r * 1.1, 0.5);
        this.engine.addShake(0.12);
        break;
      }
      case 'fireball':
      case 'firebreath': {
        const r = Math.max(1.5, splashMetres || 3);
        this.flash(pos, r * 0.8, [8, 5, 2], 0.12);
        this.fireBurst(pos, r * 0.55, this.n(26));
        this.embers(pos, this.n(14), 5, -7);
        this.smokeColumn(this.tmp.set(pos.x, gy, pos.z), this.n(7), r * 0.7, 1.8, 1.6);
        this.decal('glow', [3, 1, 0.2], this.tmp.set(pos.x, gy, pos.z), r * 1.1, 0.9);
        this.decal('shockwave', [5, 2.6, 0.8], this.tmp.set(pos.x, gy, pos.z), r * 1.2, 0.35);
        break;
      }
      case 'lightning':
        this.flash(pos, 1.3, [4, 5, 12], 0.1);
        this.sparks(pos, this.n(10), 5, [4, 6, 12], [0.6, 1, 4], 0.6, 0.05);
        break;
    }
  }

  // ------------------------------------------------------------------ hits

  hitSpark(pos: THREE.Vector3, opts: { crit?: boolean; magic?: boolean; color?: THREE.ColorRepresentation } = {}): void {
    const crit = !!opts.crit;
    let c0: RGB = opts.magic ? MAGIC : SPARK0;
    if (opts.color !== undefined) {
      const c = new THREE.Color(opts.color);
      c0 = [c.r * 6, c.g * 6, c.b * 6];
    }
    const c1: RGB = opts.magic ? [0.5, 0.8, 3] : SPARK1;
    this.flash(pos, crit ? 1.8 : 1.0, opts.magic ? [3, 4, 10] : WHITE_HOT, crit ? 0.18 : 0.14);
    this.sparks(pos, this.n(crit ? 18 : 10), crit ? 8 : 5.5, c0, c1, 0.4, crit ? 0.12 : 0.09);
    this.emitA({ x: pos.x, y: pos.y, z: pos.z, life: 0.26, size: 0.25, size1: crit ? 2.6 : 1.6, r: c0[0] * 0.25, g: c0[1] * 0.25, b: c0[2] * 0.25, cell: CELL.ring });
    if (crit) this.engine.addShake(0.05);
  }

  heal(pos: THREE.Vector3, strength = 1): void {
    const gy = this.ground(pos.x, pos.z);
    const n = this.n(14 * strength);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const r = rnd(0.1, 0.9);
      this.emitA({
        x: pos.x + Math.cos(a) * r, y: gy + rnd(0, 1.2), z: pos.z + Math.sin(a) * r,
        vx: 0, vy: rnd(0.9, 1.9), vz: 0, life: rnd(0.9, 1.5), size: rnd(0.18, 0.3), size1: 0.05, gravity: 0.4, drag: 0.8,
        r: HEAL[0] * 1.6, g: HEAL[1] * 1.6, b: HEAL[2] * 1.6, r1: 3.5, g1: 4, b1: 1.2, cell: i % 3 === 0 ? CELL.star : CELL.dot, fadeIn: 0.15, delay: rnd(0, 0.25),
      });
    }
    this.emitA({ x: pos.x, y: gy + 1, z: pos.z, life: 0.6, size: 2.2, size1: 2.8, r: 0.9, g: 1.8, b: 0.5, alpha: 0.6, cell: CELL.dot, fadeIn: 0.2 });
    this.decal('heal', mul(HEAL, 0.6), this.tmp.set(pos.x, gy, pos.z), 1.3, 1.1, { fadeIn: 0.2 });
  }

  lightning(from: THREE.Vector3, to: THREE.Vector3): void {
    const a = from.clone();
    const b = to.clone();
    let paths: THREE.Vector3[][] = [];
    let regen = 0;
    let t = 0;
    const life = 0.32;
    const core = new THREE.Color(7, 8, 16);
    const glow = new THREE.Color(1.1, 1.7, 5.5);
    const make = () => {
      const main = jagged(a, b, 22, 0.16);
      paths = [main];
      for (let k = 0; k < 2; k++) {
        const i = 4 + Math.floor(Math.random() * (main.length - 8));
        const s = main[i];
        const len = a.distanceTo(b) * rnd(0.15, 0.35);
        const dir = this.tmp.subVectors(b, a).normalize().add(new THREE.Vector3(rnd(-1, 1), rnd(-0.6, 0.8), rnd(-1, 1))).normalize();
        paths.push(jagged(s, s.clone().addScaledVector(dir, len), 8, 0.22));
      }
    };
    make();
    this.flash(a, 0.9, [4, 5, 12], 0.12);
    this.flash(b, 1.4, [5, 6, 14], 0.15);
    this.sparks(b, this.n(10), 5, [4, 6, 12], [0.6, 1, 4], 0.5, 0.05);
    this.actor({
      update: (dt) => {
        t += dt;
        regen -= dt;
        if (regen <= 0) {
          make();
          regen = 0.05;
        }
        const fade = Math.max(0, 1 - t / life);
        const flick = 0.55 + 0.45 * Math.random();
        paths.forEach((p, i) => {
          const w = i === 0 ? 1 : 0.55;
          this.ribbonList.push({ points: p, width: 0.65 * w, color: glow, alpha: 0.55 * fade * flick });
          this.ribbonList.push({ points: p, width: 0.09 * w, color: core, alpha: fade * flick });
        });
        return t < life;
      },
      dispose: () => {},
    });
  }

  burn(pos: THREE.Vector3, durSec: number): void {
    const p = pos.clone();
    this.emitter(durSec, 24, (k) => {
      const gy = this.ground(p.x, p.z);
      for (let i = 0; i < k; i++) {
        const a = Math.random() * TAU;
        const r = rnd(0, 0.45);
        this.emitA({
          x: p.x + Math.cos(a) * r, y: gy + rnd(0.2, 1.2), z: p.z + Math.sin(a) * r,
          vy: rnd(0.8, 1.6), life: rnd(0.35, 0.6), size: rnd(0.4, 0.6), size1: 0.1, gravity: 1, drag: 1, spin: rnd(-2, 2),
          r: FIRE0[0], g: FIRE0[1], b: FIRE0[2], r1: FIRE1[0], g1: FIRE1[1], b1: FIRE1[2], cell: CELL.flame, fadeIn: 0.1,
        });
        if (Math.random() < 0.4) this.embers(this.tmp.set(p.x, gy + 0.6, p.z), 1, 1.4, 0.5);
        if (Math.random() < 0.15) this.emitB({ x: p.x, y: gy + 1.2, z: p.z, vy: 0.9, life: 1.2, size: 0.3, size1: 1, drag: 0.6, r: SMOKE[0], g: SMOKE[1], b: SMOKE[2], alpha: 0.25, cell: CELL.smoke });
      }
    });
  }

  frost(pos: THREE.Vector3, durSec: number): void {
    const p = pos.clone();
    const gy = this.ground(p.x, p.z);
    this.flash(this.tmp.set(p.x, gy + 1, p.z), 1, FROST, 0.15);
    this.decal('frost', mul(FROST, 0.45), this.tmp.set(p.x, gy, p.z), 1.4, Math.max(0.6, durSec), { fadeIn: 0.15 });
    this.emitter(durSec, 14, (k) => {
      for (let i = 0; i < k; i++) {
        const a = Math.random() * TAU;
        const r = rnd(0.1, 0.7);
        this.emitA({
          x: p.x + Math.cos(a) * r, y: gy + rnd(0.1, 1.8), z: p.z + Math.sin(a) * r,
          vx: rnd(-0.1, 0.1), vy: rnd(-0.4, 0.1), vz: rnd(-0.1, 0.1), life: rnd(0.4, 0.8), size: rnd(0.1, 0.2), size1: 0.02, spin: rnd(-3, 3),
          r: FROST[0], g: FROST[1], b: FROST[2], cell: Math.random() < 0.5 ? CELL.star : CELL.shard, fadeIn: 0.3,
        });
      }
    });
  }

  /** A continuous spawner for `dur` seconds at `rate`/s. */
  private emitter(dur: number, rate: number, spawn: (count: number, t: number) => void, follow?: () => void): void {
    let t = 0;
    let acc = 0;
    const r = rate * this.density;
    this.actor({
      update: (dt) => {
        t += dt;
        follow?.();
        acc += r * dt;
        const k = Math.floor(acc);
        if (k > 0) {
          acc -= k;
          spawn(k, t);
        }
        return t < dur;
      },
      dispose: () => {},
    });
  }

  // ------------------------------------------------------------------ lord abilities

  meteor(pos: THREE.Vector3, radiusM: number): void {
    const target = pos.clone();
    target.y = this.ground(target.x, target.z);
    const start = target.clone().add(new THREE.Vector3(-16, 52, 12));
    const fall = 1.15;
    const warn = new GroundDecal('warn', [5, 1.4, 0.25], radiusM, this.ground);
    warn.place(target.x, target.z, radiusM);
    this.root.add(warn.mesh);
    const cur = new THREE.Vector3();
    const prev = start.clone();
    let t = 0;
    let landed = false;
    this.actor({
      update: (dt, time) => {
        t += dt;
        if (!landed) {
          const s = Math.min(1, Math.pow(t / fall, 1.7));
          cur.lerpVectors(start, target, s);
          warn.time = time;
          warn.progress = s;
          warn.alpha = Math.min(1, t * 4);
          const d = this.tmp.subVectors(cur, prev);
          const steps = Math.max(1, Math.ceil(d.length() / 0.8));
          for (let i = 0; i < steps; i++) {
            const q = this.tmp2.lerpVectors(prev, cur, (i + 1) / steps);
            this.emitA({ x: q.x, y: q.y, z: q.z, life: 0.07, size: 3.2, size1: 2.6, r: 7, g: 3.5, b: 1.1, alpha: 0.8, cell: CELL.dot });
            for (let k = 0; k < 3; k++)
              this.emitA({
                x: q.x + rnd(-0.5, 0.5), y: q.y + rnd(-0.5, 0.5), z: q.z + rnd(-0.5, 0.5),
                vx: rnd(-1.5, 1.5), vy: rnd(-0.5, 2), vz: rnd(-1.5, 1.5),
                life: rnd(0.4, 0.75), size: rnd(1.1, 1.7), size1: rnd(2.2, 3.2), gravity: 2, drag: 1.5, spin: rnd(-2, 2),
                r: FIRE0[0], g: FIRE0[1], b: FIRE0[2], r1: FIRE1[0], g1: FIRE1[1], b1: FIRE1[2], cell: CELL.flame,
              });
            if (Math.random() < 0.7)
              this.emitB({ x: q.x, y: q.y, z: q.z, vx: rnd(-0.5, 0.5), vy: rnd(0, 1), vz: rnd(-0.5, 0.5), life: rnd(1.2, 1.8), size: 1.5, size1: 4, drag: 0.8, spin: rnd(-0.4, 0.4), r: 0.16, g: 0.14, b: 0.12, alpha: 0.35, cell: CELL.smoke, delay: 0.05 });
            if (Math.random() < 0.5) this.embers(q, 1, 3, -4);
          }
          prev.copy(cur);
          if (s >= 1) {
            landed = true;
            this.meteorBlast(target, radiusM);
          }
          return true;
        }
        return false;
      },
      dispose: () => warn.dispose(),
    });
  }

  private meteorBlast(p: THREE.Vector3, r: number): void {
    this.engine.addShake(0.9);
    this.engine.addFlash(0.14);
    const up = this.tmp.set(p.x, p.y + 1.5, p.z);
    this.flash(up, r * 0.55, [10, 6, 2.5], 0.2);
    this.fireBurst(p, r * 0.5, this.n(40), 3);
    // rising fire column
    for (let i = 0; i < this.n(30); i++)
      this.emitA({
        x: p.x + rnd(-1, 1), y: p.y + 0.5, z: p.z + rnd(-1, 1), vx: rnd(-1.5, 1.5), vy: rnd(5, 14), vz: rnd(-1.5, 1.5),
        life: rnd(0.6, 1.1), size: rnd(1, 1.8), size1: rnd(2.5, 3.5), gravity: -2, drag: 1.8, spin: rnd(-2, 2),
        r: FIRE0[0], g: FIRE0[1], b: FIRE0[2], r1: FIRE1[0], g1: FIRE1[1], b1: FIRE1[2], cell: CELL.flame,
      });
    this.embers(p, this.n(60), 12, -9);
    this.sparks(up, this.n(30), 14, SPARK0, SPARK1, 0.7, 0.12);
    this.debrisBurst(p, this.n(34), 11, 0.5, '#5d554b');
    this.dustRing(p, this.n(30), r * 1.6, Math.min(3.5, r * 0.3), 2.0, [0.32, 0.28, 0.24], 0.42);
    this.smokeColumn(p, this.n(12), r * 0.32, 4.5, 2.4, [0.2, 0.18, 0.16], 0.3);
    this.decal('shockwave', [2.6, 1.3, 0.45], p, r * 1.7, 0.65);
    this.decal('glow', [2, 0.55, 0.08], p, r * 0.8, 2.4, { alpha: 1 });
    this.later(0.12, () => this.decal('shockwave', [1.3, 1, 0.6], p, r * 2.6, 0.9));
    // lingering fires
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * TAU;
      const d = rnd(0.2, 0.75) * r;
      this.later(rnd(0.05, 0.3), () => this.burn(new THREE.Vector3(p.x + Math.cos(a) * d, p.y, p.z + Math.sin(a) * d), rnd(1.8, 3)));
    }
  }

  rally(pos: THREE.Vector3, radiusM: number, durSec: number, follow?: () => THREE.Vector3): void {
    const c = pos.clone();
    const aura = new GroundDecal('aura', mul(GOLD, 0.45), radiusM, this.ground);
    aura.place(c.x, c.z, radiusM);
    this.root.add(aura.mesh);
    const gy = this.ground(c.x, c.z);
    this.decal('shockwave', mul(GOLD, 0.7), this.tmp.set(c.x, gy, c.z), radiusM, 0.6);
    this.flash(this.tmp.set(c.x, gy + 2, c.z), 3.5, GOLD, 0.2);
    const beam = new Pillar(mul(GOLD, 0.9), 0.7, 14, 1);
    beam.mesh.position.set(c.x, gy, c.z);
    this.root.add(beam.mesh);
    let t = 0;
    let acc = 0;
    this.actor({
      update: (dt, time) => {
        t += dt;
        if (follow) c.copy(follow());
        aura.place(c.x, c.z, radiusM);
        aura.time = time;
        const fin = Math.min(1, t / 0.3);
        const fout = Math.min(1, (durSec - t) / 0.5);
        aura.alpha = Math.max(0, Math.min(fin, fout));
        const bk = Math.max(0, 1 - t / 0.9);
        beam.material.uniforms.uAlpha.value = bk * bk;
        beam.material.uniforms.uTime.value = time;
        beam.mesh.position.set(c.x, this.ground(c.x, c.z), c.z);
        acc += dt * 28 * this.density;
        while (acc >= 1) {
          acc -= 1;
          const a = Math.random() * TAU;
          const r = Math.sqrt(Math.random()) * radiusM;
          const x = c.x + Math.cos(a) * r;
          const z = c.z + Math.sin(a) * r;
          this.emitA({
            x, y: this.ground(x, z) + 0.1, z, vy: rnd(2.2, 3.6), life: rnd(0.7, 1.1), size: rnd(0.14, 0.22), size1: 0.05, drag: 0.4,
            r: GOLD[0] * 1.5, g: GOLD[1] * 1.5, b: GOLD[2] * 1.5, r1: 3, g1: 1.6, b1: 0.4, cell: CELL.spark, stretch: 0.35, fadeIn: 0.2,
          });
        }
        return t < durSec;
      },
      dispose: () => {
        aura.dispose();
        beam.dispose();
      },
    });
  }

  bulwark(pos: THREE.Vector3, radiusM: number, durSec: number, follow?: () => THREE.Vector3): void {
    const c = pos.clone();
    const dome = new Dome([1.0, 1.9, 4.6]);
    const ring = new GroundDecal('aura', [0.6, 1.2, 3], radiusM, this.ground);
    this.root.add(dome.mesh, ring.mesh);
    const place = () => {
      const gy = this.ground(c.x, c.z);
      dome.mesh.position.set(c.x, gy - 0.2, c.z);
      dome.mesh.scale.set(radiusM, radiusM * 0.72, radiusM);
      ring.place(c.x, c.z, radiusM);
      return gy;
    };
    const gy = place();
    // spawn shimmer on the shell
    for (let i = 0; i < this.n(40); i++) {
      const a = Math.random() * TAU;
      const e = Math.random() * Math.PI * 0.5;
      const nx = Math.cos(a) * Math.cos(e);
      const ny = Math.sin(e);
      const nz = Math.sin(a) * Math.cos(e);
      this.emitA({
        x: c.x + nx * radiusM, y: gy + ny * radiusM * 0.72, z: c.z + nz * radiusM, vx: nx * 0.6, vy: ny * 0.6, vz: nz * 0.6,
        life: rnd(0.5, 0.9), size: rnd(0.15, 0.3), size1: 0.03, r: 2, g: 3.5, b: 8, cell: CELL.star, delay: rnd(0, 0.3),
      });
    }
    let t = 0;
    this.actor({
      update: (dt, time) => {
        t += dt;
        if (follow) c.copy(follow());
        place();
        const fin = Math.min(1, t / 0.25);
        const fout = Math.max(0, Math.min(1, (durSec - t) / 0.5));
        const a = Math.min(fin, fout);
        dome.material.uniforms.uAlpha.value = a * (0.8 + 0.2 * Math.sin(time * 5));
        dome.material.uniforms.uRipple.value = (t % 2.2) / 0.9;
        dome.material.uniforms.uTime.value = time;
        ring.alpha = a * 0.8;
        ring.time = time;
        return t < durSec;
      },
      dispose: () => {
        dome.dispose();
        ring.dispose();
      },
    });
  }

  skyfall(from: THREE.Vector3, to: THREE.Vector3): void {
    const a = from.clone();
    const b = to.clone();
    const dive = 0.34;
    const head = new THREE.Vector3();
    const tail = new THREE.Vector3();
    const core = new THREE.Color(7, 8, 10);
    const glow = new THREE.Color(SKY[0] * 0.6, SKY[1] * 0.6, SKY[2] * 0.6);
    const pts: THREE.Vector3[] = Array.from({ length: 12 }, () => new THREE.Vector3());
    const widths = pts.map((_, i) => 0.1 + (i / 11) * 0.7);
    const glowW = widths.map((w) => w * 3.2);
    let t = 0;
    let hit = false;
    this.actor({
      update: (dt) => {
        t += dt;
        const sh = Math.min(1, Math.pow(t / dive, 1.6));
        const st = Math.min(1, Math.pow(Math.max(0, t - 0.12) / dive, 1.6));
        head.lerpVectors(a, b, sh);
        tail.lerpVectors(a, b, st);
        for (let i = 0; i < pts.length; i++) pts[i].lerpVectors(tail, head, i / (pts.length - 1));
        const fade = hit ? Math.max(0, 1 - (t - dive) / 0.25) : 1;
        this.ribbonList.push({ points: pts, width: glowW, color: glow, alpha: 0.6 * fade });
        this.ribbonList.push({ points: pts, width: widths, color: core, alpha: fade });
        if (!hit) {
          this.emitA({ x: head.x, y: head.y, z: head.z, vx: rnd(-1, 1), vy: rnd(-1, 1), vz: rnd(-1, 1), life: 0.4, size: 0.25, size1: 0.02, r: SKY[0], g: SKY[1], b: SKY[2], cell: CELL.star });
        }
        if (!hit && sh >= 1) {
          hit = true;
          const gy = this.ground(b.x, b.z);
          const g = new THREE.Vector3(b.x, gy, b.z);
          this.engine.addShake(0.4);
          this.engine.addFlash(0.05);
          this.flash(this.tmp.set(b.x, gy + 1, b.z), 5, [7, 8.5, 12], 0.18);
          this.sparks(this.tmp.set(b.x, gy + 0.5, b.z), this.n(30), 11, [5, 7, 12], [0.8, 1.5, 4], 0.6, 0.09);
          this.dustRing(g, this.n(22), 7, 2.2, 1.6);
          this.debrisBurst(g, this.n(10), 6, 0.25);
          this.decal('shockwave', [2.5, 3.8, 7], g, 6, 0.5);
        }
        return !hit || t < dive + 0.3;
      },
      dispose: () => {},
    });
  }

  breath(origin: THREE.Vector3, dir: THREE.Vector3, lengthM: number, halfAngleRad: number, durSec: number): void {
    const o = origin.clone();
    const d = dir.clone().normalize();
    const u = new THREE.Vector3().crossVectors(d, Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(d, u).normalize();
    const lifeP = 0.62;
    const speed = lengthM / (lifeP * 0.8);
    const mid = o.clone().addScaledVector(d, lengthM * 0.6);
    const glow = new GroundDecal('glow', [4, 1.3, 0.2], lengthM * 0.45, this.ground);
    glow.place(mid.x, mid.z, lengthM * 0.45);
    this.root.add(glow.mesh);
    let t = 0;
    let acc = 0;
    const rate = 260 * this.density;
    this.actor({
      update: (dt) => {
        t += dt;
        const on = t < durSec;
        glow.alpha = (on ? Math.min(1, t * 5) : Math.max(0, 1 - (t - durSec) * 2.5)) * (0.75 + 0.25 * Math.random());
        if (on) {
          acc += rate * dt;
          this.emitA({ x: o.x, y: o.y, z: o.z, life: 0.08, size: 2.2, size1: 2, r: 9, g: 4.5, b: 1.2, alpha: 0.8, cell: CELL.dot });
          while (acc >= 1) {
            acc -= 1;
            const ang = halfAngleRad * Math.sqrt(Math.random());
            const az = Math.random() * TAU;
            const sa = Math.sin(ang);
            const dx = d.x * Math.cos(ang) + (u.x * Math.cos(az) + v.x * Math.sin(az)) * sa;
            const dy = d.y * Math.cos(ang) + (u.y * Math.cos(az) + v.y * Math.sin(az)) * sa;
            const dz = d.z * Math.cos(ang) + (u.z * Math.cos(az) + v.z * Math.sin(az)) * sa;
            const s = speed * rnd(0.75, 1.1);
            const smoke = Math.random() < 0.12;
            if (smoke)
              this.emitB({ x: o.x, y: o.y, z: o.z, vx: dx * s * 0.8, vy: dy * s * 0.8 + 1, vz: dz * s * 0.8, life: 1.3, size: 0.6, size1: lengthM * 0.14, drag: 1.1, gravity: 1.2, r: SMOKE[0], g: SMOKE[1], b: SMOKE[2], alpha: 0.35, cell: CELL.smoke, delay: 0.25 });
            else
              this.emitA({
                x: o.x, y: o.y, z: o.z, vx: dx * s, vy: dy * s, vz: dz * s, life: lifeP * rnd(0.8, 1.1), size: 0.3, size1: 0.9 + lengthM * 0.07, gravity: 2, drag: 0.7, spin: rnd(-3, 3),
                r: FIRE0[0] * 1.1, g: FIRE0[1], b: FIRE0[2], r1: FIRE1[0], g1: FIRE1[1], b1: FIRE1[2], cell: Math.random() < 0.6 ? CELL.flame : CELL.dot,
              });
          }
          if (Math.random() < 0.6 * this.density) this.embers(this.tmp.copy(o).addScaledVector(d, rnd(0.3, 1) * lengthM), 1, 3, -3);
        }
        return t < durSec + 0.5;
      },
      dispose: () => glow.dispose(),
    });
  }

  stomp(pos: THREE.Vector3, radiusM: number): void {
    const gy = this.ground(pos.x, pos.z);
    const g = new THREE.Vector3(pos.x, gy, pos.z);
    this.engine.addShake(0.3);
    this.dustRing(g, this.n(28), radiusM * 1.6, radiusM * 0.45, 1.7);
    this.debrisBurst(g, this.n(10), 5, 0.22);
    this.decal('shockwave', [2.4, 2, 1.5], g, radiusM * 1.2, 0.55);
  }

  marchDust(pos: THREE.Vector3, amount = 1): void {
    const k = Math.random() < this.density ? Math.max(1, Math.round(amount)) : 0;
    const gy = this.ground(pos.x, pos.z);
    for (let i = 0; i < k; i++)
      this.emitB({
        x: pos.x + rnd(-0.3, 0.3), y: gy + 0.15, z: pos.z + rnd(-0.3, 0.3), vx: rnd(-0.3, 0.3), vy: rnd(0.15, 0.45), vz: rnd(-0.3, 0.3),
        life: rnd(1.1, 1.9), size: 0.45, size1: 1.6, gravity: 0.05, drag: 1.6, spin: rnd(-0.4, 0.4),
        r: DUST[0], g: DUST[1], b: DUST[2], alpha: 0.22, cell: CELL.smoke, fadeIn: 0.25,
      });
    this.kick();
  }

  // ------------------------------------------------------------------ keeps

  keepHit(pos: THREE.Vector3, big = false): void {
    const k = big ? 2 : 1;
    this.flash(pos, 1.2 * k, [4, 3.4, 2.6], 0.1);
    this.sparks(pos, this.n(6 * k), 6);
    this.debrisBurst(pos, this.n(12 * k), 6 * (big ? 1.3 : 1), 0.3 * (big ? 1.3 : 1));
    this.smokeColumn(pos, this.n(10 * k), 1.6 * k, 1.5, 1.8, DUST, 0.5);
    this.engine.addShake(big ? 0.35 : 0.14);
  }

  keepCollapse(pos: THREE.Vector3): void {
    const gy = this.ground(pos.x, pos.z);
    const g = new THREE.Vector3(pos.x, gy, pos.z);
    this.engine.addShake(1.4);
    this.engine.addFlash(0.12);
    this.flash(this.tmp.set(pos.x, gy + 6, pos.z), 12, [6, 5, 3.6], 0.22);
    const wave = (scale: number) => {
      this.smokeColumn(g, this.n(40 * scale), 5.5, 4.5, 4.0, [0.3, 0.27, 0.22], 0.5);
      this.dustRing(g, this.n(36 * scale), 13, 5.5, 3.2, DUST, 0.6);
      this.debrisBurst(this.tmp.set(pos.x, gy + 5, pos.z), this.n(45 * scale), 10, 0.8);
      this.sparks(this.tmp.set(pos.x, gy + 4, pos.z), this.n(20 * scale), 10);
    };
    wave(1);
    this.decal('shockwave', [3, 2.5, 1.8], g, 26, 0.9);
    this.later(0.4, () => {
      wave(0.7);
      this.engine.addShake(0.8);
    });
    this.later(0.9, () => {
      wave(0.5);
      this.engine.addShake(0.5);
    });
  }

  levelUp(pos: THREE.Vector3): void {
    const gy = this.ground(pos.x, pos.z);
    const beam = new Pillar(mul(GOLD, 1.1), 0.55, 8, 1);
    beam.mesh.position.set(pos.x, gy, pos.z);
    this.root.add(beam.mesh);
    this.flash(this.tmp.set(pos.x, gy + 1.2, pos.z), 2.4, GOLD, 0.16);
    this.decal('shockwave', mul(GOLD, 0.6), this.tmp.set(pos.x, gy, pos.z), 2.4, 0.5);
    for (let i = 0; i < this.n(24); i++) {
      const a = Math.random() * TAU;
      const r = rnd(0.1, 0.7);
      this.emitA({
        x: pos.x + Math.cos(a) * r, y: gy + rnd(0, 0.5), z: pos.z + Math.sin(a) * r, vy: rnd(2, 5), life: rnd(0.6, 1.1), size: 0.12, size1: 0.03, drag: 0.8,
        r: GOLD[0], g: GOLD[1], b: GOLD[2], cell: CELL.spark, stretch: 0.15,
      });
    }
    let t = 0;
    this.actor({
      update: (dt, time) => {
        t += dt;
        const k = t < 0.12 ? t / 0.12 : Math.max(0, 1 - (t - 0.12) / 0.9);
        beam.material.uniforms.uAlpha.value = k;
        beam.material.uniforms.uTime.value = time;
        beam.mesh.scale.x = beam.mesh.scale.z = 0.55 * (1 + t * 0.6);
        return t < 1.05;
      },
      dispose: () => beam.dispose(),
    });
  }

  // ------------------------------------------------------------------ loot screen

  lootBeam(pos: THREE.Vector3, rarity: Rarity): LootBeamHandle {
    const c = RARITY_RGB[rarity];
    const p = pos.clone();
    const legendary = rarity === 'legendary';
    const outer = new Pillar(mul(c, 0.35), 0.8, 20, 1);
    const inner = new Pillar(mul(c, 2.2), 0.22, 26, 0.35);
    const glow = new GroundDecal('glow', mul(c, 0.6), 2.0, this.ground);
    const ring = new GroundDecal('aura', mul(c, 0.5), 1.5, this.ground);
    this.root.add(outer.mesh, inner.mesh, glow.mesh, ring.mesh);
    let dead = false;
    let t = 0;
    let acc = 0;
    this.flash(p, 3, c, 0.2);
    this.actor({
      update: (dt, time) => {
        t += dt;
        const gy = this.ground(p.x, p.z);
        outer.mesh.position.set(p.x, gy, p.z);
        inner.mesh.position.set(p.x, gy, p.z);
        glow.place(p.x, p.z);
        ring.place(p.x, p.z);
        const appear = Math.min(1, t / 0.35);
        const pulse = legendary ? 0.82 + 0.18 * Math.sin(time * 4) : 0.92 + 0.08 * Math.sin(time * 2.4);
        outer.material.uniforms.uAlpha.value = appear * pulse;
        outer.material.uniforms.uTime.value = time;
        inner.material.uniforms.uAlpha.value = appear * pulse;
        inner.material.uniforms.uTime.value = time;
        inner.mesh.scale.x = inner.mesh.scale.z = 0.22 * (1 + (1 - appear) * 3);
        glow.alpha = appear * pulse;
        ring.alpha = appear;
        ring.time = time;
        acc += dt * (legendary ? 26 : 13) * this.density;
        while (acc >= 1) {
          acc -= 1;
          const a = Math.random() * TAU;
          const r = rnd(0.15, 0.9);
          this.emitA({
            x: p.x + Math.cos(a) * r, y: gy + rnd(0, 1), z: p.z + Math.sin(a) * r, vy: rnd(1.4, 3.2), life: rnd(1.2, 2.2), size: rnd(0.07, 0.15), size1: 0.02, drag: 0.3,
            r: c[0], g: c[1], b: c[2], cell: legendary && Math.random() < 0.5 ? CELL.ember : CELL.dot, stretch: legendary ? 0.08 : 0, fadeIn: 0.2,
          });
        }
        return !dead;
      },
      dispose: () => {
        outer.dispose();
        inner.dispose();
        glow.dispose();
        ring.dispose();
      },
    });
    return {
      setPosition: (q) => {
        p.copy(q);
        this.engine.wake();
      },
      dispose: () => {
        dead = true;
        this.engine.wake();
      },
    };
  }

  // ------------------------------------------------------------------ numbers

  damageNumber(pos: THREE.Vector3, value: number, style: NumberStyle = 'normal'): void {
    this.numbers.show(pos, value, style);
    this.kick();
  }
}

/** A jagged polyline from a to b (random walk with a sine envelope). */
function jagged(a: THREE.Vector3, b: THREE.Vector3, segs: number, amp: number): THREE.Vector3[] {
  const len = a.distanceTo(b);
  const pts: THREE.Vector3[] = [];
  const off = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    off.x += (Math.random() - 0.5) * len * amp * 0.5;
    off.y += (Math.random() - 0.5) * len * amp * 0.5;
    off.z += (Math.random() - 0.5) * len * amp * 0.5;
    off.multiplyScalar(0.85);
    const env = Math.sin(Math.PI * t);
    pts.push(new THREE.Vector3().lerpVectors(a, b, t).addScaledVector(off, env));
  }
  return pts;
}
