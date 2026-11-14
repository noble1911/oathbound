// Oathbound v2 — public simulation API. Server, UI and renderer import ONLY from here (and types.ts).
//
// Lifecycle (server):
//   const s = newMatch(seed, null)              // phase 'lordPick' (or 'planning' if lords are given)
//   applyIntent(s, seat, {t:'pickLord', ...})   // both seats -> phase 'planning', round 1
//   loop:
//     applyIntent(s, seat, intent)              // validated; mutates s; returns {ok} | {ok:false, error}
//     send viewFor(s, seat) to each seat        // hidden-info filtered snapshot
//     when allReady(s) (or the planning timer ends):
//       const {replay, result} = simulateBattle(s)   // pure — does not touch s
//       broadcast replay; applyBattle(s, result)     // keeps, XP, loot offers -> phase 'results' or 'over'
//       after the results screen: nextRound(s)       // income, unlock draft, auto-resolve unpicked offers -> 'planning'
//
// Client playback: const d = decodeReplay(replay); const tf = makeTransforms(d.soldierCount);
//                  every frame: sampleReplay(d, timeMs, tf)  (no allocations); d.events is the decoded event list.
//
// Everything in src/sim is deterministic: integer maths, seeded RNG, no clocks.

export type * from './types.ts';
export { ANIM_STATES, EVENT_KINDS } from './types.ts';

export {
  newMatch, applyIntent, applyBattle, nextRound, viewFor, allReady, forceReady,
  income, deployZone, inDeployZone, levelUpCost, sellRefund, keepDamageOf, squadKeepDamage, lordLevelForXp,
  START_GOLD, KEEP_HP, ARMY_CAP, BASE_DEPLOY_LIMIT, MAX_SQUAD_LEVEL, MAX_LORD_LEVEL, LORD_XP_LEVELS,
  roundOutcome, roundOutcomeText, comebackFor, keepPct, usableSlots, slotOpen, squadFootprint, overlappingSquad, freeSpotNear,
  CATCHUP_GOLD, CATCHUP_PER_ROUND, CATCHUP_PER_DEFICIT, UNDERDOG_DEFICIT,
} from './match.ts';
// roundOutcomeText(summaryOrResult, seat): {outcome: 'won'|'lost'|'draw', title, detail} — the one wording for round results
// comebackFor(me, enemy, round, lost): Comeback       — the catch-up bonus rule (PlayerState.comeback holds the live value)
// usableSlots(player): Slot[]                          — slots with an empty open slot to fill (loot offers lean toward these)
// squadFootprint(type) / overlappingSquad(squads, type, pos, ignoreId?) / freeSpotNear(squads, seat, type, pos, ignoreId?)
//                                                     — deploy/move footprints: squads of one player may not overlap
export { POINTS_MARGIN } from './battle.ts';
// newMatch(seed: number, lords: [LordId, LordId] | null): MatchState
// applyIntent(state, seat, intent): IntentResult           — validates everything (phase, gold, zone, limits, slots)
// viewFor(state, seat: Seat | null): PlayerView            — seat's own full state + enemy's LAST-ROUND army only
// allReady(state): boolean;  forceReady(state): void        — forceReady = planning timer expired
// applyBattle(state, result: BattleResult): void            — phase -> 'results' | 'over'
// nextRound(state): void                                     — phase 'results' -> 'planning' (round + 1)

export { simulateBattle } from './battle.ts';
// simulateBattle(state: MatchState, opts?: SimulateOptions): BattleOutput   — pure; same state => byte-identical replay

export { decodeReplay, sampleReplay, makeTransforms, replayHash, keepSource, KEEP_SRC_BASE } from './replay.ts';
// decodeReplay(replay): DecodedReplay
// sampleReplay(decoded, timeMs, out: SoldierTransforms): SoldierTransforms   — interpolated transforms, allocation-free
// keepSource(seat, n): number  — the `src` used in events for keep towers (n = 0,1) and the keep itself (n = 2)

export { botPlan, BOT_STRATEGIES } from './bot.ts';
// botPlan(state, seat, strategy: BotStrategy, rngSalt?: number): void — applies a full planning turn for `seat`
// through applyIntent (so it obeys the same rules), including lord pick, drafts, loot pick, equips, deploys and ready.

export { itemName, itemLines, itemPower, rollLoot, RARITY_COLOR } from './loot.ts';
// itemName(item): string          e.g. "Vicious Ironbark Bow of Haste"
// itemLines(item): ItemLine[]     ARPG tooltip lines (name, base type, implicit, affixes, legendary power, flavour)

export { UNITS, UNIT_TYPES, BASIC_POOL, unitDef } from './data/units.ts';
export { LORDS, LORD_IDS } from './data/lords.ts';
export { BASES, AFFIXES, LEGENDARIES, RARITIES, SLOT_UNLOCK_LEVEL } from './data/items.ts';
export { FIELD_W, FIELD_H, TICK_HZ, TICK_MS, KEYFRAME_TICKS, MAX_BATTLE_TICKS, MARCH_TICKS, mirrorPos, mirrorFacing } from './constants.ts';
export { terrainAt, genTerrain } from './terrain.ts';
