// Balance multipliers (percent) applied to both HP and damage of each unit / Lord (so power scales with the square).
// Tuned by `node tools/tournament.ts --tune`; see docs/BALANCE.md.
import type { FactionId, LordId, UnitType } from '../types.ts';

/**
 * One multiplier per faction, in PER MILLE (1000 = x1), applied to every unit of the faction (not its Lords) on top of UNIT_POWER. It is the
 * lever for faction-against-faction balance at equal skill (`--same --tune-what factions`), so that UNIT_POWER only
 * has to balance units against each other and LORD_POWER the Lords within a faction. Per mille because equal-level
 * play is very sensitive: with no catch-up and no dice, 1% of unit power is worth about 7 points of win rate.
 */
export const FACTION_POWER: Record<FactionId, number> = { kingdom: 902, ashen: 1011, caliphate: 1100 };

export const UNIT_POWER: Record<UnitType, number> = { militia: 152, pikemen: 136, berserkers: 147, archers: 76, knights: 121, cavaliers: 163, mages: 78, clerics: 170, pegasus: 149, ballista: 107, trebuchet: 90, golem: 84, wyvern: 108, dragon: 69, skeleton: 169, grave_knight: 126, bone_archer: 85, wraith_rider: 90, grave_acolyte: 170, bone_drake: 71, corpse_catapult: 127, bone_golem: 83, spear_levy: 132, scimitar: 121, camel_archer: 107, mamluk: 136, djinn_binder: 68, sun_priest: 135, djinn: 73, war_elephant: 88, sand_golem: 104, sun_mirror: 70 };
export const LORD_POWER: Record<LordId, number> = { marshal: 165, archmage: 56, warden: 143, skylady: 41, lich: 87, sultana: 165, deathknight: 151, ossuary: 82, drakerider: 82, vizier: 75, rajah: 109, rocrider: 61 };

/**
 * Bot levers, not game rules (read only by src/sim/bot.ts): the share of its gold, in PER MILLE, that the Normal bot
 * (NORMAL_RESERVE) and the classic tournament strategies (CLASSIC_RESERVE) keep back each round, per Lord. Every level
 * reads the counter wheel the same way and the game's numbers are balanced on Hard against Hard; a weaker planner still
 * gets more out of some Lords than others (it does not re-form, gears simply, misjudges more), so its spending
 * discipline per Lord is what keeps Normal against Normal and the tournament field inside the gates. One per cent of
 * reserve is worth about one point of win rate. Tuned by `node tools/tournament.ts --fields normal:16 --tune N
 * --tune-what reserve` (and `--fields classic:1`); see docs/BALANCE.md.
 */
export const NORMAL_RESERVE: Record<LordId, number> = { marshal: 368, archmage: 172, warden: 250, skylady: 0, lich: 282, sultana: 500, deathknight: 351, ossuary: 240, drakerider: 218, vizier: 130, rajah: 320, rocrider: 322 };
export const CLASSIC_RESERVE: Record<LordId, number> = { marshal: 310, archmage: 269, warden: 186, skylady: 0, lich: 320, sultana: 500, deathknight: 445, ossuary: 369, drakerider: 274, vizier: 170, rajah: 370, rocrider: 174 };
