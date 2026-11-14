// Real-time deterministic battle (DESIGN §7). 20 Hz, integer maths, stateless hashed RNG.
//
// Fairness by construction (see tests/sim.mirror.test.ts):
//  * Positions are ints whose 180-degree mirror is exact (x -> 7999 - x); all divisions truncate (sign-symmetric).
//  * Every tick is "Jacobi": decisions read the tick-start snapshot, damage/heal/buffs/deaths accumulate and are
//    applied at the end of the tick, so nothing depends on whether seat 0 or seat 1 is processed first.
//  * Random rolls are hash(seed, tick, canonical soldier key, salt), where the key depends only on the squad's index
//    in its own army and the soldier's index in the squad — never on the seat.
//  * Seat 1's flow field is the exact mirror of seat 0's.
import { CELL, FIELD_H, FIELD_W, GRID_W, KEYFRAME_TICKS, MARCH_TICKS, MAX_BATTLE_TICKS } from './constants.ts';
import { LORDS, LORD_LEVEL_DMG, LORD_LEVEL_HP } from './data/lords.ts';
import { UNITS } from './data/units.ts';
import { LORD_POWER, UNIT_POWER } from './data/balance.ts';
import { angleOf, icos, idiv, isin, isqrt, mix4 } from './fixed.ts';
import { modsOf, type ItemMods } from './loot.ts';
import { keepDamageOf } from './match.ts';
import {
  ABILITY_CODES, ARC_CODES, EK, FrameEncoder, PROJ_CODES, REVIVE_CODES, WEAPON_CODES, encodeEvents, keepSource, toBase64,
} from './replay.ts';
import { DIRS, KIND_CODE, MOVE_PCT, RIVER_Y0, RIVER_Y1, cellOf, navFor } from './terrain.ts';
import type {
  AbilityEventKind, ArcType, BattleOutput, BattleResult, DamageType, KeepInfo, LordId, MatchState, ProjectileKind, Replay, ReplaySoldier,
  Seat, SimulateOptions, SoldierType, Squad, Tag, Vec2, WeaponKind,
} from './types.ts';

// ---------------------------------------------------------------- tuning constants

const T_MOUNTED = 1, T_ARMORED = 2, T_FLIER = 4, T_LARGE = 8, T_INFANTRY = 16, T_LORD = 32;
const TAG_BIT: Record<Tag, number> = { mounted: T_MOUNTED, armored: T_ARMORED, flier: T_FLIER, large: T_LARGE, infantry: T_INFANTRY };
const PROJ_SPEED: Partial<Record<ProjectileKind, number>> = { arrow: 160, bolt: 260, stone: 90, fireball: 110, firebreath: 140, tower_arrow: 160, lightning: 1000 };
const PROJ_ARC: Partial<Record<ProjectileKind, ArcType>> = { arrow: 'arc', bolt: 'line', stone: 'high_arc', fireball: 'line', firebreath: 'line', tower_arrow: 'arc', lightning: 'line' };
const BASE_CRIT = 5;
const CRIT_MULT = 150;
const LEVEL_HP = 25;
const LEVEL_DMG = 20;
const AGGRO = 1400;
const BUCKET = 400;
const BW = FIELD_W / BUCKET, BH = FIELD_H / BUCKET;
const SKELETON = { hp: 5000, dmg: 700, atk: 22, speed: 15, radius: 45, range: 120 };
const KEEP_Y = 150;
const TOWER_RANGE = 2200, TOWER_DMG = 900, TOWER_TICKS = 30;
/** Global damage scale (percent) — sets the overall battle pace. */
const DMG_SCALE = 200;

const TRIANGLE: Partial<Record<WeaponKind, WeaponKind>> = { sword: 'axe', axe: 'lance', lance: 'sword' };

// ---------------------------------------------------------------- internal types

interface Stats {
  hp: number; // centi-HP
  dmg: number; // centi-HP
  atk: number; // ticks
  range: number;
  minRange: number;
  speed: number;
  armor: number;
  mr: number;
  splash: number;
  radius: number;
  crit: number;
  leech: number;
  thorns: number;
  burn: number; // dps
  frost: number; // slow %
  heal: number; // centi
  tags: number;
  weapon: WeaponKind;
  dmgType: DamageType;
  proj: ProjectileKind;
  eff: Partial<Record<Tag, number>>;
  slay: Partial<Record<Tag, number>>;
  ranged: boolean;
  canHitAir: boolean;
  healer: boolean;
  brace: boolean;
  charge: boolean;
  pierce: boolean;
  stomp: boolean;
  cone: boolean;
  slowTurn: boolean;
  ignoresArmor: boolean;
  crushing: boolean;
  backline: boolean;
  prefLarge: boolean;
  prefFlier: boolean;
  /** Cavalry / pegasus: hunt the enemy backline (ranged, healers, artillery). */
  raider: boolean;
  magicBonus: number;
  L: Set<string>;
  ilvl: number;
  phoenix: boolean;
}

interface BSquad {
  side: Seat;
  sideIdx: number;
  id: number;
  type: SoldierType;
  lord: LordId | null;
  level: number;
  st: Stats;
  sols: Sol[];
  ax: number; ay: number; facing: number;
  engaged: boolean; engagedNext: boolean;
  macro: BSquad | null;
  c2x: number; c2y: number; alive: number;
  phoenix: boolean;
  grave: number;
  slotErr: number; slotErrNext: number;
  abilityCd: number;
  summon: boolean;
  healTarget: BSquad | null;
  sourceSquad: Squad | null;
}

interface Sol {
  i: number;
  side: Seat;
  key: number;
  sq: BSquad;
  st: Stats;
  ox: number; oy: number; // formation offset
  x: number; y: number; nx: number; ny: number;
  hp: number; maxHp: number;
  alive: boolean;
  spawnTick: number;
  cd: number;
  target: Sol | null;
  facing: number;
  anim: number; animUntil: number;
  chargeReady: boolean; firstStrike: boolean; lastAttack: number;
  reflects: number;
  undying: boolean;
  burnDps: number; burnUntil: number; burnSrc: Sol | null;
  slowPct: number; slowUntil: number;
  rallyUntil: number; bulwarkUntil: number;
  dmgAcc: number; healAcc: number; killer: Sol | null; killerDmg: number; killerTower: number;
  attacks: number; blood: number;
  summoned: boolean;
  moved: boolean;
  relocate: Vec2 | null;
  pendingSlow: number; pendingSlowUntil: number;
  pendingBurn: number; pendingBurnSrc: Sol | null;
  xpValue: number;
  dealt: number;
}

interface Strike {
  kind: 'hit' | 'meteor' | 'skyfall' | 'ember' | 'keep' | 'tower';
  owner: Sol | null;
  side: Seat;
  target: Sol | null;
  ax: number; ay: number; // aim / impact point
  fx: number; fy: number; // origin
  mul: number;
  pid: number;
  proj: ProjectileKind;
  melee: boolean;
  hill: boolean;
  dmg: number; // for fixed-damage strikes (meteor, ember, tower), centi
  radius: number;
  reflected: boolean;
  extra: boolean; // hydra / secondary: no on-hit legend procs
  towerSrc: number;
  /** Seat-independent roll sequence (owner's attack count based) for crit / miss rolls. */
  seq: number;
}

// ---------------------------------------------------------------- stats

function hasL(m: ItemMods, l: string): boolean {
  return m.legend.has(l);
}

function buildStats(sq: Squad, lordOf: LordId | null): Stats {
  const m = modsOf(sq.items);
  let base;
  let lvlHp: number, lvlDmg: number;
  let traits: string[] = [];
  let tags: number;
  let eff: Partial<Record<Tag, number>> = {};
  let heal = 0, lifesteal = 0, minRange = 0, splash = 0, radius = 60;
  if (sq.type === 'lord') {
    const L = LORDS[lordOf!];
    base = L;
    lvlHp = 100 + LORD_LEVEL_HP * (sq.level - 1);
    lvlDmg = 100 + LORD_LEVEL_DMG * (sq.level - 1);
    tags = T_LORD;
    for (const t of L.tags) tags |= TAG_BIT[t];
    splash = L.splash;
    radius = 65;
    if (L.range > 400) traits = ['backline'];
  } else {
    const U = UNITS[sq.type];
    base = U;
    lvlHp = 100 + LEVEL_HP * (sq.level - 1);
    lvlDmg = 100 + LEVEL_DMG * (sq.level - 1);
    tags = 0;
    for (const t of U.tags) tags |= TAG_BIT[t];
    traits = U.traits;
    eff = U.effective;
    heal = U.heal;
    lifesteal = U.lifesteal;
    minRange = U.minRange;
    splash = U.splash;
    radius = U.radius;
  }
  const wardenHp = lordOf === 'warden' ? 10 : 0;
  const pw = sq.type === 'lord' ? LORD_POWER[lordOf!] : UNIT_POWER[sq.type];
  let hpPct = 100 + m.hp + wardenHp;
  let dmgPct = 100 + m.dmg;
  const size = sq.type === 'lord' ? 1 : UNITS[sq.type].squadSize;
  if (hasL(m, 'warhorn') && size <= 2) { hpPct += 35; dmgPct += 35; }
  const ranged = base.range > 400;
  const weapon = base.weapon;
  let speedPct = 100 + m.move + (hasL(m, 'windrunner') ? 40 : 0);
  const windAs = hasL(m, 'windrunner') ? 25 : 0;
  const atk = Math.max(4, idiv(base.attackTicks * 100, 100 + m.as + windAs));
  const st: Stats = {
    hp: idiv(idiv(base.hp * lvlHp * hpPct, 100) * pw, 100),
    dmg: idiv(idiv(base.dmg * lvlDmg * dmgPct * DMG_SCALE, 10000) * pw, 100),
    atk,
    range: base.range + (ranged ? m.range : 0),
    minRange,
    speed: idiv(base.speed * speedPct, 100),
    armor: Math.min(80, base.armor + m.armor),
    mr: Math.min(80, base.magicResist + m.mr),
    splash,
    radius,
    crit: BASE_CRIT + m.crit,
    leech: lifesteal + m.leech,
    thorns: m.thorns,
    burn: m.burn,
    frost: hasL(m, 'frostheart') ? 40 : m.frost,
    heal: idiv(idiv(heal * lvlDmg * dmgPct, 100) * pw, 100),
    tags,
    weapon,
    dmgType: base.damageType,
    proj: base.projectile,
    eff,
    slay: m.slay,
    ranged,
    canHitAir: ranged && weapon !== 'stone' ? true : (tags & T_FLIER) !== 0,
    healer: traits.includes('healer'),
    brace: traits.includes('brace'),
    charge: traits.includes('charge'),
    pierce: traits.includes('pierce'),
    stomp: traits.includes('stomp'),
    cone: traits.includes('cone'),
    slowTurn: traits.includes('slowTurn'),
    ignoresArmor: traits.includes('ignoresArmor') || base.damageType === 'magic',
    crushing: traits.includes('crushing'),
    backline: traits.includes('backline'),
    prefLarge: sq.type === 'ballista',
    prefFlier: sq.type === 'archers',
    raider: traits.includes('raider'),
    magicBonus: lordOf === 'archmage' && base.damageType === 'magic' ? 15 : 0,
    L: m.legend,
    ilvl: m.ilvl,
    phoenix: m.phoenix,
  };
  if (st.healer) st.canHitAir = true;
  speedPct = 0;
  return st;
}

function skeletonStats(): Stats {
  return {
    hp: SKELETON.hp, dmg: SKELETON.dmg, atk: SKELETON.atk, range: SKELETON.range, minRange: 0, speed: SKELETON.speed, armor: 0, mr: 0, splash: 0,
    radius: SKELETON.radius, crit: 0, leech: 0, thorns: 0, burn: 0, frost: 0, heal: 0, tags: T_INFANTRY, weapon: 'sword', dmgType: 'physical',
    proj: 'none', eff: {}, slay: {}, ranged: false, canHitAir: false, healer: false, brace: false, charge: false, pierce: false, stomp: false,
    cone: false, slowTurn: false, ignoresArmor: false, crushing: false, backline: false, prefLarge: false, prefFlier: false, raider: false, magicBonus: 0,
    L: new Set(), ilvl: 1, phoenix: false,
  };
}

function squadSize(sq: Squad): number {
  if (sq.type === 'lord') return 1;
  const n = UNITS[sq.type].squadSize;
  const m = modsOf(sq.items);
  if (m.legend.has('warhorn')) return n >= 6 ? n + 3 : n >= 3 ? n + 1 : n;
  return n;
}

// ---------------------------------------------------------------- the battle

const clampX = (x: number): number => (x < 0 ? 0 : x > FIELD_W - 1 ? FIELD_W - 1 : x);
const clampY = (y: number): number => (y < 0 ? 0 : y > FIELD_H - 1 ? FIELD_H - 1 : y);
const sideSign = (s: Seat): number => (s === 0 ? 1 : -1);
/** Face along (dx, dy), keeping the old facing for a zero vector (angleOf(0, 0) has no mirror). */
const faceOr = (f: number, dx: number, dy: number): number => (dx || dy ? angleOf(dx, dy) : f);

class Battle {
  st: MatchState;
  seed: number;
  record: boolean;
  t = 0;
  sols: Sol[] = [];
  squads: BSquad[] = [];
  sideSquads: [BSquad[], BSquad[]] = [[], []];
  nav = navFor({ seed: 0, features: [] });
  grid: Uint8Array;
  flow: [Uint8Array, Uint8Array];
  // spatial buckets per side: head index per bucket, next per soldier
  head: [Int32Array, Int32Array] = [new Int32Array(BW * BH), new Int32Array(BW * BH)];
  next = new Int32Array(1024);
  pending: Strike[][] = [];
  pid = 0;
  ev: number[] = [];
  evCount = 0;
  lastEvTick = 0;
  frames = new FrameEncoder();
  lordXp: [number, number] = [0, 0];
  dealt: [number, number] = [0, 0];
  lost: [number, number] = [0, 0];
  keeps: [KeepInfo, KeepInfo];
  keepHp: [number, number];
  keepStage: [number, number] = [0, 0];
  summonCount: [number, number] = [0, 0];
  towerCd = [0, 0, 0, 0];
  endTick = 0;
  fightTicks = 0;
  winner: Seat | null = null;
  timeout = false;
  marching = false;
  marchDue = 0;
  marchLeft = 0;
  marchChunk = 0;
  keepDamage: [number, number] = [0, 0];
  survivors: [number[], number[]] = [[], []];
  queuedBuffs: { sol: Sol; kind: 'rally' | 'bulwark'; until: number }[] = [];

  constructor(st: MatchState, record: boolean) {
    this.st = st;
    this.record = record;
    this.seed = mix4(st.seed, st.round, 0x5eed, 7);
    this.nav = navFor(st.terrain);
    this.grid = this.nav.grid;
    this.flow = this.nav.flow;
    for (let i = 0; i < 512; i++) this.pending.push([]);
    const keepPos = (seat: Seat): Vec2 => (seat === 0 ? [3999, KEEP_Y] : [FIELD_W - 1 - 3999, FIELD_H - 1 - KEEP_Y]);
    const towers = (seat: Seat): [Vec2, Vec2] => {
      const k = keepPos(seat), s = sideSign(seat);
      return [[k[0] - 1500 * s, k[1] + 500 * s], [k[0] + 1500 * s, k[1] + 500 * s]];
    };
    this.keeps = [0, 1].map((seat) => ({
      seat: seat as Seat, pos: keepPos(seat as Seat), hpBefore: st.players[seat].keepHp, hpMax: st.players[seat].keepMax, towers: towers(seat as Seat),
    })) as [KeepInfo, KeepInfo];
    this.keepHp = [st.players[0].keepHp, st.players[1].keepHp];
    this.keepStage = [this.stageOf(0, this.keepHp[0]), this.stageOf(1, this.keepHp[1])];
    for (const seat of [0, 1] as Seat[]) {
      const p = st.players[seat];
      p.squads.forEach((sq, idx) => this.addSquad(sq, seat, idx, p.lord));
    }
  }

  stageOf(seat: Seat, hp: number): number {
    const max = this.keeps[seat].hpMax;
    if (hp <= 0) return 4;
    if (hp * 4 < max) return 3;
    if (hp * 2 < max) return 2;
    if (hp * 4 < max * 3) return 1;
    return 0;
  }

  addSquad(sq: Squad, side: Seat, idx: number, lord: LordId | null): void {
    const stats = buildStats(sq, lord);
    const n = squadSize(sq);
    const b: BSquad = {
      side, sideIdx: idx, id: sq.id, type: sq.type, lord: sq.type === 'lord' ? lord : null, level: sq.level, st: stats, sols: [],
      ax: sq.pos[0], ay: sq.pos[1], facing: sq.facing & 255, engaged: false, engagedNext: false, macro: null, c2x: 0, c2y: 0, alive: n,
      phoenix: stats.phoenix, grave: 0, slotErr: 0, slotErrNext: 0, abilityCd: sq.type === 'lord' ? 100 : 0, summon: false, healTarget: null,
      sourceSquad: sq,
    };
    // Formation: rows across the facing direction.
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
    const spacing = stats.radius * 2 + 50;
    const rows = Math.ceil(n / cols);
    const fx = icos(b.facing), fy = isin(b.facing); // forward
    const rx = fy, ry = -fx; // right
    for (let k = 0; k < n; k++) {
      const c = k % cols, r = (k - c) / cols;
      const u = (2 * c - (cols - 1)) * spacing; // doubled units
      const v = ((rows - 1) - 2 * r) * spacing;
      const ox = idiv(u * rx + v * fx, 8192), oy = idiv(u * ry + v * fy, 8192);
      this.addSol(b, k, ox, oy, clampX(b.ax + ox), clampY(b.ay + oy), stats, 0, false);
    }
    this.squads.push(b);
    this.sideSquads[side].push(b);
  }

  addSol(b: BSquad, k: number, ox: number, oy: number, x: number, y: number, st: Stats, spawnTick: number, summoned: boolean): Sol {
    const hp = st.hp;
    const s: Sol = {
      i: this.sols.length, side: b.side, key: b.sideIdx * 256 + k, sq: b, st, ox, oy, x, y, nx: x, ny: y, hp, maxHp: hp, alive: true, spawnTick,
      cd: (mix4(this.seed, b.sideIdx, k, 11) % (st.atk * 50)), target: null, facing: b.facing, anim: 0, animUntil: 0,
      chargeReady: st.charge, firstStrike: st.L.has('windrunner'), lastAttack: -1000, reflects: st.L.has('mirror_aegis') ? 3 : 0,
      undying: st.L.has('undying_oath'), burnDps: 0, burnUntil: 0, burnSrc: null, slowPct: 0, slowUntil: 0, rallyUntil: 0, bulwarkUntil: 0,
      dmgAcc: 0, healAcc: 0, killer: null, killerDmg: 0, killerTower: -1, attacks: 0, blood: 0, summoned, moved: false, relocate: null,
      pendingSlow: 0, pendingSlowUntil: 0, pendingBurn: 0, pendingBurnSrc: null,
      xpValue: b.type === 'lord' ? 30 : b.type === 'skeleton' ? 0 : Math.max(1, Math.round(UNITS[b.type as keyof typeof UNITS].cost / UNITS[b.type as keyof typeof UNITS].squadSize / 8)),
      dealt: 0,
    };
    this.sols.push(s);
    b.sols.push(s);
    if (this.next.length <= this.sols.length) {
      const n2 = new Int32Array(this.next.length * 2);
      n2.set(this.next);
      this.next = n2;
    }
    return s;
  }

  // ---------------------------------------------------------------- events

  emit(kind: number, ...f: number[]): void {
    if (!this.record) return;
    this.ev.push(this.t - this.lastEvTick, kind, ...f);
    this.lastEvTick = this.t;
    this.evCount++;
  }
  emitAbility(src: number, tgt: number, a: AbilityEventKind, x: number, y: number, radius: number, dur: number): void {
    this.emit(EK.ability, src, tgt, ABILITY_CODES.indexOf(a), x, y, radius, dur);
  }

  rnd(key: number, salt: number): number {
    return mix4(this.seed, this.t, key, salt) % 10000;
  }

  // ---------------------------------------------------------------- spatial queries

  rebuildBuckets(): void {
    this.head[0].fill(-1);
    this.head[1].fill(-1);
    for (const s of this.sols) {
      if (!s.alive || s.spawnTick > this.t) continue;
      const b = ((s.y / BUCKET) | 0) * BW + ((s.x / BUCKET) | 0);
      const h = this.head[s.side];
      this.next[s.i] = h[b];
      h[b] = s.i;
    }
  }

  /** Visit alive soldiers of `side` within radius r of (x, y). */
  near(side: Seat, x: number, y: number, r: number, fn: (o: Sol, d2: number) => void): void {
    const bx0 = Math.max(0, ((x - r) / BUCKET) | 0), bx1 = Math.min(BW - 1, ((x + r) / BUCKET) | 0);
    const by0 = Math.max(0, ((y - r) / BUCKET) | 0), by1 = Math.min(BH - 1, ((y + r) / BUCKET) | 0);
    const r2 = r * r, h = this.head[side], next = this.next, sols = this.sols;
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        for (let j = h[by * BW + bx]; j >= 0; j = next[j]) {
          const o = sols[j];
          const dx = o.x - x, dy = o.y - y, d2 = dx * dx + dy * dy;
          if (d2 <= r2) fn(o, d2);
        }
      }
    }
  }

  canHit(a: Sol, e: Sol): boolean {
    return e.alive && (!(e.st.tags & T_FLIER) || a.st.canHitAir);
  }

  // ---------------------------------------------------------------- squad-level (macro) logic

  squadPass(): void {
    for (const b of this.squads) {
      let sx = 0, sy = 0, n = 0;
      for (const s of b.sols) if (s.alive && s.spawnTick <= this.t) { sx += 2 * s.x - (FIELD_W - 1); sy += 2 * s.y - (FIELD_H - 1); n++; }
      b.alive = n;
      if (n) { b.c2x = idiv(sx, n); b.c2y = idiv(sy, n); }
      b.engaged = b.engaged || b.engagedNext;
      b.slotErr = b.slotErrNext;
      b.slotErrNext = 0;
    }
    if (this.t % 10 === 0) {
      for (const b of this.squads) {
        if (!b.alive) continue;
        let best: BSquad | null = null, bestScore = 0;
        for (const e of this.sideSquads[1 - b.side]) {
          if (!e.alive) continue;
          if ((e.st.tags & T_FLIER) && !b.st.canHitAir) continue;
          const dx = idiv(e.c2x - b.c2x, 2), dy = idiv(e.c2y - b.c2y, 2);
          let score = isqrt(dx * dx + dy * dy);
          if (b.st.prefLarge && e.st.tags & T_LARGE) score -= 2500;
          if (b.st.prefFlier && e.st.tags & T_FLIER) score -= 1500;
          if (b.st.raider && e.st.backline) score -= 4000;
          if (!best || score < bestScore || (score === bestScore && e.sideIdx < best.sideIdx)) { best = e; bestScore = score; }
        }
        b.macro = best;
        if (b.st.healer) {
          // Nearest allied squad with wounded soldiers.
          let ht: BSquad | null = null, hd = 0;
          for (const a of this.sideSquads[b.side]) {
            if (!a.alive) continue;
            let wounded = false;
            for (const s of a.sols) if (s.alive && s.hp < s.maxHp) { wounded = true; break; }
            if (!wounded) continue;
            const dx = idiv(a.c2x - b.c2x, 2), dy = idiv(a.c2y - b.c2y, 2), d = dx * dx + dy * dy;
            if (!ht || d < hd || (d === hd && a.sideIdx < ht.sideIdx)) { ht = a; hd = d; }
          }
          b.healTarget = ht;
        }
      }
    }
    // Move formation anchors (until engaged).
    for (const b of this.squads) {
      if (!b.alive || b.engaged || b.summon) continue;
      if (b.slotErr > 250 * b.alive) continue; // let stragglers catch up
      let tx: number, ty: number;
      const flier = (b.st.tags & T_FLIER) !== 0;
      const ax2 = 2 * b.ax - (FIELD_W - 1), ay2 = 2 * b.ay - (FIELD_H - 1);
      if (b.macro) {
        const dx = idiv(b.macro.c2x - ax2, 2), dy = idiv(b.macro.c2y - ay2, 2);
        const d = isqrt(dx * dx + dy * dy);
        const hold = b.st.ranged ? b.st.range - 300 : 0;
        if (d <= hold) continue;
        const crossRiver = !flier && this.acrossRiver2(ay2, b.macro.c2y);
        if (crossRiver) { const f = this.flowDir(b.side, b.ax, b.ay); tx = f[0]; ty = f[1]; }
        else { tx = idiv(dx * 1000, d || 1); ty = idiv(dy * 1000, d || 1); }
      } else {
        const f = this.flowDir(b.side, b.ax, b.ay);
        tx = f[0]; ty = f[1];
      }
      const sp = this.groundSpeed(b.st.speed, b.ax, b.ay, flier, 0);
      b.ax = clampX(b.ax + idiv(tx * sp, 1000));
      b.ay = clampY(b.ay + idiv(ty * sp, 1000));
    }
  }

  /** Is the river between two y values given in doubled-centred coordinates (Y2 = 2y - 11999)? Exactly mirror-symmetric. */
  acrossRiver2(a: number, b: number): boolean {
    const lo = 2 * RIVER_Y0 - (FIELD_H - 1), hi = 2 * RIVER_Y1 - (FIELD_H - 1);
    return (a < lo && b > hi) || (a > hi && b < lo);
  }

  flowDir(side: Seat, x: number, y: number): readonly [number, number] {
    const d = this.flow[side][cellOf(x, y)];
    return d === 8 ? [0, 0] : DIRS[d];
  }

  groundSpeed(speed: number, x: number, y: number, flier: boolean, slow: number): number {
    let sp = speed;
    if (!flier) sp = idiv(sp * MOVE_PCT[this.grid[cellOf(x, y)]], 100);
    if (slow) sp = idiv(sp * (100 - slow), 100);
    return sp < 1 ? 1 : sp;
  }

  terrainCode(x: number, y: number): number {
    return this.grid[cellOf(x, y)];
  }

  // ---------------------------------------------------------------- lords

  lordPass(): void {
    for (const b of this.squads) {
      if (b.type !== 'lord' || !b.alive) continue;
      const s = b.sols[0];
      if (b.abilityCd > 0) { b.abilityCd--; continue; }
      const L = LORDS[b.lord!];
      const enemySide = (1 - b.side) as Seat;
      let nearEnemy = false;
      this.near(enemySide, s.x, s.y, 2500, () => { nearEnemy = true; });
      if (L.ability === 'rally' || L.ability === 'bulwark') {
        if (!nearEnemy) continue;
        const r = L.ability === 'rally' ? 2000 : 1200;
        const dur = L.ability === 'rally' ? 200 : 120;
        this.near(b.side, s.x, s.y, r, (o) => this.queuedBuffs.push({ sol: o, kind: L.ability as 'rally' | 'bulwark', until: this.t + dur }));
        this.emitAbility(s.i, -1, L.ability, s.x, s.y, r, dur);
        s.anim = 3; s.animUntil = this.t + 12;
        b.abilityCd = L.ability === 'rally' ? 280 : 340;
      } else if (L.ability === 'meteor') {
        // Densest enemy cluster within 40 m.
        let best: Sol | null = null, bestN = 0;
        this.near(enemySide, s.x, s.y, 4000, (e) => {
          let n = 0;
          this.near(enemySide, e.x, e.y, 1000, () => { n++; });
          if (n > bestN || (n === bestN && best && e.key < best.key)) { best = e; bestN = n; }
        });
        if (!best || bestN < 3) continue;
        const tg = best as Sol;
        const lvl = b.level;
        const dmg = (50 + 10 * lvl) * 100;
        this.queueStrike({ kind: 'meteor', owner: s, side: b.side, target: null, ax: tg.x, ay: tg.y, fx: s.x, fy: s.y, mul: 100, pid: 0, proj: 'none', melee: false, hill: false, dmg, radius: 1000, reflected: false, extra: true, towerSrc: -1, seq: 0 }, 30);
        this.emitAbility(s.i, tg.i, 'meteor', tg.x, tg.y, 1000, 30);
        s.anim = 3; s.animUntil = this.t + 16;
        b.abilityCd = 300;
      } else if (L.ability === 'skyfall') {
        // Furthest enemy ranged squad.
        let best: BSquad | null = null, bd = -1;
        const s2x = 2 * s.x - (FIELD_W - 1), s2y = 2 * s.y - (FIELD_H - 1);
        for (const e of this.sideSquads[enemySide]) {
          if (!e.alive || !e.st.backline) continue;
          const dx = idiv(e.c2x - s2x, 2), dy = idiv(e.c2y - s2y, 2), d = dx * dx + dy * dy;
          if (d > bd || (d === bd && best && e.sideIdx < best.sideIdx)) { best = e; bd = d; }
        }
        if (!best || !nearEnemy) continue;
        let land: Sol | null = null;
        for (const e of best.sols) if (e.alive && e.spawnTick <= this.t) { land = e; break; }
        if (!land) continue;
        const dmg = idiv(s.st.dmg * 250, 100);
        this.queueStrike({ kind: 'skyfall', owner: s, side: b.side, target: land, ax: land.x, ay: land.y, fx: s.x, fy: s.y, mul: 100, pid: 0, proj: 'none', melee: true, hill: false, dmg, radius: 400, reflected: false, extra: true, towerSrc: -1, seq: 0 }, 14);
        this.emitAbility(s.i, land.i, 'skyfall', land.x, land.y, 400, 14);
        s.anim = 3; s.animUntil = this.t + 14;
        b.abilityCd = 360;
      }
    }
  }

  // ---------------------------------------------------------------- soldiers

  queueStrike(k: Strike, delay: number): void {
    this.pending[(this.t + Math.max(1, delay)) & 511].push(k);
  }

  findTarget(s: Sol, r: number): Sol | null {
    let best: Sol | null = null, bestScore = 0;
    const st = s.st, min2 = st.minRange * st.minRange;
    this.near((1 - s.side) as Seat, s.x, s.y, r, (e, d2) => {
      if (e.spawnTick > this.t || !this.canHit(s, e)) return;
      if (d2 < min2) return;
      let score = isqrt(d2);
      if (st.prefLarge && e.st.tags & T_LARGE) score -= 2000;
      if (st.prefFlier && e.st.tags & T_FLIER) score -= 1200;
      if (st.raider && e.st.backline) score -= 1500;
      if (!best || score < bestScore || (score === bestScore && e.key < best.key)) { best = e; bestScore = score; }
    });
    return best;
  }

  reach(s: Sol, e: Sol): number {
    return s.st.ranged ? s.st.range : s.st.range + e.st.radius;
  }

  soldierPass(): void {
    const t = this.t;
    for (const s of this.sols) {
      s.nx = s.x; s.ny = s.y; s.moved = false;
      if (!s.alive || s.spawnTick > t) continue;
      const st = s.st, b = s.sq;
      const flier = (st.tags & T_FLIER) !== 0;
      const slow = s.slowUntil > t ? s.slowPct : 0;
      // Attack cooldown (centi-ticks); Rally and Bloodthirst speed it up.
      s.cd -= 100 + (s.rallyUntil > t ? 30 : 0) + s.blood * 10;
      if (s.cd < -100) s.cd = -100;
      if (this.marching) { this.marchSoldier(s); continue; }
      if (st.healer) { this.healerAct(s); continue; }
      // Targeting.
      const tgt = s.target;
      if (!tgt || !this.canHit(s, tgt) || (t + s.key) % 6 === 0) {
        const r = st.ranged ? st.range + 300 : AGGRO + (b.engaged ? 800 : 0) + (st.raider ? 1200 : 0);
        s.target = this.findTarget(s, r);
      }
      let vx = 0, vy = 0;
      const sp = this.groundSpeed(st.speed, s.x, s.y, flier, slow);
      const e = s.target;
      if (e) {
        b.engagedNext = true;
        const dx = e.x - s.x, dy = e.y - s.y, d2 = dx * dx + dy * dy;
        const reach = this.reach(s, e);
        if (d2 <= reach * reach) {
          s.facing = faceOr(s.facing, dx, dy);
          if (s.cd <= 0) this.attack(s, e, isqrt(d2));
        } else {
          const d = isqrt(d2);
          const step = Math.min(sp, d - reach + 10);
          vx = idiv(dx * step, d); vy = idiv(dy * step, d);
        }
      } else {
        // Formation / advance. Goals are expressed as deltas (dx, dy) so no absolute rounding is involved.
        let dx: number, dy: number;
        if (!b.engaged) { dx = b.ax + s.ox - s.x; dy = b.ay + s.oy - s.y; }
        else if (b.macro) {
          dx = idiv(b.macro.c2x - (2 * s.x - (FIELD_W - 1)), 2); dy = idiv(b.macro.c2y - (2 * s.y - (FIELD_H - 1)), 2);
          if (!flier && this.acrossRiver2(2 * s.y - (FIELD_H - 1), b.macro.c2y)) { const f = this.flowDir(s.side, s.x, s.y); dx = f[0]; dy = f[1]; }
        } else {
          const f = this.flowDir(s.side, s.x, s.y);
          dx = f[0] * 3; dy = f[1] * 3;
        }
        const d2 = dx * dx + dy * dy;
        if (!b.engaged) b.slotErrNext += isqrt(d2);
        if (d2 > 900) {
          const d = isqrt(d2);
          const cap = b.engaged ? sp : idiv(sp * 130, 100);
          const step = Math.min(cap, d);
          vx = idiv(dx * step, d); vy = idiv(dy * step, d);
        }
      }
      this.separate(s, vx, vy, sp);
    }
  }

  separate(s: Sol, vx: number, vy: number, sp: number): void {
    const st = s.st, flier = (st.tags & T_FLIER) !== 0;
    let px = 0, py = 0;
    const r = st.radius + 200;
    for (const side of [0, 1] as Seat[]) {
      this.near(side, s.x, s.y, r, (o) => {
        if (o === s || o.spawnTick > this.t) return;
        if (((o.st.tags & T_FLIER) !== 0) !== flier) return;
        const rr = st.radius + o.st.radius;
        const dx = s.x - o.x, dy = s.y - o.y, d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) return;
        if (d2 === 0) {
          const sg = sideSign(s.side) * (s.key < o.key || o.side !== s.side ? 1 : -1);
          px += sg * 8; py += sg * 3;
          return;
        }
        const d = isqrt(d2) || 1;
        const ov = rr - d;
        // Large units shove small ones more than they are shoved.
        const w = o.st.radius * 100 / (st.radius + o.st.radius) | 0;
        px += idiv(dx * ov * w, d * 100);
        py += idiv(dy * ov * w, d * 100);
      });
    }
    const cap = Math.max(10, sp);
    if (px > cap) px = cap; else if (px < -cap) px = -cap;
    if (py > cap) py = cap; else if (py < -cap) py = -cap;
    vx += px; vy += py;
    if (vx || vy) {
      s.nx = clampX(s.x + vx);
      s.ny = clampY(s.y + vy);
      if (vx * vx + vy * vy > 16) {
        s.moved = true;
        if (!s.target || s.anim !== 2) s.facing = faceOr(s.facing, vx, vy);
      }
    }
  }

  attack(s: Sol, e: Sol, dist: number): void {
    const st = s.st, t = this.t;
    s.cd += st.atk * 100;
    s.attacks++;
    s.lastAttack = t;
    s.anim = 2;
    s.animUntil = t + Math.min(st.atk, 10);
    const hill = st.ranged && this.terrainCode(s.x, s.y) === KIND_CODE.hill;
    const windup = st.slowTurn ? 12 : 0;
    const delay = st.proj === 'none' ? (st.slowTurn ? 12 : Math.min(6, st.atk >> 1)) : this.flight(st.proj, dist, windup);
    this.emit(EK.attack, s.i, e.i, WEAPON_CODES.indexOf(st.weapon), PROJ_CODES.indexOf(st.proj), delay);
    const base: Strike = {
      kind: 'hit', owner: s, side: s.side, target: e, ax: e.x, ay: e.y, fx: s.x, fy: s.y, mul: 100, pid: 0, proj: st.proj,
      melee: !st.ranged, hill, dmg: 0, radius: st.splash, reflected: false, extra: false, towerSrc: -1, seq: s.attacks * 4,
    };
    if (st.proj === 'none') {
      this.queueStrike(base, delay);
    } else {
      this.launch(base, dist, windup);
      if (st.L.has('hydra_volley')) {
        // Two extra projectiles at other enemies in range.
        const picked: Sol[] = [];
        for (let k = 0; k < 2; k++) {
          let best: Sol | null = null, bd = 0;
          this.near((1 - s.side) as Seat, s.x, s.y, st.range, (o, d2) => {
            if (o === e || picked.includes(o) || o.spawnTick > t || !this.canHit(s, o)) return;
            if (!best || d2 < bd || (d2 === bd && o.key < best.key)) { best = o; bd = d2; }
          });
          if (!best) break;
          const o = best as Sol;
          picked.push(o);
          this.launch({ ...base, target: o, ax: o.x, ay: o.y, mul: 55, extra: true, seq: base.seq + 1 + k }, isqrt(bd), 0);
        }
      }
    }
  }

  /** Ticks from release to landing (also the attack -> hit delay for ranged attacks). */
  flight(proj: ProjectileKind, dist: number, windup: number): number {
    return Math.max(2, idiv(dist, PROJ_SPEED[proj] ?? 150) + windup);
  }

  launch(k: Strike, dist: number, windup: number): void {
    const flight = this.flight(k.proj, dist, windup);
    k.pid = ++this.pid;
    const src = k.owner ? k.owner.i : k.towerSrc;
    this.emit(EK.projectile, k.pid, src, k.target ? k.target.i : -1, PROJ_CODES.indexOf(k.proj), ARC_CODES.indexOf(PROJ_ARC[k.proj] ?? 'line'), k.fx, k.fy, k.ax, k.ay, flight);
    this.queueStrike(k, flight);
  }

  healerAct(s: Sol): void {
    const st = s.st, b = s.sq, t = this.t, flier = (st.tags & T_FLIER) !== 0;
    const sp = this.groundSpeed(st.speed, s.x, s.y, flier, s.slowUntil > t ? s.slowPct : 0);
    // Heal the most wounded ally in range.
    let best: Sol | null = null, bestFrac = 0;
    if (s.cd <= 0) {
      this.near(s.side, s.x, s.y, st.range, (o) => {
        if (o.hp >= o.maxHp || o.spawnTick > t) return;
        const frac = idiv(o.hp * 1000, o.maxHp);
        if (!best || frac < bestFrac || (frac === bestFrac && o.key < best.key)) { best = o; bestFrac = frac; }
      });
    }
    let vx = 0, vy = 0;
    if (best) {
      const o = best as Sol;
      const amt = Math.min(st.heal, o.maxHp - o.hp);
      o.healAcc += amt;
      s.cd += st.atk * 100;
      s.anim = 3; s.animUntil = t + 10;
      s.facing = faceOr(s.facing, o.x - s.x, o.y - s.y);
      this.emit(EK.heal, s.i, o.i, Math.ceil(amt / 100));
      b.engagedNext = true;
    } else {
      // Stay behind the squad we support, ~8 m back from the nearest enemy.
      let dx = b.ax + s.ox - s.x, dy = b.ay + s.oy - s.y;
      const ht = b.healTarget;
      if (ht && ht.alive && ht !== b) {
        dx = idiv(ht.c2x - (2 * s.x - (FIELD_W - 1)), 2) + s.ox;
        dy = idiv(ht.c2y - (2 * s.y - (FIELD_H - 1)), 2) - sideSign(s.side) * 600 + s.oy;
      }
      let danger = false;
      this.near((1 - s.side) as Seat, s.x, s.y, 900, (o) => { if (o.spawnTick <= t) danger = true; });
      if (danger) { dx = 0; dy = 0; }
      if (s.cd <= 0) {
        const e = this.findTarget(s, st.range);
        if (e) {
          const ex = e.x - s.x, ey = e.y - s.y;
          s.facing = faceOr(s.facing, ex, ey);
          this.attack(s, e, isqrt(ex * ex + ey * ey));
          dx = 0; dy = 0;
        }
      }
      const d2 = dx * dx + dy * dy;
      if (!b.engaged) b.slotErrNext += isqrt(d2);
      if (d2 > 900) {
        const d = isqrt(d2), step = Math.min(sp, d);
        vx = idiv(dx * step, d); vy = idiv(dy * step, d);
      }
    }
    this.separate(s, vx, vy, sp);
  }

  // ---------------------------------------------------------------- damage

  damage(a: Stats, aSol: Sol | null, d: Sol, mul: number, crit: boolean, hill: boolean, ranged: boolean, dmgType: DamageType, baseOverride: number): { dmg: number; eff: boolean; tri: number } {
    let dmg = baseOverride > 0 ? baseOverride : a.dmg;
    dmg = idiv(dmg * mul, 100);
    let tri = 0;
    if (TRIANGLE[a.weapon] && TRIANGLE[d.st.weapon]) {
      if (TRIANGLE[a.weapon] === d.st.weapon) tri = 1;
      else if (TRIANGLE[d.st.weapon] === a.weapon) tri = -1;
    }
    if (tri) dmg = idiv(dmg * (100 + 25 * tri), 100);
    let effPct = 100;
    const tags = d.st.tags;
    for (const tag in a.eff) if (tags & TAG_BIT[tag as Tag]) effPct = Math.max(effPct, a.eff[tag as Tag]!);
    if (a.L.has('kingsbane') && tags & (T_LORD | T_LARGE)) effPct = Math.max(effPct, 300);
    if (a.crushing && tags & T_ARMORED) effPct = Math.max(effPct, 150);
    let slay = 0;
    for (const tag in a.slay) if (tags & TAG_BIT[tag as Tag]) slay += a.slay[tag as Tag]!;
    if (aSol && aSol.firstStrike && baseOverride === 0) effPct = Math.max(effPct, 300);
    const eff = effPct > 100 || slay > 0;
    dmg = idiv(dmg * (effPct + slay), 100);
    // Charge (not vs braced pikemen).
    if (aSol && aSol.chargeReady && baseOverride === 0) dmg = d.st.brace ? dmg : dmg * 2;
    if (d.st.brace && a.tags & T_MOUNTED && !ranged) dmg = idiv(dmg * 70, 100);
    if (hill) dmg = idiv(dmg * 115, 100);
    if (a.L.has('frostheart') && d.slowUntil > this.t) dmg = idiv(dmg * 130, 100);
    if (crit) dmg = idiv(dmg * CRIT_MULT, 100);
    if (dmgType === 'magic') {
      if (a.magicBonus) dmg = idiv(dmg * (100 + a.magicBonus), 100);
      dmg = idiv(dmg * (100 - d.st.mr), 100);
    } else if (!a.ignoresArmor) {
      const armor = a.crushing ? d.st.armor >> 1 : d.st.armor;
      dmg = idiv(dmg * (100 - armor), 100);
    }
    if (ranged && this.terrainCode(d.x, d.y) === KIND_CODE.ruins) dmg = idiv(dmg * 75, 100);
    if (d.bulwarkUntil > this.t) dmg = idiv(dmg * 60, 100);
    if (dmg < 100) dmg = 100;
    return { dmg, eff, tri };
  }

  credit(d: Sol, dmg: number, by: Sol | null, tower: number): void {
    d.dmgAcc += dmg;
    if (by) {
      if (!d.killer || dmg > d.killerDmg || (dmg === d.killerDmg && by.key < d.killer.key)) { d.killer = by; d.killerDmg = dmg; }
      by.dealt += dmg;
    } else if (tower >= 0 && !d.killer && d.killerTower < 0) d.killerTower = tower;
  }

  applyHit(k: Strike, d: Sol, mul: number, primary: boolean): void {
    const a = k.owner!;
    const st = a.st;
    const ranged = !k.melee;
    // Forest: ranged attacks miss 40% of the time against targets inside.
    if (ranged && this.terrainCode(d.x, d.y) === KIND_CODE.forest && this.rnd(a.key, k.seq * 4099 + d.key + 7) < 4000) {
      this.emit(EK.hit, a.i, d.i, 0, 4 | (1 << 3));
      return;
    }
    const crit = this.rnd(a.key, k.seq * 4099 + d.key + 13) < st.crit * 100;
    const r = this.damage(st, primary ? a : null, d, mul, crit, k.hill, ranged, st.dmgType, 0);
    this.credit(d, r.dmg, a, -1);
    if (st.leech && a.alive) a.healAcc += idiv(r.dmg * st.leech, 100);
    if (k.melee && d.st.thorns && a.alive) this.credit(a, idiv(r.dmg * d.st.thorns, 100), d, -1);
    if (st.burn) { if (st.burn * 100 > d.pendingBurn) { d.pendingBurn = st.burn * 100; d.pendingBurnSrc = a; } }
    if (st.frost && st.frost > d.pendingSlow) { d.pendingSlow = st.frost; d.pendingSlowUntil = this.t + 40; }
    this.emit(EK.hit, a.i, d.i, Math.ceil(r.dmg / 100), (crit ? 1 : 0) | (r.eff ? 2 : 0) | ((r.tri + 1) << 3));
  }

  resolveStrikes(): void {
    const list = this.pending[this.t & 511];
    if (!list.length) return;
    this.pending[this.t & 511] = [];
    for (const k of list) this.resolveStrike(k);
  }

  resolveStrike(k: Strike): void {
    const t = this.t;
    const enemy = (1 - k.side) as Seat;
    if (k.kind === 'keep') { this.keepHitStrike(k); return; }
    if (k.kind === 'tower') {
      const d = k.target!;
      this.emit(EK.impact, k.pid, d.x, d.y, PROJ_CODES.indexOf('tower_arrow'), 0);
      if (!d.alive) return;
      let dmg = idiv(k.dmg * (100 - d.st.armor), 100);
      if (dmg < 100) dmg = 100;
      this.credit(d, dmg, null, k.towerSrc);
      this.emit(EK.hit, k.towerSrc, d.i, Math.ceil(dmg / 100), 1 << 3);
      return;
    }
    if (k.kind === 'meteor' || k.kind === 'ember' || k.kind === 'skyfall') {
      const a = k.owner!;
      if (k.kind === 'skyfall' && a.alive) a.relocate = [k.ax, k.ay];
      const magic = k.kind !== 'skyfall';
      this.near(enemy, k.ax, k.ay, k.radius, (d) => {
        if (d.spawnTick > t) return;
        if (k.kind === 'ember' && d.st.tags & T_FLIER) return;
        const r = this.damage(a.st, null, d, 100, false, false, false, magic ? 'magic' : 'physical', k.dmg);
        this.credit(d, r.dmg, a, -1);
        this.emit(EK.hit, a.i, d.i, Math.ceil(r.dmg / 100), 1 << 3);
      });
      if (k.kind === 'ember') this.emitAbility(a.i, -1, 'ember_burst', k.ax, k.ay, k.radius, 0);
      return;
    }
    // Ordinary attack.
    const a = k.owner!;
    if (k.melee && !a.alive) return; // swing interrupted
    const st = a.st;
    const tg = k.target!;
    const homing = k.proj !== 'stone';
    let ix = k.ax, iy = k.ay;
    if (homing && tg.alive) { ix = tg.x; iy = tg.y; }
    if (k.proj !== 'none') this.emit(EK.impact, k.pid, ix, iy, PROJ_CODES.indexOf(k.proj), k.radius);
    // Mirror Aegis: reflect projectiles.
    if (homing && k.proj !== 'none' && tg.alive && tg.reflects > 0 && !k.reflected && a.alive) {
      tg.reflects--;
      this.emitAbility(tg.i, a.i, 'reflect', tg.x, tg.y, 0, 0);
      const dx = a.x - tg.x, dy = a.y - tg.y;
      this.launch({ ...k, owner: tg, side: tg.side, target: a, fx: tg.x, fy: tg.y, ax: a.x, ay: a.y, reflected: true, extra: true, mul: idiv(k.mul * st.dmg, Math.max(1, tg.st.dmg)) }, isqrt(dx * dx + dy * dy), 0);
      return;
    }
    let primaryHit = false;
    if (k.proj === 'stone') {
      // Lands on the ground: splash only.
    } else if (k.proj === 'firebreath' || st.cone) {
      // Cone: everything within range in a ~60-degree cone from the origin.
      const dx0 = k.ax - k.fx, dy0 = k.ay - k.fy, l2 = dx0 * dx0 + dy0 * dy0 || 1;
      this.near(enemy, k.fx, k.fy, st.range + 100, (d) => {
        if (d.spawnTick > t || !this.canHit(a, d)) return;
        const ex = d.x - k.fx, ey = d.y - k.fy;
        const dot = ex * dx0 + ey * dy0;
        if (dot <= 0 && d !== tg) return;
        if (d !== tg && dot * dot * 100 < 75 * l2 * (ex * ex + ey * ey)) return;
        this.applyHit(k, d, k.mul, d === tg);
      });
      this.consumeCharge(a, k);
      return;
    } else if (tg.alive) {
      this.applyHit(k, tg, k.mul, !k.extra);
      primaryHit = true;
    }
    // Splash (falloff to 50% at the edge).
    if (k.radius > 0) {
      const r = k.radius;
      this.near(enemy, ix, iy, r, (d, d2) => {
        if (d === tg && primaryHit) return;
        if (d.spawnTick > t || !this.canHit(a, d)) return;
        if (k.proj === 'stone' && d.st.tags & T_FLIER) return;
        const fall = 100 - idiv(50 * isqrt(d2), r);
        this.applyHit(k, d, idiv(k.mul * (st.stomp ? 60 : fall), 100), false);
      });
      if (st.stomp && !k.extra) this.emitAbility(a.i, tg.i, 'stomp', ix, iy, r, 0);
    }
    // Ballista bolts pierce along the line.
    if (st.pierce) {
      const dx0 = ix - k.fx, dy0 = iy - k.fy, l2 = dx0 * dx0 + dy0 * dy0 || 1;
      const L = isqrt(l2);
      this.near(enemy, idiv(k.fx + ix, 2), idiv(k.fy + iy, 2), (L >> 1) + 100, (d) => {
        if (d === tg || d.spawnTick > t || !this.canHit(a, d)) return;
        const ex = d.x - k.fx, ey = d.y - k.fy, dot = ex * dx0 + ey * dy0;
        if (dot < 0 || dot > l2) return;
        const cross = ex * dy0 - ey * dx0;
        if (cross * cross > 80 * 80 * l2) return;
        this.applyHit(k, d, idiv(k.mul * 60, 100), false);
      });
    }
    if (!k.extra && primaryHit) {
      // On-hit legendary procs.
      if (st.L.has('stormcaller')) {
        let prev = tg;
        const hit: Sol[] = [tg];
        for (let j = 0; j < 3; j++) {
          let best: Sol | null = null, bd = 0;
          this.near(enemy, prev.x, prev.y, 500, (o, d2) => {
            if (hit.includes(o) || o.spawnTick > t) return;
            if (!best || d2 < bd || (d2 === bd && o.key < best.key)) { best = o; bd = d2; }
          });
          if (!best) break;
          const o = best as Sol;
          this.emitAbility(prev.i, o.i, 'chain', o.x, o.y, 0, 0);
          const r = this.damage(st, null, o, 30, false, false, false, 'magic', 0);
          this.credit(o, r.dmg, a, -1);
          this.emit(EK.hit, a.i, o.i, Math.ceil(r.dmg / 100), 1 << 3);
          hit.push(o);
          prev = o;
        }
      }
      if (st.L.has('earthshaker') && a.attacks % 4 === 0) {
        this.emitAbility(a.i, tg.i, 'earthshaker', ix, iy, 300, 0);
        this.near(enemy, ix, iy, 300, (d) => {
          if (d === tg || d.spawnTick > t || (d.st.tags & T_FLIER)) return;
          this.applyHit({ ...k, extra: true }, d, k.mul, false);
        });
      }
      if (st.L.has('hydra_volley') && k.melee) {
        const picked: Sol[] = [];
        for (let j = 0; j < 2; j++) {
          let best: Sol | null = null, bd = 0;
          this.near(enemy, tg.x, tg.y, 300, (o, d2) => {
            if (o === tg || picked.includes(o) || o.spawnTick > t || !this.canHit(a, o)) return;
            if (!best || d2 < bd || (d2 === bd && o.key < best.key)) { best = o; bd = d2; }
          });
          if (!best) break;
          picked.push(best);
          this.applyHit({ ...k, extra: true }, best, 55, false);
        }
      }
    }
    this.consumeCharge(a, k);
  }

  consumeCharge(a: Sol, k: Strike): void {
    if (k.extra) return;
    if (a.chargeReady) { a.chargeReady = false; this.emitAbility(a.i, k.target ? k.target.i : -1, 'charge', a.x, a.y, 0, 0); }
    a.firstStrike = false;
  }

  // ---------------------------------------------------------------- periodic effects

  periodic(): void {
    const t = this.t;
    if (t % 10 !== 0) return;
    for (const s of this.sols) {
      if (!s.alive || s.spawnTick > t) continue;
      if (s.burnUntil > t && s.burnDps) {
        const dmg = idiv(s.burnDps * (100 - (s.st.mr >> 1)), 200);
        this.credit(s, Math.max(50, dmg), s.burnSrc, -1);
      }
      if (s.st.L.has('lifebinder') && s.hp < s.maxHp) s.healAcc += idiv(s.maxHp * 3, 400);
      if (s.st.L.has('sunfire')) {
        const dmg = (20 + 2 * s.st.ilvl) * 50;
        this.near((1 - s.side) as Seat, s.x, s.y, 400, (o) => {
          if (o.spawnTick > t || o.st.tags & T_FLIER) return;
          this.credit(o, idiv(dmg * (100 - o.st.mr), 100), s, -1);
        });
      }
      // Re-arm charges after 5 s out of combat.
      if (s.st.charge && !s.chargeReady && t - s.lastAttack > 100) s.chargeReady = true;
    }
    // Keep towers.
    for (const seat of [0, 1] as Seat[]) {
      for (let n = 0; n < 2; n++) {
        const ci = seat * 2 + n;
        if (this.towerCd[ci] > 0) { this.towerCd[ci] -= 10; continue; }
        const [tx, ty] = this.keeps[seat].towers[n];
        let best: Sol | null = null, bd = 0;
        this.near((1 - seat) as Seat, tx, ty, TOWER_RANGE, (o, d2) => {
          if (o.spawnTick > t) return;
          if (!best || d2 < bd || (d2 === bd && o.key < best.key)) { best = o; bd = d2; }
        });
        if (!best) continue;
        const o = best as Sol;
        this.towerCd[ci] = TOWER_TICKS;
        const src = keepSource(seat, n);
        this.emit(EK.attack, src, o.i, WEAPON_CODES.indexOf('tower'), PROJ_CODES.indexOf('tower_arrow'), this.flight('tower_arrow', isqrt(bd), 0));
        this.launch({ kind: 'tower', owner: null, side: seat, target: o, ax: o.x, ay: o.y, fx: tx, fy: ty, mul: 100, pid: 0, proj: 'tower_arrow', melee: false, hill: false, dmg: TOWER_DMG, radius: 0, reflected: false, extra: true, towerSrc: src, seq: 0 }, isqrt(bd), 0);
      }
    }
  }

  // ---------------------------------------------------------------- end of tick

  endOfTick(): void {
    const t = this.t;
    for (const b of this.queuedBuffs) {
      if (b.kind === 'rally') b.sol.rallyUntil = Math.max(b.sol.rallyUntil, b.until);
      else b.sol.bulwarkUntil = Math.max(b.sol.bulwarkUntil, b.until);
    }
    this.queuedBuffs.length = 0;
    const deaths: Sol[] = [];
    for (const s of this.sols) {
      if (s.spawnTick > t) continue;
      s.x = s.nx; s.y = s.ny;
      if (s.relocate) { s.x = s.relocate[0]; s.y = s.relocate[1]; s.relocate = null; }
      if (!s.alive) continue;
      if (s.pendingSlow) { s.slowPct = s.pendingSlow; s.slowUntil = s.pendingSlowUntil; s.pendingSlow = 0; }
      if (s.pendingBurn) {
        if (s.burnUntil <= t || s.pendingBurn >= s.burnDps) { s.burnDps = s.pendingBurn; s.burnSrc = s.pendingBurnSrc; }
        s.burnUntil = t + 60; s.pendingBurn = 0; s.pendingBurnSrc = null;
      }
      if (s.dmgAcc || s.healAcc) {
        this.dealt[(1 - s.side) as Seat] += s.dmgAcc;
        s.hp = Math.min(s.maxHp, s.hp - s.dmgAcc + s.healAcc);
        s.dmgAcc = 0; s.healAcc = 0;
        if (s.hp <= 0) deaths.push(s);
        else { s.killer = null; s.killerDmg = 0; s.killerTower = -1; }
      }
      if (s.anim >= 2 && s.animUntil <= t) s.anim = 0;
      if (s.anim < 2) s.anim = s.moved ? 1 : 0;
    }
    for (const s of deaths) {
      const killer = s.killer, ktower = s.killerTower;
      s.killer = null; s.killerDmg = 0; s.killerTower = -1;
      if (s.undying) {
        s.undying = false;
        s.hp = idiv(s.maxHp * 50, 100);
        this.emit(EK.revive, s.i, Math.ceil(s.hp / 100), REVIVE_CODES.indexOf('undying_oath'));
        continue;
      }
      if (s.sq.phoenix) {
        s.sq.phoenix = false;
        s.hp = idiv(s.maxHp, 2);
        this.emit(EK.revive, s.i, Math.ceil(s.hp / 100), REVIVE_CODES.indexOf('phoenix'));
        continue;
      }
      s.alive = false;
      s.hp = 0;
      s.anim = 4;
      s.target = null;
      if (!s.summoned) this.lost[s.side]++;
      this.emit(EK.death, s.i, killer ? killer.i : ktower >= 0 ? ktower : -1);
      if (killer) {
        this.lordXp[killer.side] += s.xpValue;
        const kst = killer.st;
        if (kst.L.has('bloodthirst') && killer.alive) {
          killer.healAcc += idiv(killer.maxHp * 12, 100);
          if (killer.blood < 3) killer.blood++;
          this.emitAbility(killer.i, s.i, 'bloodthirst', killer.x, killer.y, 0, 0);
        }
        const kb = killer.sq;
        if (kst.L.has('gravebloom') && kb.grave < 10 && !s.summoned && !(s.st.tags & (T_LARGE | T_LORD))) {
          kb.grave++;
          this.raiseSkeleton(kb, s);
        }
      }
      if (s.st.L.has('ember_crown')) {
        this.queueStrike({ kind: 'ember', owner: s, side: s.side, target: null, ax: s.x, ay: s.y, fx: s.x, fy: s.y, mul: 100, pid: 0, proj: 'none', melee: false, hill: false, dmg: (40 + 5 * s.st.ilvl) * 100, radius: 350, reflected: false, extra: true, towerSrc: -1, seq: 0 }, 1);
      }
    }
  }

  raiseSkeleton(kb: BSquad, victim: Sol): void {
    const side = kb.side;
    let sk = this.squads.find((q) => q.summon && q.side === side && q.id === kb.id);
    if (!sk) {
      sk = {
        side, sideIdx: 100 + kb.sideIdx, id: kb.id, type: 'skeleton', lord: null, level: 1, st: skeletonStats(), sols: [], ax: victim.x, ay: victim.y,
        facing: side === 0 ? 64 : 192, engaged: true, engagedNext: true, macro: null, c2x: 0, c2y: 0, alive: 0, phoenix: false, grave: 0,
        slotErr: 0, slotErrNext: 0, abilityCd: 0, summon: true, healTarget: null, sourceSquad: null,
      };
      this.squads.push(sk);
      this.sideSquads[side].push(sk);
    }
    const s = this.addSol(sk, sk.sols.length, 0, 0, victim.x, victim.y, sk.st, this.t + 1, true);
    s.facing = victim.facing;
    this.summonCount[side]++;
    this.emit(EK.summon, s.i, kb.sols[0] ? kb.sols[0].i : -1, victim.x, victim.y);
  }

  // ---------------------------------------------------------------- the keep march

  armyAlive(side: Seat): boolean {
    for (const b of this.sideSquads[side]) {
      if (b.summon) continue;
      for (const s of b.sols) if (s.alive) return true;
    }
    return false;
  }

  survivorIds(side: Seat): number[] {
    const out: number[] = [];
    for (const b of this.sideSquads[side]) {
      if (b.summon) continue;
      if (b.sols.some((s) => s.alive)) out.push(b.id);
    }
    return out;
  }

  startMarch(w: Seat): void {
    const loserSide = (1 - w) as Seat;
    const ids = this.survivorIds(w);
    this.survivors[w] = ids;
    const dmg = keepDamageOf(this.st.players[w].squads, ids, this.st.round, true, false);
    this.keepDamage[loserSide] = dmg;
    this.marching = true;
    this.marchDue = this.t + MARCH_TICKS;
    this.marchLeft = dmg;
    let n = 0;
    for (const s of this.sols) {
      if (s.alive && s.side === loserSide) { s.alive = false; s.anim = 4; this.emit(EK.death, s.i, -1); }
      if (s.alive && s.side === w) n++;
    }
    this.marchChunk = Math.max(1, Math.ceil(dmg / Math.max(1, n * 3)));
  }

  marchSoldier(s: Sol): void {
    const loser = (1 - s.side) as Seat;
    const k = this.keeps[loser];
    const sg = sideSign(s.side);
    const off = ((s.key * 37) % 2000) - 1000;
    const gx = k.pos[0] + sg * off;
    const gy = k.pos[1] - sg * (600 + ((s.key * 13) % 300));
    const dx = gx - s.x, dy = gy - s.y, d2 = dx * dx + dy * dy;
    const flier = (s.st.tags & T_FLIER) !== 0;
    const sp = this.groundSpeed(s.st.speed * 2, s.x, s.y, flier, 0);
    const reach = s.st.ranged ? Math.min(s.st.range, 1800) : 250;
    if (d2 <= reach * reach || (dy * sg >= 0 && d2 <= 1200 * 1200)) {
      s.facing = faceOr(s.facing, k.pos[0] - s.x, k.pos[1] - s.y);
      if (s.cd <= 0 && this.marchLeft > 0 && !s.st.healer) {
        s.cd += s.st.atk * 100;
        s.anim = 2; s.animUntil = this.t + Math.min(s.st.atk, 10);
        const tgt = keepSource(loser, 2);
        this.emit(EK.attack, s.i, tgt, WEAPON_CODES.indexOf(s.st.weapon), PROJ_CODES.indexOf(s.st.proj), s.st.proj !== 'none' ? this.flight(s.st.proj, isqrt(d2), 0) : 6);
        const strike: Strike = { kind: 'keep', owner: s, side: s.side, target: null, ax: k.pos[0], ay: k.pos[1], fx: s.x, fy: s.y, mul: 100, pid: 0, proj: s.st.proj, melee: !s.st.ranged, hill: false, dmg: 0, radius: 0, reflected: false, extra: true, towerSrc: -1, seq: 0 };
        if (s.st.proj !== 'none') this.launch(strike, isqrt(d2), 0); else this.queueStrike(strike, 6);
      }
      this.separate(s, 0, 0, sp);
      return;
    }
    let vx: number, vy: number;
    if (!flier && this.acrossRiver2(2 * s.y - (FIELD_H - 1), 2 * gy - (FIELD_H - 1))) { const f = this.flowDir(s.side, s.x, s.y); vx = idiv(f[0] * sp, 1000); vy = idiv(f[1] * sp, 1000); }
    else { const d = isqrt(d2); vx = idiv(dx * sp, d); vy = idiv(dy * sp, d); }
    this.separate(s, vx, vy, sp);
  }

  keepHitStrike(k: Strike): void {
    const seat = (1 - k.side) as Seat;
    if (k.proj !== 'none') this.emit(EK.impact, k.pid, k.ax, k.ay, PROJ_CODES.indexOf(k.proj), 0);
    if (this.marchLeft <= 0) return;
    const d = Math.min(this.marchLeft, this.marchChunk);
    this.marchLeft -= d;
    this.hitKeep(seat, k.owner ? k.owner.i : -1, d, false);
  }

  hitKeep(seat: Seat, src: number, dmg: number, final: boolean): void {
    this.keepHp[seat] = Math.max(0, this.keepHp[seat] - dmg);
    this.emit(EK.keepHit, seat, src, dmg, this.keepHp[seat], final ? 1 : 0);
    const stg = this.stageOf(seat, this.keepHp[seat]);
    if (stg !== this.keepStage[seat]) { this.keepStage[seat] = stg; this.emit(EK.keepStage, seat, stg); }
  }

  // ---------------------------------------------------------------- keyframes

  recordFrame(): void {
    const sols = this.sols, t = this.t;
    this.frames.frame(
      sols.length,
      (i) => sols[i].spawnTick <= t,
      (i) => sols[i].x,
      (i) => sols[i].y,
      (i) => sols[i].facing,
      (i) => (sols[i].alive ? Math.max(1, Math.ceil(sols[i].hp / 100)) : 0),
      (i) => (sols[i].alive ? sols[i].anim : 4),
    );
  }

  // ---------------------------------------------------------------- main loop

  run(): void {
    const maxT = MAX_BATTLE_TICKS + MARCH_TICKS;
    for (this.t = 0; this.t <= maxT; this.t++) {
      const t = this.t;
      if (this.record && t % KEYFRAME_TICKS === 0) this.recordFrame();
      if (this.marching) {
        if (this.marchLeft <= 0 && this.pendingEmpty()) { this.finish(); return; }
        if (t >= this.marchDue) {
          if (this.marchLeft > 0) { this.hitKeep((1 - this.winner!) as Seat, keepSource((1 - this.winner!) as Seat, 2), this.marchLeft, true); this.marchLeft = 0; }
          this.finish();
          return;
        }
      } else {
        const a0 = this.armyAlive(0), a1 = this.armyAlive(1);
        if (!a0 || !a1 || t >= MAX_BATTLE_TICKS) {
          this.fightTicks = t;
          if (!a0 && !a1) { this.winner = null; this.finish(); return; }
          if (t >= MAX_BATTLE_TICKS && a0 && a1) {
            this.timeout = true;
            for (const side of [0, 1] as Seat[]) this.survivors[side] = this.survivorIds(side);
            for (const side of [0, 1] as Seat[]) {
              const dmg = keepDamageOf(this.st.players[side].squads, this.survivors[side], this.st.round, false, true);
              this.keepDamage[(1 - side) as Seat] = dmg;
              if (dmg > 0) this.hitKeep((1 - side) as Seat, keepSource((1 - side) as Seat, 2), dmg, true);
            }
            this.finish();
            return;
          }
          this.winner = a0 ? 0 : 1;
          this.startMarch(this.winner);
          if (this.marchLeft <= 0) { this.finish(); return; }
        }
      }
      this.rebuildBuckets();
      this.squadPass();
      if (!this.marching) this.lordPass();
      this.soldierPass();
      this.resolveStrikes();
      if (!this.marching) this.periodic();
      this.endOfTick();
    }
    this.finish();
  }

  pendingEmpty(): boolean {
    for (const l of this.pending) if (l.length) return false;
    return true;
  }

  finish(): void {
    // Every projectile gets an 'impact': ones still in flight when the battle ends land (harmlessly) now.
    for (let i = 0; i < this.pending.length; i++) {
      const list = this.pending[i];
      for (const k of list) if (k.pid > 0) this.emit(EK.impact, k.pid, k.target && k.proj !== 'stone' ? k.target.x : k.ax, k.target && k.proj !== 'stone' ? k.target.y : k.ay, PROJ_CODES.indexOf(k.proj), k.radius);
      this.pending[i] = [];
    }
    this.endTick = this.t;
    if (!this.fightTicks) this.fightTicks = this.t;
    if (this.record && this.t % KEYFRAME_TICKS !== 0) this.recordFrame();
  }

  output(): BattleOutput {
    const result: BattleResult = {
      round: this.st.round,
      winner: this.winner,
      timeout: this.timeout,
      keepDamage: [this.keepDamage[0], this.keepDamage[1]],
      survivors: [this.survivors[0], this.survivors[1]],
      lordXp: [this.lordXp[0] + (this.winner === 0 ? 20 : 8), this.lordXp[1] + (this.winner === 1 ? 20 : 8)],
      ticks: this.fightTicks,
      damageDealt: [Math.round(this.dealt[0] / 100), Math.round(this.dealt[1] / 100)],
      soldiersLost: [this.lost[0], this.lost[1]],
    };
    const soldiers: ReplaySoldier[] = this.sols.map((s) => {
      const src = s.sq.sourceSquad;
      const items = src ? (['weapon', 'armor', 'relic'] as const).filter((k) => src.items[k]).map((k) => {
        const it = src.items[k]!;
        return { slot: it.slot, rarity: it.rarity, base: it.base, legendary: it.legendary };
      }) : [];
      const flags: string[] = [];
      if (s.st.tags & T_FLIER) flags.push('flier');
      if (s.st.tags & T_LARGE) flags.push('large');
      if (s.st.tags & T_MOUNTED) flags.push('mounted');
      if (s.sq.type !== 'lord' && s.sq.level >= 3) flags.push('elite');
      if (s.sq.type !== 'lord' && s.sq.level >= 5) flags.push('champion');
      if (items.some((x) => x.legendary)) flags.push('legendary');
      if (s.summoned) flags.push('skeleton');
      const row: ReplaySoldier = {
        id: s.i, squad: s.sq.id, side: s.side, type: s.sq.type,
        modelId: s.sq.type === 'lord' ? LORDS[s.sq.lord!].modelId : s.sq.type === 'skeleton' ? 'skeleton' : UNITS[s.sq.type].modelId,
        level: s.sq.level, maxHp: Math.ceil(s.maxHp / 100), items, flags, spawnTick: s.spawnTick, summoned: s.summoned,
      };
      if (s.sq.lord) row.lord = s.sq.lord;
      return row;
    });
    let frames = '', events = '';
    if (this.record) {
      frames = toBase64(this.frames.w.bytes());
      events = toBase64(encodeEvents(this.ev));
    }
    const replay: Replay = {
      v: 2, seed: this.seed, round: this.st.round, ticks: this.endTick, frameTicks: KEYFRAME_TICKS,
      frameCount: this.record ? this.frames.frames : 0, soldiers, keeps: this.keeps, terrain: this.st.terrain, frames, events,
      eventCount: this.record ? this.evCount : 0, result,
    };
    return { replay, result };
  }
}

/** Simulate the battle for the current round. Pure: does not modify `state`. */
export function simulateBattle(state: MatchState, opts: SimulateOptions = {}): BattleOutput {
  const b = new Battle(state, opts.record !== false);
  b.run();
  return b.output();
}

export { T_FLIER, GRID_W, CELL };
