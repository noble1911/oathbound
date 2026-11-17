// Balance multipliers (percent) applied to both HP and damage of each unit / Lord (so power scales with the square).
// Tuned by `node tools/tournament.ts --tune`; see docs/BALANCE.md.
import type { FactionId, LordId, UnitType } from '../types.ts';

/**
 * One multiplier per faction, in PER MILLE (1000 = x1), applied to every unit of the faction (not its Lords) on top of UNIT_POWER. It is the
 * lever for faction-against-faction balance at equal skill (`--same --tune-what factions`), so that UNIT_POWER only
 * has to balance units against each other and LORD_POWER the Lords within a faction. Per mille because equal-level
 * play is very sensitive: with no catch-up and no dice, 1% of unit power is worth about 7 points of win rate.
 */
export const FACTION_POWER: Record<FactionId, number> = { kingdom: 914, ashen: 1008, caliphate: 1097 };

export const UNIT_POWER: Record<UnitType, number> = { militia: 152, pikemen: 136, berserkers: 148, archers: 77, knights: 119, cavaliers: 163, mages: 80, clerics: 170, pegasus: 147, ballista: 100, trebuchet: 86, golem: 85, wyvern: 108, dragon: 76, skeleton: 166, grave_knight: 124, bone_archer: 85, wraith_rider: 94, grave_acolyte: 170, bone_drake: 71, corpse_catapult: 128, bone_golem: 83, spear_levy: 119, scimitar: 121, camel_archer: 107, mamluk: 138, djinn_binder: 68, sun_priest: 135, djinn: 73, war_elephant: 95, sand_golem: 106 };
export const LORD_POWER: Record<LordId, number> = { marshal: 135, archmage: 61, warden: 126, skylady: 54, lich: 83, sultana: 158, deathknight: 146, ossuary: 77, drakerider: 105, vizier: 60, rajah: 113, rocrider: 77 };

/**
 * Bot levers, not game rules (read only by src/sim/bot.ts): the share of its gold, in PER MILLE, that the Normal bot
 * (NORMAL_RESERVE) and the classic tournament strategies (CLASSIC_RESERVE) keep back each round, per Lord. Every level
 * reads the counter wheel the same way and the game's numbers are balanced on Hard against Hard; a weaker planner still
 * gets more out of some Lords than others (it does not re-form, gears simply, misjudges more), so its spending
 * discipline per Lord is what keeps Normal against Normal and the tournament field inside the gates. One per cent of
 * reserve is worth about one point of win rate. Tuned by `node tools/tournament.ts --fields normal:16 --tune N
 * --tune-what reserve` (and `--fields classic:1`); see docs/BALANCE.md.
 */
export const NORMAL_RESERVE: Record<LordId, number> = { marshal: 283, archmage: 307, warden: 236, skylady: 119, lich: 261, sultana: 325, deathknight: 326, ossuary: 154, drakerider: 312, vizier: 0, rajah: 273, rocrider: 303 };
export const CLASSIC_RESERVE: Record<LordId, number> = { marshal: 61, archmage: 278, warden: 82, skylady: 30, lich: 296, sultana: 386, deathknight: 328, ossuary: 229, drakerider: 258, vizier: 5, rajah: 327, rocrider: 119 };
