// Battle playback: advances battle time, samples the source, dispatches events in order (to the
// units, the director and the VFX mapping below), and supports pause / speed / seek.
import * as THREE from 'three';
import type { BattleSource, ReplayEvent, SoldierTransforms } from './battle-source.ts';
import { TICK_MS } from './battle-source.ts';
import type { UnitRenderer } from './crowd/units.ts';
import type { Director } from './camera/director.ts';
import type { Vfx } from './vfx/index.ts';
import type { Battlefield } from './terrain/index.ts';
import { fieldToWorld } from './core/coords.ts';

const NO_IMPACT = (): void => {};
/** Event sources at or above this are keeps / towers (sim: keepSource(seat, n) = BASE + seat*4 + n). */
export const KEEP_SRC_BASE = 1_000_000;

export interface PlaybackHooks {
  /** Every event as it fires (UI: kill feed, keep HP bars, sounds). */
  onEvent?: (e: ReplayEvent, timeMs: number) => void;
  onEnd?: () => void;
  /** Show floating damage numbers (default: crits, heroes, heals, keeps). */
  damageNumbers?: 'all' | 'important' | 'off';
}

export class BattlePlayback {
  readonly source: BattleSource;
  readonly tf: SoldierTransforms;
  timeMs = 0;
  speed = 1;
  playing = true;
  ended = false;
  private cursor = 0;
  private readonly units: UnitRenderer;
  private readonly director: Director;
  private readonly vfx: Vfx;
  private readonly field: Battlefield;
  private readonly hooks: PlaybackHooks;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private sparks = 0;

  constructor(source: BattleSource, units: UnitRenderer, director: Director, vfx: Vfx, field: Battlefield, hooks: PlaybackHooks = {}) {
    this.source = source;
    this.units = units;
    this.director = director;
    this.vfx = vfx;
    this.field = field;
    this.hooks = hooks;
    this.tf = source.makeTransforms();
    units.setRoster(source.soldiers);
    source.sample(0, this.tf);
    units.update(this.tf, 0, 0);
  }

  get durationMs(): number {
    return this.source.durationMs;
  }

  private timers: { at: number; fn: () => void }[] = [];
  /** Run `fn` after `sec` of battle time. */
  private later(sec: number, fn: () => void): void {
    this.timers.push({ at: this.timeMs + sec * 1000, fn });
  }
  private runTimers(): void {
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].at > this.timeMs) continue;
      const t = this.timers[i];
      this.timers.splice(i, 1);
      t.fn();
    }
  }

  /** Advance by real seconds `dt`; returns true while it wants frames. */
  tick(dt: number): boolean {
    if (!this.playing || this.ended) {
      this.units.update(this.tf, this.timeMs / 1000, 0);
      return false;
    }
    const bdt = dt * this.speed;
    const prev = this.timeMs;
    this.timeMs = Math.min(this.durationMs, this.timeMs + bdt * 1000);
    this.source.sample(this.timeMs, this.tf);
    this.dispatch(prev, this.timeMs);
    this.runTimers();
    this.units.update(this.tf, this.timeMs / 1000, bdt);
    this.director.update(this.timeMs / 1000, bdt);
    if (this.timeMs >= this.durationMs) {
      this.ended = true;
      this.vfx.settle(); // ambient fires burn out so the loop can sleep
      this.hooks.onEnd?.();
    }
    return true;
  }

  /** Re-apply the current pose (after unit assets were swapped). */
  refresh(): void {
    this.units.update(this.tf, this.timeMs / 1000, 0);
  }

  /** Jump to a time (re-derives unit states; transient VFX are cleared). */
  seek(ms: number): void {
    const t = Math.max(0, Math.min(this.durationMs, ms));
    this.director.reset(this.director.homeYaw);
    this.vfx.clear();
    this.timers.length = 0;
    this.units.setRoster(this.source.soldiers);
    this.cursor = 0;
    this.timeMs = t;
    this.ended = t >= this.durationMs;
    // replay unit-relevant events (deaths/revives) silently so corpses are right
    const ev = this.source.events;
    while (this.cursor < ev.length && ev[this.cursor].tick * TICK_MS <= t) {
      const e = ev[this.cursor++];
      if (e.k === 'death' || e.k === 'revive') this.units.onEvent(e, (e.tick * TICK_MS) / 1000);
      if (e.k === 'keepStage') this.field.keep(e.seat).setStage(e.stage);
    }
    this.source.sample(t, this.tf);
    this.units.update(this.tf, t / 1000, 0);
  }

  private dispatch(from: number, to: number): void {
    const ev = this.source.events;
    while (this.cursor < ev.length && ev[this.cursor].tick * TICK_MS <= to) {
      const e = ev[this.cursor++];
      const tms = e.tick * TICK_MS;
      if (tms < from - 1) continue;
      const t = tms / 1000;
      this.units.onEvent(e, t);
      if (e.k === 'attack' && e.projectile !== 'none') {
        // timed fire clips (siege): release on the matching 'projectile' event
        for (let j = this.cursor; j < ev.length && ev[j].tick <= e.tick + 60; j++) {
          const p = ev[j];
          if (p.k === 'projectile' && p.src === e.src) {
            this.units.alignRelease(e.src, (p.tick * TICK_MS) / 1000);
            break;
          }
        }
      }
      this.director.onEvent(e, t);
      this.fx(e);
      this.hooks.onEvent?.(e, tms);
    }
  }

  private soldierPoint(i: number, out: THREE.Vector3, h?: number): THREE.Vector3 | null {
    if (i < 0 || i >= this.units.slots.length) return null;
    return this.units.point(i, out, h);
  }

  private ground(xcm: number, ycm: number, out: THREE.Vector3, lift = 0): THREE.Vector3 {
    fieldToWorld(xcm, ycm, out);
    out.y = Math.max(this.field.heightAt(out.x, out.z), this.field.isWater(out.x, out.z) ? this.field.waterLevel : -99) + lift;
    return out;
  }

  /**
   * Floating numbers. 'important' (default): big crits pop on their own, everything else merges
   * into one running total per target squad (`key`); misses are dropped. 'all': every hit.
   */
  private number(pos: THREE.Vector3, value: number, style: 'normal' | 'crit' | 'heal' | 'effective' | 'weak' | 'miss', important: boolean, key?: number): void {
    const mode = this.hooks.damageNumbers ?? 'important';
    if (mode === 'off') return;
    const at = pos.clone().setY(pos.y + 0.6);
    if (mode === 'all') return this.vfx.damageNumber(at, value, style);
    if (style === 'miss') return;
    if (style === 'crit' && !important) style = 'effective';
    this.vfx.damageNumber(at, value, style, key);
  }

  /** Event → visual effect mapping. */
  private fx(e: ReplayEvent): void {
    const v = this.vfx;
    const A = this.tmpA;
    const B = this.tmpB;
    switch (e.k) {
      case 'projectile': {
        let from: THREE.Vector3;
        if (e.src >= KEEP_SRC_BASE) {
          // keep id = BASE + seat*4 + n: n 0/1 = arrow towers, 2 = the keep itself
          const k = e.src - KEEP_SRC_BASE;
          const keep = this.field.keep(((k >> 2) & 1) as 0 | 1);
          const n = k & 3;
          from = n < 2 && keep.towers[n] ? A.copy(keep.towers[n]) : A.copy(keep.position).setY(keep.position.y + 12);
        } else from = this.units.muzzle(e.src, A) ?? this.ground(e.from[0], e.from[1], A, 1.5);
        const tgt = e.tgt >= 0 && e.tgt < this.units.slots.length ? this.units.slots[e.tgt] : null;
        const to = tgt && tgt.deadAt < 0 ? this.units.point(e.tgt, B)! : this.ground(e.to[0], e.to[1], B, 0.3);
        // arrows / bolts aimed at a living soldier can stay stuck in him until he falls
        const follow = tgt && tgt.deadAt < 0 ? () => (tgt.deadAt < 0 && tgt.visible ? tgt.pos : null) : undefined;
        let flight = (e.flight * TICK_MS) / 1000;
        // the launcher's clip may still be winding up: spawn at its release point, land on time
        const delay = e.src < KEEP_SRC_BASE ? Math.min(this.units.releaseDelay(e.src, (e.tick * TICK_MS) / 1000), flight * 0.6) : 0;
        if (delay > 0.03 && e.kind !== 'firebreath') {
          const kind = e.kind === 'none' ? 'arrow' : e.kind;
          const f0 = from.clone();
          const t0 = to.clone();
          flight -= delay;
          const arc = e.arc;
          const src = e.src;
          this.later(delay, () => v.projectile(kind, this.units.muzzle(src, new THREE.Vector3()) ?? f0, t0, flight, arc, NO_IMPACT, follow));
          break;
        }
        if (e.kind === 'firebreath') {
          const dir = to.clone().sub(from);
          const len = dir.length();
          v.breath(from.clone(), dir.normalize(), Math.max(10, len + 3), 0.32, Math.max(0.9, flight + 0.6));
        } else v.projectile(e.kind === 'none' ? 'arrow' : e.kind, from.clone(), to.clone(), flight, e.arc, NO_IMPACT, follow); // the 'impact' event plays the landing
        break;
      }
      case 'impact': {
        if (e.kind === 'none' || e.kind === 'firebreath') break;
        const p = this.ground(e.pos[0], e.pos[1], A, 0);
        v.impact(e.kind, p.clone(), e.splash / 100);
        if (e.kind === 'stone' && e.splash > 300) v.stomp(p.clone(), e.splash / 100);
        break;
      }
      case 'hit': {
        const p = this.soldierPoint(e.tgt, A);
        if (!p) break;
        const src = e.src >= 0 && e.src < KEEP_SRC_BASE ? this.units.slots[e.src] : undefined;
        const melee = !!src && src.arch.key !== 'archers' && src.arch.key !== 'mages';
        if (e.miss) {
          this.number(p, 0, 'miss', false);
          break;
        }
        // every blow in a 300-soldier melee would be a strobe: crits always spark, the rest thin out
        if (melee && (e.crit || this.sparks++ % 2 === 0)) v.hitSpark(p.clone(), { crit: e.crit, magic: src?.arch.key === 'mages' });
        const tgt = this.units.slots[e.tgt];
        const hero = tgt.arch.render === 'hero';
        const important = e.crit && (e.dmg >= 25 || hero);
        this.number(p, e.dmg, e.crit ? 'crit' : e.effective ? 'effective' : e.triangle < 0 ? 'weak' : 'normal', important, hero ? 500_000 + e.tgt : tgt.header.squad);
        break;
      }
      case 'heal': {
        const p = this.soldierPoint(e.tgt, A);
        if (!p) break;
        v.heal(p.clone().setY(p.y - 1), Math.min(1.5, e.amount / 60));
        this.number(p, e.amount, 'heal', true, this.units.slots[e.tgt].header.squad);
        break;
      }
      case 'death': {
        const s = this.units.slots[e.tgt];
        if (s) v.death(s.pos, s.arch.render === 'hero' ? 2.2 : s.arch.render === 'crowd' ? 1 : 1.7);
        break;
      }
      case 'ability': {
        const p = this.ground(e.pos[0], e.pos[1], A, 0).clone();
        const r = Math.max(1, e.radius / 100);
        const dur = (e.dur * TICK_MS) / 1000;
        const src = e.src;
        const follow = () => this.units.slots[src]?.pos ?? p;
        switch (e.ability) {
          case 'meteor':
            v.meteor(p, r);
            break;
          case 'rally':
            v.rally(p, r, Math.max(3, dur), follow);
            break;
          case 'bulwark':
            v.bulwark(p, r, Math.max(3, dur), follow);
            break;
          case 'skyfall': {
            const from = this.units.point(src, B) ?? p.clone().add(new THREE.Vector3(0, 30, 0));
            v.skyfall(from.clone().add(new THREE.Vector3(0, 25, 0)), p);
            break;
          }
          case 'chain': {
            const a = this.soldierPoint(e.src, A);
            const b = this.soldierPoint(e.tgt, B);
            if (a && b) v.lightning(a.clone(), b.clone());
            break;
          }
          case 'burn': {
            const q = this.soldierPoint(e.tgt, B) ?? p;
            v.burn(q.clone().setY(q.y - 0.8), Math.max(1, dur));
            break;
          }
          case 'frost': {
            const q = this.soldierPoint(e.tgt, B) ?? p;
            v.frost(q.clone().setY(q.y - 0.8), Math.max(1, dur));
            break;
          }
          case 'ember_burst':
          case 'sunfire':
            v.impact('fireball', p, r);
            break;
          case 'stomp':
          case 'earthshaker':
            v.stomp(p, r);
            break;
          case 'lifebinder':
            v.heal(p, 1.5);
            break;
          case 'levelup':
            v.levelUp(this.units.point(src, B)?.clone().setY(this.units.slots[src].pos.y) ?? p);
            break;
          case 'charge':
            v.marchDust(p, 4);
            break;
          case 'reflect':
            v.hitSpark(this.soldierPoint(e.tgt, B)?.clone() ?? p, { magic: true, color: '#9fd8ff' });
            break;
          case 'bloodthirst':
            v.hitSpark(this.soldierPoint(e.src, B)?.clone() ?? p, { crit: true, color: '#ff5a3a' });
            break;
          default:
            break;
        }
        break;
      }
      case 'keepHit': {
        if (e.dmg <= 0) break;
        const k = this.field.keep(e.seat);
        const p = k.hitPoint();
        v.keepHit(p, e.dmg >= 100 || e.final);
        this.number(p.clone().setY(p.y + 1.5), e.dmg, e.final ? 'crit' : 'effective', true);
        break;
      }
      case 'keepStage': {
        const k = this.field.keep(e.seat);
        k.setStage(e.stage);
        v.keepCollapse(k.position.clone());
        // the wounded keep burns: more fires with every stage lost
        if (e.stage > 0) v.keepFire(Array.from({ length: Math.min(4, e.stage + 1) }, () => k.hitPoint()), 45, 0.8 + e.stage * 0.15);
        break;
      }
      case 'revive': {
        const p = this.soldierPoint(e.tgt, A);
        if (p) v.heal(p.clone().setY(p.y - 1), 1.6);
        break;
      }
      case 'summon': {
        const p = this.ground(e.pos[0], e.pos[1], A, 0);
        v.marchDust(p.clone(), 3);
        v.frost(p.clone(), 0.8);
        break;
      }
      case 'attack':
        break;
    }
  }
}
