// The four Lords (DESIGN §4). Stats are Lv1; each Lord level adds LORD_LEVEL_HP% HP and LORD_LEVEL_DMG% damage.
import type { LordDef, LordId } from '../types.ts';

export const LORD_LEVEL_HP = 10;
export const LORD_LEVEL_DMG = 8;
/** Lord ability numbers (battle.ts and the skill lists read these). */
export const RALLY_PCT = 40;
export const METEOR_BASE = 18;
export const METEOR_PER_LEVEL = 3;
export const ARCHMAGE_MAGIC_PCT = 76;

export const LORDS: Record<LordId, LordDef> = {
  marshal: {
    id: 'marshal', name: 'Aldric', title: 'Marshal', modelId: 'lord_marshal', weapon: 'sword', damageType: 'physical', projectile: 'none',
    signature: ['militia', 'cavaliers'], tags: ['infantry'],
    hp: 900, dmg: 40, attackTicks: 20, range: 160, speed: 16, armor: 30, magicResist: 20, splash: 0,
    passive: '+1 squad deployment per round',
    ability: 'rally', abilityName: 'Rally', abilityText: `Allied squads within 20 m gain +${RALLY_PCT}% attack speed for 10 s.`,
  },
  archmage: {
    id: 'archmage', name: 'Sefa', title: 'Archmage', modelId: 'lord_archmage', weapon: 'tome', damageType: 'magic', projectile: 'fireball',
    signature: ['mages', 'clerics'], tags: ['infantry'],
    hp: 520, dmg: 34, attackTicks: 40, range: 2000, speed: 14, armor: 0, magicResist: 40, splash: 250,
    passive: `Magic damage +${ARCHMAGE_MAGIC_PCT}%`,
    ability: 'meteor', abilityName: 'Meteor', abilityText: 'Calls a meteor on the densest enemy cluster, 10 m radius.',
  },
  warden: {
    id: 'warden', name: 'Hrolf', title: 'Warden', modelId: 'lord_warden', weapon: 'axe', damageType: 'physical', projectile: 'none',
    signature: ['berserkers', 'knights'], tags: ['armored', 'infantry'],
    hp: 1200, dmg: 36, attackTicks: 24, range: 170, speed: 13, armor: 45, magicResist: 10, splash: 0,
    passive: 'Keep +800 HP; squads +10% HP',
    ability: 'bulwark', abilityName: 'Bulwark', abilityText: 'Allies within 12 m take 40% less damage for 6 s.',
  },
  skylady: {
    id: 'skylady', name: 'Ione', title: 'Skylady', modelId: 'lord_skylady', weapon: 'lance', damageType: 'physical', projectile: 'none',
    signature: ['pegasus', 'archers'], tags: ['flier', 'mounted'],
    hp: 700, dmg: 38, attackTicks: 20, range: 180, speed: 26, armor: 15, magicResist: 30, splash: 0,
    passive: 'Loot picks show 4 items instead of 3',
    ability: 'skyfall', abilityName: 'Skyfall', abilityText: 'Dives onto the furthest enemy ranged squad, striking everything within 4 m.',
  },
};

export const LORD_IDS = Object.keys(LORDS) as LordId[];
