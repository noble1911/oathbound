// Battle auto-director. Default framing follows the engagement: the camera looks at the midpoint
// of the two armies' fronts (each side's soldiers nearest the enemy weigh most) with a distance
// that fits their spread, drifting slowly. Big events (Lord abilities, legendary procs, keep hits
// and stage changes, squad wipes, Large-unit deaths) score a priority; the best one beyond the
// cooldown gets a cut to a close, low shot with a short dolly and depth of field, held ~2.5 s,
// then the camera glides back to the overview. The user can grab control at any time (CameraRig
// switches to 'free'); `CameraRig.returnToDirector()` hands it back.
import * as THREE from 'three';
import type { CameraRig } from './rig.ts';
import type { ReplayEvent } from '../battle-source.ts';
import type { UnitRenderer } from '../crowd/units.ts';
import { fieldToWorld } from '../core/coords.ts';

interface Candidate {
  prio: number;
  pos: THREE.Vector3;
  at: number;
  kind: string;
  /** Preferred shot distance. */
  dist: number;
  hold: number;
}

export class Director {
  enabled = true;
  /** Seconds between cuts. */
  cooldown = 3.2;
  private lastCut = -99;
  private inShotUntil = -1;
  private pending: Candidate | null = null;
  private drift = 0;
  private overviewTarget = new THREE.Vector3();
  private overviewDist = 80;
  private started = false;
  private rnd = 1;
  private readonly rig: CameraRig;
  private readonly units: UnitRenderer;
  private keepPos: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(0, 0, 60), new THREE.Vector3(0, 0, -60)];
  /** Squad id → alive count, for wipe detection. */
  private squadAlive = new Map<number, number>();
  homeYaw = 0;

  constructor(rig: CameraRig, units: UnitRenderer) {
    this.rig = rig;
    this.units = units;
  }

  setKeeps(a: THREE.Vector3, b: THREE.Vector3): void {
    this.keepPos = [a.clone(), b.clone()];
  }

  /** Call when a battle (re)starts. */
  reset(homeYaw: number): void {
    this.homeYaw = homeYaw;
    this.lastCut = -99;
    this.inShotUntil = -1;
    this.pending = null;
    this.started = false;
    this.squadAlive.clear();
    for (const s of this.units.slots) this.squadAlive.set(s.header.squad, (this.squadAlive.get(s.header.squad) ?? 0) + (s.header.spawnTick === 0 ? 1 : 0));
  }

  private random(): number {
    this.rnd = (this.rnd * 16807) % 2147483647;
    return this.rnd / 2147483647;
  }

  /** Feed each replay event as it fires. */
  onEvent(e: ReplayEvent, t: number): void {
    let c: Candidate | null = null;
    switch (e.k) {
      case 'ability': {
        const big: Record<string, number> = { meteor: 10, skyfall: 9.5, rally: 8.5, bulwark: 8.5, earthshaker: 7, sunfire: 7, ember_burst: 5.5, stomp: 5, chain: 5.2, lifebinder: 5, bloodthirst: 4.5, charge: 4 };
        const p = big[e.ability];
        if (p) c = { prio: p, pos: fieldToWorld(e.pos[0], e.pos[1]), at: t, kind: e.ability, dist: e.ability === 'meteor' ? 34 : e.ability === 'skyfall' ? 24 : 20, hold: e.ability === 'meteor' ? 3.2 : 2.6 };
        break;
      }
      case 'keepHit':
        if (e.dmg > 0) c = { prio: e.final ? 4 : 6.5, pos: this.keepPos[e.seat].clone(), at: t, kind: 'keepHit', dist: 30, hold: 2.4 };
        break;
      case 'keepStage':
        c = { prio: 9.5, pos: this.keepPos[e.seat].clone(), at: t, kind: 'keepStage', dist: 38, hold: 3.2 };
        break;
      case 'death': {
        const s = this.units.slots[e.tgt];
        if (!s) break;
        const left = (this.squadAlive.get(s.header.squad) ?? 1) - 1;
        this.squadAlive.set(s.header.squad, left);
        const large = s.header.flags.includes('large') || s.header.type === 'lord';
        if (large) c = { prio: s.header.type === 'lord' ? 8 : 7, pos: s.pos.clone(), at: t, kind: 'bigDeath', dist: 22, hold: 2.4 };
        else if (left <= 0) c = { prio: 6, pos: s.pos.clone(), at: t, kind: 'wipe', dist: 24, hold: 2.2 };
        break;
      }
      case 'summon':
        this.squadAlive.set(this.units.slots[e.tgt]?.header.squad ?? -1, (this.squadAlive.get(this.units.slots[e.tgt]?.header.squad ?? -1) ?? 0) + 1);
        break;
      case 'attack':
        if (e.projectile === 'firebreath') {
          const s = this.units.slots[e.src];
          if (s) c = { prio: 5, pos: s.pos.clone().setY(0), at: t, kind: 'breath', dist: 30, hold: 2.4 };
        }
        break;
      case 'hit':
        if (e.crit && e.dmg > 200) c = { prio: 3, pos: this.units.slots[e.tgt]?.pos.clone() ?? new THREE.Vector3(), at: t, kind: 'crit', dist: 18, hold: 1.8 };
        break;
    }
    if (c && (!this.pending || c.prio > this.pending.prio)) this.pending = c;
  }

  /** Per frame during battle playback (battle time t, seconds). */
  update(t: number, dt: number): void {
    if (!this.enabled || this.rig.mode !== 'director') return;
    this.computeOverview();
    this.drift += dt;
    if (!this.started) {
      this.started = true;
      if (t > 1) return; // joined mid-battle (seek): no establishing shot
      // establishing shot: low sweep from the home side toward the clash
      const tgt = this.overviewTarget.clone();
      this.rig.play({ target: tgt.clone().add(new THREE.Vector3(0, 0, this.homeYaw === 0 ? 12 : -12)), yaw: this.homeYaw + 0.55, dist: 60, pitch: 0.42, toTarget: tgt, toYaw: this.homeYaw + 0.25, toDist: this.overviewDist, toPitch: 0.72, dur: 4.5, cut: true, dof: 0.25 });
      this.inShotUntil = t + 4.2;
      this.lastCut = t;
      return;
    }
    const p = this.pending;
    if (p && t - p.at > 1.2) this.pending = null; // stale
    const inShot = t < this.inShotUntil;
    if (p && t - this.lastCut > this.cooldown && (!inShot || p.prio >= 9)) {
      this.pending = null;
      this.cutTo(p, t);
      return;
    }
    if (!inShot) {
      // overview: glide (not cut) toward the engagement, slow yaw drift
      const g = this.rig.goal;
      g.target.lerp(this.overviewTarget, Math.min(1, dt * 0.9));
      g.dist += (this.overviewDist - g.dist) * Math.min(1, dt * 0.6);
      g.yaw += (this.homeYaw + 0.32 * Math.sin(this.drift * 0.07) - g.yaw) * Math.min(1, dt * 0.4);
      g.pitch = 0.78 + 0.08 * Math.sin(this.drift * 0.05);
      this.rig.dofGoal = 0;
    }
  }

  /** The candidate yaw (around the preferred one) with the clearest line of sight. */
  private clearYaw(target: THREE.Vector3, yaw: number, pitch: number, dist: number): { yaw: number; pitch: number } {
    const look = target.clone();
    look.y = 0;
    let best = { yaw, pitch, score: Infinity };
    for (const dp of [0, 0.12, 0.25]) {
      for (const dy of [0, 0.4, -0.4, 0.8, -0.8, 1.3, -1.3, Math.PI]) {
        const y = yaw + dy;
        const p = pitch + dp;
        const cam = this.rig.orbitPosition(look, y, p, dist);
        const lk = look.clone().setY(cam.y - Math.sin(p) * dist);
        const b = this.rig.blocked(cam, lk);
        const score = b * 10 + Math.abs(dy) * 0.15 + dp * 2;
        if (score < best.score) best = { yaw: y, pitch: p, score };
      }
      if (best.score < 0.5) break;
    }
    return { yaw: best.yaw, pitch: best.pitch };
  }

  private cutTo(c: Candidate, t: number): void {
    const side = this.random() < 0.5 ? -1 : 1;
    const pref = this.homeYaw + side * (0.5 + this.random() * 0.6);
    const pp = c.kind === 'meteor' ? 0.55 : c.kind === 'keepStage' || c.kind === 'keepHit' ? 0.32 : 0.36;
    const clear = this.clearYaw(c.pos, pref, pp, c.dist);
    const yaw = clear.yaw;
    const target = c.pos.clone();
    if (c.kind === 'meteor') {
      // see it coming: start wide and low, push in as it lands
      this.rig.play({ target, yaw, dist: c.dist * 1.5, pitch: clear.pitch, toDist: c.dist * 1.2, toYaw: yaw + side * 0.18, toPitch: clear.pitch + 0.07, dur: c.hold, cut: true, dof: 0.4 });
    } else if (c.kind === 'keepStage' || c.kind === 'keepHit') {
      this.rig.play({ target: target.clone().setY(4), yaw, dist: c.dist, pitch: clear.pitch, toDist: c.dist * 0.85, toYaw: yaw + side * 0.15, dur: c.hold, cut: true, dof: 0.45 });
    } else {
      this.rig.play({ target, yaw, dist: c.dist * 1.08, pitch: clear.pitch, toDist: c.dist * 0.88, toYaw: yaw + side * 0.14, toPitch: clear.pitch + 0.04, dur: c.hold, cut: true, dof: 0.7 });
    }
    this.lastCut = t;
    this.inShotUntil = t + c.hold;
  }

  private tmp = new THREE.Vector3();
  private sum = [new THREE.Vector3(), new THREE.Vector3()];
  private front = [new THREE.Vector3(), new THREE.Vector3()];
  private cnt = [0, 0];
  private w = [0, 0];
  private mid = new THREE.Vector3();
  private computeOverview(): void {
    // per side: centroid of alive soldiers, then the "front" = alive soldiers closest to the enemy centroid
    const sum = this.sum;
    const cnt = this.cnt;
    sum[0].set(0, 0, 0);
    sum[1].set(0, 0, 0);
    cnt[0] = cnt[1] = 0;
    for (const s of this.units.slots) {
      if (!s.visible || s.deadAt >= 0) continue;
      const side = s.header.side;
      sum[side].add(s.pos);
      cnt[side]++;
    }
    if (cnt[0] + cnt[1] === 0) return;
    const c0 = cnt[0] ? sum[0].divideScalar(cnt[0]) : null;
    const c1 = cnt[1] ? sum[1].divideScalar(cnt[1]) : null;
    if (!c0 || !c1) {
      // one army left: follow it toward the keep it marches on
      const c = (c0 ?? c1)!;
      const keep = c0 ? this.keepPos[1] : this.keepPos[0];
      this.overviewTarget.lerpVectors(c, keep, 0.25).setY(0);
      this.overviewDist = 62;
      return;
    }
    // weighted front: each soldier weighs by closeness to the enemy centroid
    const front = this.front;
    const w = this.w;
    front[0].set(0, 0, 0);
    front[1].set(0, 0, 0);
    w[0] = w[1] = 0;
    for (const s of this.units.slots) {
      if (!s.visible || s.deadAt >= 0) continue;
      const side = s.header.side;
      const enemy = side === 0 ? c1 : c0;
      const d = this.tmp.copy(s.pos).sub(enemy).length();
      const ww = 1 / (1 + (d / 12) ** 2);
      front[side].addScaledVector(s.pos, ww);
      w[side] += ww;
    }
    front[0].divideScalar(Math.max(1e-6, w[0]));
    front[1].divideScalar(Math.max(1e-6, w[1]));
    const mid = this.mid.copy(front[0]).add(front[1]).multiplyScalar(0.5);
    const gap = front[0].distanceTo(front[1]);
    const spread = c0.distanceTo(c1);
    this.overviewTarget.set(mid.x * 0.85, 0, mid.z);
    this.overviewDist = THREE.MathUtils.clamp(28 + gap * 0.6 + spread * 0.35, 40, 120);
  }
}
