// Unit table (per soldier at Lv1). Tuned by tools/tournament.ts — see docs/BALANCE.md for the rationale.
// speed is cm/tick (x20 = cm/s), attackTicks at 20 Hz, ranges/radii in cm.
import type { UnitDef, UnitType } from '../types.ts';

type Row = Omit<UnitDef, 'id' | 'modelId' | 'minRound' | 'heal' | 'lifesteal' | 'minRange' | 'splash' | 'effective' | 'traits' | 'magicResist' | 'armor'> &
  Partial<Pick<UnitDef, 'minRound' | 'heal' | 'lifesteal' | 'minRange' | 'splash' | 'effective' | 'traits' | 'magicResist' | 'armor'>>;

const rows: Record<UnitType, Row> = {
  militia: {
    name: 'Militia', role: 'Chaff screen', cost: 100, squadSize: 12, tags: ['infantry'], weapon: 'sword', damageType: 'physical', projectile: 'none',
    hp: 70, dmg: 8, attackTicks: 20, range: 120, speed: 15, radius: 45, armor: 10, magicResist: 0,
  },
  pikemen: {
    name: 'Pikemen', role: 'Anti-cavalry', cost: 100, squadSize: 8, tags: ['infantry'], weapon: 'lance', damageType: 'physical', projectile: 'none',
    hp: 88, dmg: 10, attackTicks: 22, range: 200, speed: 13, radius: 45, armor: 20, magicResist: 0, effective: { mounted: 250 }, traits: ['brace'],
  },
  berserkers: {
    name: 'Berserkers', role: 'Melee DPS', cost: 150, squadSize: 6, tags: ['infantry'], weapon: 'axe', damageType: 'physical', projectile: 'none',
    hp: 160, dmg: 18, attackTicks: 16, range: 130, speed: 17, radius: 50, armor: 10, magicResist: 0, lifesteal: 20,
  },
  archers: {
    name: 'Archers', role: 'Ranged', cost: 100, squadSize: 9, tags: ['infantry'], weapon: 'bow', damageType: 'physical', projectile: 'arrow',
    hp: 44, dmg: 6, attackTicks: 32, range: 2500, speed: 14, radius: 42, armor: 0, magicResist: 0, effective: { flier: 125 }, traits: ['backline'],
  },
  knights: {
    name: 'Knights', role: 'Tank', cost: 200, squadSize: 4, tags: ['armored', 'infantry'], weapon: 'lance', damageType: 'physical', projectile: 'none',
    hp: 360, dmg: 22, attackTicks: 26, range: 170, speed: 11, radius: 60, armor: 60, magicResist: 0,
  },
  cavaliers: {
    name: 'Cavaliers', role: 'Flanker', cost: 200, squadSize: 4, tags: ['mounted'], weapon: 'sword', damageType: 'physical', projectile: 'none',
    hp: 300, dmg: 28, attackTicks: 22, range: 160, speed: 32, radius: 70, armor: 20, magicResist: 0, traits: ['charge', 'raider'],
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
};

export const UNIT_TYPES = Object.keys(rows) as UnitType[];

export const UNITS: Record<UnitType, UnitDef> = Object.fromEntries(
  UNIT_TYPES.map((id) => {
    const r = rows[id];
    const def: UnitDef = {
      id, modelId: id, minRound: 1, heal: 0, lifesteal: 0, minRange: 0, splash: 0, effective: {}, traits: [], armor: 0, magicResist: 0,
      ...r,
    };
    return [id, def];
  }),
) as Record<UnitType, UnitDef>;

/** Units that can appear in the round-1 basic draft (pick 2 of a random 3). */
export const BASIC_POOL: readonly UnitType[] = ['militia', 'pikemen', 'berserkers', 'archers', 'knights', 'cavaliers', 'mages', 'clerics', 'pegasus'];

export function unitDef(t: UnitType): UnitDef {
  return UNITS[t];
}
