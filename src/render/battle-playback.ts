// Battle playback: advances battle time, samples the source, dispatches events in order (to the
// units, the director and the VFX mapping below), and supports pause / speed / seek.
import * as THREE from 'three';
import type { BattleSource, ReplayEvent, SkillEvent, SoldierTransforms } from './battle-source.ts';
import { TICK_MS } from './battle-source.ts';
import type { UnitRenderer, Slot } from './crowd/units.ts';
import type { Director } from './camera/director.ts';
import type { Vfx, ProjectileKind as VfxProjectile } from './vfx/index.ts';
import type { Battlefield } from './terrain/index.ts';
import { fieldToWorld } from './core/coords.ts';
import { abilityFx } from './ability-fx.ts';

const NO_IMPACT = (): void => {};
/** Event sources at or above this are keeps / towers (sim: keepSource(seat, n) = BASE + seat*4 + n). */
export const KEEP_SRC_BASE = 1_000_000;

export type NumberMode = 'all' | 'important' | 'off';

export interface PlaybackHooks {
  /** Every event as it fires (UI: kill feed, keep HP bars, sounds). */
  onEvent?: (e: ReplayEvent, timeMs: number) => void;
  /**
   * An item skill is cast (replay v3). `e.squad` is the casting squad's row in Replay.squads, `e.skill` the
   * SkillId, `e.src` the casting soldier: enough for a banner / kill-feed line ("Mages cast Fireball").
   */
  onSkill?: (e: SkillEvent, timeMs: number) => void;
  onEnd?: () => void;
  /** Floating damage numbers: 'all' | 'important' (default: crits, skill hits, Lord hits, big totals) | 'off'. */
  damageNumbers?: NumberMode;
}

export class BattlePlayback {
  readonly source: BattleSource;
  readonly tf: SoldierTransforms;
  timeMs = 0;
  speed = 1;
  ended = false;
  private _playing = true;
  /** Set by the view: called when playback resumes after a pause, so the render loop wakes up again. */
  onResume: (() => void) | null = null;
  get playing(): boolean {
    return this._playing;
  }
  set playing(v: boolean) {
    const resume = v && !this._playing;
    this._playing = v;
    if (resume) this.onResume?.();
  }
  private cursor = 0;
  private readonly units: UnitRenderer;
  private readonly director: Director;
  private readonly vfx: Vfx;
  private readonly field: Battlefield;
  private readonly hooks: PlaybackHooks;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private sparks = 0;
  private skillCursor = 0;
  /** Squads whose volley this tick belongs to a skill (burning arrows, a pitch pot ...), and projectiles in flight dressed that way. */
  private volleys = new Map<number, { tick: number; kind: VfxProjectile; patch?: { dur: number; radius: number } }>();
  private dressed = new Map<number, { kind: VfxProjectile; patch?: { dur: number; radius: number } }>();

  constructor(source: BattleSource, units: UnitRenderer, director: Director, vfx: Vfx, field: Battlefield, hooks: PlaybackHooks = {}) {
    this.source = source;
    this.units = units;
    this.director = director;
    this.vfx = vfx;
    this.field = field;
    this.hooks = hooks;
    this.damageNumbers = hooks.damageNumbers ?? 'important';
    source.soldiers.forEach((h) => {
      const k = h.side * 1_000_000 + h.squad;
      this.squadHp.set(k, (this.squadHp.get(k) ?? 0) + h.maxHp);
    });
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
    this.chillMotes(bdt);
    this.burnMotes(bdt);
    this.ambientFx(bdt);
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
    this.volleys.clear();
    this.dressed.clear();
    this.chilled.length = 0;
    this.burning.length = 0;
    this.skillHot.clear();
    this.lastCast.clear();
    const sk = this.source.skills ?? [];
    this.skillCursor = 0;
    while (this.skillCursor < sk.length && sk[this.skillCursor].tick * TICK_MS <= t) this.skillCursor++;
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

  /** Fire the skill casts up to and including `tick` (a cast precedes the events it causes in its tick). */
  private dispatchSkills(tick: number, from: number): void {
    const sk = this.source.skills;
    if (!sk) return;
    while (this.skillCursor < sk.length && sk[this.skillCursor].tick <= tick) {
      const e = sk[this.skillCursor++];
      const tms = e.tick * TICK_MS;
      if (tms < from - 1) continue;
      this.skillHot.set(this.squadKey(e.src), tms + Math.max(2500, e.dur * TICK_MS + 1500));
      this.lastCast.set(this.squadKey(e.src), e);
      this.fxSkill(e);
      this.hooks.onSkill?.(e, tms);
    }
  }

  private dispatch(from: number, to: number): void {
    const ev = this.source.events;
    while (this.cursor < ev.length && ev[this.cursor].tick * TICK_MS <= to) {
      const e = ev[this.cursor++];
      const tms = e.tick * TICK_MS;
      this.dispatchSkills(e.tick, from);
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
    this.dispatchSkills(Math.floor(to / TICK_MS), from);
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

  /** 'all' = every hit as it lands · 'important' (default) = see `number` · 'off'. Settable while playing. */
  damageNumbers: NumberMode;
  /** Total max HP per squad (side * 1e6 + squad id), for "is this total worth showing". */
  private squadHp = new Map<number, number>();
  /** Squads that cast a skill recently (battle ms until which their hits count as skill hits). */
  private skillHot = new Map<number, number>();
  /** The last item skill each squad cast (tells a skill's own slows from innate ones on the same tick). */
  private lastCast = new Map<number, SkillEvent>();
  private squadKey(i: number): number {
    const h = this.source.soldiers[i];
    return h ? h.side * 1_000_000 + h.squad : -1;
  }

  /**
   * Floating numbers. 'important': only what the player should notice gets a number, and never one
   * per blow. Everything merges per target squad (`key`) into a total shown about once a second:
   *   · crits (big ones, or on / by a hero)         -> their own gold total, shown quickly
   *   · hits from a squad that just cast a skill, and anything dealt by or to a Lord -> always totalled
   *   · ordinary fighting -> only when the second's total is a real chunk of the squad (>= 8% of its
   *     max HP, at least 40); the steady trickle of a melee shows nothing
   *   · heals -> totalled, small ones dropped;  misses -> never.
   * The VFX layer also caps how many numbers are on screen at once (tier-scaled).
   */
  private number(pos: THREE.Vector3, value: number, style: 'normal' | 'crit' | 'heal' | 'effective' | 'weak' | 'miss', important: boolean, key?: number, notable = false): void {
    const mode = this.damageNumbers;
    if (mode === 'off') return;
    const at = pos.clone().setY(pos.y + 0.6);
    if (mode === 'all') return this.vfx.damageNumber(at, value, style);
    if (style === 'miss') return;
    if (style === 'crit' && !important) style = 'effective';
    if (key === undefined) return this.vfx.damageNumber(at, value, style);
    if (style === 'crit' || notable) return this.vfx.damageNumber(at, value, style, key, { min: 0 });
    const hp = this.squadHp.get(key) ?? 0;
    this.vfx.damageNumber(at, value, style, key, { min: style === 'heal' ? Math.max(15, hp * 0.03) : Math.max(40, hp * 0.08) });
  }

  // ------------------------------------------------------------------ debuff / buff windows
  // Driven by the sim's 'frost' / 'burn' / 'war_cry' ability events, which carry the real duration.

  /** Soldier `i` is slowed for `sec`: he takes a cold blue (or sand) cast and sheds frost. */
  private chill(i: number, sec: number, sand = false): void {
    const s = this.units.slots[i];
    if (!s || s.deadAt >= 0) return;
    s.chillSand = sand;
    s.chillUntil = Math.max(s.chillUntil, this.timeMs / 1000 + sec);
    if (!this.chilled.includes(s)) this.chilled.push(s);
  }
  private chilled: Slot[] = [];
  private chillAcc = 0;
  /** A few frost flakes around slowed soldiers (a fixed small budget however many are slowed). */
  private chillMotes(bdt: number): void {
    if (!this.chilled.length) return;
    const t = this.timeMs / 1000;
    let w = 0;
    for (const s of this.chilled) if (s.deadAt < 0 && s.chillUntil > t) this.chilled[w++] = s;
    this.chilled.length = w;
    if (!w) return;
    this.chillAcc += bdt * Math.min(14, 1.6 * w);
    while (this.chillAcc >= 1) {
      this.chillAcc -= 1;
      const s = this.chilled[Math.floor(Math.random() * w)];
      if (!s.visible) continue;
      if (s.chillSand) this.vfx.sandMote(s.pos, s.arch.render === 'hero' ? 2.6 : 1.6);
      else this.vfx.chillMote(s.pos, s.arch.render === 'hero' ? 2.6 : 1.6);
    }
  }

  /** Soldier `i` burns (or festers with plague) for `sec`: flames follow him for the window. */
  private ignite(i: number, sec: number, plague: boolean): void {
    const s = this.units.slots[i];
    if (!s || s.deadAt >= 0) return;
    s.burnPlague = plague;
    s.burnUntil = Math.max(s.burnUntil, this.timeMs / 1000 + sec);
    if (!this.burning.includes(s)) this.burning.push(s);
  }
  private burning: Slot[] = [];
  private burnAcc = 0;
  /** Flames / plague belches on burning soldiers (a fixed small budget however many burn). */
  private burnMotes(bdt: number): void {
    if (!this.burning.length) return;
    const t = this.timeMs / 1000;
    let w = 0;
    for (const s of this.burning) if (s.deadAt < 0 && s.burnUntil > t) this.burning[w++] = s;
    this.burning.length = w;
    if (!w) return;
    this.burnAcc += bdt * Math.min(18, 3 * w);
    while (this.burnAcc >= 1) {
      this.burnAcc -= 1;
      const s = this.burning[Math.floor(Math.random() * w)];
      if (!s.visible) continue;
      if (s.burnPlague) this.vfx.plagueTick(s.pos);
      else this.vfx.burnMote(s.pos, s.arch.render === 'hero' ? 1.4 : 1);
    }
  }

  /** Soldier `i` is blessed for `sec`: a soft gold glow on his body (units.ts) and a halo as it lands. */
  private bless(i: number, sec: number): void {
    const s = this.units.slots[i];
    if (!s || s.deadAt >= 0) return;
    s.blessUntil = Math.max(s.blessUntil, this.timeMs / 1000 + sec);
    if (s.visible) this.vfx.bless(s.pos);
  }

  /** Soldiers with a standing visual of their own: spectres trail wisps, Sand Golems draw sand while they mend. */
  private ambient: Slot[] | null = null;
  private ambientAcc = 0;
  private ambientFx(bdt: number): void {
    if (!this.ambient) this.ambient = this.units.slots.filter((s) => s.header.type === 'wraith_rider' || s.header.type === 'sand_golem');
    if (!this.ambient.length) return;
    this.ambientAcc += bdt;
    if (this.ambientAcc < 0.12) return;
    this.ambientAcc = 0;
    for (const s of this.ambient) {
      if (!s.visible || s.deadAt >= 0) continue;
      if (s.header.type === 'wraith_rider') {
        if (s.speed > 0.5 && Math.random() < 0.45) this.vfx.ghostWisp(s.pos, 1.8);
      } else if (this.tf.hp[s.index] < s.header.maxHp * 0.995 && Math.random() < 0.7) this.vfx.sandTrickle(s.pos, 3.2, 1.3);
    }
  }

  // ------------------------------------------------------------------ item skills

  /** Living, visible soldiers of the squad that soldier `i` belongs to. */
  private squadOf(i: number): Slot[] {
    const lead = this.units.slots[i];
    if (!lead) return [];
    const out: Slot[] = [];
    for (const s of this.units.slots) if (s.header.squad === lead.header.squad && s.header.side === lead.header.side && s.visible && s.deadAt < 0) out.push(s);
    return out;
  }

  /** The squad's next volley (this tick) flies as `kind`; `patch` = burning ground left where it lands. */
  private dress(lead: Slot, tick: number, kind: VfxProjectile, patch?: { dur: number; radius: number }): void {
    this.volleys.set(lead.header.side * 1_000_000 + lead.header.squad, { tick, kind, patch });
  }

  /** A skill cast → its signature effect (the damage / heal events that follow draw their own hits). */
  private fxSkill(e: SkillEvent): void {
    const v = this.vfx;
    const lead = this.units.slots[e.src];
    if (!lead || !lead.visible) return;
    const P = this.ground(e.pos[0], e.pos[1], new THREE.Vector3(), 0);
    const r = e.radius / 100;
    const dur = (e.dur * TICK_MS) / 1000;
    const feet = lead.pos.clone();
    feet.y = Math.max(this.field.heightAt(feet.x, feet.z), lead.pos.y - lead.lift);
    switch (e.skill) {
      case 'fireball':
        v.castFlare(feet, '#ff7a2a', 1.1);
        this.dress(lead, e.tick, 'skill_fireball', { dur: 3, radius: Math.max(2.5, r) });
        break;
      case 'chain_lightning':
        v.castFlare(feet, '#6fb0ff', 1.2); // the bolts themselves arrive as 'chain' segments this tick
        break;
      case 'frost_nova':
        v.frostNova(P, Math.max(3, r), Math.max(2, dur)); // the slowed soldiers arrive as 'frost' events
        break;
      case 'mending_light': {
        v.castFlare(feet, '#8dff9a', 1);
        const mates = this.squadOf(e.tgt >= 0 ? e.tgt : e.src);
        if (!mates.length) break;
        const c = new THREE.Vector3();
        for (const s of mates) c.add(s.pos);
        c.divideScalar(mates.length);
        let far = 0;
        for (const s of mates) far = Math.max(far, Math.hypot(s.pos.x - c.x, s.pos.z - c.z));
        v.mendingLight(c, far + 1.2);
        break;
      }
      case 'shield_wall': {
        const src = e.src;
        const out = { pos: new THREE.Vector3(), yaw: 0 };
        let width = 4;
        const follow = () => {
          const mates = this.squadOf(src);
          if (!mates.length) return null;
          out.pos.set(0, 0, 0);
          let sx = 0;
          let sz = 0;
          for (const s of mates) {
            out.pos.add(s.pos);
            sx += Math.sin(s.yaw);
            sz += Math.cos(s.yaw);
          }
          out.pos.divideScalar(mates.length);
          out.yaw = Math.atan2(sx, sz);
          return out;
        };
        const mates = this.squadOf(src);
        if (mates.length) {
          const f = follow()!;
          let lat = 0;
          for (const s of mates) lat = Math.max(lat, Math.abs((s.pos.x - f.pos.x) * Math.cos(f.yaw) - (s.pos.z - f.pos.z) * Math.sin(f.yaw)));
          width = lat * 2 + 2.4;
        }
        v.shieldWall(follow, width, Math.max(1.5, dur));
        break;
      }
      case 'war_cry': {
        v.warCry(feet, Math.max(4, r));
        // the allies who hear it flare red-gold, nearest first
        let n = 0;
        for (const s of this.units.slots) {
          if (s.header.side !== lead.header.side || !s.visible || s.deadAt >= 0) continue;
          const d = Math.hypot(s.pos.x - feet.x, s.pos.z - feet.z);
          if (d > r) continue;
          const pos = s.pos;
          this.later(d / 22, () => {
            s.flash = 0.55;
            s.flashTint = 1; // red: war paint
            if (n++ < 40) v.buffMote(pos, n % 2 ? '#ff5a2a' : '#ffc24a', 2);
          });
        }
        break;
      }
      case 'cleave':
        v.cleaveCall(feet);
        for (const s of this.squadOf(e.src)) v.buffMote(s.pos, '#cfe0ff', 1);
        break;
      case 'fire_arrows':
        v.castFlare(feet, '#ff8a3a', 0.8);
        this.dress(lead, e.tick, 'fire_arrow');
        break;
      case 'pinning_shot':
        v.castFlare(feet, '#7ac0ff', 0.8);
        this.dress(lead, e.tick, 'pin_shot');
        break;
      case 'rain_of_arrows': {
        v.castFlare(feet, '#ffd27a', 0.9);
        // the sim's three waves land 16, 28 and 40 ticks after the cast
        v.arrowRain(P, Math.max(3, r), [0.8, 1.4, 2.0], feet.clone().sub(P));
        break;
      }
      case 'thunderous_charge': {
        const from = feet.clone();
        this.later(0.15, () => v.chargeImpact(from, P, Math.max(2, r)));
        break;
      }
      case 'trample':
        v.trample(P, Math.max(2.5, r)); // the slowed soldiers arrive as 'frost' events (sand cast)
        break;
      case 'dive_strike': {
        const mates = this.squadOf(e.src);
        mates.forEach((s, i) => {
          // each rider stoops from where he flies onto the target (spread over the splash area)
          const a = (i / Math.max(1, mates.length)) * Math.PI * 2;
          const to = P.clone().add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(mates.length > 1 ? Math.min(1.2, r * 0.5) : 0));
          const from = s.pos.clone();
          from.y = Math.max(from.y + 1.5, P.y + 5);
          v.diveStrike(from, to, Math.max(1.2, r), 0.2);
        });
        break;
      }
      case 'incendiary_payload':
        v.castFlare(feet, '#ff6a2a', 1.3);
        this.dress(lead, e.tick, 'fire_pot', { dur: Math.max(2, dur), radius: Math.max(2.5, r) });
        break;
    }
  }

  /** A 'frost' / 'burn' / 'war_cry' window event → its effect (the mapping is ability-fx.ts). */
  private debuffFx(e: Extract<ReplayEvent, { k: 'ability' }>): void {
    const caster = e.src >= 0 && e.src < KEEP_SRC_BASE ? this.units.slots[e.src] : undefined;
    const cast = caster ? this.lastCast.get(this.squadKey(e.src)) : undefined;
    const fx = abilityFx(e, { srcType: caster?.header.type, srcSkill: cast && e.tick - cast.tick <= 1 ? cast.skill : null });
    if (!fx) return;
    switch (fx.kind) {
      case 'chill': {
        this.chill(e.tgt, fx.sec, fx.sand);
        const q = fx.burst ? this.soldierPoint(e.tgt, this.tmpB) : null;
        if (q) this.vfx.frost(q.setY(q.y - 0.8), Math.min(1.2, fx.sec));
        break;
      }
      case 'burn':
        this.ignite(e.tgt, fx.sec, fx.plague);
        break;
      case 'bless':
        this.bless(e.tgt, fx.sec);
        break;
      case 'warCry': {
        const p = caster && caster.visible ? caster.pos : this.ground(e.pos[0], e.pos[1], this.tmpB, 0);
        this.vfx.warCry(p, fx.radiusM);
        break;
      }
    }
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
        // shots at a Keep fly into the wall face above its foot, not into the ground in front of it
        if (!tgt && e.src < KEEP_SRC_BASE) {
          for (const seat of [0, 1] as const) {
            const w = this.field.keep(seat).hitPointNear(to);
            if (Math.hypot(w.x - to.x, w.z - to.z) < 1.6) to.y += 1.5 + ((e.src * 37) % 40) / 10;
          }
        }
        // arrows / bolts aimed at a living soldier can stay stuck in him until he falls
        const follow = tgt && tgt.deadAt < 0 ? () => (tgt.deadAt < 0 && tgt.visible ? tgt.pos : null) : undefined;
        let flight = (e.flight * TICK_MS) / 1000;
        // a skill volley: burning / pinning arrows, the empowered fireball, the pitch pot
        let kind: VfxProjectile = e.kind === 'none' ? 'arrow' : e.kind;
        const caster = e.src < KEEP_SRC_BASE ? this.units.slots[e.src] : undefined;
        const vol = caster ? this.volleys.get(caster.header.side * 1_000_000 + caster.header.squad) : undefined;
        // faction shots: the Corpse Catapult hurls plague, a Djinn-Binder throws a whirlwind
        if (caster?.header.type === 'corpse_catapult' && e.kind === 'stone') {
          kind = 'plague';
          this.dressed.set(e.id, { kind });
        } else if (caster?.header.type === 'djinn_binder' && e.kind !== 'none') {
          kind = 'sand_bolt';
          this.dressed.set(e.id, { kind });
        }
        if (vol && e.tick - vol.tick <= 1 && e.kind !== 'firebreath') {
          const fits = vol.kind === 'skill_fireball' ? e.kind === 'fireball' : vol.kind === 'fire_pot' ? e.kind === 'stone' || e.kind === 'bolt' : e.kind === 'arrow' || e.kind === 'none' || e.kind === 'bolt';
          if (fits) {
            kind = vol.kind;
            this.dressed.set(e.id, vol); // a pinning shot's slow arrives as a 'frost' event when it lands
          }
        }
        // the launcher's clip may still be winding up: spawn at its release point, land on time
        const delay = e.src < KEEP_SRC_BASE ? Math.min(this.units.releaseDelay(e.src, (e.tick * TICK_MS) / 1000), flight * 0.6) : 0;
        if (delay > 0.03 && e.kind !== 'firebreath') {
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
          // the cone stays on the snout while the dragon moves and its head swings; it is aimed at the
          // target point throughout
          const bsrc = e.src;
          const aimAt = to.clone();
          const bo = new THREE.Vector3();
          const bd = new THREE.Vector3();
          const bf = { origin: bo, dir: bd };
          const breather = this.units.slots[bsrc];
          v.breath(from.clone(), dir.normalize(), Math.max(10, len + 3), 0.3, Math.max(0.9, flight + 0.6), () => {
            if (!breather || breather.deadAt >= 0) return null;
            if (!this.units.muzzle(bsrc, bo)) return null;
            bd.subVectors(aimAt, bo);
            return bd.lengthSq() > 1 ? bf : null;
          });
        } else v.projectile(kind, from.clone(), to.clone(), flight, e.arc, NO_IMPACT, follow); // the 'impact' event plays the landing
        break;
      }
      case 'impact': {
        if (e.kind === 'none' || e.kind === 'firebreath') break;
        const p = this.ground(e.pos[0], e.pos[1], A, 0);
        const dress = this.dressed.get(e.id);
        if (dress) {
          this.dressed.delete(e.id);
          v.impact(dress.kind, p.clone(), dress.patch ? dress.patch.radius * 0.85 : e.splash / 100);
          if (dress.patch) v.firePatch(p.clone(), dress.patch.radius, dress.patch.dur);
          break;
        }
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
        const lord = tgt.header.type === 'lord' || src?.header.type === 'lord';
        const important = e.crit && (e.dmg >= 25 || hero || lord);
        // hits from a squad that has just cast a skill, and anything a Lord deals or takes, always get a total
        const notable = lord || (!!src && (this.skillHot.get(this.squadKey(e.src)) ?? 0) > this.timeMs);
        const key = this.squadKey(e.tgt);
        this.number(p, e.dmg, e.crit ? 'crit' : e.effective ? 'effective' : e.triangle < 0 ? 'weak' : 'normal', important, key, notable);
        break;
      }
      case 'heal': {
        const p = this.soldierPoint(e.tgt, A);
        if (!p) break;
        v.heal(p.clone().setY(p.y - 1), Math.min(1.5, e.amount / 60));
        this.number(p, e.amount, 'heal', true, this.squadKey(e.tgt));
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
          case 'necromancy': {
            const caster = this.soldierPoint(e.src, A);
            if (e.radius > 0) v.necromancy(p, r); // the Lich: the skeletons themselves arrive as 'summon' events
            else if (caster) v.soulCall(caster.clone(), p.clone().setY(p.y + 0.3));
            break;
          }
          case 'radiance':
            v.radiance(p, r);
            break;
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
          // ---- the newer Lords (see the AbilityEventKind comment in sim/types.ts)
          case 'soul_reap':
            v.soulReap(p, r, Math.max(3, dur), follow);
            break;
          case 'grave_taunt': {
            if (e.radius > 0) v.graveTaunt(p, r, Math.max(2, dur), follow);
            else {
              // one taunted soldier: a thread from the Warden to it, and a mark over it while the taunt lasts
              const tg = e.tgt;
              const at = new THREE.Vector3();
              const from = new THREE.Vector3();
              v.tauntMark(() => this.soldierPoint(src, from, 2.4), () => {
                const q = this.units.slots[tg];
                return q && q.deadAt < 0 ? at.copy(q.pos) : null;
              }, Math.max(1, dur));
            }
            break;
          }
          case 'plague_breath': {
            const from = (this.units.point(src, B) ?? p.clone()).clone().add(new THREE.Vector3(0, 6, 0));
            v.plagueBreath(from, p, r, Math.max(0.3, dur));
            break;
          }
          case 'whirlwind':
            v.djinnWhirlwind(p, r, Math.max(2, dur));
            break;
          case 'stampede': {
            const s0 = this.units.slots[src];
            v.stampede(s0 ? s0.pos.clone() : p.clone(), p, r);
            break;
          }
          case 'talon': {
            const from = (this.units.point(src, B) ?? p.clone()).clone().add(new THREE.Vector3(0, 4, 0));
            const tg = e.tgt;
            const at = new THREE.Vector3();
            v.talon(from, () => {
              const q = this.units.slots[tg];
              return q && q.deadAt < 0 ? at.copy(q.pos) : null;
            }, p, Math.max(0.3, dur));
            break;
          }
          case 'chain': {
            const a = this.soldierPoint(e.src, A);
            const b = this.soldierPoint(e.tgt, B);
            if (a && b) v.lightning(a.clone(), b.clone());
            break;
          }
          case 'burn':
          case 'frost':
          case 'war_cry':
            this.debuffFx(e);
            break;
          case 'ember_burst':
          case 'sunfire':
            v.impact('fireball', p, r);
            break;
          case 'stomp':
          case 'earthshaker':
            if (this.units.slots[e.src]?.header.type === 'war_elephant') v.elephantTrample(p, r);
            else v.stomp(p, r);
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
          case 'knockback': {
            const q = this.units.slots[e.tgt];
            if (q) v.knockback(q.pos.clone(), p);
            break;
          }
          case 'shield_wall': {
            const q = this.units.slots[e.tgt];
            if (q) v.buffMote(q.pos, '#7ab8ff', 2);
            break;
          }
          case 'cleave': {
            const a = this.soldierPoint(e.src, A);
            const b = this.soldierPoint(e.tgt, B) ?? p;
            if (a) v.cleaveArc(a.clone(), b.clone(), Math.max(1.5, r));
            break;
          }
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
        // a soldier's blow lands on the wall right where he stands (or where his shot was aimed)
        const at = !e.final && e.src >= 0 && e.src < KEEP_SRC_BASE ? this.soldierPoint(e.src, B) : null;
        const p = at ? k.hitPointNear(at) : k.hitPoint();
        v.keepHit(p, e.dmg >= 100 || e.final);
        // blows on a keep add up into one figure a second (the final settlement shows on its own)
        if (e.final) this.number(p.clone().setY(p.y + 1.5), e.dmg, 'crit', true);
        else this.number(p.clone().setY(p.y + 1.5), e.dmg, 'effective', true, 3_000_000 + e.seat, true);
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
        // a skeleton claws its way out of the ground
        v.raiseDead(p.clone());
        break;
      }
      case 'attack':
        break;
    }
  }
}
