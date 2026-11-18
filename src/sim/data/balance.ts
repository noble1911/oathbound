// Balance multipliers (percent) applied to both HP and damage of each unit / Lord (so power scales with the square).
// Tuned by `node tools/tournament.ts --tune`; see docs/BALANCE.md.
import type { FactionId, LordId, UnitType } from '../types.ts';

/**
 * One multiplier per faction, in PER MILLE (1000 = x1), applied to every unit of the faction (not its Lords) on top of UNIT_POWER. It is the
 * lever for faction-against-faction balance at equal skill (`--same --tune-what factions`), so that UNIT_POWER only
 * has to balance units against each other and LORD_POWER the Lords within a faction. Per mille because equal-level
 * play is very sensitive: with no catch-up and no dice, 1% of unit power is worth about 7 points of win rate.
 */
export const FACTION_POWER: Record<FactionId, number> = { kingdom: 908, ashen: 1001, caliphate: 1100 };

export const UNIT_POWER: Record<UnitType, number> = { militia: 150, pikemen: 136, berserkers: 146, archers: 74, knights: 122, cavaliers: 161, mages: 76, clerics: 169, pegasus: 146, ballista: 105, trebuchet: 92, golem: 84, wyvern: 108, dragon: 68, skeleton: 170, grave_knight: 127, bone_archer: 86, wraith_rider: 88, grave_acolyte: 170, bone_drake: 71, corpse_catapult: 127, bone_golem: 83, spear_levy: 135, scimitar: 123, camel_archer: 109, mamluk: 134, djinn_binder: 68, sun_priest: 134, djinn: 73, war_elephant: 86, sand_golem: 103, sun_mirror: 70 };
export const LORD_POWER: Record<LordId, number> = { marshal: 161, archmage: 69, warden: 133, skylady: 42, lich: 88, sultana: 150, deathknight: 135, ossuary: 75, drakerider: 89, vizier: 94, rajah: 103, rocrider: 58 };

/**
 * Bot levers, not game rules (read only by src/sim/bot.ts): the share of its gold, in PER MILLE, that the Normal bot
 * (NORMAL_RESERVE) and the classic tournament strategies (CLASSIC_RESERVE) keep back each round, per Lord. Every level
 * reads the counter wheel the same way and the game's numbers are balanced on Hard against Hard; a weaker planner still
 * gets more out of some Lords than others (it does not re-form, gears simply, misjudges more), so its spending
 * discipline per Lord is what keeps Normal against Normal and the tournament field inside the gates. One per cent of
 * reserve is worth about one point of win rate. Tuned by `node tools/tournament.ts --fields normal:16 --tune N
 * --tune-what reserve` (and `--fields classic:1`); see docs/BALANCE.md.
 */
export const NORMAL_RESERVE: Record<LordId, number> = { marshal: 428, archmage: 226, warden: 325, skylady: 0, lich: 250, sultana: 540, deathknight: 369, ossuary: 240, drakerider: 221, vizier: 190, rajah: 350, rocrider: 331 };
export const CLASSIC_RESERVE: Record<LordId, number> = { marshal: 362, archmage: 307, warden: 246, skylady: 0, lich: 368, sultana: 540, deathknight: 400, ossuary: 369, drakerider: 277, vizier: 260, rajah: 393, rocrider: 204 };
