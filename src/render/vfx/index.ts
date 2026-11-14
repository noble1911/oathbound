// The VFX system. One `Vfx` per view, one draw call per effect system:
//   · two GPU particle pools (lit smoke/dust/explosions under additive HDR glows), flipbook
//     sprites from one atlas, soft-faded against the ground
//   · one instanced decal batch (scorch marks, craters, shockwaves, sigils, scuffs)
//   · instanced projectiles, stuck arrows and debris chunks (lit meshes)
//   · batched damage numbers, camera-facing ribbons (lightning, dive streaks)
//   · a few one-off shader meshes for the Lord abilities (dome, pillars, terrain-hugging auras)
// Everything lives on LAYER_VFX (rendered after GTAO, before bloom; HDR colours > ~1.35 bloom).
//
// Driving: every spawn wakes the engine and registers an animator that calls `update(dt)` until
// nothing is animating, so callers never have to tick it and the loop goes back to sleep when the
// last particle dies. Long-lived marks (scorch, stuck arrows) are static and cost no frames.
// Particle counts scale with the quality tier (`density`).
//
// Coordinates are world metres (see core/coords.ts); `ground(x, z)` gives terrain height.
// Teen-friendly: impacts are flashes, sparks, dust and debris; never blood.
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';
import { makeAtlas, makeDecalSheet, CELL, FRAMES, DECAL } from './atlas.ts';
import { ParticlePool, type Particle } from './particles.ts';
import { GroundDecal, Dome, Pillar, RibbonBatch, type Ribbon } from './shapes.ts';
import { DecalBatch, DK, type DecalSpec } from './decals.ts';
import { DamageNumbers, type NumberStyle } from './numbers.ts';
import { Projectiles, Debris, StuckArrows, type ProjectileKind, type ArcType, type Follow } from './bodies.ts';

export type { ProjectileKind, ArcType, NumberStyle, Follow };
export type Rarity = 'common' | 'magic' | 'rare' | 'legendary';
export interface LootBeamHandle {
  setPosition(p: THREE.Vector3): void;
  dispose(): void;
}

type RGB = [number, number, number];
const FIRE: RGB = [2.6, 2.3, 2.0]; // tint for the (already orange) fire sprites
const EMBER0: RGB = [9, 3.6, 0.8];
const EMBER1: RGB = [2.4, 0.35, 0.05];
const SPARK0: RGB = [9, 6.2, 3];
const SPARK1: RGB = [3, 0.9, 0.12];
const WHITE_HOT: RGB = [8, 7, 5.5];
const MAGIC: RGB = [2.2, 3.4, 10];
const HEAL: RGB = [2.2, 5, 1.6];
const FROST: RGB = [2.2, 4.8, 8.5];
const GOLD: RGB = [6.5, 4.2, 1.3];
const SKY: RGB = [3.2, 5, 9];
const DUST: RGB = [0.6, 0.52, 0.4];
const DIRT: RGB = [0.36, 0.29, 0.21];
const SMOKE: RGB = [0.2, 0.19, 0.18];
const SOOT: RGB = [0.1, 0.095, 0.09];
const STONE = '#8b8478';
const EARTH = '#5a4631';
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

interface NumberBucket {
  sum: number;
  pos: THREE.Vector3;
  style: NumberStyle;
  due: number;
}

export class Vfx {
  readonly root = new THREE.Group();
  private engine: Engine;
  private ground: (wx: number, wz: number) => number;
  private atlas: THREE.Texture;
  private sheet: THREE.Texture;
  private add!: ParticlePool;
  private alpha!: ParticlePool;
  private decals: DecalBatch;
  private numbers: DamageNumbers;
  private projectiles: Projectiles;
  private stuck!: StuckArrows;
  private debris: Debris;
  private ribbons: RibbonBatch;
  private ribbonList: Ribbon[] = [];
  private actors: Actor[] = [];
  private tasks: { at: number; fn: () => void }[] = [];
  private buckets = new Map<number, NumberBucket>();
  private time = 0;
  private density = 1;
  private lastFrame = -1;
  private busy = false;
  private running = false;
  /** Bumped by `settle()` / `clear()`: ambient emitters (keep fires) started before it stop. */
  private epoch = 0;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(engine: Engine, ground: (wx: number, wz: number) => number) {
    this.engine = engine;
    this.ground = ground;
    this.root.name = 'vfx';
    const wake = () => engine.wake();
    this.atlas = makeAtlas(wake);
    this.sheet = makeDecalSheet(wake);
    this.atlas.anisotropy = this.sheet.anisotropy = Math.min(4, engine.quality.anisotropy);
    this.decals = new DecalBatch(384, this.sheet, ground);
    this.numbers = new DamageNumbers(1024);
    this.projectiles = new Projectiles(engine, {
      trail: (k, p, d, dt) => this.trail(k, p, d, dt),
      land: (k, p, d, follow) => this.land(k, p, d, follow),
    });
    this.debris = new Debris(engine, ground);
    this.debris.onBounce = (x, y, z, s) => {
      if (Math.random() < 0.4 * this.density) this.puff(x, y, z, s * 2.4, { life: rnd(0.7, 1.1), alpha: 0.4 });
    };
    this.ribbons = new RibbonBatch();
    this.root.add(this.decals.mesh, this.numbers.mesh, this.projectiles.group, this.debris.mesh, this.ribbons.mesh);
    this.buildPools(engine.quality.particleBudget);
    engine.scene.add(this.root);
    engine.onQuality.add((q) => this.buildPools(q.particleBudget));
  }

  private buildPools(budget: number): void {
    this.add?.dispose();
    this.alpha?.dispose();
    this.stuck?.dispose();
    this.add = new ParticlePool(Math.max(1000, Math.round(budget * 0.6)), 'add', this.atlas);
    this.alpha = new ParticlePool(Math.max(600, Math.round(budget * 0.4)), 'alpha', this.atlas);
    this.add.time = this.alpha.time = this.time;
    // arrows left in the field / in bodies: a handful on low, a forest on ultra
    this.stuck = new StuckArrows(this.projectiles.arrow, this.projectiles.wood, Math.round(THREE.MathUtils.clamp(budget / 28, 80, 640)), budget >= 6000 ? Math.round(budget / 120) : 0);
    this.root.add(this.alpha.mesh, this.add.mesh, this.stuck.mesh);
    this.density = THREE.MathUtils.clamp(budget / 12000, 0.3, 1.25);
  }

  /** Scale a particle count by the tier's density. */
  private n(x: number): number {
    return Math.max(1, Math.round(x * this.density));
  }

  /** Tint for lit particles (dust/smoke): sun + sky light. */
  setLight(c: THREE.ColorRepresentation): void {
    this.alpha.light.set(c);
    this.add.light.set(c);
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

  /** Advance everything; true while anything is animating. Safe to call more than once per frame. */
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
    if (this.buckets.size) {
      for (const [k, b] of this.buckets) {
        if (b.due > this.time) continue;
        this.buckets.delete(k);
        this.numbers.show(b.pos, b.sum, b.style);
        if (b.style === 'crit') this.flash(b.pos.x, b.pos.y + 0.4, b.pos.z, 1.6, [6, 3.4, 0.8], 0.14);
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
    this.stuck.update(dt);
    this.debris.update(dt);
    this.ribbons.build(this.ribbonList, this.engine.camera.position);
    this.add.tick(dt);
    this.alpha.tick(dt);
    this.decals.tick(dt);
    this.numbers.tick(dt);
    this.busy =
      this.add.alive || this.alpha.alive || this.decals.alive || this.numbers.alive || this.actors.length > 0 || this.projectiles.active > 0 || this.debris.active > 0 || this.tasks.length > 0 || this.buckets.size > 0;
    return this.busy;
  }

  /**
   * The battle is over: stop the open-ended ambient emitters (fires on a damaged keep) so the
   * last particles die out and the render loop can sleep. One-shot effects finish normally.
   */
  settle(): void {
    this.epoch++;
  }

  clear(): void {
    this.epoch++;
    for (const a of this.actors) a.dispose();
    this.actors.length = 0;
    this.tasks.length = 0;
    this.buckets.clear();
    this.add.clear();
    this.alpha.clear();
    this.decals.clear();
    this.numbers.clear();
    this.projectiles.clear();
    this.stuck.clear();
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
    this.decals.dispose();
    this.stuck.dispose();
    this.numbers.dispose();
    this.ribbons.dispose();
    this.root.removeFromParent();
    this.atlas.dispose();
    this.sheet.dispose();
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
  private decal(d: DecalSpec): void {
    this.decals.spawn(d);
    if (!this.running) this.kick();
  }

  /** Camera shake that falls off with the camera's distance from the event. */
  private shake(amp: number, x: number, y: number, z: number): void {
    const c = this.engine.camera.position;
    const d = Math.hypot(c.x - x, c.y - y, c.z - z);
    const k = THREE.MathUtils.clamp(45 / (d + 12), 0.2, 1.5);
    if (amp * k > 0.01) this.engine.addShake(amp * k);
  }

  /** A star glint + soft bloom halo. */
  private flash(x: number, y: number, z: number, size: number, color: RGB, life = 0.12): void {
    this.emitA({ x, y, z, life, size, size1: size * 0.35, r: color[0], g: color[1], b: color[2], cell: CELL.star, fadeOut: 0.2 });
    this.emitA({ x, y, z, life: life * 1.7, size: size * 0.9, size1: size * 1.5, r: color[0] * 0.2, g: color[1] * 0.2, b: color[2] * 0.2, cell: CELL.dot, fadeOut: 0.1 });
  }

  private sparks(x: number, y: number, z: number, count: number, speed: number, c0: RGB = SPARK0, c1: RGB = SPARK1, up = 0.4, size = 0.07): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const e = rnd(-0.2, 1) * up + (1 - up) * rnd(-0.6, 0.6);
      const s = speed * rnd(0.4, 1);
      const ce = Math.cos(e);
      this.emitA({
        x, y, z,
        vx: Math.cos(a) * ce * s, vy: Math.sin(e) * s + speed * 0.25, vz: Math.sin(a) * ce * s,
        life: rnd(0.22, 0.55), size: size * rnd(0.6, 1.3), size1: size * 0.35, gravity: -12, drag: 2.2,
        r: c0[0], g: c0[1], b: c0[2], r1: c1[0], g1: c1[1], b1: c1[2], cell: CELL.spark, stretch: 0.05,
      });
    }
  }

  /** One billowing smoke / dust flipbook sprite (lit, soft against the ground). */
  private puff(
    x: number, y: number, z: number, size: number,
    o: { vx?: number; vy?: number; vz?: number; life?: number; grow?: number; color?: RGB; alpha?: number; delay?: number; drag?: number; gravity?: number; fadeIn?: number } = {},
  ): void {
    const c = o.color ?? DUST;
    const k = rnd(0.88, 1.08);
    this.emitB({
      x, y, z, vx: o.vx ?? 0, vy: o.vy ?? 0, vz: o.vz ?? 0,
      life: o.life ?? 1.4, size, size1: size * (o.grow ?? 1.9), gravity: o.gravity ?? 0.2, drag: o.drag ?? 1.6, spin: rnd(-0.35, 0.35),
      r: c[0] * k, g: c[1] * k, b: c[2] * k, alpha: o.alpha ?? 0.6, cell: CELL.smoke + 3, frames: FRAMES.smoke - 3,
      fadeIn: o.fadeIn ?? 0.06, fadeOut: 0.55, delay: o.delay, ground: this.ground(x, z),
    });
  }

  /** One explosion flipbook sprite: emissive fire that turns into dark smoke. */
  private boom(x: number, y: number, z: number, size: number, life: number, o: { delay?: number; vy?: number; emis?: number; grow?: number } = {}): void {
    this.emitB({
      x, y, z, vy: o.vy ?? 0.6, life, size: size * 0.75, size1: size * (o.grow ?? 1.25), drag: 0.8, spin: rnd(-0.25, 0.25),
      r: SOOT[0], g: SOOT[1], b: SOOT[2], alpha: 0.95, cell: CELL.explosion, frames: FRAMES.explosion, emis: o.emis ?? 3.6,
      fadeOut: 0.75, delay: o.delay, ground: this.ground(x, z) - size * 0.1,
    });
  }

  /** A flickering upright flame from the fire loop, based at (x, y, z). */
  private flame(x: number, y: number, z: number, size: number, life: number, o: { delay?: number; vy?: number; tint?: RGB } = {}): void {
    const c = o.tint ?? FIRE;
    this.emitA({
      x, y: y + size * 0.4, z, vy: o.vy ?? 0.25, life, size: size * 0.75, size1: size, rot: 0, spin: 0,
      r: c[0], g: c[1], b: c[2], cell: CELL.fire, frames: FRAMES.fire, fps: 15 + Math.random() * 4, fadeIn: 0.18, fadeOut: 0.6, delay: o.delay,
    });
  }

  private embers(x: number, y: number, z: number, count: number, speed: number, gravity = -6): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const s = speed * rnd(0.3, 1);
      this.emitA({
        x, y, z,
        vx: Math.cos(a) * s * 0.7, vy: rnd(0.4, 1.2) * speed, vz: Math.sin(a) * s * 0.7,
        life: rnd(0.7, 1.7), size: rnd(0.05, 0.11), size1: 0.02, gravity, drag: 1.2,
        r: EMBER0[0], g: EMBER0[1], b: EMBER0[2], r1: EMBER1[0], g1: EMBER1[1], b1: EMBER1[2], cell: CELL.dot, stretch: 0.035,
      });
    }
  }

  /** Radial ground-hugging dust ring (stones, stomps, collapses). */
  private dustRing(x: number, z: number, count: number, speed: number, size: number, life = 1.8, color: RGB = DUST, alpha = 0.6): void {
    const off = Math.random() * TAU;
    for (let i = 0; i < count; i++) {
      const a = off + (i / count) * TAU + rnd(-0.2, 0.2);
      const s = speed * rnd(0.55, 1.1);
      const px = x + Math.cos(a) * size * 0.3;
      const pz = z + Math.sin(a) * size * 0.3;
      this.puff(px, this.ground(px, pz) + size * 0.3, pz, size * 0.55, { vx: Math.cos(a) * s, vy: rnd(0.2, 1.0), vz: Math.sin(a) * s, life: life * rnd(0.75, 1.2), drag: 2.4, color, alpha, grow: 2.2 });
    }
  }

  /** A rising column of smoke puffs. */
  private smokeColumn(x: number, y: number, z: number, count: number, size: number, rise: number, life: number, color: RGB = SMOKE, alpha = 0.6, spread = 0.2): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const r = rnd(0, size * 0.4);
      this.puff(x + Math.cos(a) * r, y + size * 0.4 + rnd(0, size * 0.4), z + Math.sin(a) * r, size * rnd(0.5, 0.75), {
        vx: Math.cos(a) * rnd(0.1, 1) * spread * 4, vy: rise * rnd(0.6, 1.2), vz: Math.sin(a) * rnd(0.1, 1) * spread * 4,
        life: life * rnd(0.7, 1.2), drag: 0.7, gravity: 0.35, color, alpha, delay: rnd(0, life * 0.25), grow: 2.4, fadeIn: 0.12,
      });
    }
  }

  private debrisBurst(x: number, y: number, z: number, count: number, speed: number, size: number, color: THREE.ColorRepresentation = STONE, up = 1, stretch = 1): void {
    this.kick();
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const s = speed * rnd(0.3, 1);
      this.debris.spawn(x, y + 0.3, z, Math.cos(a) * s, rnd(0.6, 1.4) * speed * up, Math.sin(a) * s, size * rnd(0.4, 1.2), rnd(2.2, 4), color, stretch);
    }
  }

  /** A continuous spawner for `dur` seconds at `rate`/s (scaled by density). */
  private emitter(dur: number, rate: number, spawn: (count: number, t: number) => void, ambient = false): void {
    let t = 0;
    let acc = 0;
    const r = rate * this.density;
    const epoch = this.epoch;
    this.actor({
      update: (dt) => {
        t += dt;
        if (ambient && epoch !== this.epoch) return false;
        acc += r * Math.min(dt, 0.1);
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

  // ------------------------------------------------------------------ projectiles

  /**
   * Launch a projectile. If `onImpact` is given it is called on landing INSTEAD of the default
   * impact visual (so playback driven by sim 'impact' events doesn't double up); without it the
   * projectile plays `impact(kind, to, 0)` itself. `follow` (arrows / bolts): the moving body
   * the shot was aimed at, so the arrow can stay stuck in it.
   */
  projectile(kind: ProjectileKind, from: THREE.Vector3, to: THREE.Vector3, flightSec: number, arc: ArcType, onImpact?: () => void, follow?: Follow): void {
    if (kind === 'lightning') {
      this.lightning(from, to);
      const dst = to.clone();
      this.later(Math.min(flightSec, 0.05), () => (onImpact ? onImpact() : this.impact('lightning', dst, 0)));
      return;
    }
    if (kind === 'fireball') {
      this.flash(from.x, from.y, from.z, 1.1, [6, 3.2, 1], 0.12);
      this.embers(from.x, from.y, from.z, this.n(4), 2.5, -3);
    } else if (kind === 'stone') {
      this.puff(from.x, from.y, from.z, 1.2, { vy: 1.5, life: 1.1, alpha: 0.35 });
    }
    const dst = to.clone();
    this.projectiles.launch(kind, from, to, flightSec, arc, () => (onImpact ? onImpact() : this.impact(kind, dst, 0)), follow);
    this.kick();
  }

  private trail(kind: ProjectileKind, p: THREE.Vector3, d: THREE.Vector3, dt: number): void {
    const per = (rate: number) => {
      const x = rate * dt * this.density;
      return Math.floor(x) + (Math.random() < x - Math.floor(x) ? 1 : 0);
    };
    switch (kind) {
      case 'bolt':
        // a thin pressure streak behind the bolt
        for (let i = per(40); i > 0; i--)
          this.emitA({ x: p.x - d.x * 1.2, y: p.y - d.y * 1.2, z: p.z - d.z * 1.2, vx: d.x * 6, vy: d.y * 6, vz: d.z * 6, life: 0.16, size: 0.1, size1: 0.02, r: 0.9, g: 0.88, b: 0.8, alpha: 0.7, cell: CELL.spark, stretch: 0.12 });
        break;
      case 'stone':
        for (let i = per(14); i > 0; i--)
          this.puff(p.x, p.y, p.z, 0.5, { vx: rnd(-0.3, 0.3), vy: rnd(-0.2, 0.3), vz: rnd(-0.3, 0.3), life: rnd(0.6, 1.0), alpha: 0.28, grow: 2.4, drag: 1 });
        break;
      case 'fireball':
      case 'firebreath': {
        const big = kind === 'firebreath' ? 1.8 : 1;
        // heat core: white-hot centre in an orange halo (re-emitted every frame, so it tracks exactly)
        this.emitA({ x: p.x, y: p.y, z: p.z, life: 0.05, size: 0.42 * big, r: 8, g: 6, b: 3.5, cell: CELL.dot, fadeOut: 0.9 });
        this.emitA({ x: p.x, y: p.y, z: p.z, life: 0.07, size: 1.1 * big, r: 1.3, g: 0.5, b: 0.1, cell: CELL.dot, fadeOut: 0.9 });
        // licking flames shed behind
        for (let i = per(48); i > 0; i--) {
          const k = Math.random();
          this.emitA({
            x: p.x - d.x * k * 0.5 + rnd(-0.07, 0.07), y: p.y - d.y * k * 0.5 + rnd(-0.07, 0.07), z: p.z - d.z * k * 0.5 + rnd(-0.07, 0.07),
            vx: d.x * 3 + rnd(-0.5, 0.5), vy: d.y * 3 + rnd(0, 0.8), vz: d.z * 3 + rnd(-0.5, 0.5),
            life: rnd(0.2, 0.36), size: 0.55 * big, size1: 0.12, gravity: 1.5, drag: 2.5, spin: rnd(-4, 4),
            r: 2.1, g: 1.8, b: 1.5, r1: 1.4, g1: 0.6, b1: 0.3, cell: CELL.explosion + 4 + Math.floor(Math.random() * 5),
          });
        }
        for (let i = per(26); i > 0; i--) this.embers(p.x, p.y, p.z, 1, 1.6, -3);
        for (let i = per(12); i > 0; i--) this.puff(p.x, p.y, p.z, 0.3 * big, { vy: 0.5, life: rnd(0.7, 1.0), alpha: 0.3, color: SOOT, grow: 2.2, delay: 0.1, drag: 1 });
        break;
      }
      default:
        break;
    }
  }

  /** A projectile reached the end of its flight: arrows and bolts stay where they struck. */
  private land(kind: ProjectileKind, p: THREE.Vector3, d: THREE.Vector3, follow?: Follow): void {
    if (kind !== 'arrow' && kind !== 'tower_arrow' && kind !== 'bolt') return;
    const scale = kind === 'bolt' ? 1.9 : 1;
    const gy = this.ground(p.x, p.z);
    if (follow && follow() && Math.random() < 0.7) {
      this.stuck.add(p, d, scale, kind === 'bolt' ? 4 : 7, follow);
      return;
    }
    if (p.y - gy > 3.5) return; // struck something tall (a keep wall): no ground arrow
    // carry on to the ground along the flight line, biting in at a believable angle
    const dir = this.tmp.copy(d);
    if (dir.y > -0.45) dir.y = -0.45 - Math.random() * 0.4;
    dir.normalize();
    const t = Math.max(0, (p.y - gy) / -dir.y);
    const tip = this.tmp2.set(p.x + dir.x * t, 0, p.z + dir.z * t);
    tip.y = this.ground(tip.x, tip.z) - 0.05;
    this.stuck.add(tip, dir, scale, kind === 'bolt' ? 20 : rnd(11, 17));
    if (Math.random() < this.density) this.puff(tip.x, tip.y + 0.1, tip.z, 0.3 * scale, { vy: 0.5, life: 0.6, alpha: 0.35, grow: 2.6 });
  }

  /** Landing visual for a projectile kind (or a sim 'impact' event). */
  impact(kind: ProjectileKind, pos: THREE.Vector3, splashMetres: number): void {
    const { x, z } = pos;
    const gy = this.ground(x, z);
    const onGround = pos.y - gy < 0.6;
    switch (kind) {
      case 'arrow':
      case 'tower_arrow':
        // arrows thud, they don't flash: a chip of dust, the odd glint off armour
        if (onGround) {
          if (Math.random() < this.density) this.puff(x, gy + 0.1, z, 0.32, { vy: 0.5, life: 0.6, alpha: 0.35, grow: 2.6 });
        } else if (Math.random() < 0.35) this.sparks(x, pos.y, z, 2, 2.5, SPARK0, SPARK1, 0.6, 0.035);
        break;
      case 'bolt':
        this.sparks(x, pos.y, z, this.n(8), 5.5);
        this.debrisBurst(x, pos.y, z, this.n(7), 4.5, 0.07, WOOD, 0.8, 5);
        this.debrisBurst(x, gy, z, this.n(4), 3.5, 0.12, EARTH);
        this.dustRing(x, z, this.n(7), 3.2, 0.9, 1.1, DUST, 0.5);
        this.puff(x, gy + 0.4, z, 1.1, { vy: 1.6, life: 1.2, alpha: 0.5 });
        this.decal({ kind: DK.scuff, x, z, radius: 1.3, life: 16, r: 0, g: 0, b: 0, alpha: 0.7, fadeIn: 0.15 });
        this.shake(0.07, x, gy, z);
        break;
      case 'stone': {
        const r = Math.max(3, splashMetres || 6);
        // the ground heaves: a dirt fountain, a rolling dust ring, flying rock and clods
        for (let i = 0; i < this.n(7); i++) {
          const a = Math.random() * TAU;
          this.puff(x + Math.cos(a) * 0.5, gy + 0.6, z + Math.sin(a) * 0.5, r * 0.6, { vx: Math.cos(a) * 1.4, vy: rnd(4, 9), vz: Math.sin(a) * 1.4, life: rnd(1.3, 1.9), drag: 2.2, gravity: -2.5, color: DIRT, alpha: 0.75, grow: 2.3 });
        }
        this.dustRing(x, z, this.n(20), r * 1.3, r * 0.7, 2.2);
        this.smokeColumn(x, gy, z, this.n(5), r * 0.4, 1.6, 2.2, DUST, 0.45);
        this.debrisBurst(x, gy, z, this.n(14), 8, 0.3);
        this.debrisBurst(x, gy, z, this.n(12), 6, 0.2, EARTH, 1.3);
        this.decal({ kind: DK.shock, x, z, radius: r * 1.25, life: 0.5, r: 0.4, g: 0.34, b: 0.27 });
        this.decal({ kind: DK.mark, cell: DECAL.cracks, x, z, radius: r * 0.62, life: 28, r: 0, g: 0, b: 0, alpha: 0.85, fadeIn: 0.08 });
        this.decal({ kind: DK.scuff, x, z, radius: r * 0.75, life: 28, r: 0, g: 0, b: 0, alpha: 0.6, fadeIn: 0.1 });
        this.shake(0.3, x, gy, z);
        break;
      }
      case 'fireball':
      case 'firebreath':
        this.fireBlast(x, Math.max(pos.y, gy + 0.3), z, Math.max(1.5, splashMetres || 3));
        break;
      case 'lightning':
        this.flash(x, pos.y, z, 1.3, [4, 5, 12], 0.1);
        this.sparks(x, pos.y, z, this.n(10), 5, [4, 6, 12], [0.6, 1, 4], 0.6, 0.05);
        if (onGround) this.decal({ kind: DK.mark, cell: DECAL.scorch, x, z, radius: 1.1, life: 12, r: 1, g: 2, b: 6, alpha: 0.6 });
        break;
    }
  }

  /** A fireball burst of radius `r`: flash, flipbook fire, embers, smoke, scorch. */
  private fireBlast(x: number, y: number, z: number, r: number): void {
    const gy = this.ground(x, z);
    this.flash(x, y, z, r * 0.7, [5, 3, 1.2], 0.1);
    this.boom(x, gy + r * 0.42, z, r * 1.45, rnd(0.85, 1.0));
    for (let i = 0; i < this.n(3); i++) {
      const a = Math.random() * TAU;
      this.boom(x + Math.cos(a) * r * 0.35, gy + r * rnd(0.25, 0.5), z + Math.sin(a) * r * 0.35, r * rnd(0.7, 0.95), rnd(0.7, 0.95), { delay: rnd(0.02, 0.1), vy: 1.2 });
    }
    this.embers(x, y, z, this.n(16), 5.5, -7);
    this.sparks(x, y, z, this.n(8), 7, [9, 5, 1.6], [3, 0.6, 0.1], 0.6, 0.06);
    this.smokeColumn(x, gy, z, this.n(4), r * 0.55, 1.8, 2.0, SMOKE, 0.5);
    this.decal({ kind: DK.glow, x, z, radius: r * 1.5, life: 0.8, r: 0.6, g: 0.2, b: 0.04 });
    this.decal({ kind: DK.shock, x, z, radius: r * 1.35, life: 0.32, r: 1.2, g: 0.55, b: 0.16 });
    this.decal({ kind: DK.mark, cell: DECAL.scorch, x, z, radius: r * 0.95, life: 22, r: 6, g: 1.6, b: 0.25, alpha: 0.9, fadeIn: 0.1 });
    this.shake(0.06 + r * 0.02, x, gy, z);
  }

  // ------------------------------------------------------------------ hits

  /** Melee contact: sparks off steel and a kick of dust at the feet. */
  hitSpark(pos: THREE.Vector3, opts: { crit?: boolean; magic?: boolean; color?: THREE.ColorRepresentation } = {}): void {
    const crit = !!opts.crit;
    const { x, y, z } = pos;
    let c0: RGB = opts.magic ? MAGIC : SPARK0;
    if (opts.color !== undefined) {
      const c = new THREE.Color(opts.color);
      c0 = [c.r * 6, c.g * 6, c.b * 6];
    }
    const c1: RGB = opts.magic || opts.color !== undefined ? mul(c0, 0.25) : SPARK1;
    this.flash(x, y, z, crit ? 1.5 : 0.7, opts.magic ? [3, 4, 10] : opts.color !== undefined ? c0 : WHITE_HOT, crit ? 0.16 : 0.1);
    this.sparks(x, y, z, this.n(crit ? 16 : 6), crit ? 8 : 5, c0, c1, 0.45, crit ? 0.13 : 0.09);
    if (crit) {
      // a second, slower shower and a hard glint
      this.sparks(x, y, z, this.n(8), 4, c0, c1, 0.8, 0.08);
      this.emitA({ x, y, z, life: 0.2, size: 2.6, size1: 0.6, r: c0[0] * 0.5, g: c0[1] * 0.5, b: c0[2] * 0.5, cell: CELL.star, rot: 0.6, fadeOut: 0.2 });
      this.shake(0.04, x, y, z);
    }
    if (crit || Math.random() < 0.5 * this.density) {
      const gy = this.ground(x, z);
      this.puff(x + rnd(-0.3, 0.3), gy + 0.15, z + rnd(-0.3, 0.3), crit ? 0.7 : 0.45, { vx: rnd(-0.6, 0.6), vy: rnd(0.4, 0.9), vz: rnd(-0.6, 0.6), life: rnd(0.7, 1.1), alpha: 0.4, grow: 2.4 });
    }
  }

  /** A soldier fell: a puff of dust and a dark scuff where he lies. */
  death(pos: THREE.Vector3, size = 1): void {
    const { x, z } = pos;
    const gy = this.ground(x, z);
    const n = size > 1.5 ? this.n(5) : Math.random() < this.density + 0.3 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      this.puff(x + Math.cos(a) * 0.3 * size, gy + 0.2, z + Math.sin(a) * 0.3 * size, 0.55 * size, { vx: Math.cos(a) * 0.9, vy: rnd(0.3, 0.8), vz: Math.sin(a) * 0.9, life: rnd(1.0, 1.5), alpha: 0.45, grow: 2.3, delay: 0.25 });
    }
    this.decal({ kind: DK.scuff, x, z, radius: 0.85 * size, life: 30, r: 0, g: 0, b: 0, alpha: 0.5, fadeIn: 0.6, delay: 0.3 });
    if (size > 1.5) this.shake(0.08, x, gy, z);
  }

  /** Cleric heal: a sigil unfurls on the ground and soft motes of light drift up. */
  heal(pos: THREE.Vector3, strength = 1): void {
    const { x, z } = pos;
    const gy = this.ground(x, z);
    const rad = 1.25 + 0.35 * strength;
    this.decal({ kind: DK.sigil, cell: DECAL.heal, x, z, radius: rad, life: 1.5, r: HEAL[0] * 0.3, g: HEAL[1] * 0.3, b: HEAL[2] * 0.3, fadeIn: 0.3, grow: 0.5, spin: 0.7 });
    this.decal({ kind: DK.glow, x, z, radius: rad * 1.3, life: 1.3, r: 0.3, g: 0.75, b: 0.28, fadeIn: 0.25 });
    const n = this.n(12 * strength);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * rad * 0.8;
      // motes: slow, soft, slightly swaying
      this.emitA({
        x: x + Math.cos(a) * r, y: gy + rnd(0.05, 0.8), z: z + Math.sin(a) * r,
        vx: rnd(-0.25, 0.25), vy: rnd(0.7, 1.5), vz: rnd(-0.25, 0.25), life: rnd(1.1, 1.8), size: rnd(0.12, 0.26), size1: 0.04, gravity: 0.25, drag: 0.5,
        r: HEAL[0], g: HEAL[1], b: HEAL[2], r1: 3.2, g1: 3.6, b1: 1.4, cell: CELL.dot, fadeIn: 0.25, fadeOut: 0.4, delay: rnd(0, 0.45),
      });
    }
    for (let i = 0; i < this.n(3); i++)
      this.emitA({ x: x + rnd(-0.5, 0.5), y: gy + rnd(0.8, 1.9), z: z + rnd(-0.5, 0.5), life: rnd(0.35, 0.6), size: 0.1, size1: 0.5, r: 3, g: 5, b: 2.4, cell: CELL.star, fadeIn: 0.3, delay: rnd(0.1, 0.7), spin: 1.5 });
    // a soft shaft of light over the patient
    this.emitA({ x, y: gy + 1.1, z, life: 0.9, size: 1.9, size1: 2.5, r: 0.5, g: 1.1, b: 0.4, cell: CELL.dot, fadeIn: 0.3, fadeOut: 0.3 });
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
        const dir = new THREE.Vector3().subVectors(b, a).normalize().add(new THREE.Vector3(rnd(-1, 1), rnd(-0.6, 0.8), rnd(-1, 1))).normalize();
        paths.push(jagged(s, s.clone().addScaledVector(dir, len), 8, 0.22));
      }
    };
    make();
    this.flash(a.x, a.y, a.z, 0.9, [4, 5, 12], 0.12);
    this.flash(b.x, b.y, b.z, 1.4, [5, 6, 14], 0.15);
    this.sparks(b.x, b.y, b.z, this.n(10), 5, [4, 6, 12], [0.6, 1, 4], 0.5, 0.05);
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

  /** A patch of fire burning on the ground / on a unit for `durSec`. */
  burn(pos: THREE.Vector3, durSec: number, size = 1): void {
    const p = pos.clone();
    const gy = this.ground(p.x, p.z);
    this.decal({ kind: DK.glow, x: p.x, z: p.z, radius: 1.6 * size, life: durSec + 0.4, r: 0.8, g: 0.27, b: 0.05, fadeIn: 0.3 });
    this.emitter(durSec, 7, (k) => {
      for (let i = 0; i < k; i++) {
        const a = Math.random() * TAU;
        const r = rnd(0, 0.4) * size;
        this.flame(p.x + Math.cos(a) * r, gy, p.z + Math.sin(a) * r, rnd(1.0, 1.6) * size, rnd(0.5, 0.8));
        if (Math.random() < 0.6) this.embers(p.x, gy + 0.5 * size, p.z, 1, 1.4, 0.5);
        if (Math.random() < 0.3) this.puff(p.x, gy + 1.2 * size, p.z, 0.5 * size, { vy: 1.3, life: 1.4, alpha: 0.4, color: SMOKE, grow: 2.6, drag: 0.5 });
      }
    });
  }

  frost(pos: THREE.Vector3, durSec: number): void {
    const p = pos.clone();
    const gy = this.ground(p.x, p.z);
    const dur = Math.max(0.6, durSec);
    this.flash(p.x, gy + 1, p.z, 1.1, FROST, 0.15);
    this.decal({ kind: DK.sigil, cell: DECAL.frost, x: p.x, z: p.z, radius: 1.7, life: dur, r: FROST[0] * 0.28, g: FROST[1] * 0.28, b: FROST[2] * 0.28, fadeIn: 0.18, grow: 0.25 });
    for (let i = 0; i < this.n(6); i++) {
      const a = Math.random() * TAU;
      this.puff(p.x + Math.cos(a) * 0.3, gy + 0.2, p.z + Math.sin(a) * 0.3, 0.6, { vx: Math.cos(a) * 1.6, vy: 0.3, vz: Math.sin(a) * 1.6, life: 1.1, alpha: 0.3, color: [0.75, 0.85, 0.95], grow: 2.4, drag: 2.5 });
    }
    this.emitter(dur, 12, (k) => {
      for (let i = 0; i < k; i++) {
        const a = Math.random() * TAU;
        const r = rnd(0.1, 0.8);
        this.emitA({
          x: p.x + Math.cos(a) * r, y: gy + rnd(0.1, 1.8), z: p.z + Math.sin(a) * r,
          vx: rnd(-0.1, 0.1), vy: rnd(-0.5, 0.05), vz: rnd(-0.1, 0.1), life: rnd(0.5, 0.9), size: rnd(0.1, 0.22), size1: 0.03, spin: rnd(-3, 3),
          r: FROST[0], g: FROST[1], b: FROST[2], cell: CELL.star, fadeIn: 0.3,
        });
      }
    });
  }

  // ------------------------------------------------------------------ lord abilities

  /** Archmage: a burning rock falls out of the sky onto a marked circle. */
  meteor(pos: THREE.Vector3, radiusM: number): void {
    const target = pos.clone();
    target.y = this.ground(target.x, target.z);
    const start = target.clone().add(new THREE.Vector3(-16, 52, 12));
    const fall = 1.15;
    this.decal({ kind: DK.warn, x: target.x, z: target.z, radius: radiusM, life: fall, r: 5, g: 1.3, b: 0.2, rot: 0 });
    this.decal({ kind: DK.sigil, cell: DECAL.arcane, x: target.x, z: target.z, radius: radiusM * 0.8, life: fall + 0.1, r: 3.2, g: 0.9, b: 0.15, fadeIn: 0.35, grow: 0.4, spin: 1.2, alpha: 0.7 });
    const cur = new THREE.Vector3();
    const prev = start.clone();
    const dir = new THREE.Vector3().subVectors(target, start).normalize();
    let t = 0;
    this.actor({
      update: (dt) => {
        t += dt;
        const s = Math.min(1, Math.pow(t / fall, 1.7));
        cur.lerpVectors(start, target, s);
        const dist = cur.distanceTo(prev);
        const steps = Math.max(1, Math.min(8, Math.ceil(dist / 1.1)));
        // the rock: white-hot head in a wide halo
        this.emitA({ x: cur.x, y: cur.y, z: cur.z, life: 0.05, size: 2.2, r: 10, g: 7.5, b: 4.5, cell: CELL.dot, fadeOut: 0.9 });
        this.emitA({ x: cur.x, y: cur.y, z: cur.z, life: 0.08, size: 6.5, r: 2.4, g: 0.9, b: 0.2, cell: CELL.dot, fadeOut: 0.9 });
        for (let i = 0; i < steps; i++) {
          const q = this.tmp2.lerpVectors(prev, cur, (i + 1) / steps);
          // burning wake, then a thick smoke trail hanging in the sky
          if (Math.random() < this.density + 0.4)
            this.emitA({
              x: q.x + rnd(-0.4, 0.4), y: q.y + rnd(-0.4, 0.4), z: q.z + rnd(-0.4, 0.4), vx: dir.x * 9, vy: dir.y * 9, vz: dir.z * 9,
              life: rnd(0.35, 0.6), size: rnd(2.2, 3.0), size1: 0.8, drag: 2.5, spin: rnd(-3, 3),
              r: FIRE[0], g: FIRE[1], b: FIRE[2], r1: 3, g1: 1, b1: 0.4, cell: CELL.explosion + 5 + Math.floor(Math.random() * 5),
            });
          if (Math.random() < this.density * 0.9) this.puff(q.x, q.y, q.z, 1.6, { vx: rnd(-0.4, 0.4), vy: rnd(0, 0.8), vz: rnd(-0.4, 0.4), life: rnd(1.6, 2.4), alpha: 0.5, color: SOOT, grow: 2.6, delay: 0.12, drag: 0.8 });
          if (Math.random() < 0.6) this.embers(q.x, q.y, q.z, 1, 3, -4);
        }
        prev.copy(cur);
        if (s >= 1) {
          this.meteorBlast(target, radiusM);
          return false;
        }
        return true;
      },
      dispose: () => {},
    });
  }

  private meteorBlast(p: THREE.Vector3, r: number): void {
    const { x, y, z } = p;
    this.shake(0.9, x, y, z);
    this.engine.addFlash(0.1);
    this.flash(x, y + 1.5, z, r * 1.3, [10, 6, 2.5], 0.18);
    // the fireball: one big flipbook burst, a ring of smaller ones rolling outward, a rising cap
    this.boom(x, y + r * 0.3, z, r * 1.35, 1.25, { vy: 1.5 });
    const ring = this.n(7);
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * TAU + rnd(-0.3, 0.3);
      const d = r * rnd(0.3, 0.6);
      this.boom(x + Math.cos(a) * d, y + r * rnd(0.12, 0.25), z + Math.sin(a) * d, r * rnd(0.5, 0.75), rnd(0.9, 1.2), { delay: rnd(0.03, 0.16), vy: 2 });
    }
    this.boom(x, y + r * 0.7, z, r * 0.9, 1.5, { delay: 0.12, vy: 5.5, grow: 1.6 });
    this.embers(x, y + 0.5, z, this.n(60), 13, -9);
    this.sparks(x, y + 1, z, this.n(26), 15, SPARK0, SPARK1, 0.7, 0.12);
    this.debrisBurst(x, y, z, this.n(30), 12, 0.5, '#4d453c');
    this.debrisBurst(x, y, z, this.n(16), 9, 0.3, EARTH, 1.3);
    this.dustRing(x, z, this.n(22), r * 1.7, Math.min(3.2, r * 0.3), 2.2, [0.42, 0.36, 0.3], 0.55);
    this.smokeColumn(x, y + r * 0.2, z, this.n(10), r * 0.4, 4.5, 3.4, SOOT, 0.7);
    this.decal({ kind: DK.shock, x, z, radius: r * 1.8, life: 0.6, r: 1.8, g: 0.85, b: 0.25 });
    this.decal({ kind: DK.shock, x, z, radius: r * 2.8, life: 0.95, r: 0.7, g: 0.55, b: 0.4, delay: 0.1 });
    this.decal({ kind: DK.glow, x, z, radius: r * 1.2, life: 2.6, r: 1.1, g: 0.36, b: 0.06 });
    this.decal({ kind: DK.mark, cell: DECAL.scorch, x, z, radius: r * 1.05, life: 40, r: 7, g: 1.8, b: 0.25, alpha: 0.95, fadeIn: 0.1 });
    this.decal({ kind: DK.mark, cell: DECAL.cracks, x, z, radius: r * 0.6, life: 40, r: 9, g: 2.6, b: 0.4, alpha: 0.9, fadeIn: 0.1 });
    // lingering fires in the crater
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * TAU;
      const d = rnd(0.15, 0.7) * r;
      this.later(rnd(0.3, 0.7), () => this.burn(new THREE.Vector3(x + Math.cos(a) * d, y, z + Math.sin(a) * d), rnd(2.2, 3.6), rnd(0.9, 1.5)));
    }
  }

  /** Marshal: a golden heraldic circle, a pillar of light and rising streaks over the aura. */
  rally(pos: THREE.Vector3, radiusM: number, durSec: number, follow?: () => THREE.Vector3): void {
    const c = pos.clone();
    const aura = new GroundDecal('sigil', mul(GOLD, 0.3), radiusM, this.ground);
    aura.setSheet(this.sheet, DECAL.rally);
    aura.progress = 0.3;
    aura.place(c.x, c.z, radiusM);
    this.root.add(aura.mesh);
    const gy = this.ground(c.x, c.z);
    this.decal({ kind: DK.shock, x: c.x, z: c.z, radius: radiusM * 1.15, life: 0.7, r: GOLD[0], g: GOLD[1], b: GOLD[2] });
    this.decal({ kind: DK.shock, x: c.x, z: c.z, radius: radiusM * 0.6, life: 0.5, r: GOLD[0], g: GOLD[1], b: GOLD[2], delay: 0.15 });
    this.flash(c.x, gy + 2.2, c.z, 4.5, GOLD, 0.22);
    const beam = new Pillar(mul(GOLD, 0.9), 0.9, 18, 1);
    beam.mesh.position.set(c.x, gy, c.z);
    this.root.add(beam.mesh);
    // a burst of banners of light racing outward along the ground
    for (let i = 0; i < this.n(26); i++) {
      const a = (i / this.n(26)) * TAU;
      this.emitA({
        x: c.x, y: gy + 0.4, z: c.z, vx: Math.cos(a) * radiusM * 1.6, vy: 1.2, vz: Math.sin(a) * radiusM * 1.6, life: 0.7, size: 0.22, size1: 0.05, drag: 1.6,
        r: GOLD[0] * 1.4, g: GOLD[1] * 1.4, b: GOLD[2] * 1.4, cell: CELL.spark, stretch: 0.12,
      });
    }
    let t = 0;
    let acc = 0;
    this.actor({
      update: (dt, time) => {
        t += dt;
        if (follow) c.copy(follow());
        aura.place(c.x, c.z, radiusM);
        aura.time = time;
        const fin = Math.min(1, t / 0.35);
        const fout = Math.min(1, (durSec - t) / 0.6);
        aura.alpha = Math.max(0, Math.min(fin, fout));
        const bk = Math.max(0, 1 - t / 1.1);
        beam.material.uniforms.uAlpha.value = bk * bk;
        beam.material.uniforms.uTime.value = time;
        beam.mesh.position.set(c.x, this.ground(c.x, c.z), c.z);
        acc += Math.min(dt, 0.1) * 26 * this.density;
        while (acc >= 1) {
          acc -= 1;
          const a = Math.random() * TAU;
          const r = Math.sqrt(Math.random()) * radiusM;
          const x = c.x + Math.cos(a) * r;
          const z = c.z + Math.sin(a) * r;
          this.emitA({
            x, y: this.ground(x, z) + 0.1, z, vy: rnd(2.2, 3.8), life: rnd(0.7, 1.2), size: rnd(0.12, 0.2), size1: 0.04, drag: 0.4,
            r: GOLD[0] * 1.4, g: GOLD[1] * 1.4, b: GOLD[2] * 1.4, r1: 3, g1: 1.6, b1: 0.4, cell: CELL.spark, stretch: 0.3, fadeIn: 0.2,
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

  /** Warden: a hex-plated dome over an arcane ward ring. */
  bulwark(pos: THREE.Vector3, radiusM: number, durSec: number, follow?: () => THREE.Vector3): void {
    const c = pos.clone();
    const dome = new Dome([1.0, 1.9, 4.6]);
    const ring = new GroundDecal('sigil', [0.35, 0.7, 1.9], radiusM, this.ground);
    ring.setSheet(this.sheet, DECAL.arcane);
    ring.progress = 0.45;
    this.root.add(dome.mesh, ring.mesh);
    const place = () => {
      const gy = this.ground(c.x, c.z);
      dome.mesh.position.set(c.x, gy - 0.2, c.z);
      dome.mesh.scale.set(radiusM, radiusM * 0.72, radiusM);
      ring.place(c.x, c.z, radiusM);
      return gy;
    };
    const gy = place();
    this.decal({ kind: DK.shock, x: c.x, z: c.z, radius: radiusM * 1.2, life: 0.55, r: 1.6, g: 3, b: 7 });
    this.flash(c.x, gy + 1.5, c.z, 3.5, [2, 3.5, 8], 0.18);
    this.shake(0.1, c.x, gy, c.z);
    // shimmer raining down the shell as it forms
    for (let i = 0; i < this.n(46); i++) {
      const a = Math.random() * TAU;
      const e = Math.random() * Math.PI * 0.5;
      const nx = Math.cos(a) * Math.cos(e);
      const ny = Math.sin(e);
      const nz = Math.sin(a) * Math.cos(e);
      this.emitA({
        x: c.x + nx * radiusM, y: gy + ny * radiusM * 0.72, z: c.z + nz * radiusM, vx: nx * 0.4, vy: -1.5 * ny, vz: nz * 0.4,
        life: rnd(0.5, 0.9), size: rnd(0.15, 0.3), size1: 0.03, r: 2, g: 3.5, b: 8, cell: CELL.star, delay: rnd(0, 0.35),
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
        ring.alpha = a * 0.9;
        ring.time = time;
        return t < durSec;
      },
      dispose: () => {
        dome.dispose();
        ring.dispose();
      },
    });
  }

  /** Skylady: a streak of sky-light dives from above and bursts in a ring of wind and dust. */
  skyfall(from: THREE.Vector3, to: THREE.Vector3): void {
    const a = from.clone();
    const b = to.clone();
    const dive = 0.34;
    const head = new THREE.Vector3();
    const tail = new THREE.Vector3();
    const core = new THREE.Color(7, 8, 10);
    const glow = new THREE.Color(SKY[0] * 0.6, SKY[1] * 0.6, SKY[2] * 0.6);
    const pts: THREE.Vector3[] = Array.from({ length: 12 }, () => new THREE.Vector3());
    const widths = pts.map((_, i) => 0.1 + (i / 11) * 0.8);
    const glowW = widths.map((w) => w * 3.4);
    const gyb = this.ground(b.x, b.z);
    this.decal({ kind: DK.warn, x: b.x, z: b.z, radius: 4, life: dive, r: 1.5, g: 2.6, b: 5, rot: 0 });
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
          for (let i = 0; i < 2; i++)
            this.emitA({ x: head.x, y: head.y, z: head.z, vx: rnd(-2, 2), vy: rnd(-1, 2), vz: rnd(-2, 2), life: 0.5, size: 0.3, size1: 0.02, r: SKY[0], g: SKY[1], b: SKY[2], cell: CELL.star });
        }
        if (!hit && sh >= 1) {
          hit = true;
          const { x, z } = b;
          this.shake(0.4, x, gyb, z);
          this.engine.addFlash(0.04);
          this.flash(x, gyb + 1, z, 5.5, [7, 8.5, 12], 0.18);
          this.sparks(x, gyb + 0.5, z, this.n(28), 11, [5, 7, 12], [0.8, 1.5, 4], 0.6, 0.09);
          // feathers of light thrown up and out
          for (let i = 0; i < this.n(14); i++) {
            const an = Math.random() * TAU;
            this.emitA({
              x, y: gyb + 0.5, z, vx: Math.cos(an) * rnd(3, 7), vy: rnd(4, 9), vz: Math.sin(an) * rnd(3, 7), life: rnd(0.8, 1.3), size: 0.28, size1: 0.06, gravity: -7, drag: 1.6, spin: rnd(-6, 6),
              r: 4, g: 5.5, b: 9, r1: 1.5, g1: 2.5, b1: 6, cell: CELL.star,
            });
          }
          this.dustRing(x, z, this.n(16), 7.5, 1.9, 1.6);
          this.debrisBurst(x, gyb, z, this.n(10), 6, 0.25);
          this.decal({ kind: DK.shock, x, z, radius: 7, life: 0.5, r: 1.0, g: 1.5, b: 2.8 });
          this.decal({ kind: DK.shock, x, z, radius: 11, life: 0.8, r: 0.5, g: 0.75, b: 1.3, delay: 0.08 });
          this.decal({ kind: DK.glow, x, z, radius: 5, life: 0.8, r: 0.22, g: 0.4, b: 0.9 });
          this.decal({ kind: DK.mark, cell: DECAL.cracks, x, z, radius: 3.2, life: 26, r: 1.5, g: 3, b: 8, alpha: 0.85, fadeIn: 0.08 });
        }
        return !hit || t < dive + 0.3;
      },
      dispose: () => {},
    });
  }

  /** Dragon breath: a roaring cone of fire that scorches the ground it sweeps. */
  breath(origin: THREE.Vector3, dir: THREE.Vector3, lengthM: number, halfAngleRad: number, durSec: number): void {
    const o = origin.clone();
    const d = dir.clone().normalize();
    const u = new THREE.Vector3().crossVectors(d, Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(d, u).normalize();
    const lifeP = 0.6;
    const speed = lengthM / (lifeP * 0.72);
    // where the cone meets the ground (for the scorch trail)
    const hx = d.x;
    const hz = d.z;
    const hl = Math.hypot(hx, hz) || 1;
    let t = 0;
    let acc = 0;
    let scorchAt = 0.15;
    let scorched = 0;
    const rate = 85 * this.density;
    const epoch = this.epoch;
    this.shake(0.12, o.x, o.y, o.z);
    this.actor({
      update: (dt) => {
        t += dt;
        if (epoch !== this.epoch) return false;
        const on = t < durSec;
        if (!on) return t < durSec + 0.2;
        acc += rate * Math.min(dt, 0.1);
        // the furnace at the jaws
        this.emitA({ x: o.x, y: o.y, z: o.z, life: 0.06, size: 0.9, r: 7, g: 4.5, b: 2, cell: CELL.dot, fadeOut: 0.9 });
        this.emitA({ x: o.x + d.x * 1.5, y: o.y + d.y * 1.5, z: o.z + d.z * 1.5, life: 0.08, size: 3, r: 0.9, g: 0.33, b: 0.07, cell: CELL.dot, fadeOut: 0.9 });
        while (acc >= 1) {
          acc -= 1;
          const ang = halfAngleRad * Math.sqrt(Math.random());
          const az = Math.random() * TAU;
          const sa = Math.sin(ang);
          const ca = Math.cos(ang);
          const dx = d.x * ca + (u.x * Math.cos(az) + v.x * Math.sin(az)) * sa;
          const dy = d.y * ca + (u.y * Math.cos(az) + v.y * Math.sin(az)) * sa;
          const dz = d.z * ca + (u.z * Math.cos(az) + v.z * Math.sin(az)) * sa;
          const s = speed * rnd(0.7, 1.1);
          const k = Math.random();
          if (k < 0.1)
            this.puff(o.x + dx * lengthM * 0.5, o.y + dy * lengthM * 0.5, o.z + dz * lengthM * 0.5, lengthM * 0.1, { vx: dx * s * 0.3, vy: 1.6, vz: dz * s * 0.3, life: 1.5, alpha: 0.45, color: SOOT, grow: 2.6, delay: 0.3, drag: 1 });
          else
            // flame gouts: explosion frames thrown down the cone; fire glows, soot occludes
            this.emitB({
              x: o.x, y: o.y, z: o.z, vx: dx * s, vy: dy * s, vz: dz * s, life: lifeP * rnd(0.9, 1.3), size: 0.5, size1: 1.1 + lengthM * 0.1, gravity: 2.5, drag: 0.75, spin: rnd(-1.5, 1.5),
              r: SOOT[0], g: SOOT[1], b: SOOT[2], alpha: 0.8, cell: CELL.explosion + 3, frames: 13, emis: 3.4, fadeOut: 0.6,
            });
        }
        if (Math.random() < 0.8 * this.density) {
          const q = rnd(0.3, 1) * lengthM;
          this.embers(o.x + d.x * q, o.y + d.y * q, o.z + d.z * q, 1, 3, -3);
        }
        // scorch + small fires along the swept ground
        if (t >= scorchAt && scorched < 7) {
          scorchAt += 0.16;
          const q = lengthM * (0.3 + 0.1 * scorched + rnd(-0.03, 0.03));
          const side = rnd(-1, 1) * Math.tan(halfAngleRad) * q * 0.6;
          const sx = o.x + d.x * q + (-hz / hl) * side;
          const sz = o.z + d.z * q + (hx / hl) * side;
          scorched++;
          this.decal({ kind: DK.mark, cell: DECAL.scorch, x: sx, z: sz, radius: rnd(1.6, 2.4), life: 24, r: 6, g: 1.6, b: 0.25, alpha: 0.85, fadeIn: 0.25 });
          this.decal({ kind: DK.glow, x: sx, z: sz, radius: 3.5, life: 1.2, r: 0.7, g: 0.22, b: 0.04, fadeIn: 0.15 });
          if (scorched % 2 === 0) this.burn(new THREE.Vector3(sx, 0, sz), rnd(1.5, 2.5), rnd(0.7, 1.1));
        }
        return true;
      },
      dispose: () => {},
    });
  }

  /** A heavy footfall / ground slam. */
  stomp(pos: THREE.Vector3, radiusM: number): void {
    const { x, z } = pos;
    const gy = this.ground(x, z);
    this.shake(0.3, x, gy, z);
    this.dustRing(x, z, this.n(18), radiusM * 1.6, radiusM * 0.4, 1.7);
    this.debrisBurst(x, gy, z, this.n(10), 5, 0.22);
    this.debrisBurst(x, gy, z, this.n(8), 4.5, 0.16, EARTH, 1.2);
    this.decal({ kind: DK.shock, x, z, radius: radiusM * 1.25, life: 0.55, r: 2.2, g: 1.9, b: 1.5 });
    this.decal({ kind: DK.mark, cell: DECAL.cracks, x, z, radius: radiusM * 0.7, life: 22, r: 0, g: 0, b: 0, alpha: 0.8, fadeIn: 0.08 });
  }

  /** Dust kicked up by marching / charging feet. */
  marchDust(pos: THREE.Vector3, amount = 1): void {
    const k = Math.random() < this.density ? Math.max(1, Math.round(amount)) : 0;
    if (!k) return;
    const gy = this.ground(pos.x, pos.z);
    for (let i = 0; i < k; i++)
      this.puff(pos.x + rnd(-0.3, 0.3), gy + 0.15, pos.z + rnd(-0.3, 0.3), 0.42, { vx: rnd(-0.3, 0.3), vy: rnd(0.15, 0.45), vz: rnd(-0.3, 0.3), life: rnd(1.1, 1.8), alpha: 0.26, grow: 2.8, fadeIn: 0.2 });
  }

  // ------------------------------------------------------------------ keeps

  /** A blow on the keep wall: chips of stone, mortar dust, sparks. */
  keepHit(pos: THREE.Vector3, big = false): void {
    const k = big ? 2 : 1;
    const { x, y, z } = pos;
    this.flash(x, y, z, 0.9 * k, [4, 3.4, 2.6], 0.09);
    this.sparks(x, y, z, this.n(6 * k), 6);
    this.debrisBurst(x, y, z, this.n(10 * k), 6 * (big ? 1.3 : 1), 0.3 * (big ? 1.35 : 1));
    for (let i = 0; i < this.n(4 * k); i++) {
      const a = Math.random() * TAU;
      this.puff(x, y, z, 1.1 * k, { vx: Math.cos(a) * 2.2, vy: rnd(-0.5, 1.5), vz: Math.sin(a) * 2.2, life: rnd(1.3, 1.9), alpha: 0.55, color: [0.6, 0.57, 0.52], grow: 2.3, drag: 2 });
    }
    // mortar dust sifting down the wall
    this.puff(x, y - 0.6, z, 1.3 * k, { vy: -1.2, life: 1.8, alpha: 0.4, color: [0.6, 0.57, 0.52], grow: 2, drag: 0.8, delay: 0.15 });
    this.shake(big ? 0.3 : 0.1, x, y, z);
  }

  /** A stage of the keep comes down: rolling waves of rubble, dust and sparks. */
  keepCollapse(pos: THREE.Vector3): void {
    const { x, z } = pos;
    const gy = this.ground(x, z);
    this.shake(1.3, x, gy, z);
    this.engine.addFlash(0.08);
    const grey: RGB = [0.4, 0.37, 0.33];
    const wave = (scale: number) => {
      // dust billows out from the foot of the walls and pours off the battlements
      const n = this.n(34 * scale);
      const off = Math.random() * TAU;
      for (let i = 0; i < n; i++) {
        const a = off + (i / n) * TAU + rnd(-0.15, 0.15);
        const d = rnd(9.5, 12.5);
        const px = x + Math.cos(a) * d;
        const pz = z + Math.sin(a) * d;
        const high = i % 3 === 0;
        this.puff(px, this.ground(px, pz) + (high ? rnd(5, 9) : 1.6), pz, rnd(4.5, 6.5), {
          vx: Math.cos(a) * rnd(4, 9), vy: high ? rnd(-1, 2) : rnd(0.3, 1.6), vz: Math.sin(a) * rnd(4, 9), life: rnd(2.6, 4), drag: 1.5, color: grey, alpha: 0.6, grow: 2.0, delay: rnd(0, 0.25),
        });
      }
      this.smokeColumn(x, gy + 8, z, this.n(10 * scale), 6, 4.5, 4.2, grey, 0.7, 0.8);
      this.debrisBurst(x, gy + 7, z, this.n(45 * scale), 11, 0.85);
      this.debrisBurst(x, gy + 5, z, this.n(16 * scale), 9, 0.3, WOOD, 1, 5);
      this.sparks(x, gy + 7, z, this.n(18 * scale), 10);
    };
    wave(1);
    this.decal({ kind: DK.shock, x, z, radius: 26, life: 0.95, r: 2.6, g: 2.2, b: 1.7 });
    this.later(0.4, () => {
      wave(0.7);
      this.shake(0.8, x, gy, z);
    });
    this.later(0.9, () => {
      wave(0.5);
      this.shake(0.5, x, gy, z);
    });
  }

  /**
   * Fires on a damaged keep: flames, embers and a tall dark smoke column at each point until
   * `durSec` is up or the battle settles (`settle()` / `clear()`).
   */
  keepFire(points: THREE.Vector3[], durSec = 45, size = 1): void {
    for (const p0 of points) {
      const p = p0.clone();
      this.emitter(
        durSec,
        5,
        (k) => {
          for (let i = 0; i < k; i++) {
            const ox = rnd(-0.6, 0.6) * size;
            const oz = rnd(-0.6, 0.6) * size;
            this.flame(p.x + ox, p.y - 0.3, p.z + oz, rnd(2.0, 3.2) * size, rnd(0.6, 0.95), { vy: 0.5 });
            if (Math.random() < 0.7) this.embers(p.x + ox, p.y + 0.8 * size, p.z + oz, 1, 2.2, 1.2);
            if (Math.random() < 0.45) this.puff(p.x + ox, p.y + 2.2 * size, p.z + oz, 1.5 * size, { vx: rnd(0.3, 1.1), vy: rnd(2.4, 3.6), vz: rnd(-0.3, 0.3), life: rnd(3.2, 4.4), alpha: 0.6, color: SOOT, grow: 3.2, drag: 0.25, gravity: 0.1, fadeIn: 0.15 });
          }
        },
        true,
      );
    }
  }

  levelUp(pos: THREE.Vector3): void {
    const { x, z } = pos;
    const gy = this.ground(x, z);
    const beam = new Pillar(mul(GOLD, 1.1), 0.55, 8, 1);
    beam.mesh.position.set(x, gy, z);
    this.root.add(beam.mesh);
    this.flash(x, gy + 1.2, z, 2.4, GOLD, 0.16);
    this.decal({ kind: DK.shock, x, z, radius: 2.6, life: 0.5, r: GOLD[0] * 0.7, g: GOLD[1] * 0.7, b: GOLD[2] * 0.7 });
    this.decal({ kind: DK.sigil, cell: DECAL.rally, x, z, radius: 1.6, life: 1.2, r: GOLD[0] * 0.3, g: GOLD[1] * 0.3, b: GOLD[2] * 0.3, fadeIn: 0.2, grow: 0.4, spin: 1 });
    for (let i = 0; i < this.n(24); i++) {
      const a = Math.random() * TAU;
      const r = rnd(0.1, 0.7);
      this.emitA({
        x: x + Math.cos(a) * r, y: gy + rnd(0, 0.5), z: z + Math.sin(a) * r, vy: rnd(2, 5), life: rnd(0.6, 1.1), size: 0.12, size1: 0.03, drag: 0.8,
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

  /** A rarity-coloured beam over a loot drop; lives until the handle is disposed. */
  lootBeam(pos: THREE.Vector3, rarity: Rarity): LootBeamHandle {
    const c = RARITY_RGB[rarity];
    const p = pos.clone();
    const legendary = rarity === 'legendary';
    const tier = rarity === 'common' ? 0 : rarity === 'magic' ? 1 : rarity === 'rare' ? 2 : 3;
    const outer = new Pillar(mul(c, 0.3), 0.75 + tier * 0.08, 18 + tier * 3, 1);
    const inner = new Pillar(mul(c, 2.4), 0.16, 24 + tier * 3, 0.35);
    const glow = new GroundDecal('glow', mul(c, 0.7), 2.2, this.ground);
    const ring = new GroundDecal('sigil', mul(c, 0.35), 1.7, this.ground);
    ring.setSheet(this.sheet, DECAL.arcane);
    ring.progress = 1.4;
    this.root.add(outer.mesh, inner.mesh, glow.mesh, ring.mesh);
    let dead = false;
    let t = 0;
    let acc = 0;
    this.flash(p.x, p.y + 0.5, p.z, 3 + tier, c, 0.22);
    this.decal({ kind: DK.shock, x: p.x, z: p.z, radius: 3 + tier, life: 0.6, r: c[0], g: c[1], b: c[2] });
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
        inner.mesh.scale.x = inner.mesh.scale.z = 0.16 * (1 + (1 - appear) * 3);
        glow.alpha = appear * pulse;
        ring.alpha = appear;
        ring.time = time;
        acc += Math.min(dt, 0.1) * (6 + tier * 7) * this.density;
        while (acc >= 1) {
          acc -= 1;
          const a = Math.random() * TAU;
          const r = rnd(0.15, 1.0);
          // motes spiralling up the beam; legendary drops shed sparks too
          this.emitA({
            x: p.x + Math.cos(a) * r, y: gy + rnd(0, 1), z: p.z + Math.sin(a) * r, vx: -Math.sin(a) * 0.8, vy: rnd(1.4, 3.2), vz: Math.cos(a) * 0.8,
            life: rnd(1.2, 2.2), size: rnd(0.07, 0.16), size1: 0.02, drag: 0.3,
            r: c[0], g: c[1], b: c[2], cell: tier >= 2 && Math.random() < 0.3 ? CELL.star : CELL.dot, stretch: legendary ? 0.08 : 0, fadeIn: 0.2,
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

  /**
   * A floating damage / heal number. With `key` (e.g. the target squad), numbers of the same
   * kind landing within a short window merge into one total, so a volley into a squad reads as
   * a single figure instead of confetti. Crits and misses always show on their own.
   */
  damageNumber(pos: THREE.Vector3, value: number, style: NumberStyle = 'normal', key?: number): void {
    if (key === undefined || style === 'miss') {
      this.numbers.show(pos, value, style);
      if (style === 'crit') this.flash(pos.x, pos.y + 0.4, pos.z, 1.6, [6, 3.4, 0.8], 0.14);
      this.kick();
      return;
    }
    const k = key * 4 + (style === 'heal' ? 1 : style === 'crit' ? 2 : 0);
    const b = this.buckets.get(k);
    if (b) {
      b.sum += value;
      b.pos.lerp(pos, 0.5);
      // the strongest flavour wins: effective > normal > weak
      if (style === 'effective' && b.style !== 'crit') b.style = style;
      else if (style === 'normal' && b.style === 'weak') b.style = style;
    } else this.buckets.set(k, { sum: value, pos: pos.clone(), style, due: this.time + (style === 'crit' ? 0.3 : 0.75) });
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
