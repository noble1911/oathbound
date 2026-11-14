// Balance multipliers (percent) applied to both HP and damage of each unit / Lord (so power scales with the square).
// Tuned by `node tools/tournament.ts --tune`; see docs/BALANCE.md.
import type { LordId, UnitType } from '../types.ts';

export const UNIT_POWER: Record<UnitType, number> = { militia: 133, pikemen: 111, berserkers: 144, archers: 70, knights: 115, cavaliers: 150, mages: 70, clerics: 128, pegasus: 128, ballista: 70, trebuchet: 73, golem: 110, wyvern: 126, dragon: 106 };
export const LORD_POWER: Record<LordId, number> = { marshal: 205, archmage: 48, warden: 118, skylady: 78 };
