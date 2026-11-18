// Real-time deterministic battle (DESIGN §7). 20 Hz, integer maths, and NO random rolls at all: critical hits come
// on a per-soldier counter (every 100 / crit% attacks), forest cover is a flat damage reduction, and the first-attack
// stagger depends only on a soldier's place in its own army. The same two armies always fight the same battle.
//
// Fairness by construction (see tests/sim.mirror.test.ts):
//  * Positions are ints whose 180-degree mirror is exact (x -> 7999 - x); all divisions truncate (sign-symmetric).
//  * Every tick is "Jacobi": decisions read the tick-start snapshot, damage/heal/buffs/deaths accumulate and are
//    applied at the end of the tick, so nothing depends on whether seat 0 or seat 1 is processed first.
//  * Per-soldier counters (crit, attack stagger) are keyed by the squad's index in its own army and the soldier's
//    index in the squad — never by the seat or the match seed.
//  * Seat 1's flow field is the exact mirror of seat 0's.
import { CELL, COUNTER_PCT, FIELD_H, FIELD_W, GRID_W, KEYFRAME_TICKS, MARCH_TICKS, MAX_BATTLE_TICKS } from './constants.ts';
import {
  ARCHMAGE_MAGIC_PCT, LICH_DMG_PCT, LORDS, LORD_LEVEL_DMG, LORD_LEVEL_HP, METEOR_BASE, METEOR_PER_LEVEL, NECRO_BASE, NECRO_LEVELS_PER, NECRO_RANGE,
  RADIANCE_BASE, RADIANCE_PER_LEVEL, RADIANCE_RANGE, RALLY_PCT, RALLY_RANGE, BULWARK_RANGE, METEOR_REACH, LORD_TRIGGER_RANGE, SULTANA_HASTE_PCT, SULTANA_HOLY, SUN_PRIEST_HOLY,
  DK_INFANTRY_PCT, SOUL_REAP_PCT, SOUL_REAP_RANGE, SOUL_REAP_TICKS, OSSUARY_ARMOR, TAUNT_GUARD_PCT, TAUNT_RANGE, TAUNT_TICKS, DRAKE_SPEED_PCT, PLAGUE_BURN_BASE,
  PLAGUE_BURN_PER_LEVEL, PLAGUE_PCT, PLAGUE_RADIUS, PLAGUE_REACH, VIZIER_HASTE_PCT, WHIRL_BASE, WHIRL_PER_LEVEL, WHIRL_RADIUS, WHIRL_REACH, WHIRL_SLOW, WHIRL_WAVES,
  RAJAH_GIANT_ARMOR, RAJAH_GIANT_HP, STAMPEDE_BASE, STAMPEDE_KNOCK, STAMPEDE_LEN, STAMPEDE_PER_LEVEL, STAMPEDE_REACH, STAMPEDE_WIDTH, ROC_RANGED_PCT, TALON_PCT,
  TALON_REACH, TALON_STUN, TALON_THROW,
} from './data/lords.ts';
import { ABILITY_CD, SKILLS, SKILL_START_CD, canEquip, classesOf, skillNum } from './data/skills.ts';
import { UNITS, formationCols, growsBySize, squadSizeAt } from './data/units.ts';
import { WHEEL, beatsClass, wheelIndex } from './data/wheel.ts';
import { FACTION_POWER, LORD_POWER, UNIT_POWER } from './data/balance.ts';
import { angleOf, icos, idiv, isin, isqrt } from './fixed.ts';
import { modsOf, warhornSoldiers, type ItemMods } from './loot.ts';
import { LEVEL_DMG_PCT, LEVEL_HP_PCT, keepDamageOf } from './match.ts';
import {
  ABILITY_CODES, ARC_CODES, EK, FrameEncoder, KEEP_SRC_BASE, PROJ_CODES, REPLAY_VERSION, REVIVE_CODES, SKILL_CODES, STAT_CAUSES, TALLY_TICKS, WEAPON_CODES,
  encodeEvents, keepSource, toBase64,
} from './replay.ts';
import { DIRS, KIND_CODE, MOVE_PCT, RIVER_Y0, RIVER_Y1, cellOf, navFor } from './terrain.ts';
import type {
  AbilityEventKind, AbilityId, ArcType, BattleEnd, BattleOutput, BattleResult, DamageType, KeepInfo, LordId, MatchState, ProjectileKind, Replay, ReplaySoldier,
  ReplaySquad, Seat, SimulateOptions, SkillId, SoldierType, Squad, StatCause, Tag, Vec2, WeaponKind,
} from './types.ts';

/** Ledger cause codes (index into STAT_CAUSES). */
const cz = (c: StatCause): number => STAT_CAUSES.indexOf(c);
const C_ATTACK = cz('attack'), C_BURN = cz('burn'), C_THORNS = cz('thorns'), C_TOWER = cz('tower'), C_CHAIN = cz('chain'), C_EMBER = cz('ember_burst'),
  C_SUNFIRE = cz('sunfire'), C_METEOR = cz('meteor'), C_SKYFALL = cz('skyfall'), C_HEAL = cz('heal'), C_LEECH = cz('leech'), C_LIFEBINDER = cz('lifebinder'),
  C_BLOOD = cz('bloodthirst'), C_REVIVE = cz('revive'), C_ROUT = cz('rout'), C_RADIANCE = cz('radiance'), C_REGEN = cz('regen'),
  C_SOUL_REAP = cz('soul_reap'), C_PLAGUE = cz('plague_breath'), C_WHIRL = cz('whirlwind'), C_STAMPEDE = cz('stampede'), C_TALON = cz('talon');

// ---------------------------------------------------------------- tuning constants

const T_MOUNTED = 1, T_ARMORED = 2, T_FLIER = 4, T_LARGE = 8, T_INFANTRY = 16, T_LORD = 32;
const TAG_BIT: Record<Tag, number> = { mounted: T_MOUNTED, armored: T_ARMORED, flier: T_FLIER, large: T_LARGE, infantry: T_INFANTRY };
const PROJ_SPEED: Partial<Record<ProjectileKind, number>> = { arrow: 160, bolt: 260, stone: 90, fireball: 110, firebreath: 140, tower_arrow: 160, lightning: 1000, sunbeam: 1000 };
const PROJ_ARC: Partial<Record<ProjectileKind, ArcType>> = { arrow: 'arc', bolt: 'line', stone: 'high_arc', fireball: 'line', firebreath: 'line', tower_arrow: 'arc', lightning: 'line', sunbeam: 'line' };
const BASE_CRIT = 5;
const CRIT_MULT = 150;
const LEVEL_HP = LEVEL_HP_PCT;
const LEVEL_DMG = LEVEL_DMG_PCT;
const AGGRO = 1400;
/** Lord stances (LordStance in types.ts): a Lord told to hold or to follow is tethered to a spot. He chases only what
 *  stands within HOLD_LEASH of it (a ranged Lord: his range + 3 m) and walks back to it. */
const ST_ADVANCE = 0, ST_HOLD = 1, ST_FOLLOW = 2;
export const HOLD_LEASH = 1400;
/** A following Lord's spot: this far behind the centre of the squad he follows, towards his own Keep. */
export const FOLLOW_BEHIND = 600;
const BUCKET = 400;
const BW = FIELD_W / BUCKET, BH = FIELD_H / BUCKET;
/** Skeletons raised in battle (Grave Acolytes, the Lich-Priest, Gravebloom): 120 life, 16 damage a blow. */
const SKELETON = { hp: 12000, dmg: 1600, atk: 22, speed: 15, radius: 45, range: 120 };
/** Ranged damage a flier shrugs off when shot from the ground (percent; unitSkills quotes it). */
export const FLIER_EVADE_PCT = 30;
/** Grave Acolytes: a squad raises at most RAISE_BASE + its level skeletons per battle; Sun Priests' blessing: +BLESS_PCT% attack speed for BLESS_TICKS. */
export const RAISE_BASE = 3;
export const BLESS_PCT = 15;
export const BLESS_TICKS = 80;
/** Legendary numbers (the item texts in data/items.ts quote these). */
const HYDRA_PCT = 40, KINGSBANE_PCT = 300, FROSTHEART_PCT = 30, STORM_PCT = 30, BLOOD_HEAL_PCT = 10, BLOOD_HASTE = 10, GRAVE_MAX = 14;
/** Kingsbane's triple damage hits Lords and the Giant class. */
const KINGSBANE_WC = wheelIndex('giant');
const KEEP_Y = 150;
/** Keep centre -> its front wall face, half the wall's width, and tower centre -> its foot (cm).
 *  Must match the castle the renderer draws (src/render/terrain/keep.ts: the art Keep's footprint). */
const KEEP_FRONT = 340;
const KEEP_HALF_W = 850;
const TOWER_FRONT = 230;
const TOWER_RANGE = 2200, TOWER_DMG = 900, TOWER_TICKS = 30;
/** Global damage scale (percent) — sets the overall battle pace. */
const DMG_SCALE = 200;
/** Stall detection: no damage for STALL_TICKS after the first contact (or no contact by NO_CONTACT_TICKS) ends the battle. */
export const STALL_TICKS = 200;
export const NO_CONTACT_TICKS = 1200;
/** One side unable to target anything left on the other side for this long also ends the battle: the other side wins it (endOnPoints). */
export const HELPLESS_TICKS = 200;
/** A timeout / stalemate is won on points by a lead of at least this many percentage points; closer is a draw. */
export const POINTS_MARGIN = 5;
/** Army value of the Lord for points: LORD_POINTS_BASE + LORD_POINTS_PER_LEVEL x level. */
const LORD_POINTS_BASE = 300, LORD_POINTS_PER_LEVEL = 30;

/** Wheel index of the raised skeletons' class (Swarm). */
const SKELETON_WC = wheelIndex('swarm');
/** How much nearer (cm) a ranged squad / soldier counts a target of the class it beats on the wheel. */
const PREF_CLASS_SQUAD = 2000, PREF_CLASS_SOL = 1500;


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
  /** Wheel class (index into WHEEL) and the index of the class it beats. */
  wc: number;
  beats: number;
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
  /** Ranged: aims first at targets of the class it beats on the wheel (archers at fliers, siege at casters...). */
  prefCls: boolean;
  /** Cavalry / pegasus: hunt the enemy backline (ranged, healers, artillery). */
  raider: boolean;
  /** Faction traits: raises skeletons from corpses; heals also quicken; regeneration (tenths of a percent of max life per second). */
  raise: boolean;
  bless: boolean;
  regen: number;
  /** Sunlight against the dead: `holy` = damage percent against undead targets (100 = none); `undead` = an Ashen unit, the Lich or a raised skeleton. */
  holy: number;
  undead: boolean;
  magicBonus: number;
  L: Set<string>;
  ilvl: number;
  phoenix: boolean;
  /** Item-granted active skills (already filtered by class). */
  skills: { id: SkillId; ilvl: number }[];
}
export type BattleStats = Stats;

interface BSquad {
  /** Index in Battle.squads = row in Replay.squads. */
  row: number;
  skills: { id: SkillId; ilvl: number; cd: number }[];
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
  /** Lord stance (ST_*), the squad a following Lord follows, and the tether spot in doubled-centred coordinates. */
  stance: number;
  leader: BSquad | null;
  t2x: number; t2y: number;
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
  /** Presentation only (never read by the rules): the tick the last 'burn' event's flames run out. */
  burnFxUntil: number;
  slowPct: number; slowUntil: number;
  /** Presentation only (never read by the rules): who applied the current slow, and the tick the last 'frost' event's window runs out. */
  slowSrc: Sol | null; slowFxUntil: number;
  rallyUntil: number; bulwarkUntil: number;
  /** Soul Reaping (Death Knight): extra life drain until this tick. Grave Taunt (Ossuary Warden): must attack `tauntBy`
   *  until `tauntUntil`. Talon Strike (Roc Rider): stunned (no move, no attack) until `stunUntil`; `pendingStun` is applied at
   *  the end of the tick. */
  reapUntil: number; tauntBy: Sol | null; tauntUntil: number; stunUntil: number; pendingStun: number;
  dmgAcc: number; healAcc: number; killer: Sol | null; killerDmg: number; killerTower: number;
  attacks: number; blood: number;
  summoned: boolean;
  moved: boolean;
  relocate: Vec2 | null;
  pendingSlow: number; pendingSlowUntil: number; pendingSlowSrc: Sol | null;
  pendingBurn: number; pendingBurnSrc: Sol | null;
  xpValue: number;
  dealt: number;
  // Skill buffs (applied at end of tick, like Rally).
  wallUntil: number; wallPct: number; cryUntil: number; cryPct: number; cleaveUntil: number; cleavePct: number;
  /** A corpse already raised as a skeleton by seat 0 (bit 0) / seat 1 (bit 1): each side may use a corpse once. */
  rz: number;
  /** Crit counter: +crit% per attack; an attack that takes it to 100 is critical (and takes 100 off). */
  critAcc: number;
  /** Knockback displacement to apply at the end of this tick. */
  kx: number; ky: number;
  /** Ledger cause of the current burn (C_BURN, or the skill that lit it). */
  burnCause: number; pendingBurnCause: number;
  /** Ledger scratch: effective / raw damage and healing left to attribute this tick. */
  eD: number; rD: number; eH: number; rH: number;
}

/** Riders of a skill strike (kind 'skill'). */
interface SkFx {
  /** Flat damage in centi-HP; 0 = `mul` percent of the owner's attack damage. */
  dmg: number;
  type: DamageType;
  /** Burn in centi-HP per second, slow percent and its duration in ticks, knockback distance in cm. */
  burn: number; slow: number; slowTicks: number; knock: number;
  /** Does not touch fliers. */
  ground: boolean;
}

interface Strike {
  kind: 'hit' | 'meteor' | 'skyfall' | 'ember' | 'keep' | 'tower' | 'skill';
  /** Ledger cause (default: a plain attack) and, for kind 'skill' or skill volleys, the riders. */
  cause?: number;
  sk?: SkFx;
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
  /** The owner's attack count when the strike was made (kept for debugging; nothing is rolled from it). */
  seq: number;
  /** A critical strike (decided by the attacker's crit counter when it swung): every hit of the strike is x1.5. */
  crit?: boolean;
  /** A skill strike the owner dives with (Plague Breath): the owner lands on the impact point. */
  dive?: boolean;
}

// ---------------------------------------------------------------- stats

function hasL(m: ItemMods, l: string): boolean {
  return m.legend.has(l);
}

/** Battle stats of a squad (per soldier; hp / dmg / heal in centi-HP). Exported for squadSheet (sheet.ts). */
export function buildStats(sq: Pick<Squad, 'type' | 'level' | 'items'>, lordOf: LordId | null): Stats {
  // Legendary powers count only on the wheel classes they are built for (legendaryFits).
  const m = modsOf(sq.items, sq.type, lordOf);
  let base;
  let lvlHp: number, lvlDmg: number;
  let traits: string[] = [];
  let tags: number;
  let heal = 0, lifesteal = 0, minRange = 0, splash = 0, radius = 60, innateBurn = 0, innateSlow = 0, regen = 0;
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
    // Swarm squads level by adding soldiers (squadSize), not by making each soldier stronger.
    const grow = growsBySize(sq.type);
    lvlHp = grow ? 100 : 100 + LEVEL_HP * (sq.level - 1);
    lvlDmg = grow ? 100 : 100 + LEVEL_DMG * (sq.level - 1);
    tags = 0;
    for (const t of U.tags) tags |= TAG_BIT[t];
    traits = U.traits;
    heal = U.heal;
    lifesteal = U.lifesteal;
    minRange = U.minRange;
    splash = U.splash;
    radius = U.radius;
    innateBurn = U.burn;
    innateSlow = U.slow;
    regen = U.regen;
  }
  const wardenHp = lordOf === 'warden' ? 10 : 0;
  // The newer Lords' passives, by the class of the squad (classesOf: a Lord is also of its fighting class).
  const cls = classesOf(sq.type, lordOf);
  const rajahGiant = lordOf === 'rajah' && cls.includes('giant');
  // Power in 1/100000: percent x per mille (a unit's own multiplier times its faction's; Lords have only their own).
  const pw = sq.type === 'lord' ? LORD_POWER[lordOf!] * 1000 : UNIT_POWER[sq.type] * FACTION_POWER[UNITS[sq.type].faction];
  let hpPct = 100 + m.hp + wardenHp + (rajahGiant ? RAJAH_GIANT_HP : 0);
  let dmgPct = 100 + m.dmg + (lordOf === 'lich' ? LICH_DMG_PCT : 0) + (lordOf === 'deathknight' && cls.includes('infantry') ? DK_INFANTRY_PCT : 0)
    + (lordOf === 'rocrider' && cls.includes('ranged') ? ROC_RANGED_PCT : 0);
  const size = sq.type === 'lord' ? 1 : UNITS[sq.type].squadSize;
  const wc = wheelIndex(sq.type === 'lord' ? LORDS[lordOf!].class : UNITS[sq.type].class);
  if (hasL(m, 'warhorn') && size <= 2) { hpPct += 35; dmgPct += 35; }
  const ranged = base.range > 400;
  const weapon = base.weapon;
  let speedPct = 100 + m.move + (hasL(m, 'windrunner') ? 40 : 0) + (lordOf === 'drakerider' ? DRAKE_SPEED_PCT : 0);
  const windAs = hasL(m, 'windrunner') ? 25 : 0;
  const atk = Math.max(4, idiv(base.attackTicks * 100, 100 + m.as + windAs + (lordOf === 'sultana' ? SULTANA_HASTE_PCT : 0)
    + (lordOf === 'vizier' && base.damageType === 'magic' ? VIZIER_HASTE_PCT : 0)));
  const st: Stats = {
    hp: idiv(idiv(base.hp * lvlHp * hpPct, 100) * pw, 100000),
    dmg: idiv(idiv(base.dmg * lvlDmg * dmgPct * DMG_SCALE, 10000) * pw, 100000),
    atk,
    range: base.range + (ranged ? m.range : 0),
    minRange,
    speed: idiv(base.speed * speedPct, 100),
    armor: Math.min(80, base.armor + m.armor + (lordOf === 'ossuary' ? OSSUARY_ARMOR : 0) + (rajahGiant ? RAJAH_GIANT_ARMOR : 0)),
    // May be negative (ethereal Wraith Riders): magic then deals more than its listed damage.
    mr: Math.min(80, base.magicResist + m.mr),
    splash,
    radius,
    crit: BASE_CRIT + m.crit,
    leech: lifesteal + m.leech,
    thorns: m.thorns,
    burn: Math.max(m.burn, innateBurn),
    frost: hasL(m, 'frostheart') ? 40 : Math.max(m.frost, innateSlow),
    heal: idiv(idiv(heal * lvlDmg * dmgPct, 100) * pw, 100000),
    tags,
    weapon,
    dmgType: base.damageType,
    proj: base.projectile,
    wc,
    beats: wheelIndex(beatsClass(WHEEL[wc])),
    slay: m.slay,
    ranged,
    canHitAir: (ranged && weapon !== 'stone') || traits.includes('howdah') ? true : (tags & T_FLIER) !== 0,
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
    prefCls: ranged,
    raider: traits.includes('raider'),
    raise: traits.includes('raise'),
    bless: traits.includes('bless'),
    regen,
    holy: sq.type === 'sun_priest' ? SUN_PRIEST_HOLY : lordOf === 'sultana' && sq.type === 'lord' ? SULTANA_HOLY : 100,
    undead: sq.type === 'lord' ? LORDS[lordOf!].faction === 'ashen' : UNITS[sq.type].faction === 'ashen',
    magicBonus: lordOf === 'archmage' && base.damageType === 'magic' ? ARCHMAGE_MAGIC_PCT : 0,
    L: m.legend,
    ilvl: m.ilvl,
    phoenix: m.phoenix,
    skills: m.skills.filter((k) => canEquip({ skill: k.id }, sq.type, lordOf)),
  };
  if (st.healer) st.canHitAir = true;
  speedPct = 0;
  return st;
}

function skeletonStats(): Stats {
  return {
    hp: SKELETON.hp, dmg: SKELETON.dmg, atk: SKELETON.atk, range: SKELETON.range, minRange: 0, speed: SKELETON.speed, armor: 0, mr: 0, splash: 0,
    radius: SKELETON.radius, crit: 0, leech: 0, thorns: 0, burn: 0, frost: 0, heal: 0, tags: T_INFANTRY, weapon: 'sword', dmgType: 'physical',
    proj: 'none', wc: SKELETON_WC, beats: wheelIndex(beatsClass('swarm')), slay: {}, ranged: false, canHitAir: false, healer: false, brace: false, charge: false, pierce: false, stomp: false,
    cone: false, slowTurn: false, ignoresArmor: false, crushing: false, backline: false, prefCls: false, raider: false, raise: false, bless: false, regen: 0, holy: 100, undead: true, magicBonus: 0,
    L: new Set(), ilvl: 1, phoenix: false, skills: [],
  };
}

/** Soldiers in the squad at the start of a battle (Warhorn adds some). */
export function squadSize(sq: Pick<Squad, 'type' | 'items'> & { level?: number }): number {
  if (sq.type === 'lord') return 1;
  // Swarm squads grow by level (squadSizeAt); others keep their size.
  const n = squadSizeAt(sq.type, sq.level ?? 1);
  const m = modsOf(sq.items, sq.type, null);
  if (m.legend.has('warhorn')) return n + warhornSoldiers(sq.type);
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
  /** Classic events only (Replay.eventCount); skill and tally events are not counted. */
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
  end: BattleEnd = 'wipe';
  score: [number, number] = [0, 0];
  lastDamageTick = -1;
  helplessSince = -1;
  /** When a stalemate is called: which sides could no longer damage the other (BattleResult.helpless). Exactly one = that side loses. */
  helpless: [boolean, boolean] | null = null;
  marching = false;
  marchDue = 0;
  marchLeft = 0;
  marchChunk = 0;
  keepDamage: [number, number] = [0, 0];
  survivors: [number[], number[]] = [[], []];
  /** The fallen that can still be raised as skeletons (no Lords, no Large units, no summons). */
  corpses: Sol[] = [];
  queuedBuffs: { sol: Sol; kind: 'rally' | 'bulwark' | 'wall' | 'cry' | 'cleave' | 'reap' | 'taunt'; until: number; pct: number; by?: Sol }[] = [];
  // Statistics ledger (only when recording): this tick's raw contributions, and the running TALLY_TICKS window.
  cT: Sol[] = []; cS: number[] = []; cC: number[] = []; cA: number[] = []; cM: number[] = []; cH: number[] = [];
  tally = new Map<number, [number, number, number, number]>();

  constructor(st: MatchState, record: boolean) {
    this.st = st;
    this.record = record;
    // Carried in the replay header only: the battle itself rolls nothing.
    this.seed = st.seed;
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
    // Lord stances. 'follow' names a squad of the same army; one that is not there means 'advance'.
    for (const b of this.squads) {
      const want = b.type === 'lord' ? b.sourceSquad?.stance : undefined;
      if (!want || want.t === 'advance') continue;
      if (want.t === 'hold') {
        b.stance = ST_HOLD;
        b.t2x = 2 * b.ax - (FIELD_W - 1); b.t2y = 2 * b.ay - (FIELD_H - 1);
      } else if (want.t === 'follow') {
        const lead = this.sideSquads[b.side].find((o) => o !== b && o.id === want.squad && o.type !== 'lord') ?? null;
        if (lead) { b.stance = ST_FOLLOW; b.leader = lead; }
      }
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
      row: this.squads.length, skills: stats.skills.map((k) => ({ id: k.id, ilvl: k.ilvl, cd: SKILL_START_CD })),
      side, sideIdx: idx, id: sq.id, type: sq.type, lord: sq.type === 'lord' ? lord : null, level: sq.level, st: stats, sols: [],
      ax: sq.pos[0], ay: sq.pos[1], facing: sq.facing & 255, engaged: false, engagedNext: false, macro: null, c2x: 0, c2y: 0, alive: n,
      phoenix: stats.phoenix, grave: 0, slotErr: 0, slotErrNext: 0, abilityCd: sq.type === 'lord' ? 100 : 0, summon: false, healTarget: null,
      sourceSquad: sq, stance: ST_ADVANCE, leader: null, t2x: 0, t2y: 0,
    };
    // Formation: rows across the facing direction.
    const cols = formationCols(n);
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
      // First attacks are staggered over half an attack interval by the soldier's place in its army (no randomness).
      cd: ((b.sideIdx * 7 + k * 13) % 50) * st.atk, target: null, facing: b.facing, anim: 0, animUntil: 0,
      chargeReady: st.charge, firstStrike: st.L.has('windrunner'), lastAttack: -1000, reflects: st.L.has('mirror_aegis') ? 3 : 0,
      undying: st.L.has('undying_oath'), burnDps: 0, burnUntil: 0, burnSrc: null, burnFxUntil: 0, slowPct: 0, slowUntil: 0, slowSrc: null, slowFxUntil: 0, rallyUntil: 0, bulwarkUntil: 0,
      reapUntil: 0, tauntBy: null, tauntUntil: 0, stunUntil: 0, pendingStun: 0,
      dmgAcc: 0, healAcc: 0, killer: null, killerDmg: 0, killerTower: -1, attacks: 0, blood: 0, summoned, moved: false, relocate: null,
      pendingSlow: 0, pendingSlowUntil: 0, pendingSlowSrc: null, pendingBurn: 0, pendingBurnSrc: null,
      xpValue: b.type === 'lord' ? 30 : summoned ? 0 : Math.max(1, Math.round(UNITS[b.type as keyof typeof UNITS].cost / UNITS[b.type as keyof typeof UNITS].squadSize / 8)),
      dealt: 0,
      wallUntil: 0, wallPct: 0, cryUntil: 0, cryPct: 0, cleaveUntil: 0, cleavePct: 0, kx: 0, ky: 0, burnCause: C_BURN, pendingBurnCause: C_BURN,
      eD: 0, rD: 0, eH: 0, rH: 0, critAcc: (b.sideIdx * 29 + k * 37) % 100, rz: 0,
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
    if (kind < EK.skill) this.evCount++;
  }
  emitAbility(src: number, tgt: number, a: AbilityEventKind, x: number, y: number, radius: number, dur: number): void {
    this.emit(EK.ability, src, tgt, ABILITY_CODES.indexOf(a), x, y, radius, dur);
  }

  /** A 'skill' event: `lead` casts `id` at (x, y) / soldier `tgt` / squad `tb`. */
  emitSkill(lead: Sol, id: SkillId, tgt: Sol | null, tb: BSquad | null, x: number, y: number, radius: number, dur: number): void {
    this.emit(EK.skill, lead.i, lead.sq.row, SKILL_CODES.indexOf(id), tgt ? tgt.i : -1, tb ? tb.row : -1, x, y, radius, dur);
    lead.anim = 3; lead.animUntil = this.t + 12;
  }

  /** Ledger: note a raw contribution to soldier `d` this tick (settled against the HP it really lost / gained in endOfTick). */
  note(d: Sol, src: number, cause: number, amt: number, mit: number, heal: number): void {
    this.cT.push(d); this.cS.push(src); this.cC.push(cause); this.cA.push(amt); this.cM.push(mit); this.cH.push(heal);
  }
  tallyAdd(src: number, tgtRow: number, cause: number, dmg: number, mit: number, heal: number, n: number): void {
    // The stream stores unsigned numbers: a negative amount would corrupt everything after it.
    if (dmg < 0) dmg = 0;
    if (mit < 0) mit = 0;
    if (heal < 0) heal = 0;
    const key = ((src >= KEEP_SRC_BASE ? 3000 + (src - KEEP_SRC_BASE) : src + 1) * 4096 + tgtRow) * 64 + cause;
    const e = this.tally.get(key);
    if (e) { e[0] += dmg; e[1] += mit; e[2] += heal; e[3] += n; }
    else this.tally.set(key, [dmg, mit, heal, n]);
  }
  flushTally(): void {
    if (!this.tally.size) return;
    for (const [key, e] of this.tally) {
      if (!e[0] && !e[1] && !e[2]) continue;
      const cause = key % 64, rest = (key - cause) / 64, tgt = rest % 4096, s = (rest - tgt) / 4096;
      this.emit(EK.tally, s >= 3000 ? KEEP_SRC_BASE + (s - 3000) : s - 1, tgt, cause, e[0], e[1], e[2], e[3]);
    }
    this.tally.clear();
  }
  /** Queue a heal on `o` from `by` (applied at the end of the tick). */
  heal(o: Sol, amt: number, by: Sol | null, cause: number): void {
    o.healAcc += amt;
    if (this.record) this.note(o, by ? by.sq.row : -1, cause, amt, 0, 1);
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
    // Lord stances: a holding Lord is released when no other squad of his is left, a following one when the squad he
    // follows has fallen; from then on he advances like any squad, from where he stands.
    for (const b of this.squads) {
      if (b.stance === ST_ADVANCE || !b.alive) continue;
      let free: boolean;
      if (b.stance === ST_HOLD) {
        free = true;
        for (const a of this.sideSquads[b.side]) if (a !== b && !a.summon && a.alive) { free = false; break; }
      } else {
        const lead = b.leader!;
        free = !lead.alive;
        if (!free) { b.t2x = lead.c2x; b.t2y = lead.c2y - sideSign(b.side) * 2 * FOLLOW_BEHIND; }
      }
      if (free) {
        b.stance = ST_ADVANCE;
        b.ax = b.sols[0].x; b.ay = b.sols[0].y;
      }
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
          if (b.st.prefCls && e.st.wc === b.st.beats) score -= PREF_CLASS_SQUAD;
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
      if (!b.alive || b.engaged || b.summon || b.stance !== ST_ADVANCE) continue;
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
      this.near(enemySide, s.x, s.y, LORD_TRIGGER_RANGE, () => { nearEnemy = true; });
      if (L.ability === 'rally' || L.ability === 'bulwark') {
        if (!nearEnemy) continue;
        const r = L.ability === 'rally' ? RALLY_RANGE : BULWARK_RANGE;
        const dur = L.ability === 'rally' ? 200 : 120;
        this.near(b.side, s.x, s.y, r, (o) => this.queuedBuffs.push({ sol: o, kind: L.ability as 'rally' | 'bulwark', until: this.t + dur, pct: 0 }));
        this.emitAbility(s.i, -1, L.ability, s.x, s.y, r, dur);
        s.anim = 3; s.animUntil = this.t + 12;
        b.abilityCd = ABILITY_CD[L.ability];
      } else if (L.ability === 'meteor') {
        // Densest enemy cluster within 40 m.
        let best: Sol | null = null, bestN = 0;
        this.near(enemySide, s.x, s.y, METEOR_REACH, (e) => {
          let n = 0;
          this.near(enemySide, e.x, e.y, 1000, () => { n++; });
          if (n > bestN || (n === bestN && best && e.key < best.key)) { best = e; bestN = n; }
        });
        if (!best || bestN < 3) continue;
        const tg = best as Sol;
        const lvl = b.level;
        const dmg = (METEOR_BASE + METEOR_PER_LEVEL * lvl) * 100;
        this.queueStrike({ kind: 'meteor', owner: s, side: b.side, target: null, ax: tg.x, ay: tg.y, fx: s.x, fy: s.y, mul: 100, pid: 0, proj: 'none', melee: false, hill: false, dmg, radius: 1000, reflected: false, extra: true, towerSrc: -1, seq: 0 }, 30);
        this.emitAbility(s.i, tg.i, 'meteor', tg.x, tg.y, 1000, 30);
        s.anim = 3; s.animUntil = this.t + 16;
        b.abilityCd = ABILITY_CD.meteor;
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
        b.abilityCd = ABILITY_CD.skyfall;
      } else if (L.ability === 'necromancy') {
        // The Lich-Priest raises the nearest fallen (of either army) as skeletons that fight for him.
        if (!nearEnemy) continue;
        const want = NECRO_BASE + idiv(b.level, NECRO_LEVELS_PER);
        let raised = 0;
        for (let k = 0; k < want; k++) {
          const c = this.nearestCorpse(b.side, s.x, s.y, NECRO_RANGE);
          if (!c) break;
          c.rz |= 1 << b.side;
          this.raiseSkeleton(b, c);
          raised++;
        }
        if (!raised) continue;
        this.emitAbility(s.i, -1, 'necromancy', s.x, s.y, NECRO_RANGE, 0);
        s.anim = 3; s.animUntil = this.t + 16;
        b.abilityCd = ABILITY_CD.necromancy;
      } else if (L.ability === 'radiance') {
        // The Sultana's sun-burst: burns the enemies around her and mends the allies.
        let foes = 0;
        this.near(enemySide, s.x, s.y, RADIANCE_RANGE, (o) => { if (o.spawnTick <= this.t) foes++; });
        if (foes < 2) continue;
        const amt = (RADIANCE_BASE + RADIANCE_PER_LEVEL * b.level) * 100;
        this.near(enemySide, s.x, s.y, RADIANCE_RANGE, (o) => {
          if (o.spawnTick > this.t) return;
          // (Radiance against the undead is scaled by the Sultana's `holy` inside damage().)
          const r = this.damage(s.st, null, o, 100, false, false, false, 'magic', amt);
          this.credit(o, r.dmg, s, -1, C_RADIANCE, r.mit);
          this.emit(EK.hit, s.i, o.i, Math.ceil(r.dmg / 100), 1 << 3);
        });
        this.near(b.side, s.x, s.y, RADIANCE_RANGE, (o) => {
          if (o.spawnTick > this.t || o.hp >= o.maxHp) return;
          const h = Math.min(amt, o.maxHp - o.hp);
          this.heal(o, h, s, C_RADIANCE);
          this.emit(EK.heal, s.i, o.i, Math.ceil(h / 100));
        });
        this.emitAbility(s.i, -1, 'radiance', s.x, s.y, RADIANCE_RANGE, 0);
        s.anim = 3; s.animUntil = this.t + 14;
        b.abilityCd = ABILITY_CD.radiance;
      } else {
        // The newer abilities poll a failed trigger again a quarter of a second later (their target searches are wider).
        b.abilityCd = this.newLordAbility(b, s, L.ability, enemySide, nearEnemy) ? ABILITY_CD[L.ability] : 5;
      }
    }
  }

  /**
   * The six newer Lord abilities (one distinct mechanic each). Returns true when cast. Like the others they read only the
   * tick-start snapshot and queue their effects (buffs, strikes, knockback, stun) for the end of the tick.
   */
  newLordAbility(b: BSquad, s: Sol, ab: AbilityId, enemy: Seat, nearEnemy: boolean): boolean {
    const t = this.t, lvl = b.level;
    const FX = (dmg: number, type: DamageType, o: Partial<SkFx> = {}): SkFx => ({ dmg, type, burn: 0, slow: 0, slowTicks: 0, knock: 0, ground: false, ...o });
    const strike = (target: Sol | null, x: number, y: number, radius: number, mul: number, cause: number, fx: SkFx): Strike => ({
      kind: 'skill', cause, sk: fx, owner: s, side: b.side, target, ax: x, ay: y, fx: s.x, fy: s.y, mul, pid: 0, proj: 'none',
      melee: false, hill: false, dmg: 0, radius, reflected: false, extra: true, towerSrc: -1, seq: 0,
    });
    switch (ab) {
      case 'soul_reap': {
        // Death Knight: every ally around him drains life from what it strikes (like Rally, but life instead of speed).
        if (!nearEnemy) return false;
        this.near(b.side, s.x, s.y, SOUL_REAP_RANGE, (o) => { if (o.spawnTick <= t) this.queuedBuffs.push({ sol: o, kind: 'reap', until: t + SOUL_REAP_TICKS, pct: 0 }); });
        this.emitAbility(s.i, -1, 'soul_reap', s.x, s.y, SOUL_REAP_RANGE, SOUL_REAP_TICKS);
        s.anim = 3; s.animUntil = t + 14;
        return true;
      }
      case 'grave_taunt': {
        // Ossuary Warden: the enemies around him must strike him (and he braces for it).
        let foes = 0;
        this.near(enemy, s.x, s.y, TAUNT_RANGE, (o) => { if (o.spawnTick <= t) foes++; });
        if (foes < 3) return false;
        this.near(enemy, s.x, s.y, TAUNT_RANGE, (o) => {
          if (o.spawnTick > t) return;
          this.queuedBuffs.push({ sol: o, kind: 'taunt', until: t + TAUNT_TICKS, pct: 0, by: s });
          this.emitAbility(s.i, o.i, 'grave_taunt', o.x, o.y, 0, TAUNT_TICKS);
        });
        // TAUNT_GUARD_PCT is Bulwark's 40% (damage() applies bulwarkUntil).
        this.queuedBuffs.push({ sol: s, kind: 'bulwark', until: t + TAUNT_TICKS, pct: TAUNT_GUARD_PCT });
        this.emitAbility(s.i, -1, 'grave_taunt', s.x, s.y, TAUNT_RANGE, TAUNT_TICKS);
        s.anim = 3; s.animUntil = t + 14;
        return true;
      }
      case 'plague_breath': {
        // Drake Rider: dives onto the densest enemy cluster and breathes a festering plague over it.
        if (!nearEnemy) return false;
        const c = this.cluster(enemy, s.x, s.y, PLAGUE_REACH, 0, PLAGUE_RADIUS, 3, false);
        if (!c) return false;
        const k = strike(c, c.x, c.y, PLAGUE_RADIUS, PLAGUE_PCT, C_PLAGUE, FX(0, 'magic', { burn: (PLAGUE_BURN_BASE + PLAGUE_BURN_PER_LEVEL * lvl) * 100 }));
        k.dive = true;
        this.queueStrike(k, 14);
        this.emitAbility(s.i, c.i, 'plague_breath', c.x, c.y, PLAGUE_RADIUS, 14);
        s.anim = 3; s.animUntil = t + 14;
        return true;
      }
      case 'whirlwind': {
        // Grand Vizier: a djinn whirlwind spins on the densest enemy cluster for WHIRL_WAVES seconds, cutting and slowing.
        const c = this.cluster(enemy, s.x, s.y, WHIRL_REACH, 0, WHIRL_RADIUS, 3, false);
        if (!c) return false;
        const fx = FX((WHIRL_BASE + WHIRL_PER_LEVEL * lvl) * 100, 'magic', { slow: WHIRL_SLOW, slowTicks: 30 });
        for (let w = 0; w < WHIRL_WAVES; w++) this.queueStrike(strike(null, c.x, c.y, WHIRL_RADIUS, 100, C_WHIRL, fx), 10 + 20 * w);
        this.emitAbility(s.i, c.i, 'whirlwind', c.x, c.y, WHIRL_RADIUS, 10 + 20 * WHIRL_WAVES);
        s.anim = 3; s.animUntil = t + 16;
        return true;
      }
      case 'stampede': {
        // Rajah: his elephant charges at the nearest ground enemy, trampling and throwing aside all in its path.
        let tg: Sol | null = null, bd = 0;
        this.near(enemy, s.x, s.y, STAMPEDE_REACH, (o, d2) => {
          if (o.spawnTick > t || o.st.tags & T_FLIER) return;
          if (!tg || d2 < bd || (d2 === bd && o.key < tg.key)) { tg = o; bd = d2; }
        });
        if (!tg) return false;
        const o0 = tg as Sol;
        const dx = o0.x - s.x, dy = o0.y - s.y, d = isqrt(dx * dx + dy * dy);
        // Charge through the target (a little past it), up to STAMPEDE_LEN.
        const len = Math.min(STAMPEDE_LEN, d + 200);
        const ex = d > 0 ? clampX(s.x + idiv(dx * len, d)) : s.x, ey = d > 0 ? clampY(s.y + idiv(dy * len, d)) : clampY(s.y + sideSign(b.side) * len);
        const sx = ex - s.x, sy = ey - s.y, l2 = sx * sx + sy * sy;
        const fx = FX((STAMPEDE_BASE + STAMPEDE_PER_LEVEL * lvl) * 100, 'physical', { knock: STAMPEDE_KNOCK, ground: true });
        const w2 = STAMPEDE_WIDTH * STAMPEDE_WIDTH;
        const r = idiv(len, 2) + STAMPEDE_WIDTH;
        this.near(enemy, s.x + idiv(sx, 2), s.y + idiv(sy, 2), r, (o) => {
          if (o.spawnTick > t || o.st.tags & T_FLIER) return;
          // Distance from the soldier to the charge's path (integer point-to-segment test).
          const px = o.x - s.x, py = o.y - s.y, dot = px * sx + py * sy;
          let qx: number, qy: number;
          if (dot <= 0 || l2 === 0) { qx = s.x; qy = s.y; if (px * px + py * py > w2) return; }
          else if (dot >= l2) { qx = ex; qy = ey; const fx2 = o.x - ex, fy2 = o.y - ey; if (fx2 * fx2 + fy2 * fy2 > w2) return; }
          else {
            const cr = px * sy - py * sx;
            if (cr * cr > w2 * l2) return;
            // Thrown sideways, away from the path: the knockback pushes away from its nearest point on the path.
            qx = s.x + idiv(sx * idiv(dot * 1024, l2), 1024); qy = s.y + idiv(sy * idiv(dot * 1024, l2), 1024);
          }
          this.skillHit(s, o, C_STAMPEDE, fx, 100, qx, qy);
        });
        s.relocate = [ex, ey];
        this.emitAbility(s.i, o0.i, 'stampede', ex, ey, STAMPEDE_WIDTH, 0);
        s.anim = 3; s.animUntil = t + 12;
        return true;
      }
      case 'talon': {
        // Roc Rider: the roc seizes the toughest enemy in reach that is not Large and drops it among her own army.
        if (!nearEnemy) return false;
        let tg: Sol | null = null;
        this.near(enemy, s.x, s.y, TALON_REACH, (o) => {
          if (o.spawnTick > t || o.st.tags & T_LARGE) return;
          if (!tg || o.maxHp > tg.maxHp || (o.maxHp === tg.maxHp && o.key < tg.key)) tg = o;
        });
        if (!tg) return false;
        const o0 = tg as Sol;
        const dropX = o0.x, dropY = clampY(o0.y - sideSign(b.side) * TALON_THROW);
        const k = strike(o0, o0.x, o0.y, 0, TALON_PCT, C_TALON, FX(0, 'physical'));
        this.queueStrike(k, 12);
        this.emitAbility(s.i, o0.i, 'talon', dropX, dropY, 0, 12);
        s.anim = 3; s.animUntil = t + 12;
        return true;
      }
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- necromancy (Ashen Covenant)

  /**
   * The nearest corpse within `range` that `side` has not raised yet. Ties go to a corpse of the raiser's own army,
   * then to the lower key: both are the same whichever seat the raiser sits in.
   */
  nearestCorpse(side: Seat, x: number, y: number, range: number): Sol | null {
    let best: Sol | null = null, bd = 0;
    const r2 = range * range, bit = 1 << side;
    for (const c of this.corpses) {
      if (c.rz & bit) continue;
      const dx = c.x - x, dy = c.y - y, d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      if (!best || d2 < bd || (d2 === bd && ((c.side === side) !== (best.side === side) ? c.side === side : c.key < best.key))) { best = c; bd = d2; }
    }
    return best;
  }

  /** A Grave Acolyte spends its attack raising a skeleton from a corpse in reach, while its squad's quota lasts. */
  tryRaise(s: Sol): boolean {
    const b = s.sq;
    if (b.grave >= RAISE_BASE + b.level) return false;
    const c = this.nearestCorpse(s.side, s.x, s.y, s.st.range);
    if (!c) return false;
    c.rz |= 1 << s.side;
    b.grave++;
    this.raiseSkeleton(b, c);
    s.cd += s.st.atk * 100;
    s.anim = 3; s.animUntil = this.t + 10;
    this.emitAbility(s.i, c.i, 'necromancy', c.x, c.y, 0, 0);
    return true;
  }

  // ---------------------------------------------------------------- item skills

  /** The squad's caster: its first living soldier. */
  leader(b: BSquad): Sol | null {
    for (const s of b.sols) if (s.alive && s.spawnTick <= this.t) return s;
    return null;
  }

  /**
   * The enemy soldier within `range` of (x, y) (and beyond `minRange`) with the most enemies within `r` of it, if
   * that is at least `need`. `ground` skips fliers. Ties go to the lower key, so the choice is seat-independent.
   */
  cluster(enemy: Seat, x: number, y: number, range: number, minRange: number, r: number, need: number, ground: boolean): Sol | null {
    let best: Sol | null = null, bestN = 0;
    const t = this.t, min2 = minRange * minRange;
    this.near(enemy, x, y, range, (e, d2) => {
      if (e.spawnTick > t || d2 < min2 || (ground && e.st.tags & T_FLIER)) return;
      let n = 0;
      this.near(enemy, e.x, e.y, r, (o) => { if (o.spawnTick <= t && !(ground && o.st.tags & T_FLIER)) n++; });
      if (n > bestN || (n === bestN && best && e.key < best.key)) { best = e; bestN = n; }
    });
    return bestN >= need ? best : null;
  }

  /** Share (0..100) of life left among the squad's living soldiers. */
  lifeShare(b: BSquad): number {
    let hp = 0, max = 0;
    for (const s of b.sols) if (s.alive && s.spawnTick <= this.t) { hp += s.hp; max += s.maxHp; }
    return max > 0 ? idiv(hp * 100, max) : 100;
  }

  /** One hit of a skill on `d`: damage through the usual armour / resistance rules, then its riders. */
  skillHit(a: Sol, d: Sol, cause: number, fx: SkFx, mul: number, fromX: number, fromY: number): void {
    const r = this.damage(a.st, null, d, mul, false, false, false, fx.type, fx.dmg);
    this.credit(d, r.dmg, a, -1, cause, r.mit);
    this.emit(EK.hit, a.i, d.i, Math.ceil(r.dmg / 100), (r.eff ? 2 : 0) | ((r.tri + 1) << 3));
    if (fx.burn && fx.burn > d.pendingBurn) { d.pendingBurn = fx.burn; d.pendingBurnSrc = a; d.pendingBurnCause = cause; }
    if (fx.slow && fx.slow >= d.pendingSlow) { d.pendingSlow = fx.slow; d.pendingSlowUntil = this.t + fx.slowTicks; d.pendingSlowSrc = a; }
    if (fx.knock && !(d.st.tags & (T_FLIER | T_LARGE)) && !d.kx && !d.ky) {
      const dx = d.x - fromX, dy = d.y - fromY, l = isqrt(dx * dx + dy * dy);
      if (l > 0) { d.kx = idiv(dx * fx.knock, l); d.ky = idiv(dy * fx.knock, l); }
      else d.ky = sideSign(a.side) * fx.knock;
      this.emitAbility(a.i, d.i, 'knockback', clampX(d.x + d.kx), clampY(d.y + d.ky), 0, 0);
    }
  }

  /** A skill strike lands (kind 'skill'): everything within `radius` of the impact, or the target alone. */
  resolveSkill(k: Strike): void {
    const a = k.owner!, fx = k.sk!, t = this.t, enemy = (1 - k.side) as Seat, cause = k.cause ?? C_ATTACK;
    let ix = k.ax, iy = k.ay;
    const tg = k.target;
    if (tg && tg.alive) { ix = tg.x; iy = tg.y; }
    if (k.dive && a.alive) a.relocate = [ix, iy];
    if (k.pid > 0) this.emit(EK.impact, k.pid, ix, iy, PROJ_CODES.indexOf(k.proj), k.radius);
    if (k.radius > 0) {
      this.near(enemy, ix, iy, k.radius, (d) => {
        if (d.spawnTick > t || (fx.ground && d.st.tags & T_FLIER)) return;
        this.skillHit(a, d, cause, fx, k.mul, k.fx, k.fy);
      });
    } else if (tg && tg.alive) {
      this.skillHit(a, tg, cause, fx, k.mul, k.fx, k.fy);
      if (cause === C_TALON) {
        // Lifted and dropped TALON_THROW towards the Roc Rider's own lines (end-of-tick displacement), then dazed.
        const ny = clampY(tg.y - sideSign(a.side) * TALON_THROW);
        tg.kx = 0; tg.ky = ny - tg.y;
        tg.pendingStun = t + TALON_STUN;
      }
    }
  }

  skillStrike(owner: Sol, id: SkillId, target: Sol | null, x: number, y: number, radius: number, mul: number, fx: SkFx): Strike {
    return {
      kind: 'skill', cause: cz(id), sk: fx, owner, side: owner.side, target, ax: x, ay: y, fx: owner.x, fy: owner.y, mul, pid: 0, proj: 'none',
      melee: false, hill: false, dmg: 0, radius, reflected: false, extra: true, towerSrc: -1, seq: 0,
    };
  }

  skillPass(): void {
    for (const b of this.squads) {
      if (!b.skills.length || !b.alive) continue;
      for (const k of b.skills) {
        if (k.cd > 0) { k.cd--; continue; }
        // A failed trigger is polled again a quarter of a second later.
        k.cd = this.castSkill(b, k.id, k.ilvl) ? SKILLS[k.id].cooldown : 5;
      }
    }
  }

  /** Try to cast `id`; false when its trigger does not hold. Effects obey the Jacobi rule (applied at end of tick). */
  castSkill(b: BSquad, id: SkillId, ilvl: number): boolean {
    const lead = this.leader(b);
    if (!lead) return false;
    const t = this.t, enemy = (1 - b.side) as Seat, cause = cz(id);
    const n = skillNum(id, ilvl);
    const FX = (dmg: number, type: DamageType, o: Partial<SkFx> = {}): SkFx => ({ dmg, type, burn: 0, slow: 0, slowTicks: 0, knock: 0, ground: false, ...o });
    const countNear = (x: number, y: number, r: number, ground: boolean): number => {
      let c = 0;
      this.near(enemy, x, y, r, (o) => { if (o.spawnTick <= t && !(ground && o.st.tags & T_FLIER)) c++; });
      return c;
    };
    /** Soldiers of the squad whose target is alive and in reach right now. */
    const strikers = (): Sol[] => {
      const out: Sol[] = [];
      for (const s of b.sols) {
        const e = s.target;
        if (!s.alive || s.spawnTick > t || !e || !this.canHit(s, e)) continue;
        const dx = e.x - s.x, dy = e.y - s.y, reach = this.reach(s, e);
        if (dx * dx + dy * dy <= reach * reach) out.push(s);
      }
      return out;
    };
    switch (id) {
      case 'fireball': {
        const c = this.cluster(enemy, lead.x, lead.y, 2200, 0, 350, 3, false);
        if (!c) return false;
        this.emitSkill(lead, id, c, c.sq, c.x, c.y, 350, 0);
        // Homes on the soldier at the heart of the cluster (lands where it fell if it dies on the way).
        const k = this.skillStrike(lead, id, c, c.x, c.y, 350, 100, FX(n.a * 100, 'magic', { burn: n.b * 100 }));
        k.proj = 'fireball';
        const dx = c.x - lead.x, dy = c.y - lead.y;
        this.launch(k, isqrt(dx * dx + dy * dy), 0);
        return true;
      }
      case 'chain_lightning': {
        let first: Sol | null = null, bd = 0;
        this.near(enemy, lead.x, lead.y, 2000, (o, d2) => {
          if (o.spawnTick > t) return;
          if (!first || d2 < bd || (d2 === bd && o.key < first.key)) { first = o; bd = d2; }
        });
        if (!first) return false;
        const f0 = first as Sol;
        this.emitSkill(lead, id, f0, f0.sq, f0.x, f0.y, 0, 0);
        const fx = FX(n.a * 100, 'magic');
        const hit: Sol[] = [];
        let prev = lead, cur: Sol | null = f0, mul = 100;
        for (let j = 0; j < 5 && cur; j++) {
          this.emitAbility(prev.i, cur.i, 'chain', cur.x, cur.y, 0, 0);
          this.skillHit(lead, cur, cause, fx, mul, prev.x, prev.y);
          hit.push(cur);
          prev = cur;
          mul = idiv(mul * 80, 100);
          let best: Sol | null = null, d0 = 0;
          this.near(enemy, prev.x, prev.y, 500, (o, d2) => {
            if (hit.includes(o) || o.spawnTick > t) return;
            if (!best || d2 < d0 || (d2 === d0 && o.key < best.key)) { best = o; d0 = d2; }
          });
          cur = best;
        }
        return true;
      }
      case 'frost_nova': {
        if (countNear(lead.x, lead.y, 700, false) < 2) return false;
        this.emitSkill(lead, id, null, null, lead.x, lead.y, 700, 80);
        const fx = FX(n.a * 100, 'magic', { slow: 50, slowTicks: 80 });
        this.near(enemy, lead.x, lead.y, 700, (o) => { if (o.spawnTick <= t) this.skillHit(lead, o, cause, fx, 100, lead.x, lead.y); });
        return true;
      }
      case 'mending_light': {
        let best: BSquad | null = null, bs = 70;
        const l2x = 2 * lead.x - (FIELD_W - 1), l2y = 2 * lead.y - (FIELD_H - 1);
        for (const a of this.sideSquads[b.side]) {
          if (!a.alive) continue;
          const dx = idiv(a.c2x - l2x, 2), dy = idiv(a.c2y - l2y, 2);
          if (dx * dx + dy * dy > 1800 * 1800) continue;
          const share = this.lifeShare(a);
          if (share < bs) { best = a; bs = share; }
        }
        if (!best) return false;
        const tb = best as BSquad;
        const tl = this.leader(tb) ?? lead;
        this.emitSkill(lead, id, tl, tb, tl.x, tl.y, 0, 0);
        for (const o of tb.sols) {
          if (!o.alive || o.spawnTick > t || o.hp >= o.maxHp) continue;
          const amt = Math.min(idiv(o.maxHp * n.a, 100), o.maxHp - o.hp);
          this.heal(o, amt, lead, cause);
          this.emit(EK.heal, lead.i, o.i, Math.ceil(amt / 100));
        }
        return true;
      }
      case 'shield_wall': {
        if (this.lifeShare(b) >= 85 && b.alive >= b.sols.length) return false;
        if (countNear(lead.x, lead.y, 900, false) < 1) return false;
        this.emitSkill(lead, id, null, b, lead.x, lead.y, 0, 100);
        for (const o of b.sols) {
          if (!o.alive || o.spawnTick > t) continue;
          this.queuedBuffs.push({ sol: o, kind: 'wall', until: t + 100, pct: n.a });
          this.emitAbility(lead.i, o.i, 'shield_wall', o.x, o.y, 0, 100);
        }
        return true;
      }
      case 'war_cry': {
        if (countNear(lead.x, lead.y, 800, false) < 1) return false;
        this.emitSkill(lead, id, null, b, lead.x, lead.y, 1000, 120);
        this.near(b.side, lead.x, lead.y, 1000, (o) => {
          if (o.spawnTick <= t) this.queuedBuffs.push({ sol: o, kind: 'cry', until: t + 120, pct: n.a });
        });
        return true;
      }
      case 'cleave': {
        if (lead.st.ranged || countNear(lead.x, lead.y, 400, true) < 4) return false;
        this.emitSkill(lead, id, null, b, lead.x, lead.y, 0, 80);
        for (const o of b.sols) if (o.alive && o.spawnTick <= t) this.queuedBuffs.push({ sol: o, kind: 'cleave', until: t + 80, pct: n.a });
        return true;
      }
      case 'fire_arrows':
      case 'pinning_shot': {
        if (!lead.st.ranged) return false;
        const who = strikers();
        if (!who.length) return false;
        const e0 = who[0].target!;
        this.emitSkill(lead, id, e0, e0.sq, e0.x, e0.y, 0, 0);
        const fx = id === 'fire_arrows' ? FX(0, lead.st.dmgType, { burn: n.a * 100 }) : FX(0, lead.st.dmgType, { slow: 50, slowTicks: 80 });
        const mul = id === 'fire_arrows' ? 100 : n.a;
        for (const s of who) {
          const e = s.target!;
          const dx = e.x - s.x, dy = e.y - s.y;
          const hill = this.terrainCode(s.x, s.y) === KIND_CODE.hill;
          s.anim = 2; s.animUntil = t + 8;
          this.launch({
            kind: 'hit', cause, sk: fx, owner: s, side: s.side, target: e, ax: e.x, ay: e.y, fx: s.x, fy: s.y, mul, pid: 0, proj: s.st.proj === 'none' ? 'arrow' : s.st.proj,
            melee: false, hill, dmg: 0, radius: 0, reflected: false, extra: true, towerSrc: -1, seq: s.attacks * 4 + 3,
          }, isqrt(dx * dx + dy * dy), 0);
        }
        return true;
      }
      case 'rain_of_arrows': {
        if (!lead.st.ranged) return false;
        const c = this.cluster(enemy, lead.x, lead.y, lead.st.range, 0, 500, 5, false);
        if (!c) return false;
        this.emitSkill(lead, id, c, c.sq, c.x, c.y, 500, 40);
        for (let w = 0; w < 3; w++) this.queueStrike(this.skillStrike(lead, id, null, c.x, c.y, 500, 100, FX(n.a * 100, 'physical')), 16 + 12 * w);
        return true;
      }
      case 'thunderous_charge': {
        const who = strikers();
        if (!who.length) return false;
        const s = who[0], e = s.target!;
        this.emitSkill(s, id, e, e.sq, e.x, e.y, 300, 0);
        this.queueStrike(this.skillStrike(s, id, null, e.x, e.y, 300, 100, FX(n.a * 100, 'physical', { knock: 200, ground: true })), 3);
        return true;
      }
      case 'trample': {
        if (countNear(lead.x, lead.y, 350, true) < 3) return false;
        this.emitSkill(lead, id, null, null, lead.x, lead.y, 350, 0);
        const fx = FX(n.a * 100, 'physical', { slow: 30, slowTicks: 40, ground: true });
        this.near(enemy, lead.x, lead.y, 350, (o) => { if (o.spawnTick <= t && !(o.st.tags & T_FLIER)) this.skillHit(lead, o, cause, fx, 100, lead.x, lead.y); });
        return true;
      }
      case 'dive_strike': {
        const who = strikers();
        if (!who.length) return false;
        const e0 = who[0].target!;
        this.emitSkill(lead, id, e0, e0.sq, e0.x, e0.y, 200, 0);
        for (const s of who) {
          const e = s.target!;
          s.anim = 2; s.animUntil = t + 8;
          this.queueStrike(this.skillStrike(s, id, e, e.x, e.y, 200, n.a, FX(0, s.st.dmgType)), 4);
        }
        return true;
      }
      case 'incendiary_payload': {
        if (!lead.st.ranged) return false;
        const c = this.cluster(enemy, lead.x, lead.y, lead.st.range, lead.st.minRange, 400, 3, true);
        if (!c) return false;
        this.emitSkill(lead, id, c, c.sq, c.x, c.y, 400, 80);
        const dx = c.x - lead.x, dy = c.y - lead.y, dist = isqrt(dx * dx + dy * dy);
        // A light pot of pitch on a flat, fast throw (at most 0.8 s in the air), so it lands where the enemy stands.
        const proj: ProjectileKind = lead.st.proj === 'none' ? 'stone' : lead.st.proj;
        const flight = Math.min(16, this.flight(proj, dist, 0));
        for (let w = 0; w < 4; w++) {
          const k = this.skillStrike(lead, id, null, c.x, c.y, 400, 100, FX(n.a * 100, 'magic', { ground: true }));
          if (w === 0) {
            k.proj = proj;
            k.pid = ++this.pid;
            this.emit(EK.projectile, k.pid, lead.i, c.i, PROJ_CODES.indexOf(proj), ARC_CODES.indexOf('arc'), lead.x, lead.y, c.x, c.y, flight);
          }
          this.queueStrike(k, flight + 20 * w);
        }
        return true;
      }
    }
    return false;
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
      if (st.prefCls && e.st.wc === st.beats) score -= PREF_CLASS_SOL;
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
      const cry = s.cryUntil > t ? s.cryPct : 0;
      s.cd -= 100 + (s.rallyUntil > t ? (cry > RALLY_PCT ? cry : RALLY_PCT) : cry) + s.blood * BLOOD_HASTE;
      if (s.cd < -100) s.cd = -100;
      if (this.marching) { this.marchSoldier(s); continue; }
      if (s.stunUntil > t) continue; // seized and dropped by a roc: dazed
      if (st.healer) { this.healerAct(s); continue; }
      // Targeting. A soldier taunted by the Ossuary Warden attacks him while it can.
      const tgt = s.target;
      const taunter = s.tauntUntil > t ? s.tauntBy : null;
      if (taunter && taunter.alive && this.canHit(s, taunter)) s.target = taunter;
      else if (!tgt || !this.canHit(s, tgt) || (t + s.key) % 6 === 0) {
        const r = st.ranged ? st.range + 300 : AGGRO + (b.engaged && b.stance === ST_ADVANCE ? 800 : 0) + (st.raider ? 1200 : 0);
        s.target = this.findTarget(s, r);
      }
      let vx = 0, vy = 0;
      const sp = this.groundSpeed(st.speed, s.x, s.y, flier, slow);
      let e = s.target;
      // A Lord told to hold or to follow strikes what is in reach, but leaves his spot only for what is within the leash of it.
      if (e && b.stance !== ST_ADVANCE) {
        const dx = e.x - s.x, dy = e.y - s.y, reach = this.reach(s, e);
        if (dx * dx + dy * dy > reach * reach) {
          const lx = 2 * e.x - (FIELD_W - 1) - b.t2x, ly = 2 * e.y - (FIELD_H - 1) - b.t2y;
          const leash = 2 * (st.ranged ? st.range + 300 : HOLD_LEASH);
          if (lx * lx + ly * ly > leash * leash) e = null;
        }
      }
      if (e) {
        b.engagedNext = true;
        const dx = e.x - s.x, dy = e.y - s.y, d2 = dx * dx + dy * dy;
        const reach = this.reach(s, e);
        if (d2 <= reach * reach) {
          s.facing = faceOr(s.facing, dx, dy);
          if (s.cd <= 0 && !(st.raise && this.tryRaise(s))) this.attack(s, e, isqrt(d2));
        } else {
          const d = isqrt(d2);
          const step = Math.min(sp, d - reach + 10);
          vx = idiv(dx * step, d); vy = idiv(dy * step, d);
        }
      } else {
        // Formation / advance. Goals are expressed as deltas (dx, dy) so no absolute rounding is involved.
        let dx: number, dy: number;
        if (b.stance !== ST_ADVANCE) {
          // Back to the post (hold) or to the spot behind the squad he follows.
          const s2y = 2 * s.y - (FIELD_H - 1);
          dx = idiv(b.t2x - (2 * s.x - (FIELD_W - 1)), 2); dy = idiv(b.t2y - s2y, 2);
          if (!flier && this.acrossRiver2(s2y, b.t2y)) { const f = this.flowDir(s.side, s.x, s.y); dx = f[0]; dy = f[1]; }
        } else if (!b.engaged) { dx = b.ax + s.ox - s.x; dy = b.ay + s.oy - s.y; }
        else if (b.macro) {
          dx = idiv(b.macro.c2x - (2 * s.x - (FIELD_W - 1)), 2); dy = idiv(b.macro.c2y - (2 * s.y - (FIELD_H - 1)), 2);
          if (!flier && this.acrossRiver2(2 * s.y - (FIELD_H - 1), b.macro.c2y)) { const f = this.flowDir(s.side, s.x, s.y); dx = f[0]; dy = f[1]; }
        } else {
          const f = this.flowDir(s.side, s.x, s.y);
          dx = f[0] * 3; dy = f[1] * 3;
        }
        const d2 = dx * dx + dy * dy;
        if (!b.engaged && b.stance === ST_ADVANCE) b.slotErrNext += isqrt(d2);
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
    // Critical hits are counted, not rolled: with 20% crit every fifth attack of this soldier is critical.
    s.critAcc += st.crit;
    const crit = s.critAcc >= 100;
    if (crit) s.critAcc -= 100;
    const base: Strike = {
      kind: 'hit', owner: s, side: s.side, target: e, ax: e.x, ay: e.y, fx: s.x, fy: s.y, mul: 100, pid: 0, proj: st.proj,
      melee: !st.ranged, hill, dmg: 0, radius: st.splash, reflected: false, extra: false, towerSrc: -1, seq: s.attacks * 4, crit,
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
          this.launch({ ...base, target: o, ax: o.x, ay: o.y, mul: HYDRA_PCT, extra: true, seq: base.seq + 1 + k }, isqrt(bd), 0);
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
      this.heal(o, amt, s, C_HEAL);
      // Sun Priests bless what they heal: it attacks faster for a few seconds.
      if (st.bless) { if (o.cryUntil <= t) this.emitAbility(s.i, o.i, 'war_cry', o.x, o.y, 0, BLESS_TICKS); this.queuedBuffs.push({ sol: o, kind: 'cry', until: t + BLESS_TICKS, pct: BLESS_PCT }); }
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

  damage(a: Stats, aSol: Sol | null, d: Sol, mul: number, crit: boolean, hill: boolean, ranged: boolean, dmgType: DamageType, baseOverride: number): { dmg: number; eff: boolean; tri: number; mit: number } {
    let dmg = baseOverride > 0 ? baseOverride : a.dmg;
    dmg = idiv(dmg * mul, 100);
    // The counter wheel: the one counter rule (there is no weapon triangle and no per-unit bonus against tags).
    const counter = a.beats === d.st.wc;
    if (counter) dmg = idiv(dmg * COUNTER_PCT, 100);
    const tri = 0;
    // The sun burns the dead: Sun Priests and the Sultana deal more to Ashen units, the Lich and raised skeletons.
    if (a.holy > 100 && d.st.undead) dmg = idiv(dmg * a.holy, 100);
    let effPct = 100;
    const tags = d.st.tags;
    if (a.L.has('kingsbane') && (tags & T_LORD || d.st.wc === KINGSBANE_WC)) effPct = Math.max(effPct, KINGSBANE_PCT);
    let slay = 0;
    for (const tag in a.slay) if (tags & TAG_BIT[tag as Tag]) slay += a.slay[tag as Tag]!;
    if (aSol && aSol.firstStrike && baseOverride === 0) effPct = Math.max(effPct, 300);
    const eff = counter || effPct > 100 || slay > 0;
    dmg = idiv(dmg * (effPct + slay), 100);
    // Charge (not vs braced pikemen).
    if (aSol && aSol.chargeReady && baseOverride === 0) dmg = d.st.brace ? dmg : dmg * 2;
    if (hill) dmg = idiv(dmg * 115, 100);
    if (a.L.has('frostheart') && d.slowUntil > this.t) dmg = idiv(dmg * (100 + FROSTHEART_PCT), 100);
    if (crit) dmg = idiv(dmg * CRIT_MULT, 100);
    if (dmgType === 'magic' && a.magicBonus) dmg = idiv(dmg * (100 + a.magicBonus), 100);
    // Everything below is the defender's mitigation (armour, resistance, cover, Bulwark, Shield Wall).
    const pre = dmg;
    if (dmgType === 'magic') {
      dmg = idiv(dmg * (100 - d.st.mr), 100);
    } else if (!a.ignoresArmor) {
      const armor = a.crushing ? d.st.armor >> 1 : d.st.armor;
      dmg = idiv(dmg * (100 - armor), 100);
    }
    if (ranged) {
      // Cover: ruins take a quarter off ranged damage, forest 40% (a flat reduction; nothing ever "misses").
      const tc = this.terrainCode(d.x, d.y);
      if (tc === KIND_CODE.ruins) dmg = idiv(dmg * 75, 100);
      else if (tc === KIND_CODE.forest) dmg = idiv(dmg * 60, 100);
      // Fliers are hard to hit from the ground: shots from non-fliers lose FLIER_EVADE_PCT percent.
      if (d.st.tags & T_FLIER && !(a.tags & T_FLIER)) dmg = idiv(dmg * (100 - FLIER_EVADE_PCT), 100);
    }
    if (d.bulwarkUntil > this.t) dmg = idiv(dmg * 60, 100);
    if (d.wallUntil > this.t) dmg = idiv(dmg * (100 - d.wallPct), 100);
    if (dmg < 100) dmg = 100;
    return { dmg, eff, tri, mit: pre > dmg ? pre - dmg : 0 };
  }

  credit(d: Sol, dmg: number, by: Sol | null, tower: number, cause = C_ATTACK, mit = 0): void {
    d.dmgAcc += dmg;
    if (this.record) this.note(d, by ? by.sq.row : tower, cause, dmg, mit, 0);
    if (by) {
      if (!d.killer || dmg > d.killerDmg || (dmg === d.killerDmg && by.key < d.killer.key)) { d.killer = by; d.killerDmg = dmg; }
      by.dealt += dmg;
    } else if (tower >= 0 && !d.killer && d.killerTower < 0) d.killerTower = tower;
  }

  applyHit(k: Strike, d: Sol, mul: number, primary: boolean): void {
    const a = k.owner!;
    const st = a.st;
    const ranged = !k.melee;
    const crit = !!k.crit;
    const r = this.damage(st, primary ? a : null, d, mul, crit, k.hill, ranged, st.dmgType, 0);
    this.credit(d, r.dmg, a, -1, k.cause ?? C_ATTACK, r.mit);
    if (st.leech && a.alive) this.heal(a, idiv(r.dmg * st.leech, 100), a, C_LEECH);
    if (a.reapUntil > this.t && a.alive) this.heal(a, idiv(r.dmg * SOUL_REAP_PCT, 100), a, C_SOUL_REAP);
    if (k.melee && d.st.thorns && a.alive) this.credit(a, idiv(r.dmg * d.st.thorns, 100), d, -1, C_THORNS);
    if (st.burn) { if (st.burn * 100 > d.pendingBurn) { d.pendingBurn = st.burn * 100; d.pendingBurnSrc = a; d.pendingBurnCause = C_BURN; } }
    if (st.frost && st.frost > d.pendingSlow) { d.pendingSlow = st.frost; d.pendingSlowUntil = this.t + 40; d.pendingSlowSrc = a; }
    // Skill volleys (Fire Arrows, Pinning Shot) carry their own burn / slow.
    const fx = k.sk;
    if (fx) {
      if (fx.burn && fx.burn > d.pendingBurn) { d.pendingBurn = fx.burn; d.pendingBurnSrc = a; d.pendingBurnCause = k.cause ?? C_BURN; }
      if (fx.slow && fx.slow >= d.pendingSlow) { d.pendingSlow = fx.slow; d.pendingSlowUntil = this.t + fx.slowTicks; d.pendingSlowSrc = a; }
    }
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
    if (k.kind === 'skill') { this.resolveSkill(k); return; }
    if (k.kind === 'tower') {
      const d = k.target!;
      this.emit(EK.impact, k.pid, d.x, d.y, PROJ_CODES.indexOf('tower_arrow'), 0);
      if (!d.alive) return;
      let dmg = idiv(k.dmg * (100 - d.st.armor), 100);
      if (dmg < 100) dmg = 100;
      this.credit(d, dmg, null, k.towerSrc, C_TOWER, k.dmg > dmg ? k.dmg - dmg : 0);
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
        this.credit(d, r.dmg, a, -1, k.kind === 'meteor' ? C_METEOR : k.kind === 'ember' ? C_EMBER : C_SKYFALL, r.mit);
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
    // Cleave (skill): while it lasts, melee blows also strike the enemies around their target.
    if (!k.extra && primaryHit && k.melee && a.cleaveUntil > t) {
      this.emitAbility(a.i, tg.i, 'cleave', tg.x, tg.y, 250, 0);
      const ck: Strike = { ...k, extra: true, cause: cz('cleave') };
      this.near(enemy, tg.x, tg.y, 250, (d) => {
        if (d === tg || d.spawnTick > t || !this.canHit(a, d)) return;
        this.applyHit(ck, d, a.cleavePct, false);
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
          const r = this.damage(st, null, o, STORM_PCT, false, false, false, 'magic', 0);
          this.credit(o, r.dmg, a, -1, C_CHAIN, r.mit);
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
          this.applyHit({ ...k, extra: true }, best, HYDRA_PCT, false);
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
        this.credit(s, Math.max(50, dmg), s.burnSrc, -1, s.burnCause);
      }
      if (s.st.L.has('lifebinder') && s.hp < s.maxHp) this.heal(s, idiv(s.maxHp * 3, 400), s, C_LIFEBINDER);
      if (s.st.regen && s.hp < s.maxHp) this.heal(s, idiv(s.maxHp * s.st.regen, 2000), s, C_REGEN);
      if (s.st.L.has('sunfire')) {
        const dmg = (20 + 2 * s.st.ilvl) * 50;
        this.near((1 - s.side) as Seat, s.x, s.y, 400, (o) => {
          if (o.spawnTick > t || o.st.tags & T_FLIER) return;
          // Resistance can be negative (ethereal Wraith Riders): then nothing is mitigated.
          const sd = idiv(dmg * (100 - o.st.mr), 100);
          this.credit(o, sd, s, -1, C_SUNFIRE, dmg > sd ? dmg - sd : 0);
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
      const o = b.sol;
      if (b.kind === 'rally') o.rallyUntil = Math.max(o.rallyUntil, b.until);
      else if (b.kind === 'bulwark') o.bulwarkUntil = Math.max(o.bulwarkUntil, b.until);
      else if (b.kind === 'reap') o.reapUntil = Math.max(o.reapUntil, b.until);
      else if (b.kind === 'taunt') { o.tauntBy = b.by ?? null; o.tauntUntil = b.until; }
      else if (b.kind === 'wall') { if (o.wallUntil <= t || b.pct >= o.wallPct) o.wallPct = b.pct; o.wallUntil = Math.max(o.wallUntil, b.until); }
      else if (b.kind === 'cry') { if (o.cryUntil <= t || b.pct >= o.cryPct) o.cryPct = b.pct; o.cryUntil = Math.max(o.cryUntil, b.until); }
      else { if (o.cleaveUntil <= t || b.pct >= o.cleavePct) o.cleavePct = b.pct; o.cleaveUntil = Math.max(o.cleaveUntil, b.until); }
    }
    this.queuedBuffs.length = 0;
    const deaths: Sol[] = [];
    for (const s of this.sols) {
      if (s.spawnTick > t) continue;
      s.x = s.nx; s.y = s.ny;
      if (s.relocate) { s.x = s.relocate[0]; s.y = s.relocate[1]; s.relocate = null; }
      if (s.kx || s.ky) { if (s.alive) { s.x = clampX(s.x + s.kx); s.y = clampY(s.y + s.ky); } s.kx = 0; s.ky = 0; }
      if (!s.alive) continue;
      if (s.pendingStun) { s.stunUntil = Math.max(s.stunUntil, s.pendingStun); s.pendingStun = 0; }
      if (s.pendingSlow) {
        // a refresh may shorten the slow: a slow that starts afresh always gets its own event
        if (s.slowUntil <= t) s.slowFxUntil = 0;
        s.slowPct = s.pendingSlow; s.slowUntil = s.pendingSlowUntil; s.slowSrc = s.pendingSlowSrc; s.pendingSlow = 0; s.pendingSlowSrc = null;
      }
      if (s.slowUntil > t && s.slowFxUntil <= t) {
        // A 'frost' event when a slow starts (src = who applied it, dur = how long it lasts), and again whenever the
        // last event's window runs out while refreshes keep the slow on. Presentation only, like the burn's below.
        this.emitAbility(s.slowSrc ? s.slowSrc.i : -1, s.i, 'frost', s.x, s.y, 0, s.slowUntil - t);
        s.slowFxUntil = s.slowUntil;
      }
      if (s.pendingBurn) {
        if (s.burnUntil <= t || s.pendingBurn >= s.burnDps) { s.burnDps = s.pendingBurn; s.burnSrc = s.pendingBurnSrc; s.burnCause = s.pendingBurnCause; }
        s.burnUntil = t + 60; s.pendingBurn = 0; s.pendingBurnSrc = null; s.pendingBurnCause = C_BURN;
      }
      if (s.burnUntil > t && s.burnFxUntil <= t) {
        // A 'burn' event when a burn / plague starts (src = the soldier whose hit lit it, e.g. the Corpse Catapult),
        // and again whenever the last event's flames run out while refreshes keep the burn alive, so the
        // flames last as long as the burn. Presentation only: burnFxUntil feeds nothing but this event.
        this.emitAbility(s.burnSrc ? s.burnSrc.i : -1, s.i, 'burn', s.x, s.y, 0, s.burnUntil - t);
        s.burnFxUntil = s.burnUntil;
      }
      if (s.dmgAcc || s.healAcc) {
        this.dealt[(1 - s.side) as Seat] += s.dmgAcc;
        if (s.dmgAcc > 0) this.lastDamageTick = t;
        if (this.record) {
          // Ledger: what this soldier really lost and regained (no overkill, no overheal).
          const net = s.hp - s.dmgAcc + s.healAcc;
          s.rD = s.dmgAcc; s.rH = s.healAcc;
          if (net <= 0) { s.eD = s.hp; s.eH = 0; }
          else { s.eD = s.dmgAcc; s.eH = net > s.maxHp ? s.healAcc - (net - s.maxHp) : s.healAcc; }
        }
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
        if (this.record) this.tallyAdd(s.sq.row, s.sq.row, C_REVIVE, 0, 0, s.hp, 0);
        this.emit(EK.revive, s.i, Math.ceil(s.hp / 100), REVIVE_CODES.indexOf('undying_oath'));
        continue;
      }
      if (s.sq.phoenix) {
        s.sq.phoenix = false;
        s.hp = idiv(s.maxHp, 2);
        if (this.record) this.tallyAdd(s.sq.row, s.sq.row, C_REVIVE, 0, 0, s.hp, 0);
        this.emit(EK.revive, s.i, Math.ceil(s.hp / 100), REVIVE_CODES.indexOf('phoenix'));
        continue;
      }
      s.alive = false;
      s.hp = 0;
      s.anim = 4;
      s.target = null;
      if (!s.summoned) this.lost[s.side]++;
      if (!s.summoned && !(s.st.tags & (T_LARGE | T_LORD))) this.corpses.push(s);
      this.emit(EK.death, s.i, killer ? killer.i : ktower >= 0 ? ktower : -1);
      if (killer) {
        this.lordXp[killer.side] += s.xpValue;
        const kst = killer.st;
        if (kst.L.has('bloodthirst') && killer.alive) {
          this.heal(killer, idiv(killer.maxHp * BLOOD_HEAL_PCT, 100), killer, C_BLOOD);
          if (killer.blood < 3) killer.blood++;
          this.emitAbility(killer.i, s.i, 'bloodthirst', killer.x, killer.y, 0, 0);
        }
        const kb = killer.sq;
        if (kst.L.has('gravebloom') && kb.grave < GRAVE_MAX && !s.summoned && !(s.st.tags & (T_LARGE | T_LORD))) {
          kb.grave++;
          this.raiseSkeleton(kb, s);
        }
      }
      if (s.st.L.has('ember_crown')) {
        this.queueStrike({ kind: 'ember', owner: s, side: s.side, target: null, ax: s.x, ay: s.y, fx: s.x, fy: s.y, mul: 100, pid: 0, proj: 'none', melee: false, hill: false, dmg: (90 + 12 * s.st.ilvl) * 100, radius: 450, reflected: false, extra: true, towerSrc: -1, seq: 0 }, 1);
      }
    }
    if (this.record) this.settleLedger();
  }

  /**
   * Ledger: share out the life each soldier really lost / regained this tick among the sources that caused it,
   * in proportion to their raw amounts (the last source takes the rounding), then flush the window every TALLY_TICKS.
   * Bloodthirst heals queued during the death loop above land in the next tick's settlement.
   */
  settleLedger(): void {
    const n = this.cT.length;
    let keep = 0;
    for (let i = 0; i < n; i++) {
      const s = this.cT[i], amt = this.cA[i];
      if (this.cH[i]) {
        if (s.healAcc > 0 && s.rH === 0) {
          // Queued after this soldier was settled (Bloodthirst on a kill): carry it over to the next tick.
          this.cT[keep] = s; this.cS[keep] = this.cS[i]; this.cC[keep] = this.cC[i]; this.cA[keep] = amt; this.cM[keep] = 0; this.cH[keep] = 1;
          keep++;
          continue;
        }
        const e = s.rH > 0 ? idiv(amt * s.eH, s.rH) : 0;
        s.eH -= e; s.rH -= amt;
        if (e) this.tallyAdd(this.cS[i], s.sq.row, this.cC[i], 0, 0, e, 0);
      } else {
        const e = s.rD > 0 ? idiv(amt * s.eD, s.rD) : 0;
        s.eD -= e; s.rD -= amt;
        if (e || this.cM[i]) this.tallyAdd(this.cS[i], s.sq.row, this.cC[i], e, this.cM[i], 0, 1);
      }
    }
    this.cT.length = keep; this.cS.length = keep; this.cC.length = keep; this.cA.length = keep; this.cM.length = keep; this.cH.length = keep;
    if ((this.t + 1) % TALLY_TICKS === 0) this.flushTally();
  }

  raiseSkeleton(kb: BSquad, victim: Sol): void {
    const side = kb.side;
    let sk = this.squads.find((q) => q.summon && q.side === side && q.id === kb.id);
    if (!sk) {
      sk = {
        row: this.squads.length, skills: [],
        side, sideIdx: 100 + kb.sideIdx, id: kb.id, type: 'skeleton', lord: null, level: 1, st: skeletonStats(), sols: [], ax: victim.x, ay: victim.y,
        facing: side === 0 ? 64 : 192, engaged: true, engagedNext: true, macro: null, c2x: 0, c2y: 0, alive: 0, phoenix: false, grave: 0,
        slotErr: 0, slotErrNext: 0, abilityCd: 0, summon: true, healTarget: null, sourceSquad: null, stance: ST_ADVANCE, leader: null, t2x: 0, t2y: 0,
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

  /** Can any soldier of `side` target any soldier left on the other side? (Every attack hits ground; only some hit air.) */
  canDamage(side: Seat): boolean {
    let any = false, air = false;
    for (const s of this.sols) {
      if (s.side !== side || !s.alive || s.spawnTick > this.t) continue;
      any = true;
      if (s.st.canHitAir) { air = true; break; }
    }
    if (!any) return false;
    for (const e of this.sols) {
      if (e.side === side || !e.alive || e.spawnTick > this.t) continue;
      if (!(e.st.tags & T_FLIER) || air) return true;
    }
    return false;
  }

  /** Has the battle stalled? Checked every 10 ticks while both armies stand. */
  stalled(t: number): boolean {
    const c0 = this.canDamage(0), c1 = this.canDamage(1);
    if (!c0 && !c1) return true;
    if (c0 && c1) this.helplessSince = -1;
    else if (this.helplessSince < 0) this.helplessSince = t;
    else if (t - this.helplessSince >= HELPLESS_TICKS) return true;
    return this.lastDamageTick >= 0 ? t - this.lastDamageTick >= STALL_TICKS : t >= NO_CONTACT_TICKS;
  }

  /** Points for `side`: percent of its army value still standing (squad value x share of its soldiers' HP left). */
  points(side: Seat): number {
    let left = 0, total = 0;
    for (const b of this.sideSquads[side]) {
      if (b.summon || !b.sourceSquad) continue;
      const sq = b.sourceSquad;
      const value = sq.type === 'lord' ? LORD_POINTS_BASE + LORD_POINTS_PER_LEVEL * sq.level : Math.max(1, sq.spent);
      let hp = 0, max = 0;
      for (const s of b.sols) { max += s.maxHp; if (s.alive) hp += s.hp; }
      total += value;
      if (max > 0) left += idiv(value * hp, max);
    }
    return total > 0 ? idiv(left * 100, total) : 0;
  }

  /**
   * Timeout or stalemate with both armies standing. The round is decided on points, with one exception: a stalemate
   * called because exactly ONE side could no longer harm the other (`helpless`) goes to the side that still could,
   * whatever the points say. An army that cannot touch what the enemy has left has lost the field, however much of it
   * still stands (four Golems under a lone Wyvern used to win that round "on points").
   *
   * Keep damage: the winner's survivors deal theirs plus the round bonus for its points lead (roundBonus); the
   * loser's deal none. A side that wins the field while BEHIND on points has no lead, so it earns no round bonus
   * (the margin is floored at 0, never negative): its survivors' own damage is all it deals. A draw: both sides'
   * survivors deal half.
   */
  endOnPoints(end: BattleEnd): void {
    this.timeout = true;
    this.end = end;
    this.score = [this.points(0), this.points(1)];
    const d = this.score[0] - this.score[1];
    const h = end === 'stalemate' ? this.helpless : null;
    this.winner = h && h[0] !== h[1] ? (h[0] ? 1 : 0) : d >= POINTS_MARGIN ? 0 : -d >= POINTS_MARGIN ? 1 : null;
    for (const side of [0, 1] as Seat[]) this.survivors[side] = this.survivorIds(side);
    for (const side of [0, 1] as Seat[]) {
      if (this.winner !== null && this.winner !== side) continue;
      // A points win counts in full (survivors + the round bonus); a draw: both sides' survivors deal half.
      const dmg = this.winner === side
        ? keepDamageOf(this.st.players[side].squads, this.survivors[side], this.st.round, true, false, Math.max(0, this.score[side] - this.score[1 - side]))
        : keepDamageOf(this.st.players[side].squads, this.survivors[side], this.st.round, false, true);
      this.keepDamage[(1 - side) as Seat] = dmg;
      if (dmg > 0) this.hitKeep((1 - side) as Seat, keepSource((1 - side) as Seat, 2), dmg, true);
    }
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
    const dmg = keepDamageOf(this.st.players[w].squads, ids, this.st.round, true, false, this.score[w] - this.score[loserSide]);
    this.keepDamage[loserSide] = dmg;
    this.marching = true;
    this.marchDue = this.t + MARCH_TICKS;
    this.marchLeft = dmg;
    let n = 0;
    for (const s of this.sols) {
      if (s.alive && s.side === loserSide) {
        // What is left of the routed side (summoned skeletons) falls with it.
        if (this.record && s.spawnTick <= this.t) this.tallyAdd(-1, s.sq.row, C_ROUT, s.hp, 0, 0, 0);
        s.alive = false; s.anim = 4; this.emit(EK.death, s.i, -1);
      }
      if (s.alive && s.side === w) n++;
    }
    this.marchChunk = Math.max(1, Math.ceil(dmg / Math.max(1, n * 3)));
  }

  /**
   * The winners march on the loser's Keep and strike it. Each soldier owns a spot on the Keep's
   * front wall (one in five takes the foot of an arrow tower instead): melee walk right up to it
   * (their body radius + ~0.5 m off the stone; ranks jammed behind the first still strike from
   * within ~2 m of the wall), ranged stop at 4/5 of their range from it, fliers hold above it.
   * Only where and when the blows land changes: the total is `marchLeft` (see run()).
   */
  marchSoldier(s: Sol): void {
    const loser = (1 - s.side) as Seat;
    const k = this.keeps[loser];
    const sg = sideSign(s.side);
    // the spot struck: on the front wall, or at a tower's foot
    let ax: number, ay: number;
    if ((s.key * 7) % 5 === 0) {
      const tw = k.towers[s.key & 1];
      ax = tw[0] + sg * (((s.key * 37) % 300) - 150);
      ay = tw[1] - sg * TOWER_FRONT;
    } else {
      ax = k.pos[0] + sg * (((s.key * 37) % (2 * KEEP_HALF_W)) - KEEP_HALF_W);
      ay = k.pos[1] - sg * KEEP_FRONT;
    }
    const ranged = s.st.ranged;
    const reach = Math.min(s.st.range, 1800);
    const stand = ranged ? idiv(reach * 4, 5) : s.st.radius + 40 + ((s.key * 13) % 50);
    const gx = ax, gy = ay - sg * stand;
    const dx = gx - s.x, dy = gy - s.y, d2 = dx * dx + dy * dy;
    const wx = ax - s.x, wy = ay - s.y, wd2 = wx * wx + wy * wy;
    const flier = (s.st.tags & T_FLIER) !== 0;
    const sp = this.groundSpeed(s.st.speed * 2, s.x, s.y, flier, 0);
    // distance still to go to the stone, along the march
    const gap = wy * sg;
    const inPlace = ranged
      ? wd2 <= reach * reach
      : d2 <= 90 * 90 || (gap >= 0 && gap <= s.st.radius + 220 && Math.abs(wx) <= 400);
    if (inPlace) {
      s.facing = faceOr(s.facing, wx, wy);
      if (s.cd <= 0 && this.marchLeft > 0 && !s.st.healer) {
        s.cd += s.st.atk * 100;
        s.anim = 2; s.animUntil = this.t + Math.min(s.st.atk, 10);
        const tgt = keepSource(loser, 2);
        this.emit(EK.attack, s.i, tgt, WEAPON_CODES.indexOf(s.st.weapon), PROJ_CODES.indexOf(s.st.proj), s.st.proj !== 'none' ? this.flight(s.st.proj, isqrt(wd2), 0) : 6);
        const strike: Strike = { kind: 'keep', owner: s, side: s.side, target: null, ax, ay, fx: s.x, fy: s.y, mul: 100, pid: 0, proj: s.st.proj, melee: !s.st.ranged, hill: false, dmg: 0, radius: 0, reflected: false, extra: true, towerSrc: -1, seq: 0 };
        if (s.st.proj !== 'none') this.launch(strike, isqrt(wd2), 0); else this.queueStrike(strike, 6);
      }
      // melee that are not on their spot yet keep pressing in; the rest hold
      if (ranged || d2 <= 90 * 90) { this.separate(s, 0, 0, sp); return; }
    }
    let vx: number, vy: number;
    if (!flier && this.acrossRiver2(2 * s.y - (FIELD_H - 1), 2 * gy - (FIELD_H - 1))) { const f = this.flowDir(s.side, s.x, s.y); vx = idiv(f[0] * sp, 1000); vy = idiv(f[1] * sp, 1000); }
    else { const d = Math.max(1, isqrt(d2)); vx = idiv(dx * sp, d); vy = idiv(dy * sp, d); }
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
    // Never more than the keep has left: overkill is not damage.
    if (dmg > this.keepHp[seat]) dmg = this.keepHp[seat];
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
        const stall = a0 && a1 && t > 0 && t % 10 === 0 && t < MAX_BATTLE_TICKS && this.stalled(t);
        if (!a0 || !a1 || t >= MAX_BATTLE_TICKS || stall) {
          this.fightTicks = t;
          if (!a0 && !a1) { this.winner = null; this.end = 'mutualWipe'; this.finish(); return; }
          if (a0 && a1) {
            if (stall) this.helpless = [!this.canDamage(0), !this.canDamage(1)];
            this.endOnPoints(stall ? 'stalemate' : 'timeout');
            this.finish();
            return;
          }
          this.winner = a0 ? 0 : 1;
          this.score = [this.points(0), this.points(1)];
          this.startMarch(this.winner);
          if (this.marchLeft <= 0) { this.finish(); return; }
        }
      }
      this.rebuildBuckets();
      this.squadPass();
      if (!this.marching) { this.lordPass(); this.skillPass(); }
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
    if (this.record) this.flushTally();
    this.endTick = this.t;
    if (!this.fightTicks) this.fightTicks = this.t;
    if (this.record && this.t % KEYFRAME_TICKS !== 0) this.recordFrame();
  }

  output(): BattleOutput {
    const lordDamage: [number, number] = [0, 0];
    for (const b of this.squads) if (b.type === 'lord') for (const s of b.sols) lordDamage[b.side] += s.dealt;
    const result: BattleResult = {
      round: this.st.round,
      winner: this.winner,
      timeout: this.timeout,
      end: this.end,
      score: [this.score[0], this.score[1]],
      // Clamped to the keep's life: overkill on a falling keep is not damage taken.
      keepDamage: [Math.min(this.keepDamage[0], this.keeps[0].hpBefore), Math.min(this.keepDamage[1], this.keeps[1].hpBefore)],
      survivors: [this.survivors[0], this.survivors[1]],
      lordXp: [this.lordXp[0] + (this.winner === 0 ? 20 : 8), this.lordXp[1] + (this.winner === 1 ? 20 : 8)],
      ticks: this.fightTicks,
      damageDealt: [Math.round(this.dealt[0] / 100), Math.round(this.dealt[1] / 100)],
      soldiersLost: [this.lost[0], this.lost[1]],
      lordDamage: [Math.round(lordDamage[0] / 100), Math.round(lordDamage[1] / 100)],
    };
    if (this.helpless) result.helpless = [this.helpless[0], this.helpless[1]];
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
        modelId: s.sq.type === 'lord' ? LORDS[s.sq.lord!].modelId : UNITS[s.sq.type].modelId,
        level: s.sq.level, maxHp: Math.ceil(s.maxHp / 100), items, flags, spawnTick: s.spawnTick, summoned: s.summoned,
      };
      if (s.sq.lord) row.lord = s.sq.lord;
      if (s.sq.skills.length) row.skills = s.sq.skills.map((k) => k.id);
      return row;
    });
    const squads: ReplaySquad[] = this.squads.map((b) => {
      const row: ReplaySquad = { row: b.row, id: b.id, side: b.side, type: b.type, level: b.level, summoned: b.summon, soldiers: b.sols.map((s) => s.i), skills: b.skills.map((k) => k.id) };
      if (b.lord) row.lord = b.lord;
      if (b.sourceSquad) { row.items = b.sourceSquad.items; row.ownerLord = this.st.players[b.side].lord; }
      return row;
    });
    let frames = '', events = '';
    if (this.record) {
      frames = toBase64(this.frames.w.bytes());
      events = toBase64(encodeEvents(this.ev));
    }
    const replay: Replay = {
      v: REPLAY_VERSION, seed: this.seed, round: this.st.round, ticks: this.endTick, frameTicks: KEYFRAME_TICKS,
      frameCount: this.record ? this.frames.frames : 0, soldiers, squads, keeps: this.keeps, terrain: this.st.terrain, frames, events,
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

export { T_FLIER, T_LARGE, GRID_W, CELL, AGGRO };
