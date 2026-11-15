// The three factions (DESIGN §4b). A player picks a faction (and one of its Lords) at match start; both players may
// pick the same one. A faction is a roster: only its units can be unlocked, and its Lords start with two of them.
// Everything else (income, loot offers, deployment limit, the rules of battle) is identical for every faction.
import type { FactionDef, FactionId, LordId, UnitType } from '../types.ts';
import { LORDS, LORD_IDS, LORD_ROLE, LORD_ROLES } from './lords.ts';
import { UNITS, UNIT_TYPES } from './units.ts';

const unitsOf = (f: FactionId): UnitType[] => UNIT_TYPES.filter((u) => UNITS[u].faction === f);
/** A faction's four Lords in role order: infantry, magic, armour, fliers. */
const lordsOf = (f: FactionId): LordId[] => LORD_IDS.filter((l) => LORDS[l].faction === f).sort((a, b) => LORD_ROLES.indexOf(LORD_ROLE[a]) - LORD_ROLES.indexOf(LORD_ROLE[b]));
const mk = (id: FactionId, name: string, short: string, blurb: string, identity: string, colors: [string, string, string]): FactionDef => ({
  id, name, short, blurb, identity, colors, lords: lordsOf(id), units: unitsOf(id), basic: unitsOf(id).filter((u) => UNITS[u].basic),
});

export const FACTIONS: Record<FactionId, FactionDef> = {
  kingdom: mk('kingdom', 'The Oathsworn Kingdom', 'Kingdom',
    'Knights, levies and war engines sworn to the crown.',
    'The broadest roster: an answer to everything, and healers to keep it standing.',
    ['#2f5fa8', '#c9ced6', '#e6b84a']),
  ashen: mk('ashen', 'The Ashen Covenant', 'Covenant',
    'The dead of old wars, bound by green soul-fire.',
    'No healers. The fallen rise instead: Grave Acolytes and the Lich-Priest raise skeletons from corpses, undead drain life (the Death Knight makes them drain more), and Wraith Riders shrug off steel but burn to magic.',
    ['#d9d4c2', '#6b6f6a', '#5fe08a']),
  caliphate: mk('caliphate', 'The Sun Caliphate', 'Caliphate',
    'A desert empire under the banner of the sun.',
    'Fast and blessed: Sun Priests heal and quicken, camel archers shoot from the saddle, sand and djinn slow the foe, and the giants trample or mend themselves.',
    ['#f2efe6', '#c98a2b', '#2fb7b0']),
};
export const FACTION_IDS = Object.keys(FACTIONS) as FactionId[];

export function factionOfLord(lord: LordId): FactionId {
  return LORDS[lord].faction;
}
export function factionOfUnit(u: UnitType): FactionId {
  return UNITS[u].faction;
}
