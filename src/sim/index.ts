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
  income, deployZone, inDeployZone, levelUpCost, sellRefund, keepDamageOf, roundBonus, ROUND_BONUS_FULL_MARGIN, squadKeepDamage, lordLevelForXp,
  START_GOLD, KEEP_HP, ARMY_CAP, BASE_DEPLOY_LIMIT, DEPLOY_BUDGET, DEPLOY_BONUS, deployWeight, deployPointsText, MAX_SQUAD_LEVEL, MAX_LORD_LEVEL, LORD_XP_LEVELS,
  roundOutcome, roundOutcomeText, stalemateCause, stalemateField, comebackFor, keepPct, usableSlots, slotOpen, squadFootprint, overlappingSquad, freeSpotNear,
  CATCHUP_GOLD, CATCHUP_PER_ROUND, CATCHUP_PER_DEFICIT, UNDERDOG_DEFICIT,
} from './match.ts';
// roundOutcomeText(summaryOrResult, seat): {outcome: 'won'|'lost'|'draw', title, detail} — the one wording for round results
// comebackFor(): Comeback                              — deprecated: always zeros (there is no catch-up; both players are equal)
// deployWeight(type): 1 | 2 | 3                       — deploy weight in deploy points (100 gold = 1, 150-300 = 2, 400+ = 3);
//                                                       PlayerState.deployLimit / deploysUsed are deploy points too (budget 4)
// deployPointsText(points): "3"                        — deploy points as the UI writes them (whole numbers)
// usableSlots(player): Slot[]                          — slots with an empty open slot to fill (informational)
// squadFootprint(type) / overlappingSquad(squads, type, pos, ignoreId?) / freeSpotNear(squads, seat, type, pos, ignoreId?)
//                                                     — deploy/move footprints: squads of one player may not overlap
export { concede, armyClasses, suddenDeathPct, unlockOptions, SUDDEN_DEATH_ROUND, SUDDEN_DEATH_PCT, FIRST_UNLOCKS } from './match.ts';
// Relocation (DESIGN §2): squads from earlier rounds are locked; Muster ({t:'muster'}, instead of the round's unlock) relocates up to MUSTER_MOVES.
// squadLocked(squad, round) / squadHome(player, id) / relocatedSquads(player, round) / relocationsLeft(player, round) / canMuster(player, round)
export { MUSTER_MOVES, MARCH_CAP, LOCKED_ERROR, squadLocked, squadHome, relocatedSquads, relocationsLeft, canMuster } from './match.ts';
// concede(state, seat): IntentResult                  — `seat` gives up: phase 'over', the other seat wins, overReason 'concede'
// suddenDeathPct(round)                               — keep-damage multiplier (percent): sudden death from round 10
// unlockOptions(player, round): UnitType[]            — what may be unlocked this round (= PlayerState.draftOptions; not random)
export { POINTS_MARGIN } from './battle.ts';

// ---- Skills (data/skills.ts) ----
export {
  SKILLS, SKILL_IDS, UNIT_CLASS, LORD_CLASS, UNIT_CLASSES, CLASS_NAME, classesOf, squadClasses, canEquip, unitSkills, lordSkills, squadSkills,
  skillText, skillNum, skillCooldownSec, usableByText,
} from './data/skills.ts';
// unitSkills(type: UnitType): SkillInfo[]                         — innate abilities of a unit type (traits, counters), real numbers
// lordSkills(lord: LordId, level?: number): SkillInfo[]           — a Lord's passive + auto ability (with cooldown)
// squadSkills(squad, lord?: LordId | null): SkillInfo[]           — innate (or Lord) + legendary powers + item skills of a squad
// canEquip(item, squadType, lord): boolean                        — class gate of skill items (applyIntent enforces it)
// classesOf(squadType, lord): UnitClass[];  SKILLS[id]: SkillDef  — classes, cooldown (ticks), trigger, slot

// ---- Inspector: stats sheet and battle statistics ----
export { squadSheet, replaySquadSheet, sheetOf } from './sheet.ts';
export type { SquadSheet, StatLine, StatKey, SheetItem } from './sheet.ts';
// squadSheet(view: PlayerView, squadId: number): SquadSheet | null — stats base -> effective, items (+ tooltip lines), skills
// replaySquadSheet(replay: Replay, row: number): SquadSheet | null — the same for any squad of a battle replay
export { squadStatsAt, squadStatsOf, squadDamagePairs, replaySquads } from './stats.ts';
export type { SquadStats, SkillStat, BattleStatsAt, SideStats } from './stats.ts';
// squadStatsAt(decoded: DecodedReplay, tick: number): BattleStatsAt — per-squad damage / healing / kills / skills up to `tick`
// squadStatsOf(stats, side, squadId): SquadStats | null
// squadDamagePairs(decoded, tick): Map<rowA, Map<rowB, damage>>     — who hurt whom (for the battle report)
// newMatch(seed: number, lords: [LordId, LordId] | null): MatchState
// applyIntent(state, seat, intent): IntentResult           — validates everything (phase, gold, zone, limits, slots)
// viewFor(state, seat: Seat | null): PlayerView            — seat's own full state + enemy's LAST-ROUND army only
// allReady(state): boolean;  forceReady(state): void        — forceReady = planning timer expired
// applyBattle(state, result: BattleResult): void            — phase -> 'results' | 'over'
// nextRound(state): void                                     — phase 'results' -> 'planning' (round + 1)

export { simulateBattle } from './battle.ts';
// simulateBattle(state: MatchState, opts?: SimulateOptions): BattleOutput   — pure; same state => byte-identical replay

export { decodeReplay, sampleReplay, makeTransforms, replayHash, keepSource, KEEP_SRC_BASE, REPLAY_VERSION, TALLY_TICKS } from './replay.ts';
// decodeReplay(replay): DecodedReplay
// sampleReplay(decoded, timeMs, out: SoldierTransforms): SoldierTransforms   — interpolated transforms, allocation-free
// keepSource(seat, n): number  — the `src` used in events for keep towers (n = 0,1) and the keep itself (n = 2)

export { botPlan, BOT_STRATEGIES } from './bot.ts';
// botPlan(state, seat, strategy: BotStrategy, rngSalt?: number): void — applies a full planning turn for `seat`
// through applyIntent (so it obeys the same rules), including lord pick, drafts, loot pick, equips, deploys and ready.

export { itemName, itemLines, itemPower, itemBudget, rollLoot, lootRarity, lootSchedule, legendaryFits, bestOnText, wheelClassOf, RARITY_COLOR, SKILL_CHANCE } from './loot.ts';
// rollLoot(seed, round, count, nextId): Item[]   the round's offer, identical for both players: weapon (offence),
//                                                armor (defence), relic (utility), one rarity and one power budget
// lootRarity(round): Rarity                      the offer's rarity (Magic, then Rare; every 3rd round all Legendary)
// legendaryFits(id, type, lord): boolean         a legendary power works only on the wheel classes it is built for
// itemName(item): string          e.g. "Vicious Ironbark Bow of Haste"
// itemLines(item): ItemLine[]     ARPG tooltip lines (name, base type, implicit, affixes, legendary power, flavour)

export { UNITS, UNIT_TYPES, BASIC_POOL, unitDef, like, squadSizeAt, growsBySize, SWARM_GROWTH_PCT, formationCols } from './data/units.ts';
// squadSizeAt(type, level): soldiers before items — Swarm squads grow +25% of their base size per level
export { WHEEL, WHEEL_NAME, WHEEL_WHY, beatsClass, beatenBy, classBeats } from './data/wheel.ts';
// The counter wheel (DESIGN §3): UnitDef.class / LordDef.class; beatsClass(c) / beatenBy(c); COUNTER_PCT damage to the class beaten
export { LORDS, LORD_IDS } from './data/lords.ts';
export { FACTIONS, FACTION_IDS, factionOfLord, factionOfUnit } from './data/factions.ts';
// FACTIONS[id]: { name, short, blurb, identity, colors, lords, units, basic } — the three factions (DESIGN §4b)
// Lord pick phase: {t:'pickFaction', faction} (optional, changeable) then {t:'pickLord', lord}; a Lord implies its faction.
export { BASES, AFFIXES, LEGENDARIES, RARITIES, SLOT_UNLOCK_LEVEL } from './data/items.ts';
export { FIELD_W, FIELD_H, TICK_HZ, TICK_MS, KEYFRAME_TICKS, MAX_BATTLE_TICKS, MARCH_TICKS, COUNTER_PCT, mirrorPos, mirrorFacing } from './constants.ts';
export { terrainAt, genTerrain } from './terrain.ts';
