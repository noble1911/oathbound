// Balance multipliers (percent) applied to both HP and damage of each unit / Lord (so power scales with the square).
// Tuned by `node tools/tournament.ts --tune`; see docs/BALANCE.md.
import type { FactionId, LordId, UnitType } from '../types.ts';

/**
 * One multiplier per faction, in PER MILLE (1000 = x1), applied to every unit of the faction (not its Lords) on top of UNIT_POWER. It is the
 * lever for faction-against-faction balance at equal skill (`--same --tune-what factions`), so that UNIT_POWER only
 * has to balance units against each other and LORD_POWER the Lords within a faction. Per mille because equal-level
 * play is very sensitive: with no catch-up and no dice, 1% of unit power is worth about 7 points of win rate.
 */
export const FACTION_POWER: Record<FactionId, number> = { kingdom: 976, ashen: 1046, caliphate: 966 };

export const UNIT_POWER: Record<UnitType, number> = { militia: 140, pikemen: 134, berserkers: 147, archers: 70, knights: 125, cavaliers: 140, mages: 70, clerics: 129, pegasus: 140, ballista: 75, trebuchet: 74, golem: 93, wyvern: 138, dragon: 80, skeleton: 134, grave_knight: 126, bone_archer: 70, wraith_rider: 130, grave_acolyte: 135, bone_drake: 71, corpse_catapult: 125, bone_golem: 104, spear_levy: 140, scimitar: 147, camel_archer: 115, mamluk: 132, djinn_binder: 84, sun_priest: 110, djinn: 95, war_elephant: 93, sand_golem: 150 };
export const LORD_POWER: Record<LordId, number> = { marshal: 125, archmage: 43, warden: 160, skylady: 56, lich: 95, sultana: 115 };
