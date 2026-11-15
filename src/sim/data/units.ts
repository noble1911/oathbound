// Unit table (per soldier at Lv1). Tuned by tools/tournament.ts — see docs/BALANCE.md for the rationale.
// speed is cm/tick (x20 = cm/s), attackTicks at 20 Hz, ranges/radii in cm.
//
// Three factions share this table (DESIGN §4b). Every unit names the Kingdom unit it plays `like`, so bots and the
// counter table understand all rosters; `basic` units can be unlocked in round 1.
import type { KingdomUnit, UnitDef, UnitType } from '../types.ts';

type Opt = 'minRound' | 'heal' | 'lifesteal' | 'minRange' | 'splash' | 'effective' | 'traits' | 'magicResist' | 'armor' | 'faction' | 'like' | 'basic' | 'burn' | 'slow' | 'regen';
type Row = Omit<UnitDef, 'id' | 'modelId' | Opt> & Partial<Pick<UnitDef, Opt>>;

const rows: Record<UnitType, Row> = {
  militia: {
    name: 'Militia', role: 'Chaff screen', cost: 100, squadSize: 12, tags: ['infantry'], weapon: 'sword', damageType: 'physical', projectile: 'none',
    hp: 84, dmg: 9, attackTicks: 20, range: 120, speed: 15, radius: 45, armor: 10, magicResist: 0,
  },
  pikemen: {
    name: 'Pikemen', role: 'Anti-cavalry', cost: 100, squadSize: 8, tags: ['infantry'], weapon: 'lance', damageType: 'physical', projectile: 'none',
    hp: 88, dmg: 10, attackTicks: 22, range: 200, speed: 13, radius: 45, armor: 20, magicResist: 0, effective: { mounted: 250 }, traits: ['brace'],
  },
  berserkers: {
    name: 'Berserkers', role: 'Melee DPS', cost: 150, squadSize: 6, tags: ['infantry'], weapon: 'axe', damageType: 'physical', projectile: 'none',
    hp: 176, dmg: 19, attackTicks: 16, range: 130, speed: 17, radius: 50, armor: 10, magicResist: 0, lifesteal: 20,
  },
  archers: {
    name: 'Archers', role: 'Ranged', cost: 100, squadSize: 9, tags: ['infantry'], weapon: 'bow', damageType: 'physical', projectile: 'arrow',
    hp: 44, dmg: 6, attackTicks: 32, range: 2500, speed: 14, radius: 42, armor: 0, magicResist: 0, effective: { flier: 125 }, traits: ['backline'],
  },
  knights: {
    name: 'Knights', role: 'Tank', cost: 200, squadSize: 4, tags: ['armored', 'infantry'], weapon: 'lance', damageType: 'physical', projectile: 'none',
    hp: 400, dmg: 23, attackTicks: 26, range: 170, speed: 11, radius: 60, armor: 60, magicResist: 0,
  },
  cavaliers: {
    name: 'Cavaliers', role: 'Flanker', cost: 200, squadSize: 4, tags: ['mounted'], weapon: 'sword', damageType: 'physical', projectile: 'none',
    hp: 400, dmg: 31, attackTicks: 22, range: 160, speed: 32, radius: 70, armor: 20, magicResist: 0, traits: ['charge', 'raider'],
  },
  mages: {
    name: 'Mages', role: 'AoE caster', cost: 200, squadSize: 4, tags: ['infantry'], weapon: 'tome', damageType: 'magic', projectile: 'fireball',
    hp: 80, dmg: 19, attackTicks: 40, range: 2000, speed: 13, radius: 42, armor: 0, magicResist: 30, splash: 250, traits: ['ignoresArmor', 'backline'],
  },
  clerics: {
    name: 'Clerics', role: 'Healer', cost: 150, squadSize: 3, tags: ['infantry'], weapon: 'staff', damageType: 'magic', projectile: 'lightning',
    hp: 95, dmg: 9, attackTicks: 30, range: 1500, speed: 13, radius: 42, armor: 0, magicResist: 40, heal: 34, traits: ['healer', 'backline'],
  },
  pegasus: {
    name: 'Pegasus Knights', role: 'Air raider', cost: 200, squadSize: 3, tags: ['flier', 'mounted'], weapon: 'lance', damageType: 'physical', projectile: 'none',
    hp: 150, dmg: 24, attackTicks: 20, range: 170, speed: 28, radius: 70, armor: 10, magicResist: 30, traits: ['raider'],
  },
  ballista: {
    name: 'Ballista', role: 'Anti-large', cost: 200, squadSize: 1, tags: ['large'], weapon: 'bolt', damageType: 'physical', projectile: 'bolt',
    hp: 280, dmg: 95, attackTicks: 60, range: 4000, speed: 9, radius: 110, armor: 20, magicResist: 0, effective: { large: 200 }, traits: ['pierce', 'backline'],
  },
  trebuchet: {
    name: 'Trebuchet', role: 'Artillery', cost: 300, squadSize: 1, tags: ['large'], weapon: 'stone', damageType: 'physical', projectile: 'stone',
    hp: 320, dmg: 105, attackTicks: 100, range: 6000, minRange: 1200, speed: 7, radius: 140, armor: 20, magicResist: 0, splash: 500,
    traits: ['slowTurn', 'crushing', 'backline'],
  },
  golem: {
    name: 'Stone Golem', role: 'Giant tank', cost: 400, squadSize: 1, tags: ['large', 'armored'], weapon: 'fists', damageType: 'physical', projectile: 'none',
    hp: 3400, dmg: 80, attackTicks: 36, range: 260, speed: 9, radius: 160, armor: 35, magicResist: 10, splash: 250, traits: ['stomp', 'crushing'],
  },
  wyvern: {
    name: 'Wyvern Riders', role: 'Heavy air', cost: 300, squadSize: 2, tags: ['flier', 'large', 'mounted'], weapon: 'axe', damageType: 'physical', projectile: 'none',
    hp: 720, dmg: 55, attackTicks: 30, range: 220, speed: 23, radius: 120, armor: 25, magicResist: 10,
  },
  dragon: {
    name: 'Dragon', role: 'Late game', cost: 500, squadSize: 1, tags: ['flier', 'large'], weapon: 'breath', damageType: 'magic', projectile: 'firebreath',
    hp: 2800, dmg: 45, attackTicks: 30, range: 700, speed: 20, radius: 200, armor: 20, magicResist: 30, splash: 400, traits: ['cone'], minRound: 5,
  },

  // ---------------------------------------------------------------- The Ashen Covenant (undead)
  skeleton: {
    faction: 'ashen', like: 'pikemen', basic: true,
    name: 'Skeleton Spearmen', role: 'Chaff, anti-cavalry', cost: 100, squadSize: 10, tags: ['infantry'], weapon: 'lance', damageType: 'physical', projectile: 'none',
    hp: 68, dmg: 8, attackTicks: 22, range: 190, speed: 14, radius: 45, armor: 10, magicResist: 0, effective: { mounted: 200 }, traits: ['brace'],
  },
  grave_knight: {
    faction: 'ashen', like: 'knights', basic: true,
    name: 'Grave Knights', role: 'Heavy infantry', cost: 200, squadSize: 4, tags: ['armored', 'infantry'], weapon: 'sword', damageType: 'physical', projectile: 'none',
    hp: 330, dmg: 24, attackTicks: 26, range: 160, speed: 11, radius: 60, armor: 55, magicResist: 0, lifesteal: 10,
  },
  bone_archer: {
    faction: 'ashen', like: 'archers', basic: true,
    name: 'Bone Archers', role: 'Ranged', cost: 100, squadSize: 9, tags: ['infantry'], weapon: 'bow', damageType: 'physical', projectile: 'arrow',
    hp: 40, dmg: 6, attackTicks: 30, range: 2400, speed: 14, radius: 42, armor: 0, magicResist: 0, effective: { flier: 125 }, traits: ['backline'],
  },
  wraith_rider: {
    faction: 'ashen', like: 'cavaliers', basic: true,
    // Spectral steeds are not flesh: the riders do not carry the 'mounted' tag, so anti-cavalry bonuses miss them
    // (a braced spear wall still stops their charge).
    name: 'Wraith Riders', role: 'Spectral flanker', cost: 200, squadSize: 4, tags: [], weapon: 'sword', damageType: 'physical', projectile: 'none',
    // Ethereal: blades pass through them (45% armor), magic bites deeper (-10% resistance).
    hp: 330, dmg: 32, attackTicks: 22, range: 160, speed: 30, radius: 70, armor: 45, magicResist: -10, traits: ['charge', 'raider'],
  },
  grave_acolyte: {
    faction: 'ashen', like: 'mages', basic: true,
    name: 'Grave Acolytes', role: 'Necromancer', cost: 200, squadSize: 3, tags: ['infantry'], weapon: 'staff', damageType: 'magic', projectile: 'lightning',
    hp: 100, dmg: 20, attackTicks: 34, range: 1800, speed: 13, radius: 42, armor: 0, magicResist: 30, lifesteal: 30, traits: ['raise', 'backline'],
  },
  bone_drake: {
    faction: 'ashen', like: 'wyvern',
    name: 'Bone Drake', role: 'Heavy air', cost: 300, squadSize: 1, tags: ['flier', 'large'], weapon: 'axe', damageType: 'physical', projectile: 'none',
    // Arrows rattle through its ribs: 40% of all physical damage is lost on it; magic is the answer.
    hp: 1500, dmg: 95, attackTicks: 30, range: 240, speed: 22, radius: 160, armor: 40, magicResist: 0, splash: 200,
  },
  corpse_catapult: {
    faction: 'ashen', like: 'trebuchet',
    name: 'Corpse Catapult', role: 'Plague artillery', cost: 300, squadSize: 1, tags: ['large'], weapon: 'stone', damageType: 'physical', projectile: 'stone',
    hp: 320, dmg: 95, attackTicks: 100, range: 5500, minRange: 1200, speed: 7, radius: 140, armor: 20, magicResist: 0, splash: 500, burn: 4,
    traits: ['slowTurn', 'backline'],
  },
  bone_golem: {
    faction: 'ashen', like: 'golem',
    name: 'Bone Golem', role: 'Giant', cost: 400, squadSize: 1, tags: ['large', 'armored'], weapon: 'fists', damageType: 'physical', projectile: 'none',
    hp: 3100, dmg: 85, attackTicks: 34, range: 260, speed: 9, radius: 160, armor: 30, magicResist: 0, splash: 250, traits: ['stomp', 'crushing'],
  },

  // ---------------------------------------------------------------- The Sun Caliphate (desert empire)
  spear_levy: {
    faction: 'caliphate', like: 'pikemen', basic: true,
    name: 'Spear Levy', role: 'Chaff, anti-cavalry', cost: 100, squadSize: 10, tags: ['infantry'], weapon: 'lance', damageType: 'physical', projectile: 'none',
    hp: 72, dmg: 9, attackTicks: 22, range: 200, speed: 14, radius: 45, armor: 10, magicResist: 0, effective: { mounted: 200 }, traits: ['brace'],
  },
  scimitar: {
    faction: 'caliphate', like: 'berserkers', basic: true,
    name: 'Scimitar Guard', role: 'Line infantry', cost: 150, squadSize: 6, tags: ['infantry'], weapon: 'sword', damageType: 'physical', projectile: 'none',
    hp: 172, dmg: 19, attackTicks: 15, range: 130, speed: 17, radius: 50, armor: 15, magicResist: 0,
  },
  camel_archer: {
    faction: 'caliphate', like: 'archers', basic: true,
    name: 'Camel Archers', role: 'Mounted ranged', cost: 200, squadSize: 4, tags: ['mounted'], weapon: 'bow', damageType: 'physical', projectile: 'arrow',
    hp: 150, dmg: 15, attackTicks: 28, range: 1800, speed: 24, radius: 70, armor: 10, magicResist: 0, effective: { flier: 125 }, traits: ['backline'],
  },
  mamluk: {
    faction: 'caliphate', like: 'cavaliers', basic: true,
    name: 'Mamluk Lancers', role: 'Shock cavalry', cost: 200, squadSize: 4, tags: ['mounted', 'armored'], weapon: 'lance', damageType: 'physical', projectile: 'none',
    hp: 335, dmg: 32, attackTicks: 24, range: 180, speed: 28, radius: 70, armor: 35, magicResist: 0, traits: ['charge', 'raider'],
  },
  djinn_binder: {
    faction: 'caliphate', like: 'mages', basic: true,
    name: 'Djinn-Binders', role: 'Whirlwind caster', cost: 200, squadSize: 4, tags: ['infantry'], weapon: 'tome', damageType: 'magic', projectile: 'fireball',
    hp: 80, dmg: 16, attackTicks: 40, range: 1900, speed: 13, radius: 42, armor: 0, magicResist: 30, splash: 300, slow: 25, traits: ['ignoresArmor', 'backline'],
  },
  sun_priest: {
    faction: 'caliphate', like: 'clerics', basic: true,
    name: 'Sun Priests', role: 'Healer, buffer', cost: 150, squadSize: 3, tags: ['infantry'], weapon: 'staff', damageType: 'magic', projectile: 'lightning',
    hp: 100, dmg: 9, attackTicks: 30, range: 1500, speed: 13, radius: 42, armor: 0, magicResist: 40, heal: 32, traits: ['healer', 'bless', 'backline'],
  },
  djinn: {
    // Plays like Pegasus Knights, not Wyverns: it is not Large, so bolt-throwers are no answer to it (the bots
    // used to buy Ballistae against Djinn).
    faction: 'caliphate', like: 'pegasus',
    // Wind-blades: a sword in the weapon triangle (beats axes, loses to lances), dealing magic damage.
    name: 'Bound Djinn', role: 'Air striker', cost: 300, squadSize: 2, tags: ['flier'], weapon: 'sword', damageType: 'magic', projectile: 'none',
    hp: 520, dmg: 50, attackTicks: 28, range: 220, speed: 24, radius: 110, armor: 0, magicResist: 15, splash: 150,
  },
  war_elephant: {
    faction: 'caliphate', like: 'golem', minRound: 3,
    name: 'War Elephant', role: 'Giant, archer tower', cost: 400, squadSize: 1, tags: ['large', 'mounted'], weapon: 'fists', damageType: 'physical', projectile: 'none',
    hp: 2800, dmg: 75, attackTicks: 34, range: 280, speed: 12, radius: 170, armor: 25, magicResist: 0, splash: 300, traits: ['stomp', 'howdah'],
  },
  sand_golem: {
    faction: 'caliphate', like: 'golem',
    name: 'Sand Golem', role: 'Regenerating giant', cost: 300, squadSize: 1, tags: ['large'], weapon: 'fists', damageType: 'physical', projectile: 'none',
    hp: 2000, dmg: 60, attackTicks: 34, range: 250, speed: 9, radius: 150, armor: 20, magicResist: 20, splash: 200, regen: 15, traits: ['stomp'],
  },
};

export const UNIT_TYPES = Object.keys(rows) as UnitType[];
const KINGDOM_BASIC: readonly UnitType[] = ['militia', 'pikemen', 'berserkers', 'archers', 'knights', 'cavaliers', 'mages', 'clerics', 'pegasus'];

export const UNITS: Record<UnitType, UnitDef> = Object.fromEntries(
  UNIT_TYPES.map((id) => {
    const r = rows[id];
    const def: UnitDef = {
      id, modelId: id, minRound: 1, heal: 0, lifesteal: 0, minRange: 0, splash: 0, effective: {}, traits: [], armor: 0, magicResist: 0,
      faction: 'kingdom', like: id as KingdomUnit, basic: false, burn: 0, slow: 0, regen: 0,
      ...r,
    };
    if (def.faction === 'kingdom') def.basic = KINGDOM_BASIC.includes(id);
    return [id, def];
  }),
) as Record<UnitType, UnitDef>;

/** The Kingdom's round-1 units (the other factions mark theirs with `basic` in the table; see FACTIONS[f].basic). */
export const BASIC_POOL: readonly UnitType[] = KINGDOM_BASIC;

/** The Kingdom unit `u` plays like (itself for Kingdom units). */
export function like(u: UnitType): KingdomUnit {
  return UNITS[u].like;
}

export function unitDef(t: UnitType): UnitDef {
  return UNITS[t];
}
