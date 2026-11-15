// Balance multipliers (percent) applied to both HP and damage of each unit / Lord (so power scales with the square).
// Tuned by `node tools/tournament.ts --tune`; see docs/BALANCE.md.
import type { FactionId, LordId, UnitType } from '../types.ts';

/**
 * One multiplier per faction, in PER MILLE (1000 = x1), applied to every unit of the faction (not its Lords) on top of UNIT_POWER. It is the
 * lever for faction-against-faction balance at equal skill (`--same --tune-what factions`), so that UNIT_POWER only
 * has to balance units against each other and LORD_POWER the Lords within a faction. Per mille because equal-level
 * play is very sensitive: with no catch-up and no dice, 1% of unit power is worth about 7 points of win rate.
 */
export const FACTION_POWER: Record<FactionId, number> = { kingdom: 964, ashen: 1062, caliphate: 976 };

export const UNIT_POWER: Record<UnitType, number> = { militia: 136, pikemen: 129, berserkers: 150, archers: 70, knights: 110, cavaliers: 150, mages: 86, clerics: 150, pegasus: 119, ballista: 92, trebuchet: 73, golem: 98, wyvern: 122, dragon: 80, skeleton: 129, grave_knight: 130, bone_archer: 70, wraith_rider: 123, grave_acolyte: 137, bone_drake: 70, corpse_catapult: 125, bone_golem: 104, spear_levy: 124, scimitar: 150, camel_archer: 127, mamluk: 119, djinn_binder: 100, sun_priest: 110, djinn: 94, war_elephant: 93, sand_golem: 141 };
export const LORD_POWER: Record<LordId, number> = { marshal: 125, archmage: 43, warden: 130, skylady: 65, lich: 95, sultana: 115 };
