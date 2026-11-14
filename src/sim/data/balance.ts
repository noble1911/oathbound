// Balance multipliers (percent) applied to both HP and damage of each unit / Lord (so power scales with the square).
// Tuned by `node tools/tournament.ts --tune`; see docs/BALANCE.md.
import type { LordId, UnitType } from '../types.ts';

export const UNIT_POWER: Record<UnitType, number> = { militia: 139, pikemen: 114, berserkers: 142, archers: 70, knights: 118, cavaliers: 150, mages: 70, clerics: 127, pegasus: 150, ballista: 70, trebuchet: 72, golem: 103, wyvern: 140, dragon: 86 };
export const LORD_POWER: Record<LordId, number> = { marshal: 142, archmage: 43, warden: 135, skylady: 70 };
