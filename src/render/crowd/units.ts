// The unit renderer: one slot per replay soldier, drawn either as an instance in its archetype's
// VAT batch (crowd) or as its own skinned mesh with an AnimationMixer (Lords, Large units, siege).
//
// Per frame `update(tf, t, dt)` takes interpolated transforms (sim contract) at battle time `t`
// (seconds): places each soldier on the ground (fliers at cruise height), picks the base clip
// from the anim state and ground speed (idle / move / run, rate-matched to speed), overlays
// one-shot clips triggered by events (attack, cast, hit), cross-fades clip changes, holds the
// death clip's last frame, then sinks + dither-fades corpses. All animation is a function of
// battle time, so pausing / scrubbing works.
import * as THREE from 'three';
import type { Engine } from '../core/engine.ts';
import { worldX, worldZ, facingToYaw } from '../core/coords.ts';
import type { ReplaySoldier, SoldierTransforms, ReplayEvent } from '../battle-source.ts';
import { archetypeFor, TEAM_COLORS, type Archetype } from './archetypes.ts';
import { UnitAssets, type CrowdAsset, type HeroAsset } from './assets.ts';
import type { VatClip } from './vat.ts';

const BLEND = 0.18;
const CORPSE_HOLD = 4;
const CORPSE_SINK = 2.5;

interface Anim {
  clip: string;
  /** Start (battle s) for one-shots; loops accumulate `loopT`. */
  t0: number;
  loopT: number;
  rate: number;
  prevClip: string;
  prevT0: number;
  prevLoopT: number;
  prevRate: number;
  blendAt: number;
  oneShot: string | null;
  oneShotAt: number;
  oneShotRate: number;
}

export interface Slot {
  index: number;
  header: ReplaySoldier;
  arch: Archetype;
  team: THREE.Color;
  crowd: CrowdBatch | null;
  hero: HeroInst | null;
  anim: Anim;
  phase: number;
  visible: boolean;
  /** World position (ground / flight), yaw. */
  pos: THREE.Vector3;
  yaw: number;
  lastX: number;
  lastY: number;
  speed: number;
  deadAt: number;
  deathYaw: number;
  flash: number;
  fade: number;
  hp: number;
  /** Height above ground currently (fliers drop when they die). */
  lift: number;
  moving: boolean;
  /** Planning: fade multiplier for ghosts (enemy last-round army). */
  ghost: number;
  /** Planning: constant highlight glow 0..1, and its colour (0 warm white, 1 red = invalid). */
  glow: number;
  glowColor: number;
}

class CrowdBatch {
  readonly mesh: THREE.InstancedMesh;
  /** Twin of `mesh` sharing its buffers: the occluded-silhouette pass. */
  readonly ghost: THREE.InstancedMesh;
  readonly asset: CrowdAsset;
  private iA: THREE.InstancedBufferAttribute;
  private iB: THREE.InstancedBufferAttribute;
  private iC: THREE.InstancedBufferAttribute;
  private iTeam: THREE.InstancedBufferAttribute;
  count = 0;
  readonly capacity: number;
  /** Draw the occluded-silhouette pass (off for fliers: they fly above the canopies). */
  ghosts = true;
  constructor(asset: CrowdAsset, capacity: number) {
    this.asset = asset;
    this.capacity = Math.max(1, capacity);
    const g = asset.geometry.clone();
    const n = this.capacity;
    this.iA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.iB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.iC = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.iTeam = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    for (const a of [this.iA, this.iB, this.iC, this.iTeam]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.iA);
    g.setAttribute('iB', this.iB);
    g.setAttribute('iC', this.iC);
    g.setAttribute('iTeam', this.iTeam);
    this.mesh = new THREE.InstancedMesh(g, asset.material, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.customDepthMaterial = asset.depth;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.name = `crowd:${asset.key}`;
    this.ghost = new THREE.InstancedMesh(g, asset.ghost, n);
    this.ghost.instanceMatrix = this.mesh.instanceMatrix;
    this.ghost.frustumCulled = false;
    this.ghost.count = 0;
    this.ghost.renderOrder = 5;
    this.ghost.name = `crowd-ghost:${asset.key}`;
  }
  begin(): void {
    this.count = 0;
  }
  push(m: THREE.Matrix4, a: [number, number, number], b: [number, number, number], blend: number, fade: number, flash: number, flashColor: number, team: THREE.Color, mirror = 1): void {
    const i = this.count++;
    if (i >= this.capacity) return;
    this.mesh.setMatrixAt(i, m);
    this.iA.setXYZW(i, a[0], a[1], a[2], mirror);
    this.iB.setXYZW(i, b[0], b[1], b[2], 0);
    this.iC.setXYZW(i, blend, fade, flash, flashColor);
    this.iTeam.setXYZ(i, team.r, team.g, team.b);
  }
  end(): void {
    this.mesh.count = Math.min(this.count, this.capacity);
    this.ghost.count = this.ghosts ? this.mesh.count : 0;
    this.ghost.visible = this.ghost.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    for (const a of [this.iA, this.iB, this.iC, this.iTeam]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.mesh.count * a.itemSize);
      a.needsUpdate = true;
    }
  }
  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

class HeroInst {
  readonly root: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  readonly actions = new Map<string, THREE.AnimationAction>();
  readonly uniforms: { uTeam: { value: THREE.Color }; uFlash: { value: number }; uFade: { value: number } }[] = [];
  readonly asset: HeroAsset;
  constructor(engine: Engine, asset: HeroAsset, root: THREE.Object3D, team: THREE.Color, makeMat: (src: THREE.Material, mesh: THREE.Mesh) => { material: THREE.Material; uniforms: HeroInst['uniforms'][number] }) {
    this.asset = asset;
    this.root = root;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const { material, uniforms } = makeMat(m.material as THREE.Material, m);
      uniforms.uTeam.value.copy(team);
      m.material = material;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.uniforms.push(uniforms);
    });
    engine.prepare(root);
    this.mixer = new THREE.AnimationMixer(root);
    for (const [name, clip] of asset.clips) {
      const a = this.mixer.clipAction(clip);
      a.setLoop(THREE.LoopRepeat, Infinity);
      a.clampWhenFinished = true;
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      this.actions.set(name, a);
    }
  }
  /** Set the pose from two clips at explicit times with a blend weight for `b`. */
  pose(a: string, ta: number, b: string, tb: number, wb: number): void {
    for (const [name, act] of this.actions) {
      if (name === a) {
        act.time = ta;
        act.setEffectiveWeight(1 - wb);
      } else if (name === b && wb > 0.001) {
        act.time = tb;
        act.setEffectiveWeight(wb);
      } else act.setEffectiveWeight(0);
    }
    this.mixer.update(0);
  }
  setFx(flash: number, fade: number): void {
    for (const u of this.uniforms) {
      u.uFlash.value = flash;
      u.uFade.value = fade;
    }
  }
}

const hash = (i: number) => {
  let x = (i + 1) * 374761393;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

export class UnitRenderer {
  readonly group = new THREE.Group();
  readonly slots: Slot[] = [];
  readonly assets: UnitAssets;
  private batches = new Map<string, CrowdBatch>();
  private readonly engine: Engine;
  private readonly ground: (x: number, z: number) => number;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3(1, 1, 1);
  private yAxis = new THREE.Vector3(0, 1, 0);
  private fa: [number, number, number] = [0, 0, 0];
  private fb: [number, number, number] = [0, 0, 0];
  /** Called when a soldier with dust > 0 moves (marching dust hook). */
  onMarch: ((slot: Slot) => void) | null = null;
  private heroMatFactory: (src: THREE.Material, asset: HeroAsset, mesh: THREE.Mesh) => { material: THREE.Material; uniforms: HeroInst['uniforms'][number] };
  private archByKey = new Map<string, { arch: Archetype; modelId: string }>();
  private requested = new Set<string>();

  constructor(engine: Engine, ground: (x: number, z: number) => number, makeHeroMaterial: (surf: boolean, src: THREE.Material, tintMap: THREE.Texture | null) => { material: THREE.Material; uniforms: HeroInst['uniforms'][number] }) {
    this.engine = engine;
    this.ground = ground;
    this.assets = new UnitAssets(engine);
    // the tint mask covers the body atlas; weapons (nodes weapon_*) have their own textures
    this.heroMatFactory = (src, asset, mesh) => makeHeroMaterial(asset.surf, src, isWeapon(mesh) ? null : asset.tintMap);
    this.group.name = 'units';
    engine.scene.add(this.group);
  }

  /** Build slots for a replay header (re-uses baked assets across battles). */
  setRoster(soldiers: ReplaySoldier[]): void {
    this.clear();
    const counts = new Map<string, number>();
    const archs = soldiers.map((s) => archetypeFor(s));
    archs.forEach((a) => a.render === 'crowd' && counts.set(a.key, (counts.get(a.key) ?? 0) + 1));
    for (const [key, n] of counts) {
      const arch = archs.find((a) => a.key === key)!;
      const asset = this.assets.crowd(arch);
      const b = new CrowdBatch(asset, n);
      b.ghosts = this.showGhosts && arch.flyHeight === 0;
      this.batches.set(key, b);
      this.group.add(b.mesh, b.ghost);
    }
    soldiers.forEach((h, i) => {
      const arch = archs[i];
      const team = new THREE.Color(TEAM_COLORS[h.side]);
      let hero: HeroInst | null = null;
      if (arch.render === 'hero') {
        const asset = this.assets.hero(arch);
        hero = new HeroInst(this.engine, asset, this.assets.cloneHero(asset), team, (src, mesh) => this.heroMatFactory(src, asset, mesh));
        this.group.add(hero.root);
      }
      const ph = hash(i);
      this.slots.push({
        index: i, header: h, arch, team, crowd: arch.render === 'crowd' ? this.batches.get(arch.key)! : null, hero,
        anim: { clip: 'idle', t0: 0, loopT: ph * 10, rate: 1, prevClip: 'idle', prevT0: 0, prevLoopT: 0, prevRate: 1, blendAt: -99, oneShot: null, oneShotAt: 0, oneShotRate: 1 },
        phase: ph, visible: false, pos: new THREE.Vector3(), yaw: 0, lastX: NaN, lastY: NaN, speed: 0, deadAt: -1, deathYaw: (hash(i + 7777) - 0.5) * 0.9,
        flash: 0, fade: 1, hp: h.maxHp, lift: arch.flyHeight, moving: false, ghost: 1, glow: 0, glowColor: 0,
      });
    });
    // lazily fetch art for the unit types present (procedural stand-ins until they arrive)
    soldiers.forEach((h, i) => {
      const arch = archs[i];
      if (!this.archByKey.has(arch.key)) this.archByKey.set(arch.key, { arch, modelId: h.modelId });
      if (this.requested.has(arch.key)) return;
      this.requested.add(arch.key);
      void this.assets.upgrade(arch, h.modelId).then((ok) => ok && this.swapAssets(arch.key));
    });
  }

  /** Occluded-unit silhouettes (battle); planning turns them off (the canopy fade shows units there). */
  showGhosts = true;
  /** Uniform scale-up applied to every unit when the camera is far out (readability, Total War style). */
  farScale = 1;

  /** Called when an archetype's art arrived: rebuild its batch / hero instances in place. */
  onAssetsChanged: (() => void) | null = null;
  private swapAssets(key: string): void {
    const info = this.archByKey.get(key);
    if (!info) return;
    const old = this.batches.get(key);
    if (old) {
      const b = new CrowdBatch(this.assets.crowd(info.arch), old.capacity);
      b.ghosts = old.ghosts;
      this.group.remove(old.mesh, old.ghost);
      old.dispose();
      this.batches.set(key, b);
      this.group.add(b.mesh, b.ghost);
      for (const s of this.slots) if (s.crowd === old) s.crowd = b;
    }
    for (const s of this.slots) {
      if (!s.hero || s.arch.key !== key) continue;
      const asset = this.assets.hero(s.arch);
      this.group.remove(s.hero.root);
      s.hero.mixer.stopAllAction();
      s.hero = new HeroInst(this.engine, asset, this.assets.cloneHero(asset), s.team, (src, mesh) => this.heroMatFactory(src, asset, mesh));
      this.group.add(s.hero.root);
    }
    this.engine.markShadows();
    this.engine.wake();
    this.onAssetsChanged?.();
  }

  private hasClip(s: Slot, clip: string): boolean {
    if (s.crowd) return s.crowd.asset.clip.has(clip);
    return !!s.hero?.asset.clips.has(clip);
  }
  /** attack/attack2 alternate per soldier; missing clips fall back (cast → attack). */
  private resolveClip(s: Slot, clip: string): string | null {
    if (clip === 'attack' && (s.index & 1) === 1 && this.hasClip(s, 'attack2')) return 'attack2';
    if (this.hasClip(s, clip)) return clip;
    if (clip === 'cast') return this.hasClip(s, 'attack') ? 'attack' : null;
    return null;
  }
  /** Seconds into the attack clip at which the blow lands. */
  private impactTime(s: Slot, clip: string): number {
    if (s.hero?.asset.fireTime !== undefined && clip === 'attack') return s.hero.asset.fireTime;
    const frac = s.crowd?.asset.impactFrac ?? (s.hero?.asset.art ? 0.42 : null);
    if (frac !== null && frac !== undefined) return this.clipDuration(s, clip) * frac;
    return clip === 'cast' ? 0.5 : s.arch.attackImpact;
  }

  clear(): void {
    for (const b of this.batches.values()) {
      this.group.remove(b.mesh, b.ghost);
      b.dispose();
    }
    this.batches.clear();
    for (const s of this.slots) if (s.hero) {
      this.group.remove(s.hero.root);
      s.hero.mixer.stopAllAction();
    }
    this.slots.length = 0;
  }

  // ------------------------------------------------------------------ events

  /** Apply a replay event at battle time `t` (seconds). */
  onEvent(e: ReplayEvent, t: number): void {
    switch (e.k) {
      case 'attack': {
        const s = this.slots[e.src];
        if (!s || s.deadAt >= 0) return;
        const want = e.weapon === 'staff' && s.arch.key.includes('cleric') ? 'cast' : 'attack';
        const clip = this.resolveClip(s, want);
        if (!clip) break;
        // time the swing so the blow lands at hitTick (rate within 0.7..1.6x, then shift the start)
        this.oneShot(s, clip, t);
        // melee: time the swing so the blow lands at hitTick (rate 0.7..1.6x, then shift the start).
        // ranged: hitTick is the landing tick, so the draw simply starts now.
        if (e.projectile === 'none') {
          const hitT = (e.hitTick ?? e.tick + 6) * 0.05;
          const ti = this.impactTime(s, clip);
          const d = hitT - t;
          const rate = d > 0.05 ? Math.min(1.6, Math.max(0.7, ti / d)) : 1;
          s.anim.oneShotRate = rate;
          s.anim.oneShotAt = Math.min(t + 0.4, hitT - ti / rate);
        }
        break;
      }
      case 'heal': {
        const s = this.slots[e.src];
        const c = s ? this.resolveClip(s, 'cast') : null;
        if (s && c && s.deadAt < 0 && s.anim.oneShot !== c) this.oneShot(s, c, t);
        break;
      }
      case 'ability': {
        const s = this.slots[e.src];
        const c = s ? this.resolveClip(s, 'cast') : null;
        if (s && c && s.deadAt < 0 && ['rally', 'meteor', 'bulwark'].includes(e.ability)) this.oneShot(s, c, t);
        break;
      }
      case 'hit': {
        const s = this.slots[e.tgt];
        if (!s || e.miss) return;
        s.flash = e.crit ? 1 : 0.75;
        if (s.hero && !s.anim.oneShot && this.hasClip(s, 'hit')) this.oneShot(s, 'hit', t);
        break;
      }
      case 'death': {
        const s = this.slots[e.tgt];
        if (s && s.deadAt < 0) this.kill(s, t);
        break;
      }
      case 'revive': {
        const s = this.slots[e.tgt];
        if (s) {
          s.deadAt = -1;
          s.fade = 1;
          s.anim.oneShot = null;
        }
        break;
      }
    }
  }

  private oneShot(s: Slot, clip: string, t: number): void {
    const a = s.anim;
    if (a.oneShot === 'death') return;
    this.switchClip(s, clip, t, true);
    a.oneShot = clip;
    a.oneShotAt = t;
    a.oneShotRate = clip === 'attack' || clip === 'attack2' ? this.attackRate(s) : 1;
  }

  /** Speed up the attack clip for fast attackers, never slower than the authored clip. */
  private attackRate(s: Slot): number {
    return s.arch.key === 'berserkers' ? 1.3 : 1;
  }

  private kill(s: Slot, t: number): void {
    s.deadAt = t;
    this.switchClip(s, 'death', t, true);
    s.anim.oneShot = 'death';
    s.anim.oneShotAt = t;
    s.anim.oneShotRate = 1;
  }

  private switchClip(s: Slot, clip: string, t: number, oneShot: boolean): void {
    const a = s.anim;
    const cur = a.oneShot ?? a.clip;
    if (cur === clip && !oneShot) return;
    a.prevClip = cur;
    a.prevT0 = a.oneShot ? a.oneShotAt : a.t0;
    a.prevLoopT = a.loopT;
    a.prevRate = a.oneShot ? a.oneShotRate : a.rate;
    a.blendAt = t;
    if (!oneShot) {
      a.clip = clip;
      a.t0 = t;
    }
  }

  // ------------------------------------------------------------------ per frame

  /** Battle time `t` in seconds; `dt` battle-seconds since the last update (0 when paused). */
  update(tf: SoldierTransforms, t: number, dt: number): void {
    for (const b of this.batches.values()) b.begin();
    const n = Math.min(this.slots.length, tf.count);
    for (let i = 0; i < n; i++) this.updateSlot(this.slots[i], tf, i, t, dt);
    for (const b of this.batches.values()) b.end();
  }

  private updateSlot(s: Slot, tf: SoldierTransforms, i: number, t: number, dt: number): void {
    const vis = tf.visible[i] === 1 && tf.anim[i] !== 255;
    if (!vis) {
      if (s.hero) s.hero.root.visible = false;
      s.visible = false;
      s.lastX = NaN;
      return;
    }
    const x = tf.x[i];
    const y = tf.y[i];
    // speed (m/s of battle time), smoothed
    if (!Number.isNaN(s.lastX) && dt > 0) {
      const d = Math.hypot(x - s.lastX, y - s.lastY) / 100;
      const v = d / dt;
      s.speed += (Math.min(v, 20) - s.speed) * Math.min(1, dt * 8);
    } else if (Number.isNaN(s.lastX)) s.speed = 0;
    s.lastX = x;
    s.lastY = y;
    s.hp = tf.hp[i];
    const state = tf.anim[i];
    const dead = state === 4;
    if (dead && s.deadAt < 0) this.kill(s, t);
    if (!dead && s.deadAt >= 0 && t < s.deadAt) {
      // scrubbed back before the death
      s.deadAt = -1;
      s.anim.oneShot = null;
    }
    const a = s.anim;
    // base clip
    if (s.deadAt < 0) {
      const moving = state === 1 && s.speed > 0.25;
      s.moving = moving;
      const base = moving ? (s.speed > s.arch.runAbove ? 'run' : 'move') : 'idle';
      if (base !== a.clip) this.switchClip(s, base, t, false);
      a.rate = base === 'move' ? clamp(s.speed / s.arch.walkSpeed, 0.6, 1.8) : base === 'run' ? clamp(s.speed / s.arch.runSpeed, 0.7, 1.6) : 1;
      a.loopT += dt * a.rate;
      a.prevLoopT += dt * a.prevRate;
      if (moving && s.arch.dust > 0) this.onMarch?.(s);
    } else s.moving = false;
    // one-shot expiry
    if (a.oneShot && a.oneShot !== 'death') {
      const dur = this.clipDuration(s, a.oneShot);
      if ((t - a.oneShotAt) * a.oneShotRate >= dur - 0.02 && a.oneShot === 'attack' && s.hero?.asset.fireTime !== undefined && this.hasClip(s, 'reload')) {
        // siege: fire -> reload, then back to idle
        this.oneShot(s, 'reload', t);
      } else if ((t - a.oneShotAt) * a.oneShotRate >= dur - 0.02 || t < a.oneShotAt - 1) {
        this.switchClip(s, a.clip, t, true);
        a.prevClip = a.oneShot;
        a.prevT0 = a.oneShotAt;
        a.prevRate = a.oneShotRate;
        a.oneShot = null;
        a.blendAt = t;
      }
    }
    // placement
    const wx = worldX(x);
    const wz = worldZ(y);
    let gy = this.ground(wx, wz);
    if (s.arch.flyHeight > 0) {
      const target = s.deadAt >= 0 ? 0 : s.arch.flyHeight + Math.sin(t * 1.3 + s.phase * 6) * 0.35;
      if (s.deadAt >= 0) {
        const k = clamp((t - s.deadAt) / 1.1, 0, 1);
        s.lift = s.arch.flyHeight * (1 - k * k);
      } else s.lift += (target - s.lift) * Math.min(1, dt * 3 + (dt === 0 ? 0 : 0.02));
      gy = Math.max(gy, -0.2) + s.lift;
    }
    let fade = 1;
    if (s.deadAt >= 0) {
      const since = t - s.deadAt;
      const sink = clamp((since - CORPSE_HOLD) / CORPSE_SINK, 0, 1);
      gy -= sink * 0.8;
      fade = 1 - sink;
      if (sink >= 1) {
        if (s.hero) s.hero.root.visible = false;
        s.visible = false;
        return;
      }
    }
    fade *= s.ghost;
    s.fade = fade;
    s.visible = true;
    s.pos.set(wx, gy, wz);
    s.yaw = facingToYaw(tf.facing[i]) + (s.deadAt >= 0 ? s.deathYaw : 0);
    s.flash = Math.max(0, s.flash - Math.max(dt, 1 / 60) * 5);

    // clip sampling
    const curName = a.oneShot ?? a.clip;
    const curT = a.oneShot ? (t - a.oneShotAt) * a.oneShotRate : a.loopT;
    const prevT = this.isLoop(s, a.prevClip) ? a.prevLoopT : (t - a.prevT0) * a.prevRate;
    const wb = 1 - clamp((t - a.blendAt) / BLEND, 0, 1);
    if (s.crowd) {
      const b = s.crowd;
      const ca = b.asset.clip.get(curName) ?? b.asset.clip.get('idle')!;
      const cb = b.asset.clip.get(a.prevClip) ?? ca;
      frameOf(ca, curT, this.fa);
      frameOf(cb, prevT, this.fb);
      this.q.setFromAxisAngle(this.yAxis, s.yaw);
      this.s.setScalar(s.arch.scale * this.farScale);
      this.m.compose(s.pos, this.q, this.s);
      const mirror = s.deadAt >= 0 && (s.index & 1) === 1 && curName === 'death' ? -1 : 1;
      b.push(this.m, this.fa, this.fb, wb, fade, Math.max(s.flash, s.glow), s.glowColor, s.team, mirror);
    } else if (s.hero) {
      const h = s.hero;
      h.root.visible = true;
      h.root.position.copy(s.pos);
      h.root.rotation.set(0, s.yaw, 0);
      h.root.scale.setScalar(s.arch.scale * this.farScale);
      const ac = h.asset.clips.get(curName) ?? h.asset.clips.get('idle')!;
      const pc = h.asset.clips.get(a.prevClip) ?? ac;
      h.pose(ac.name, clipTime(ac, curT, this.isLoop(s, curName)), pc.name, clipTime(pc, prevT, this.isLoop(s, a.prevClip)), wb);
      h.setFx(Math.max(s.flash, s.glow), fade);
    }
  }

  private isLoop(s: Slot, clip: string): boolean {
    if (s.crowd) return s.crowd.asset.clip.get(clip)?.loop ?? true;
    return (s.hero?.asset.clips.get(clip)?.userData?.loop as boolean | undefined) ?? (clip === 'idle' || clip === 'move' || clip === 'run');
  }
  private clipDuration(s: Slot, clip: string): number {
    if (s.crowd) return s.crowd.asset.clip.get(clip)?.duration ?? 1;
    return s.hero?.asset.clips.get(clip)?.duration ?? 1;
  }

  /** Siege: shift the current fire clip so its fireTime lands at battle time `releaseT`. */
  alignRelease(i: number, releaseT: number): void {
    const s = this.slots[i];
    const ft = s?.hero?.asset.fireTime;
    if (!s || ft === undefined || s.anim.oneShot !== 'attack') return;
    s.anim.oneShotRate = 1;
    s.anim.oneShotAt = Math.min(releaseT - ft, s.anim.oneShotAt + 2);
  }

  /**
   * Seconds from `t` until soldier `i`'s current attack clip reaches its release point (siege
   * fireTime); 0 if it isn't in a timed fire clip. Playback delays the projectile spawn by this.
   */
  releaseDelay(i: number, t: number): number {
    const s = this.slots[i];
    const ft = s?.hero?.asset.fireTime;
    if (!s || ft === undefined || s.anim.oneShot !== 'attack') return 0;
    return Math.max(0, s.anim.oneShotAt + ft / s.anim.oneShotRate - t);
  }

  // ------------------------------------------------------------------ queries (VFX, camera)

  /** World position of a soldier at `height` above its feet (or its chest by default). */
  point(i: number, out = new THREE.Vector3(), height?: number): THREE.Vector3 | null {
    const s = this.slots[i];
    if (!s) return null;
    return out.copy(s.pos).setY(s.pos.y + (height ?? s.arch.chest));
  }
  muzzle(i: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const s = this.slots[i];
    if (!s) return null;
    return this.point(i, out, s.arch.muzzle);
  }
  /** Draw stats: instanced soldiers this frame + heroes. */
  get counts(): { crowd: number; heroes: number; batches: number } {
    let crowd = 0;
    for (const b of this.batches.values()) crowd += b.mesh.count;
    return { crowd, heroes: this.slots.filter((s) => s.hero && s.visible).length, batches: this.batches.size };
  }
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

function frameOf(c: VatClip, local: number, out: [number, number, number]): void {
  let x = local * c.fps;
  let f0: number;
  let f1: number;
  if (c.loop) {
    x = ((x % c.frames) + c.frames) % c.frames;
    f0 = Math.floor(x);
    f1 = (f0 + 1) % c.frames;
  } else {
    x = clamp(x, 0, c.frames - 1);
    f0 = Math.floor(x);
    f1 = Math.min(f0 + 1, c.frames - 1);
  }
  out[0] = c.start + f0;
  out[1] = c.start + f1;
  out[2] = x - f0;
}

function clipTime(c: THREE.AnimationClip, t: number, loop: boolean): number {
  if (loop) return ((t % c.duration) + c.duration) % c.duration;
  return clamp(t, 0, c.duration - 1e-4);
}

function isWeapon(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (/^weapon/i.test(p.name)) return true;
  return false;
}
