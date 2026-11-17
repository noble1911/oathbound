// The Lords (DESIGN §4): four per faction, one in each role: infantry, magic, armour and fliers. Each newer Lord's
// passive and ability have a counterpart among the Kingdom's four (Marshal, Archmage, Warden, Skylady), so they balance
// against comparable numbers. Stats are Lv1; each Lord level adds LORD_LEVEL_HP% HP and LORD_LEVEL_DMG% damage.
import type { LordDef, LordId } from '../types.ts';

export const LORD_LEVEL_HP = 10;
export const LORD_LEVEL_DMG = 8;
/** Lord ability numbers (battle.ts and the skill lists read these). */
export const RALLY_PCT = 40;
export const METEOR_BASE = 18;
export const METEOR_PER_LEVEL = 3;
export const ARCHMAGE_MAGIC_PCT = 55;
/** Lich-Priest: squads deal this much more damage; Necromancy raises NECRO_BASE + level / NECRO_LEVELS_PER skeletons from corpses within NECRO_RANGE cm. */
export const LICH_DMG_PCT = 12;
export const NECRO_BASE = 3;
export const NECRO_LEVELS_PER = 3;
export const NECRO_RANGE = 2500;
/** Sultana: squads attack this much faster; Radiance deals RADIANCE_BASE + RADIANCE_PER_LEVEL x level magic damage and heals allies as much, within RADIANCE_RANGE cm. */
export const SULTANA_HASTE_PCT = 12;
export const RADIANCE_BASE = 20;
export const RADIANCE_PER_LEVEL = 4;
export const RADIANCE_RANGE = 800;
/** Rally / Bulwark reach (cm), the ring within which Meteor looks for its target, and how near an enemy must be before
 *  Rally, Bulwark, Skyfall and Necromancy fire. battle.ts reads these; the planning screen draws them as the Lord's aura ring. */
export const RALLY_RANGE = 2000;
export const BULWARK_RANGE = 1200;
export const METEOR_REACH = 4000;
export const LORD_TRIGGER_RANGE = 2500;

// ---- The Ashen Covenant's other three Lords
/** Death Knight (infantry, like the Marshal): infantry squads (and he) deal DK_INFANTRY_PCT% more damage; Soul Reaping makes
 *  allies within SOUL_REAP_RANGE drain SOUL_REAP_PCT% of the damage they deal as life for SOUL_REAP_TICKS. */
export const DK_INFANTRY_PCT = 15;
export const SOUL_REAP_RANGE = 2000;
export const SOUL_REAP_PCT = 35;
export const SOUL_REAP_TICKS = 200;
/** Ossuary Warden (armour, like the Warden): keep +OSSUARY_KEEP_BONUS, squads +OSSUARY_ARMOR armour; Grave Taunt forces the
 *  enemies within TAUNT_RANGE to attack him for TAUNT_TICKS while he takes TAUNT_GUARD_PCT% less damage. */
export const OSSUARY_KEEP_BONUS = 500;
export const OSSUARY_ARMOR = 8;
export const TAUNT_RANGE = 1000;
export const TAUNT_TICKS = 100;
export const TAUNT_GUARD_PCT = 40;
/** Bone Drake Rider (fliers, like the Skylady): squads move DRAKE_SPEED_PCT% faster; Plague Breath dives onto the densest
 *  enemy cluster within PLAGUE_REACH: PLAGUE_PCT% of her damage as magic within PLAGUE_RADIUS, and a plague of
 *  PLAGUE_BURN_BASE + PLAGUE_BURN_PER_LEVEL x level damage a second for 3 s. */
export const DRAKE_SPEED_PCT = 10;
export const PLAGUE_REACH = 3000;
export const PLAGUE_RADIUS = 450;
export const PLAGUE_PCT = 120;
export const PLAGUE_BURN_BASE = 10;
export const PLAGUE_BURN_PER_LEVEL = 1;

// ---- The Sun Caliphate's other three Lords
/** Grand Vizier (magic, like the Archmage): magic squads attack VIZIER_HASTE_PCT% faster; the Djinn Whirlwind spins on the
 *  densest enemy cluster within WHIRL_REACH for WHIRL_WAVES seconds: each second WHIRL_BASE + WHIRL_PER_LEVEL x level
 *  magic damage within WHIRL_RADIUS and a WHIRL_SLOW% slow. */
export const VIZIER_HASTE_PCT = 20;
export const WHIRL_REACH = 4000;
export const WHIRL_RADIUS = 500;
export const WHIRL_WAVES = 4;
export const WHIRL_BASE = 10;
export const WHIRL_PER_LEVEL = 2;
export const WHIRL_SLOW = 40;
/** Rajah (armour and giants, like the Warden): Giants (and he) have +RAJAH_GIANT_HP% life and +RAJAH_GIANT_ARMOR armour;
 *  Stampede charges through the nearest ground enemy within STAMPEDE_REACH (2 m past it, at most STAMPEDE_LEN), trampling everything within
 *  STAMPEDE_WIDTH of his path for STAMPEDE_BASE + STAMPEDE_PER_LEVEL x level and throwing it STAMPEDE_KNOCK aside. */
export const RAJAH_GIANT_HP = 20;
export const RAJAH_GIANT_ARMOR = 10;
export const STAMPEDE_REACH = 1200;
export const STAMPEDE_LEN = 1400;
export const STAMPEDE_WIDTH = 280;
export const STAMPEDE_BASE = 40;
export const STAMPEDE_PER_LEVEL = 6;
export const STAMPEDE_KNOCK = 200;
/** Roc Rider (fliers, like the Skylady): archer squads deal ROC_RANGED_PCT% more damage; Talon Strike seizes the toughest
 *  enemy within TALON_REACH that is not Large, deals TALON_PCT% of her damage, drops it TALON_THROW towards her own lines
 *  and stuns it for TALON_STUN ticks. */
export const ROC_RANGED_PCT = 25;
export const TALON_REACH = 3000;
export const TALON_PCT = 250;
export const TALON_THROW = 800;
export const TALON_STUN = 30;
/** The radius (cm) the planning screen rings around a Lord, and what that ring means. */
export function lordAuraRing(ability: LordDef['ability']): { radius: number; label: string } {
  switch (ability) {
    case 'rally': return { radius: RALLY_RANGE, label: 'Rally' };
    case 'bulwark': return { radius: BULWARK_RANGE, label: 'Bulwark' };
    case 'radiance': return { radius: RADIANCE_RANGE, label: 'Radiance' };
    case 'necromancy': return { radius: NECRO_RANGE, label: 'Necromancy' };
    case 'meteor': return { radius: METEOR_REACH, label: 'Meteor reach' };
    case 'skyfall': return { radius: LORD_TRIGGER_RANGE, label: 'Skyfall trigger' };
    case 'soul_reap': return { radius: SOUL_REAP_RANGE, label: 'Soul Reaping' };
    case 'grave_taunt': return { radius: TAUNT_RANGE, label: 'Grave Taunt' };
    case 'plague_breath': return { radius: PLAGUE_REACH, label: 'Plague Breath reach' };
    case 'whirlwind': return { radius: WHIRL_REACH, label: 'Whirlwind reach' };
    case 'stampede': return { radius: STAMPEDE_REACH, label: 'Stampede reach' };
    case 'talon': return { radius: TALON_REACH, label: 'Talon reach' };
  }
}
/** Sunlight burns the dead: damage percent of the Sultana (blade and Radiance) and of Sun Priests against undead (Ashen units, the Lich, raised skeletons). */
export const SULTANA_HOLY = 150;
export const SUN_PRIEST_HOLY = 150;

export const LORDS: Record<LordId, LordDef> = {
  marshal: {
    id: 'marshal', class: 'line', faction: 'kingdom', name: 'Aldric', title: 'Marshal', modelId: 'lord_marshal', weapon: 'sword', damageType: 'physical', projectile: 'none',
    signature: ['militia', 'cavaliers'], tags: ['infantry'],
    hp: 900, dmg: 40, attackTicks: 20, range: 160, speed: 16, armor: 30, magicResist: 20, splash: 0,
    passive: '+2 deploy points per round',
    ability: 'rally', abilityName: 'Rally', abilityText: `Allied squads within ${RALLY_RANGE / 100} m gain +${RALLY_PCT}% attack speed for 10 s.`,
  },
  archmage: {
    id: 'archmage', class: 'magic', faction: 'kingdom', name: 'Sefa', title: 'Archmage', modelId: 'lord_archmage', weapon: 'tome', damageType: 'magic', projectile: 'fireball',
    signature: ['mages', 'clerics'], tags: ['infantry'],
    hp: 520, dmg: 34, attackTicks: 40, range: 2000, speed: 14, armor: 0, magicResist: 40, splash: 150,
    passive: `Magic damage +${ARCHMAGE_MAGIC_PCT}%`,
    ability: 'meteor', abilityName: 'Meteor', abilityText: 'Calls a meteor on the densest enemy cluster, 10 m radius.',
  },
  warden: {
    id: 'warden', class: 'line', faction: 'kingdom', name: 'Hrolf', title: 'Warden', modelId: 'lord_warden', weapon: 'axe', damageType: 'physical', projectile: 'none',
    signature: ['berserkers', 'knights'], tags: ['armored', 'infantry'],
    hp: 1200, dmg: 36, attackTicks: 24, range: 170, speed: 13, armor: 45, magicResist: 10, splash: 0,
    passive: 'Keep +800 HP; squads +10% HP',
    ability: 'bulwark', abilityName: 'Bulwark', abilityText: `Allies within ${BULWARK_RANGE / 100} m take 40% less damage for 6 s.`,
  },
  skylady: {
    id: 'skylady', class: 'air', faction: 'kingdom', name: 'Ione', title: 'Skylady', modelId: 'lord_skylady', weapon: 'lance', damageType: 'physical', projectile: 'none',
    signature: ['pegasus', 'archers'], tags: ['flier', 'mounted'],
    hp: 700, dmg: 38, attackTicks: 20, range: 180, speed: 26, armor: 15, magicResist: 30, splash: 0,
    passive: 'Loot picks show 4 items instead of 3',
    ability: 'skyfall', abilityName: 'Skyfall', abilityText: 'Dives onto the furthest enemy ranged squad, striking everything within 4 m.',
  },
  lich: {
    id: 'lich', class: 'magic', faction: 'ashen', name: 'Morthen', title: 'Lich-Priest', modelId: 'lord_lich', weapon: 'tome', damageType: 'magic', projectile: 'lightning',
    signature: ['skeleton', 'grave_acolyte'], tags: ['infantry'],
    hp: 560, dmg: 30, attackTicks: 38, range: 1800, speed: 13, armor: 0, magicResist: 40, splash: 200,
    passive: `Squads deal +${LICH_DMG_PCT}% damage`,
    ability: 'necromancy', abilityName: 'Necromancy', abilityText: `Raises ${NECRO_BASE} (+1 per ${NECRO_LEVELS_PER} Lord levels) skeletons from the fallen within ${NECRO_RANGE / 100} m.`,
  },
  sultana: {
    id: 'sultana', class: 'line', faction: 'caliphate', name: 'Zahira', title: 'Sultana', modelId: 'lord_sultana', weapon: 'sword', damageType: 'physical', projectile: 'none',
    signature: ['spear_levy', 'camel_archer'], tags: ['infantry'],
    hp: 950, dmg: 36, attackTicks: 20, range: 170, speed: 16, armor: 30, magicResist: 25, splash: 0,
    passive: `Squads attack ${SULTANA_HASTE_PCT}% faster`,
    ability: 'radiance', abilityName: 'Radiance', abilityText: `A burst of sunlight within ${RADIANCE_RANGE / 100} m: ${RADIANCE_BASE} (+${RADIANCE_PER_LEVEL} per Lord level) magic damage to enemies (${SULTANA_HOLY - 100}% more to the undead), and as much life restored to allies.`,
  },
  // ---- The Ashen Covenant
  deathknight: {
    id: 'deathknight', class: 'line', faction: 'ashen', name: 'Vaelric', title: 'Death Knight', modelId: 'lord_deathknight', weapon: 'sword', damageType: 'physical', projectile: 'none',
    signature: ['skeleton', 'wraith_rider'], tags: ['infantry'],
    hp: 950, dmg: 40, attackTicks: 22, range: 170, speed: 15, armor: 35, magicResist: 20, splash: 0,
    passive: `Infantry squads (and he) deal +${DK_INFANTRY_PCT}% damage`,
    ability: 'soul_reap', abilityName: 'Soul Reaping', abilityText: `Allies within ${SOUL_REAP_RANGE / 100} m drain ${SOUL_REAP_PCT}% of the damage they deal as life for ${SOUL_REAP_TICKS / 20} s.`,
  },
  ossuary: {
    id: 'ossuary', class: 'giant', faction: 'ashen', name: 'Gorrath', title: 'Ossuary Warden', modelId: 'lord_ossuary', weapon: 'axe', damageType: 'physical', projectile: 'none',
    signature: ['grave_knight', 'bone_archer'], tags: ['armored', 'infantry'],
    hp: 1300, dmg: 34, attackTicks: 26, range: 180, speed: 12, armor: 50, magicResist: 10, splash: 0,
    passive: `Keep +${OSSUARY_KEEP_BONUS} HP; squads +${OSSUARY_ARMOR} armour`,
    ability: 'grave_taunt', abilityName: 'Grave Taunt', abilityText: `Enemies within ${TAUNT_RANGE / 100} m must attack him for ${TAUNT_TICKS / 20} s, while he takes ${TAUNT_GUARD_PCT}% less damage.`,
  },
  drakerider: {
    id: 'drakerider', class: 'air', faction: 'ashen', name: 'Nyssara', title: 'Drake Rider', modelId: 'lord_drakerider', weapon: 'lance', damageType: 'physical', projectile: 'none',
    signature: ['wraith_rider', 'bone_archer'], tags: ['flier', 'mounted'],
    hp: 760, dmg: 38, attackTicks: 22, range: 200, speed: 24, armor: 20, magicResist: 25, splash: 0,
    passive: `Squads move ${DRAKE_SPEED_PCT}% faster`,
    ability: 'plague_breath', abilityName: 'Plague Breath', abilityText: `Dives onto the densest enemy cluster within ${PLAGUE_REACH / 100} m and breathes plague: ${PLAGUE_PCT}% of her damage as magic within ${PLAGUE_RADIUS / 100} m, then ${PLAGUE_BURN_BASE} (+${PLAGUE_BURN_PER_LEVEL} per Lord level) damage a second for 3 s.`,
  },
  // ---- The Sun Caliphate
  vizier: {
    id: 'vizier', class: 'magic', faction: 'caliphate', name: 'Kasim', title: 'Grand Vizier', modelId: 'lord_vizier', weapon: 'staff', damageType: 'magic', projectile: 'fireball',
    signature: ['djinn_binder', 'sun_priest'], tags: ['infantry'],
    hp: 540, dmg: 30, attackTicks: 40, range: 1900, speed: 13, armor: 0, magicResist: 40, splash: 150,
    passive: `Magic squads attack ${VIZIER_HASTE_PCT}% faster`,
    ability: 'whirlwind', abilityName: 'Djinn Whirlwind', abilityText: `A djinn whirlwind spins on the densest enemy cluster within ${WHIRL_REACH / 100} m for ${WHIRL_WAVES} s: each second ${WHIRL_BASE} (+${WHIRL_PER_LEVEL} per Lord level) magic damage within ${WHIRL_RADIUS / 100} m and a ${WHIRL_SLOW}% slow.`,
  },
  rajah: {
    id: 'rajah', class: 'giant', faction: 'caliphate', name: 'Bahadur', title: 'Rajah', modelId: 'lord_rajah', weapon: 'fists', damageType: 'physical', projectile: 'none',
    signature: ['scimitar', 'mamluk'], tags: ['large', 'mounted'],
    hp: 1400, dmg: 40, attackTicks: 30, range: 260, speed: 12, armor: 30, magicResist: 10, splash: 0,
    passive: `He and giants: +${RAJAH_GIANT_HP}% life, +${RAJAH_GIANT_ARMOR} armour`,
    ability: 'stampede', abilityName: 'Stampede', abilityText: `His elephant charges the nearest ground enemy within ${STAMPEDE_REACH / 100} m, trampling all in its path for ${STAMPEDE_BASE} (+${STAMPEDE_PER_LEVEL} per Lord level) damage and throwing them ${STAMPEDE_KNOCK / 100} m aside.`,
  },
  rocrider: {
    id: 'rocrider', class: 'air', faction: 'caliphate', name: 'Amira', title: 'Roc Rider', modelId: 'lord_rocrider', weapon: 'bow', damageType: 'physical', projectile: 'arrow',
    signature: ['camel_archer', 'mamluk'], tags: ['flier', 'mounted'],
    hp: 680, dmg: 30, attackTicks: 26, range: 1800, speed: 26, armor: 10, magicResist: 30, splash: 0,
    passive: `Archer squads deal +${ROC_RANGED_PCT}% damage`,
    ability: 'talon', abilityName: 'Talon Strike', abilityText: `Her roc seizes the toughest enemy within ${TALON_REACH / 100} m that is not Large, strikes it for ${TALON_PCT}% of her damage and drops it ${TALON_THROW / 100} m towards her lines, stunned for ${TALON_STUN / 20} s.`,
  },
};

/** The role each Lord plays (four per faction, one of each); the pick screen and the codex order Lords by it. */
export const LORD_ROLES = ['infantry', 'magic', 'armour', 'fliers'] as const;
export type LordRole = (typeof LORD_ROLES)[number];
export const LORD_ROLE: Record<LordId, LordRole> = {
  marshal: 'infantry', archmage: 'magic', warden: 'armour', skylady: 'fliers',
  deathknight: 'infantry', lich: 'magic', ossuary: 'armour', drakerider: 'fliers',
  sultana: 'infantry', vizier: 'magic', rajah: 'armour', rocrider: 'fliers',
};
export const LORD_ROLE_NAME: Record<LordRole, string> = { infantry: 'Infantry', magic: 'Magic', armour: 'Armour', fliers: 'Fliers' };
/** Every Lord ability (the battle log, the inspector and the camera treat these as Lord casts). */
export const LORD_ABILITY_IDS: readonly LordDef['ability'][] = ['rally', 'meteor', 'bulwark', 'skyfall', 'necromancy', 'radiance', 'soul_reap', 'grave_taunt', 'plague_breath', 'whirlwind', 'stampede', 'talon'];

export const LORD_IDS = Object.keys(LORDS) as LordId[];
