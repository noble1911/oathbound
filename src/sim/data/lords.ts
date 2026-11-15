// The Lords (DESIGN §4): four of the Kingdom, one each of the Ashen Covenant and the Sun Caliphate. Stats are Lv1; each Lord level adds LORD_LEVEL_HP% HP and LORD_LEVEL_DMG% damage.
import type { LordDef, LordId } from '../types.ts';

export const LORD_LEVEL_HP = 10;
export const LORD_LEVEL_DMG = 8;
/** Lord ability numbers (battle.ts and the skill lists read these). */
export const RALLY_PCT = 40;
export const METEOR_BASE = 18;
export const METEOR_PER_LEVEL = 3;
export const ARCHMAGE_MAGIC_PCT = 70;
/** Lich-Priest: squads deal this much more damage; Necromancy raises NECRO_BASE + level / NECRO_LEVELS_PER skeletons from corpses within NECRO_RANGE cm. */
export const LICH_DMG_PCT = 12;
export const NECRO_BASE = 3;
export const NECRO_LEVELS_PER = 3;
export const NECRO_RANGE = 2500;
/** Sultana: squads attack this much faster; Radiance deals RADIANCE_BASE + RADIANCE_PER_LEVEL x level magic damage and heals allies as much, within RADIANCE_RANGE cm. */
export const SULTANA_HASTE_PCT = 8;
export const RADIANCE_BASE = 20;
export const RADIANCE_PER_LEVEL = 4;
export const RADIANCE_RANGE = 800;
/** Sunlight burns the dead: damage percent of the Sultana (blade and Radiance) and of Sun Priests against undead (Ashen units, the Lich, raised skeletons). */
export const SULTANA_HOLY = 125;
export const SUN_PRIEST_HOLY = 150;

export const LORDS: Record<LordId, LordDef> = {
  marshal: {
    id: 'marshal', faction: 'kingdom', name: 'Aldric', title: 'Marshal', modelId: 'lord_marshal', weapon: 'sword', damageType: 'physical', projectile: 'none',
    signature: ['militia', 'cavaliers'], tags: ['infantry'],
    hp: 900, dmg: 40, attackTicks: 20, range: 160, speed: 16, armor: 30, magicResist: 20, splash: 0,
    passive: '+1 squad deployment per round',
    ability: 'rally', abilityName: 'Rally', abilityText: `Allied squads within 20 m gain +${RALLY_PCT}% attack speed for 10 s.`,
  },
  archmage: {
    id: 'archmage', faction: 'kingdom', name: 'Sefa', title: 'Archmage', modelId: 'lord_archmage', weapon: 'tome', damageType: 'magic', projectile: 'fireball',
    signature: ['mages', 'clerics'], tags: ['infantry'],
    hp: 520, dmg: 34, attackTicks: 40, range: 2000, speed: 14, armor: 0, magicResist: 40, splash: 150,
    passive: `Magic damage +${ARCHMAGE_MAGIC_PCT}%`,
    ability: 'meteor', abilityName: 'Meteor', abilityText: 'Calls a meteor on the densest enemy cluster, 10 m radius.',
  },
  warden: {
    id: 'warden', faction: 'kingdom', name: 'Hrolf', title: 'Warden', modelId: 'lord_warden', weapon: 'axe', damageType: 'physical', projectile: 'none',
    signature: ['berserkers', 'knights'], tags: ['armored', 'infantry'],
    hp: 1200, dmg: 36, attackTicks: 24, range: 170, speed: 13, armor: 45, magicResist: 10, splash: 0,
    passive: 'Keep +800 HP; squads +10% HP',
    ability: 'bulwark', abilityName: 'Bulwark', abilityText: 'Allies within 12 m take 40% less damage for 6 s.',
  },
  skylady: {
    id: 'skylady', faction: 'kingdom', name: 'Ione', title: 'Skylady', modelId: 'lord_skylady', weapon: 'lance', damageType: 'physical', projectile: 'none',
    signature: ['pegasus', 'archers'], tags: ['flier', 'mounted'],
    hp: 700, dmg: 38, attackTicks: 20, range: 180, speed: 26, armor: 15, magicResist: 30, splash: 0,
    passive: 'Loot picks show 4 items instead of 3',
    ability: 'skyfall', abilityName: 'Skyfall', abilityText: 'Dives onto the furthest enemy ranged squad, striking everything within 4 m.',
  },
  lich: {
    id: 'lich', faction: 'ashen', name: 'Morthen', title: 'Lich-Priest', modelId: 'lord_lich', weapon: 'tome', damageType: 'magic', projectile: 'lightning',
    signature: ['skeleton', 'grave_acolyte'], tags: ['infantry'],
    hp: 560, dmg: 30, attackTicks: 38, range: 1800, speed: 13, armor: 0, magicResist: 40, splash: 200,
    passive: `Squads deal +${LICH_DMG_PCT}% damage`,
    ability: 'necromancy', abilityName: 'Necromancy', abilityText: `Raises ${NECRO_BASE} (+1 per ${NECRO_LEVELS_PER} Lord levels) skeletons from the fallen within ${NECRO_RANGE / 100} m.`,
  },
  sultana: {
    id: 'sultana', faction: 'caliphate', name: 'Zahira', title: 'Sultana', modelId: 'lord_sultana', weapon: 'sword', damageType: 'physical', projectile: 'none',
    signature: ['spear_levy', 'camel_archer'], tags: ['infantry'],
    hp: 950, dmg: 36, attackTicks: 20, range: 170, speed: 16, armor: 30, magicResist: 25, splash: 0,
    passive: `Squads attack ${SULTANA_HASTE_PCT}% faster`,
    ability: 'radiance', abilityName: 'Radiance', abilityText: `A burst of sunlight within ${RADIANCE_RANGE / 100} m: ${RADIANCE_BASE} (+${RADIANCE_PER_LEVEL} per Lord level) magic damage to enemies (a quarter more to the undead), and as much life restored to allies.`,
  },
};

export const LORD_IDS = Object.keys(LORDS) as LordId[];
