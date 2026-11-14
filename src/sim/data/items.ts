// Loot tables (DESIGN §5): bases with implicits, the affix pool and legendary powers.
// Affix ranges are given at item level 1 and grow by `growth` percent per item level (ilvl = round).
import type { AffixId, BaseId, LegendaryId, Rarity, Slot, Tag } from '../types.ts';

export interface BaseDef { id: BaseId; name: string; slot: Slot; implicit: AffixId; lo: number; hi: number; implicitTag?: Tag }
export interface AffixDef {
  id: AffixId;
  /** 'prefix' goes before the base name ("Vicious"), 'suffix' after ("of Haste"). */
  kind: 'prefix' | 'suffix';
  name: string;
  slots: Slot[];
  lo: number;
  hi: number;
  /** Percent growth of the range per item level above 1 (0 = flat). */
  growth: number;
  /** Tooltip template; {v} is the value, {tag} the slaying tag. */
  text: string;
  /** Only on rare+ items. */
  rareOnly?: boolean;
  /** Relative roll weight. */
  weight: number;
  /** Stat budget per point of value (for itemPower / bots). */
  power: number;
}
export interface LegendaryDef { id: LegendaryId; name: string; slot: Slot; text: string; flavor: string; power: number }

export const RARITIES: readonly Rarity[] = ['common', 'magic', 'rare', 'legendary'];
export const RARITY_WEIGHT: Record<Rarity, number> = { common: 40, magic: 35, rare: 20, legendary: 5 };
export const LEGENDARY_MIN_ROUND = 3;

/** Squad level at which each slot opens (the Lord has all three from the start). */
export const SLOT_UNLOCK_LEVEL: Record<Slot, number> = { weapon: 1, armor: 2, relic: 4 };

export const BASES: Record<BaseId, BaseDef> = {
  steel_blade: { id: 'steel_blade', name: 'Steel Blade', slot: 'weapon', implicit: 'vicious', lo: 8, hi: 12 },
  ironbark_bow: { id: 'ironbark_bow', name: 'Ironbark Bow', slot: 'weapon', implicit: 'farreach', lo: 200, hi: 300 },
  war_axe: { id: 'war_axe', name: 'War Axe', slot: 'weapon', implicit: 'haste', lo: 6, hi: 10 },
  ash_spear: { id: 'ash_spear', name: 'Ash Spear', slot: 'weapon', implicit: 'slaying', lo: 15, hi: 25, implicitTag: 'mounted' },
  grimoire: { id: 'grimoire', name: 'Grimoire', slot: 'weapon', implicit: 'keen', lo: 5, hi: 8 },
  mail_hauberk: { id: 'mail_hauberk', name: 'Mail Hauberk', slot: 'armor', implicit: 'stalwart', lo: 10, hi: 14 },
  warded_robe: { id: 'warded_robe', name: 'Warded Robe', slot: 'armor', implicit: 'warding', lo: 18, hi: 24 },
  plate_cuirass: { id: 'plate_cuirass', name: 'Plate Cuirass', slot: 'armor', implicit: 'plated', lo: 8, hi: 12 },
  leather_jerkin: { id: 'leather_jerkin', name: 'Leather Jerkin', slot: 'armor', implicit: 'fleet', lo: 8, hi: 12 },
  bone_charm: { id: 'bone_charm', name: 'Bone Charm', slot: 'relic', implicit: 'leech', lo: 4, hi: 6 },
  sun_medallion: { id: 'sun_medallion', name: 'Sun Medallion', slot: 'relic', implicit: 'stalwart', lo: 6, hi: 9 },
  oath_ring: { id: 'oath_ring', name: 'Oath Ring', slot: 'relic', implicit: 'haste', lo: 5, hi: 8 },
  war_banner: { id: 'war_banner', name: 'War Banner', slot: 'relic', implicit: 'vicious', lo: 5, hi: 8 },
};
export const BASE_IDS = Object.keys(BASES) as BaseId[];

export const AFFIXES: Record<AffixId, AffixDef> = {
  keen: { id: 'keen', kind: 'prefix', name: 'Keen', slots: ['weapon', 'relic'], lo: 4, hi: 8, growth: 6, text: '+{v}% critical strike chance', weight: 10, power: 1.0 },
  vicious: { id: 'vicious', kind: 'prefix', name: 'Vicious', slots: ['weapon', 'relic'], lo: 6, hi: 12, growth: 6, text: '+{v}% damage', weight: 12, power: 1.0 },
  haste: { id: 'haste', kind: 'suffix', name: 'of Haste', slots: ['weapon', 'relic'], lo: 5, hi: 10, growth: 6, text: '+{v}% attack speed', weight: 10, power: 1.0 },
  leech: { id: 'leech', kind: 'suffix', name: 'of the Leech', slots: ['weapon', 'relic'], lo: 4, hi: 8, growth: 5, text: '{v}% of damage dealt is returned as life', weight: 7, power: 1.0 },
  stalwart: { id: 'stalwart', kind: 'prefix', name: 'Stalwart', slots: ['armor', 'relic'], lo: 6, hi: 14, growth: 6, text: '+{v}% maximum life', weight: 12, power: 1.0 },
  warding: { id: 'warding', kind: 'suffix', name: 'of Warding', slots: ['armor', 'relic'], lo: 10, hi: 20, growth: 4, text: '+{v}% magic resistance', weight: 8, power: 0.5 },
  fleet: { id: 'fleet', kind: 'prefix', name: 'Fleet', slots: ['armor', 'relic'], lo: 6, hi: 14, growth: 3, text: '+{v}% movement speed', weight: 7, power: 0.4 },
  thorns: { id: 'thorns', kind: 'suffix', name: 'of Thorns', slots: ['armor'], lo: 10, hi: 20, growth: 5, text: 'Reflects {v}% of melee damage taken', weight: 7, power: 0.5 },
  slaying: { id: 'slaying', kind: 'prefix', name: 'Slaying', slots: ['weapon'], lo: 20, hi: 40, growth: 5, text: '+{v}% damage against {tag} units', weight: 8, power: 0.35 },
  embers: { id: 'embers', kind: 'suffix', name: 'of Embers', slots: ['weapon'], lo: 3, hi: 6, growth: 8, text: 'Attacks burn for {v} damage per second over 3 seconds', weight: 7, power: 2.0 },
  frost: { id: 'frost', kind: 'suffix', name: 'of Frost', slots: ['weapon'], lo: 20, hi: 20, growth: 0, text: 'Attacks slow the target by {v}% for 2 seconds', weight: 6, power: 0.4 },
  farreach: { id: 'farreach', kind: 'prefix', name: 'Far-reaching', slots: ['weapon'], lo: 200, hi: 400, growth: 3, text: '+{v} m range (ranged only)', weight: 6, power: 0.02 },
  phoenix: { id: 'phoenix', kind: 'suffix', name: 'of the Phoenix', slots: ['armor', 'relic'], lo: 1, hi: 1, growth: 0, text: 'The first soldier of this squad to fall each battle is revived', weight: 5, power: 8 },
  command: { id: 'command', kind: 'suffix', name: 'of Command', slots: ['relic'], lo: 1, hi: 1, growth: 0, text: '+1 squad deployment next round', weight: 3, rareOnly: true, power: 10 },
  plated: { id: 'plated', kind: 'prefix', name: 'Plated', slots: ['armor'], lo: 5, hi: 10, growth: 5, text: '+{v}% physical damage reduction', weight: 8, power: 1.0 },
};
export const AFFIX_IDS = Object.keys(AFFIXES) as AffixId[];

export const LEGENDARIES: Record<LegendaryId, LegendaryDef> = {
  stormcaller: { id: 'stormcaller', name: 'Stormcaller', slot: 'weapon', power: 18,
    text: 'Attacks chain lightning to 3 nearby enemies for 30% damage', flavor: '"The sky answers those who never kneel."' },
  kingsbane: { id: 'kingsbane', name: 'Kingsbane', slot: 'weapon', power: 14,
    text: 'Deals triple damage to Lords and Large units', flavor: 'Forged from the crown of the last tyrant of Velmor.' },
  undying_oath: { id: 'undying_oath', name: 'Undying Oath', slot: 'armor', power: 18,
    text: 'Each soldier rises once at 50% life after falling', flavor: '"Not yet. The oath is not yet fulfilled."' },
  ember_crown: { id: 'ember_crown', name: 'Ember Crown', slot: 'relic', power: 14,
    text: 'Fallen soldiers explode for 40 (+5 per item level) fire damage within 3.5 m', flavor: 'Its wearers do not die. They become the fire.' },
  mirror_aegis: { id: 'mirror_aegis', name: 'Mirror Aegis', slot: 'armor', power: 14,
    text: 'The first 3 projectiles striking each soldier are reflected', flavor: 'Polished by a thousand years of sorrow.' },
  warhorn: { id: 'warhorn', name: 'Warhorn of Valor', slot: 'relic', power: 18,
    text: '+3 soldiers (+1 for squads of 3-4; squads of 1-2 gain +35% life and damage instead)', flavor: 'One blast, and the fallen of Aster Field march again.' },
  gravebloom: { id: 'gravebloom', name: 'Gravebloom', slot: 'relic', power: 14,
    text: 'Enemies slain by this squad rise as skeletons for the rest of the battle (max 10)', flavor: 'Where it is planted, nothing stays buried.' },
  bloodthirst: { id: 'bloodthirst', name: 'Bloodthirst', slot: 'weapon', power: 14,
    text: 'Each kill heals 12% life and grants +10% attack speed (stacks 3 times)', flavor: 'It drinks. It is never full.' },
  earthshaker: { id: 'earthshaker', name: 'Earthshaker', slot: 'weapon', power: 14,
    text: 'Every 4th attack shakes the ground, dealing full damage within 3 m', flavor: 'The mountain remembers every footstep.' },
  frostheart: { id: 'frostheart', name: 'Frostheart', slot: 'weapon', power: 14,
    text: 'Attacks slow by 40% for 2 s and deal +30% damage to slowed enemies', flavor: 'Cold enough to still a heartbeat mid-stride.' },
  lifebinder: { id: 'lifebinder', name: 'Lifebinder', slot: 'relic', power: 14,
    text: 'The squad regenerates 1.5% of maximum life per second', flavor: 'Woven from the roots of the first oak.' },
  hydra_volley: { id: 'hydra_volley', name: 'Hydra Volley', slot: 'weapon', power: 16,
    text: 'Attacks strike 2 additional nearby enemies for 55% damage', flavor: 'Cut one string, and two more sing.' },
  windrunner: { id: 'windrunner', name: 'Windrunner', slot: 'armor', power: 12,
    text: '+40% movement speed and +25% attack speed; each soldier\'s first strike deals 300% damage', flavor: 'Faster than the rumour of its coming.' },
  sunfire: { id: 'sunfire', name: 'Sunfire Mantle', slot: 'armor', power: 14,
    text: 'Burns enemies within 4 m for 20 (+2 per item level) damage per second', flavor: 'A scrap of the dawn, sewn into wool.' },
};
export const LEGENDARY_IDS = Object.keys(LEGENDARIES) as LegendaryId[];

export const SLAY_TAGS: readonly Tag[] = ['mounted', 'armored', 'flier', 'large'];
