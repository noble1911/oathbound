// Skills (DESIGN §5b): unit classes, the 14 item-granted active skills, and the read-only skill lists the
// inspector shows (innate traits, Lord abilities, legendary powers, item skills) with their real numbers.
//
// An item with `skill` set grants that skill to the squad wearing it. The squad auto-casts it in battle whenever
// its cooldown is up and its trigger holds (battle.ts skillPass). Skill items are class-locked: see canEquip.
import { TICK_HZ } from '../constants.ts';
import type { Item, LordId, SkillId, SkillInfo, Slot, Squad, SquadType, UnitClass, UnitType } from '../types.ts';
import { LEGENDARIES } from './items.ts';
import {
  LORDS, METEOR_BASE, METEOR_PER_LEVEL, PLAGUE_BURN_BASE, PLAGUE_BURN_PER_LEVEL, PLAGUE_PCT, PLAGUE_RADIUS, PLAGUE_REACH, STAMPEDE_BASE, STAMPEDE_KNOCK, STAMPEDE_REACH,
  STAMPEDE_PER_LEVEL, WHIRL_BASE, WHIRL_PER_LEVEL, WHIRL_RADIUS, WHIRL_REACH, WHIRL_SLOW, WHIRL_WAVES,
} from './lords.ts';
import { UNITS } from './units.ts';

/** Mirrors FLIER_EVADE_PCT in battle.ts (a test keeps them equal; data files do not import the battle). */
export const FLIER_EVADE = 30;

/** The one class of each unit type. */
export const UNIT_CLASS: Record<UnitType, UnitClass> = {
  militia: 'infantry', pikemen: 'infantry', berserkers: 'infantry', knights: 'infantry',
  archers: 'ranged', cavaliers: 'mounted', mages: 'caster', clerics: 'caster',
  pegasus: 'flier', wyvern: 'flier', dragon: 'flier', ballista: 'siege', trebuchet: 'siege', golem: 'giant',
  // The Ashen Covenant
  skeleton: 'infantry', grave_knight: 'infantry', bone_archer: 'ranged', wraith_rider: 'mounted', grave_acolyte: 'caster', bone_drake: 'flier',
  corpse_catapult: 'siege', bone_golem: 'giant',
  // The Sun Caliphate (Camel Archers are bowmen first: they take the archers' skills)
  spear_levy: 'infantry', scimitar: 'infantry', camel_archer: 'ranged', mamluk: 'mounted', djinn_binder: 'caster', sun_priest: 'caster', djinn: 'flier',
  war_elephant: 'giant', sand_golem: 'giant', sun_mirror: 'siege',
};
/** A Lord is of class 'lord' and also of the class of its fighting style. */
export const LORD_CLASS: Record<LordId, UnitClass> = {
  marshal: 'infantry', warden: 'infantry', archmage: 'caster', skylady: 'flier', lich: 'caster', sultana: 'infantry',
  deathknight: 'infantry', ossuary: 'infantry', drakerider: 'flier', vizier: 'caster', rajah: 'giant', rocrider: 'flier',
};
export const UNIT_CLASSES: readonly UnitClass[] = ['caster', 'infantry', 'ranged', 'mounted', 'flier', 'siege', 'giant', 'lord'];
export const CLASS_NAME: Record<UnitClass, string> = {
  caster: 'Casters', infantry: 'Infantry', ranged: 'Archers', mounted: 'Cavalry', flier: 'Fliers', siege: 'Siege engines', giant: 'Giants', lord: 'Lords',
};

/** Classes of a squad type (`lord` = the owner's Lord id, needed only for type 'lord'). */
export function classesOf(type: SquadType, lord: LordId | null | undefined): UnitClass[] {
  if (type === 'lord') return lord ? ['lord', LORD_CLASS[lord]] : ['lord'];
  return [UNIT_CLASS[type]];
}
export function squadClasses(sq: Pick<Squad, 'type'>, lord: LordId | null | undefined): UnitClass[] {
  return classesOf(sq.type, lord);
}

export interface SkillDef {
  id: SkillId;
  name: string;
  /** Item name suffix: "Grimoire of Fireball". */
  suffix: string;
  /** The item slot the skill rolls on. */
  slot: Slot;
  classes: UnitClass[];
  /** Ticks between casts. */
  cooldown: number;
  /** When the squad casts it (shown in the tooltip). */
  trigger: string;
  /** Effect text; {a} {b} {c} are filled from SKILL_NUM at the item's level. */
  text: string;
  /** Stat budget (same scale as LegendaryDef.power) for itemPower / bots. */
  power: number;
}

/** Ticks before the first cast of a battle is possible. */
export const SKILL_START_CD = 40;

export const SKILLS: Record<SkillId, SkillDef> = {
  fireball: {
    id: 'fireball', name: 'Fireball', suffix: 'of Fireball', slot: 'weapon', classes: ['caster'], cooldown: 200, power: 11,
    trigger: '3 or more enemies bunched within 22 m',
    text: 'Hurls a fireball: {a} magic damage within 3.5 m, and burns for {b} damage per second over 3 s',
  },
  chain_lightning: {
    id: 'chain_lightning', name: 'Chain Lightning', suffix: 'of Chain Lightning', slot: 'weapon', classes: ['caster'], cooldown: 160, power: 11,
    trigger: 'an enemy within 20 m',
    text: 'A bolt strikes the nearest enemy for {a} magic damage and leaps to 4 more, losing 20% each leap',
  },
  frost_nova: {
    id: 'frost_nova', name: 'Frost Nova', suffix: 'of the Frost Nova', slot: 'relic', classes: ['caster'], cooldown: 200, power: 9,
    trigger: '2 or more enemies within 7 m of the squad',
    text: 'A ring of ice: {a} magic damage and a 50% slow for 4 s to every enemy within 7 m',
  },
  mending_light: {
    id: 'mending_light', name: 'Mending Light', suffix: 'of Mending Light', slot: 'relic', classes: ['caster'], cooldown: 160, power: 10,
    trigger: 'an allied squad within 18 m below 70% life',
    text: 'Restores {a}% of maximum life to every soldier of the most wounded allied squad in reach',
  },
  shield_wall: {
    id: 'shield_wall', name: 'Shield Wall', suffix: 'of the Shield Wall', slot: 'armor', classes: ['infantry', 'giant'], cooldown: 280, power: 10,
    trigger: 'the squad is in combat and below 85% life',
    text: 'The squad takes {a}% less damage for 5 s',
  },
  war_cry: {
    id: 'war_cry', name: 'War Cry', suffix: 'of the War Cry', slot: 'relic', classes: ['infantry', 'lord'], cooldown: 320, power: 10,
    trigger: 'an enemy within 8 m',
    text: 'Allies within 10 m attack {a}% faster for 6 s (does not stack with Rally)',
  },
  cleave: {
    id: 'cleave', name: 'Cleave', suffix: 'of Cleaving', slot: 'weapon', classes: ['infantry'], cooldown: 240, power: 10,
    trigger: '4 or more enemies within 4 m of the squad',
    text: 'For 4 s every melee blow also strikes the enemies within 2.5 m of its target for {a}% damage',
  },
  fire_arrows: {
    id: 'fire_arrows', name: 'Fire Arrows', suffix: 'of Fire Arrows', slot: 'weapon', classes: ['ranged'], cooldown: 200, power: 10,
    trigger: 'enemies in bow range',
    text: 'An extra volley of burning arrows: full damage, and each hit burns for {a} damage per second over 3 s',
  },
  pinning_shot: {
    id: 'pinning_shot', name: 'Pinning Shot', suffix: 'of the Pinning Shot', slot: 'weapon', classes: ['ranged'], cooldown: 180, power: 9,
    trigger: 'enemies in bow range',
    text: 'An extra volley at {a}% damage that slows every enemy it hits by 50% for 4 s',
  },
  rain_of_arrows: {
    id: 'rain_of_arrows', name: 'Rain of Arrows', suffix: 'of the Arrow Storm', slot: 'armor', classes: ['ranged'], cooldown: 280, power: 10,
    trigger: '5 or more enemies bunched in bow range',
    text: 'Arrows rain on a 5 m circle: 3 waves of {a} physical damage (hits fliers too)',
  },
  thunderous_charge: {
    id: 'thunderous_charge', name: 'Thunderous Charge', suffix: 'of the Thunderous Charge', slot: 'weapon', classes: ['mounted'], cooldown: 280, power: 10,
    trigger: 'the first impact, then whenever it is ready and the squad strikes',
    text: 'The impact deals {a} physical damage within 3 m and throws ground enemies back 2 m',
  },
  trample: {
    id: 'trample', name: 'Trample', suffix: 'of Trampling', slot: 'armor', classes: ['mounted', 'giant'], cooldown: 200, power: 9,
    trigger: '3 or more ground enemies within 3.5 m of the squad',
    text: 'Tramples ground enemies within 3.5 m: {a} physical damage and a 30% slow for 2 s',
  },
  dive_strike: {
    id: 'dive_strike', name: 'Dive Strike', suffix: 'of the Dive', slot: 'weapon', classes: ['flier'], cooldown: 240, power: 10,
    trigger: 'the squad reaches an enemy',
    text: 'Every soldier dives on its target for {a}% damage, also hitting enemies within 2 m of it',
  },
  incendiary_payload: {
    id: 'incendiary_payload', name: 'Incendiary Payload', suffix: 'of the Incendiary Payload', slot: 'weapon', classes: ['siege'], cooldown: 280, power: 10,
    trigger: '3 or more ground enemies bunched in range',
    text: 'Lobs burning pitch: the ground within 4 m burns for 4 s, {a} magic damage per second',
  },
};
export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];

/** The numbers of a skill at item level `L` (integer maths; shared by the battle and the tooltips). */
export function skillNum(id: SkillId, L: number): { a: number; b: number } {
  const l = L < 1 ? 1 : L;
  switch (id) {
    case 'fireball': return { a: 36 + 6 * l, b: 3 + Math.trunc(l / 2) };
    case 'chain_lightning': return { a: 40 + 6 * l, b: 0 };
    case 'frost_nova': return { a: 28 + 5 * l, b: 0 };
    case 'mending_light': return { a: 14 + l, b: 0 };
    case 'shield_wall': return { a: Math.min(50, 28 + 2 * l), b: 0 };
    case 'war_cry': return { a: 14 + 2 * l, b: 0 };
    case 'cleave': return { a: 40 + 4 * l, b: 0 };
    case 'fire_arrows': return { a: 4 + l, b: 0 };
    case 'pinning_shot': return { a: 60 + 5 * l, b: 0 };
    case 'rain_of_arrows': return { a: 11 + 2 * l, b: 0 };
    case 'thunderous_charge': return { a: 30 + 5 * l, b: 0 };
    case 'trample': return { a: 36 + 6 * l, b: 0 };
    case 'dive_strike': return { a: 180 + 12 * l, b: 0 };
    case 'incendiary_payload': return { a: 6 + l, b: 0 };
  }
}

/** Effect text of a skill at item level `ilvl`, numbers filled in. */
export function skillText(id: SkillId, ilvl: number): string {
  const n = skillNum(id, ilvl);
  return SKILLS[id].text.replace('{a}', String(n.a)).replace('{b}', String(n.b));
}
export function skillCooldownSec(id: SkillId): number {
  return SKILLS[id].cooldown / TICK_HZ;
}
/** "Casters", "Infantry and Giants". */
export function usableByText(id: SkillId): string {
  const names = SKILLS[id].classes.map((c) => CLASS_NAME[c]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
}

/** May a squad of this type wear `item`? Only skill items are restricted (to the skill's classes). */
export function canEquip(item: Pick<Item, 'skill'>, type: SquadType, lord: LordId | null | undefined): boolean {
  if (!item.skill) return true;
  const cls = classesOf(type, lord);
  return SKILLS[item.skill].classes.some((c) => cls.includes(c));
}
/** The error applyIntent gives for a class mismatch. */
export function classError(item: Pick<Item, 'skill'>): string {
  const sk = SKILLS[item.skill!];
  return `only ${usableByText(sk.id)} can use ${sk.name}`;
}

// ---------------------------------------------------------------- skill lists for the inspector

const m = (cm: number): string => String(Math.round(cm / 10) / 10);
const sec = (ticks: number): number => Math.round((ticks / TICK_HZ) * 10) / 10;

/** Lord ability cooldowns in ticks (battle.ts uses these). */
export const ABILITY_CD = {
  rally: 280, bulwark: 340, meteor: 300, skyfall: 360, necromancy: 320, radiance: 300,
  soul_reap: 300, grave_taunt: 340, plague_breath: 340, whirlwind: 320, stampede: 300, talon: 340,
} as const;

/** The innate abilities of a unit type: traits, counters and movement rules, as data. Behaviour lives in battle.ts. */
export function unitSkills(type: UnitType): SkillInfo[] {
  const u = UNITS[type];
  const out: SkillInfo[] = [];
  const add = (id: string, name: string, text: string, kind: 'passive' | 'active' = 'passive', cooldown?: number): void => {
    const s: SkillInfo = { id, name, kind, text, source: 'innate' };
    if (cooldown !== undefined) s.cooldown = cooldown;
    out.push(s);
  };
  if (u.traits.includes('raise')) add('raise', 'Raise dead', `Instead of attacking, raises a fallen soldier within ${m(u.range)} m as a skeleton that fights for you (up to 3 + the squad's level per battle; not Lords or Large units)`, 'active', sec(u.attackTicks));
  if (u.traits.includes('bless')) add('bless', 'Sun blessing', 'Soldiers it heals attack 15% faster for 4 s');
  if (u.id === 'sun_priest') add('radiant', 'Radiant', 'Its sunbolts deal 50% more damage to the undead (Ashen units, the Lich-Priest, raised skeletons)');
  if (u.traits.includes('healer')) add('heal', 'Heal', `Heals the most wounded ally within ${m(u.range)} m for ${u.heal} life (grows with level); attacks only when nobody needs healing`, 'active', sec(u.attackTicks));
  if (u.traits.includes('brace')) add('brace', 'Brace', 'Braced against charges: a charge deals it no double damage');
  if (u.traits.includes('charge')) add('charge', 'Charge', 'The first hit of a charge deals double damage; re-arms after 5 s out of combat');
  if (u.traits.includes('raider')) add('raider', 'Raider', 'Hunts the enemy backline: archers, casters, healers and siege engines');
  if (u.lifesteal) add('lifesteal', u.faction === 'ashen' ? 'Life drain' : 'Bloodlust', `Heals for ${u.lifesteal}% of the damage it deals`);
  if (u.burn && u.faction === 'ashen') add('plague', 'Plague', `Hits fester for ${u.burn} damage per second over 3 s`);
  else if (u.burn) add('burning', 'Burning', `Sets its target alight: ${u.burn} damage per second for 3 s`);
  if (u.projectile === 'sunbeam') add('sunbeam', 'Focused sunlight', 'A single beam of sunlight strikes one target at long range; it cannot miss a flier but splashes nothing');
  if (u.slow) add('slowing', 'Whirlwind', `Hits slow the target by ${u.slow}% for 2 s`);
  if (u.regen) add('regen', 'Shifting sands', `Regenerates ${u.regen / 10}% of maximum life per second`);
  if (u.traits.includes('howdah')) add('howdah', 'Howdah archers', 'Can also strike fliers that come within reach');
  if (u.magicResist < 0) add('ethereal', 'Ethereal', `Steel passes through it (${u.armor}% less physical damage), but magic deals ${-u.magicResist}% more`);
  if (u.traits.includes('pierce')) add('pierce', 'Piercing bolt', 'Bolts pass through the target, hitting everything along the line for 60% damage');
  if (u.traits.includes('stomp')) add('stomp', 'Stomp', `Every blow shakes the ground: 60% damage to all enemies within ${m(u.splash)} m`);
  else if (u.traits.includes('cone')) add('cone', 'Fire breath', `Breathes fire in a cone ${m(u.range)} m long, burning everything inside it`);
  else if (u.splash) add('splash', 'Splash', `Attacks hit everything within ${m(u.splash)} m of the impact (half damage at the edge)`);
  if (u.damageType === 'magic') add('magic', 'Magic', 'Magic damage ignores armor; only magic resistance reduces it');
  if (u.traits.includes('crushing')) add('crushing', 'Crushing', 'Ignores half of the target\'s armor');
  if (u.minRange) add('min_range', 'Siege engine', `Cannot hit anything closer than ${m(u.minRange)} m or in the air; slow to aim`);
  if (u.tags.includes('flier')) add('flier', 'Flying', `Ignores terrain; only bows, magic, bolts and other fliers can hit it, and shots from the ground deal ${FLIER_EVADE}% less`);
  if (u.armor >= 30) add('armored', 'Heavy armor', `Takes ${u.armor}% less physical damage`);
  if (u.magicResist >= 30) add('resist', 'Warded', `Takes ${u.magicResist}% less magic damage`);
  if (u.range > 400 && !u.minRange) add('ranged', 'Ranged', `Attacks from ${m(u.range)} m${u.weapon !== 'stone' ? ' and can hit fliers' : ''}; +15% range damage on hills`);
  return out;
}

/** A Lord's passive and auto-cast ability. `level` fills in level-scaled numbers (Meteor). */
export function lordSkills(lord: LordId, level = 1): SkillInfo[] {
  const L = LORDS[lord];
  let text = L.abilityText;
  if (L.ability === 'meteor') text = `Calls a meteor on the densest enemy cluster within 40 m: ${METEOR_BASE + METEOR_PER_LEVEL * level} magic damage in a 10 m radius.`;
  if (L.ability === 'skyfall') text = 'Dives onto the furthest enemy backline squad, striking everything within 4 m for 250% damage.';
  if (L.ability === 'plague_breath') text = `Dives onto the densest enemy cluster within ${m(PLAGUE_REACH)} m and breathes plague: ${PLAGUE_PCT}% of her damage as magic within ${m(PLAGUE_RADIUS)} m, then ${PLAGUE_BURN_BASE + PLAGUE_BURN_PER_LEVEL * level} damage a second for 3 s.`;
  if (L.ability === 'whirlwind') text = `A djinn whirlwind spins on the densest enemy cluster within ${m(WHIRL_REACH)} m for ${WHIRL_WAVES} s: each second ${WHIRL_BASE + WHIRL_PER_LEVEL * level} magic damage within ${m(WHIRL_RADIUS)} m and a ${WHIRL_SLOW}% slow.`;
  if (L.ability === 'stampede') text = `His elephant charges through the nearest ground enemy within ${m(STAMPEDE_REACH)} m, trampling everything in its path for ${STAMPEDE_BASE + STAMPEDE_PER_LEVEL * level} damage and throwing it ${m(STAMPEDE_KNOCK)} m aside.`;
  const out: SkillInfo[] = [
    { id: `${lord}_passive`, name: `${L.title}'s command`, kind: 'passive', text: L.passive, source: 'lord' },
    { id: L.ability, name: L.abilityName, kind: 'active', text, cooldown: sec(ABILITY_CD[L.ability]), source: 'lord' },
  ];
  if (L.tags.includes('flier')) out.push({ id: 'flier', name: 'Flying', kind: 'passive', text: `Ignores terrain; only bows, magic, bolts and other fliers can hit it, and shots from the ground deal ${FLIER_EVADE}% less`, source: 'innate' });
  if (L.damageType === 'magic') out.push({ id: 'magic', name: 'Magic', kind: 'passive', text: 'Magic damage ignores armor; only magic resistance reduces it', source: 'innate' });
  return out;
}

/** Tooltip text of a legendary power with its level-scaled numbers filled in. */
export function legendaryText(id: keyof typeof LEGENDARIES, ilvl: number): string {
  const L = LEGENDARIES[id];
  return id === 'sunfire' ? L.text.replace('20 (+2 per item level)', String(20 + 2 * ilvl))
    : id === 'ember_crown' ? L.text.replace('90 (+12 per item level)', String(90 + 12 * ilvl)) : L.text;
}

/**
 * Everything a squad can do: innate abilities (or the Lord's passive and ability), then the legendary powers and
 * active skills its items grant. `lord` = the owner's Lord id (needed for the Lord squad; ignored otherwise).
 */
export function squadSkills(sq: Pick<Squad, 'type' | 'level' | 'items'>, lord?: LordId | null): SkillInfo[] {
  const out = sq.type === 'lord' ? (lord ? lordSkills(lord, sq.level) : []) : unitSkills(sq.type);
  for (const it of [sq.items.weapon, sq.items.armor, sq.items.relic]) {
    if (!it) continue;
    if (it.legendary) out.push({ id: it.legendary, name: LEGENDARIES[it.legendary].name, kind: 'passive', text: legendaryText(it.legendary, it.ilvl), source: 'item', item: it.id });
    if (it.skill) {
      const d = SKILLS[it.skill];
      out.push({ id: d.id, name: d.name, kind: 'active', text: `${skillText(d.id, it.ilvl)}. Cast when: ${d.trigger}.`, cooldown: skillCooldownSec(d.id), source: 'item', item: it.id, skill: d.id });
    }
  }
  return out;
}
