// Loot tables (DESIGN §5): bases with implicits, the affix pool and legendary powers.
// Affix ranges are given at item level 1 and grow by `growth` percent per item level (ilvl = round). An item's lines are
// then scaled to its power budget (itemBudget in loot.ts), so every item of one offer is worth the same.
//
// Each slot is one KIND of item, and an affix rolls on exactly one slot:
//   weapon = offence: Keen (crit), Vicious (damage), Slaying, of Haste (attack speed), of Embers (burn);
//   armor  = defence: Stalwart (life), Plated (armour), of Warding (magic resist), of Thorns, of the Phoenix (revive);
//   relic  = utility: Fleet (speed), Far-reaching (range), of the Leech, of Frost (slow), of Command (+1 deploy).
import type { AffixId, BaseId, LegendaryId, Rarity, Slot, Tag, WheelClass } from '../types.ts';

export interface BaseDef { id: BaseId; name: string; slot: Slot; implicit: AffixId; lo: number; hi: number; implicitTag?: Tag }
export interface AffixDef {
  id: AffixId;
  /** 'prefix' goes before the base name ("Vicious"), 'suffix' after ("of Haste"). */
  kind: 'prefix' | 'suffix';
  name: string;
  /** The one slot (item kind) it rolls on: weapon = offence, armor = defence, relic = utility. */
  slots: [Slot];
  lo: number;
  hi: number;
  /** Percent growth of the range per item level above 1 (0 = flat). */
  growth: number;
  /** Tooltip template; {v} is the value, {tag} the slaying tag. */
  text: string;
  /** Only on rare+ items. */
  rareOnly?: boolean;
  /** A flag (phoenix, command): never scaled to the item budget. */
  fixed?: boolean;
  /** Relative roll weight. */
  weight: number;
  /** Stat budget per point of value (itemPower, the item budget, the bots). */
  power: number;
}
export interface LegendaryDef {
  id: LegendaryId; name: string; slot: Slot; text: string; flavor: string; power: number;
  /**
   * The wheel classes it is built for. The power works only on a squad of one of these classes (a Lord counts as the
   * class of its body or mount); on any other squad the item is just its affixes. The tooltip shows "Best on: ...".
   */
  best: WheelClass[];
}

/** What each slot is for: every offer is one weapon (offence), one armor (defence) and one relic (utility). */
export const ITEM_KIND: Record<Slot, string> = { weapon: 'Offence', armor: 'Defence', relic: 'Utility' };

export const RARITIES: readonly Rarity[] = ['common', 'magic', 'rare', 'legendary'];
/** The first round whose offer is all Legendary (then every LEGENDARY_EVERY rounds; see lootRarity in loot.ts). */
export const LEGENDARY_MIN_ROUND = 3;
export const LEGENDARY_EVERY = 3;

/**
 * Power budget of an item at item level 1, by rarity (itemPower points). It grows by BUDGET_GROWTH percent per item
 * level. Every item of one offer has the same rarity and level, so the same budget.
 */
export const ITEM_BUDGET: Record<Rarity, number> = { common: 10, magic: 20, rare: 36, legendary: 40 };
export const BUDGET_GROWTH = 4;
/** Affix lines (besides the implicit) by rarity. A Rare's skill takes one line's place; a Legendary adds its power. */
export const AFFIX_COUNT: Record<Rarity, number> = { common: 0, magic: 2, rare: 3, legendary: 2 };
/** Every legendary power is worth the same budget. */
export const LEGENDARY_POWER = 16;

/** Squad level at which each slot opens (the Lord has all three from the start). */
export const SLOT_UNLOCK_LEVEL: Record<Slot, number> = { weapon: 1, armor: 1, relic: 3 };

export const BASES: Record<BaseId, BaseDef> = {
  steel_blade: { id: 'steel_blade', name: 'Steel Blade', slot: 'weapon', implicit: 'vicious', lo: 8, hi: 12 },
  ironbark_bow: { id: 'ironbark_bow', name: 'Ironbark Bow', slot: 'weapon', implicit: 'slaying', lo: 15, hi: 25, implicitTag: 'flier' },
  war_axe: { id: 'war_axe', name: 'War Axe', slot: 'weapon', implicit: 'haste', lo: 6, hi: 10 },
  ash_spear: { id: 'ash_spear', name: 'Ash Spear', slot: 'weapon', implicit: 'slaying', lo: 15, hi: 25, implicitTag: 'mounted' },
  grimoire: { id: 'grimoire', name: 'Grimoire', slot: 'weapon', implicit: 'keen', lo: 5, hi: 8 },
  mail_hauberk: { id: 'mail_hauberk', name: 'Mail Hauberk', slot: 'armor', implicit: 'stalwart', lo: 10, hi: 14 },
  warded_robe: { id: 'warded_robe', name: 'Warded Robe', slot: 'armor', implicit: 'warding', lo: 18, hi: 24 },
  plate_cuirass: { id: 'plate_cuirass', name: 'Plate Cuirass', slot: 'armor', implicit: 'plated', lo: 8, hi: 12 },
  leather_jerkin: { id: 'leather_jerkin', name: 'Studded Jerkin', slot: 'armor', implicit: 'thorns', lo: 12, hi: 18 },
  bone_charm: { id: 'bone_charm', name: 'Bone Charm', slot: 'relic', implicit: 'leech', lo: 4, hi: 6 },
  sun_medallion: { id: 'sun_medallion', name: 'Sun Medallion', slot: 'relic', implicit: 'farreach', lo: 150, hi: 250 },
  oath_ring: { id: 'oath_ring', name: 'Rime Ring', slot: 'relic', implicit: 'frost', lo: 15, hi: 20 },
  war_banner: { id: 'war_banner', name: 'War Banner', slot: 'relic', implicit: 'fleet', lo: 6, hi: 10 },
};
export const BASE_IDS = Object.keys(BASES) as BaseId[];

export const AFFIXES: Record<AffixId, AffixDef> = {
  // weapon: offence
  keen: { id: 'keen', kind: 'prefix', name: 'Keen', slots: ['weapon'], lo: 4, hi: 8, growth: 6, text: '+{v}% critical strike chance', weight: 10, power: 1.0 },
  vicious: { id: 'vicious', kind: 'prefix', name: 'Vicious', slots: ['weapon'], lo: 6, hi: 12, growth: 6, text: '+{v}% damage', weight: 12, power: 1.0 },
  slaying: { id: 'slaying', kind: 'prefix', name: 'Slaying', slots: ['weapon'], lo: 20, hi: 40, growth: 5, text: '+{v}% damage against {tag} units', weight: 8, power: 0.35 },
  haste: { id: 'haste', kind: 'suffix', name: 'of Haste', slots: ['weapon'], lo: 5, hi: 10, growth: 6, text: '+{v}% attack speed', weight: 10, power: 1.0 },
  embers: { id: 'embers', kind: 'suffix', name: 'of Embers', slots: ['weapon'], lo: 3, hi: 6, growth: 8, text: 'Attacks burn for {v} damage per second over 3 seconds', weight: 7, power: 2.0 },
  // armor: defence
  stalwart: { id: 'stalwart', kind: 'prefix', name: 'Stalwart', slots: ['armor'], lo: 6, hi: 14, growth: 6, text: '+{v}% maximum life', weight: 12, power: 1.0 },
  plated: { id: 'plated', kind: 'prefix', name: 'Plated', slots: ['armor'], lo: 5, hi: 10, growth: 5, text: '+{v}% physical damage reduction', weight: 9, power: 1.0 },
  warding: { id: 'warding', kind: 'suffix', name: 'of Warding', slots: ['armor'], lo: 10, hi: 20, growth: 4, text: '+{v}% magic resistance', weight: 8, power: 0.5 },
  thorns: { id: 'thorns', kind: 'suffix', name: 'of Thorns', slots: ['armor'], lo: 10, hi: 20, growth: 5, text: 'Reflects {v}% of melee damage taken', weight: 7, power: 0.5 },
  phoenix: { id: 'phoenix', kind: 'suffix', name: 'of the Phoenix', slots: ['armor'], lo: 1, hi: 1, growth: 0, text: 'The first soldier of this squad to fall each battle is revived', weight: 5, power: 8, fixed: true },
  // relic: utility
  fleet: { id: 'fleet', kind: 'prefix', name: 'Fleet', slots: ['relic'], lo: 6, hi: 14, growth: 3, text: '+{v}% movement speed', weight: 9, power: 0.4 },
  farreach: { id: 'farreach', kind: 'prefix', name: 'Far-reaching', slots: ['relic'], lo: 200, hi: 400, growth: 3, text: '+{v} m range (ranged only)', weight: 8, power: 0.02 },
  leech: { id: 'leech', kind: 'suffix', name: 'of the Leech', slots: ['relic'], lo: 4, hi: 8, growth: 5, text: '{v}% of damage dealt is returned as life', weight: 9, power: 1.0 },
  frost: { id: 'frost', kind: 'suffix', name: 'of Frost', slots: ['relic'], lo: 15, hi: 25, growth: 2, text: 'Attacks slow the target by {v}% for 2 seconds', weight: 7, power: 0.5 },
  command: { id: 'command', kind: 'suffix', name: 'of Command', slots: ['relic'], lo: 1, hi: 1, growth: 0, text: '+1 squad deployment next round', weight: 3, rareOnly: true, power: 10, fixed: true },
};
export const AFFIX_IDS = Object.keys(AFFIXES) as AffixId[];

// Narrow, build-defining powers: each works only on the wheel classes in `best` (see LegendaryDef).
export const LEGENDARIES: Record<LegendaryId, LegendaryDef> = {
  // weapon
  stormcaller: { id: 'stormcaller', name: 'Stormcaller', slot: 'weapon', power: LEGENDARY_POWER, best: ['magic', 'air'],
    text: 'Attacks chain lightning to 3 nearby enemies for 30% damage', flavor: '"The sky answers those who never kneel."' },
  kingsbane: { id: 'kingsbane', name: 'Kingsbane', slot: 'weapon', power: LEGENDARY_POWER, best: ['siege', 'cavalry'],
    text: 'Deals triple damage to Lords and Giants', flavor: 'Forged from the crown of the last tyrant of Velmor.' },
  bloodthirst: { id: 'bloodthirst', name: 'Bloodthirst', slot: 'weapon', power: LEGENDARY_POWER, best: ['cavalry', 'air'],
    text: 'Each kill heals 10% life and grants +10% attack speed (stacks 3 times)', flavor: 'It drinks. It is never full.' },
  earthshaker: { id: 'earthshaker', name: 'Earthshaker', slot: 'weapon', power: LEGENDARY_POWER, best: ['giant', 'line'],
    text: 'Every 4th attack shakes the ground, dealing full damage within 3 m', flavor: 'The mountain remembers every footstep.' },
  frostheart: { id: 'frostheart', name: 'Frostheart', slot: 'weapon', power: LEGENDARY_POWER, best: ['ranged', 'magic'],
    text: 'Attacks slow by 40% for 2 s and deal +30% damage to slowed enemies', flavor: 'Cold enough to still a heartbeat mid-stride.' },
  hydra_volley: { id: 'hydra_volley', name: 'Hydra Volley', slot: 'weapon', power: LEGENDARY_POWER, best: ['ranged', 'siege'],
    text: 'Attacks strike 2 additional nearby enemies for 40% damage', flavor: 'Cut one string, and two more sing.' },
  // armor
  undying_oath: { id: 'undying_oath', name: 'Undying Oath', slot: 'armor', power: LEGENDARY_POWER, best: ['line', 'magic'],
    text: 'Each soldier rises once at 50% life after falling', flavor: '"Not yet. The oath is not yet fulfilled."' },
  mirror_aegis: { id: 'mirror_aegis', name: 'Mirror Aegis', slot: 'armor', power: LEGENDARY_POWER, best: ['air', 'giant'],
    text: 'The first 3 projectiles striking each soldier are reflected', flavor: 'Polished by a thousand years of sorrow.' },
  sunfire: { id: 'sunfire', name: 'Sunfire Mantle', slot: 'armor', power: LEGENDARY_POWER, best: ['line', 'giant'],
    text: 'Burns enemies within 4 m for 20 (+2 per item level) damage per second', flavor: 'A scrap of the dawn, sewn into wool.' },
  lifebinder: { id: 'lifebinder', name: 'Lifebinder', slot: 'armor', power: LEGENDARY_POWER, best: ['giant', 'siege'],
    text: 'The squad regenerates 1.5% of maximum life per second', flavor: 'Woven from the roots of the first oak.' },
  // relic
  ember_crown: { id: 'ember_crown', name: 'Ember Crown', slot: 'relic', power: LEGENDARY_POWER, best: ['swarm'],
    text: 'Fallen soldiers explode for 90 (+12 per item level) fire damage within 4.5 m', flavor: 'Its wearers do not die. They become the fire.' },
  warhorn: { id: 'warhorn', name: 'Warhorn of Valor', slot: 'relic', power: LEGENDARY_POWER, best: ['swarm', 'line'],
    text: 'Swarm squads gain +4 soldiers and Line squads +2 (a Line Lord gains +35% life and damage instead)', flavor: 'One blast, and the fallen of Aster Field march again.' },
  gravebloom: { id: 'gravebloom', name: 'Gravebloom', slot: 'relic', power: LEGENDARY_POWER, best: ['swarm', 'cavalry'],
    text: 'Enemies slain by this squad rise as skeletons for the rest of the battle (max 14)', flavor: 'Where it is planted, nothing stays buried.' },
  windrunner: { id: 'windrunner', name: 'Windrunner', slot: 'relic', power: LEGENDARY_POWER, best: ['cavalry', 'ranged'],
    text: "+40% movement speed and +25% attack speed; each soldier's first strike deals 300% damage", flavor: 'Faster than the rumour of its coming.' },
};
export const LEGENDARY_IDS = Object.keys(LEGENDARIES) as LegendaryId[];

export const SLAY_TAGS: readonly Tag[] = ['mounted', 'armored', 'flier', 'large'];
