// Match rules (DESIGN §1, §2, §4, §5): lords, economy, unlock drafts, deployment limits, level-ups, loot and items,
// intent validation, the hidden-information view, and applying battle results.
import { FIELD_H, FIELD_W, mirrorPos, mirrorFacing } from './constants.ts';
import { SLOT_UNLOCK_LEVEL } from './data/items.ts';
import { canEquip, classError, classesOf } from './data/skills.ts';
import { FACTIONS, FACTION_IDS } from './data/factions.ts';
import { LORDS, LORD_IDS, OSSUARY_KEEP_BONUS } from './data/lords.ts';
import { UNITS, formationCols, squadSizeAt } from './data/units.ts';
import { modsOf, rollLoot } from './loot.ts';
import { genTerrain } from './terrain.ts';
import type {
  BattleEnd, BattleResult, Comeback, EnemyView, Intent, IntentResult, Item, LordId, MatchState, PlayerState, PlayerView, RoundOutcome, RoundSummary, Seat, Slot,
  FactionId, LordStance, Squad, SquadType, UnitClass, UnitType, Vec2,
} from './types.ts';

export const START_GOLD = 300;
export const KEEP_HP = 4000;
export const WARDEN_KEEP_BONUS = 800;
export const ARMY_CAP = 16;
/**
 * Deploy points (DESIGN §2): every round each player may deploy squads whose deploy weights (deployWeight: 1, 2
 * or 3) add up to DEPLOY_BUDGET (4 points). The Marshal and each 'of Command' relic add DEPLOY_BONUS (2 points).
 * Kept under its old name: it is the base limit. (The points were once shown halved; the values never changed.)
 */
export const BASE_DEPLOY_LIMIT = 4;
export const DEPLOY_BUDGET = BASE_DEPLOY_LIMIT;
export const DEPLOY_BONUS = 2;
/** Deploy weight of a unit in deploy points, by its cost: 100 gold = 1, 150-300 = 2, 400 and up = 3. */
export function deployWeight(type: UnitType): number {
  const c = UNITS[type].cost;
  return c <= 100 ? 1 : c < 400 ? 2 : 3;
}
/** Deploy points as the UI writes them: whole numbers, exactly the sim's values (3 -> "3"). */
export function deployPointsText(points: number): string {
  return String(points);
}
export const MAX_SQUAD_LEVEL = 5;
export const MAX_LORD_LEVEL = 10;
/**
 * There is no catch-up: both players always get the same income, deployments and loot offers, whoever is ahead.
 * These constants are all 0 and stay only so older UI code that reads them keeps compiling.
 * @deprecated
 */
export const CATCHUP_GOLD = 0;
/** @deprecated */
export const CATCHUP_PER_ROUND = 0;
/** @deprecated */
export const CATCHUP_PER_DEFICIT = 0;
/** @deprecated */
export const UNDERDOG_DEFICIT = 0;
/** Cumulative XP needed for Lord levels 1..10. */
export const LORD_XP_LEVELS = [0, 50, 120, 215, 335, 480, 655, 865, 1105, 1375];
/**
 * Not a game rule: a guard against an endless match in tests and bot runs. Matches end by a keep falling; the
 * keep-damage curve and sudden death make that happen by about round 12 at the latest. Should a match ever reach
 * this round, the higher keep wins.
 */
export const MAX_ROUNDS = 30;
/** Keep damage per cost tier (cost / 100) of a surviving Lv1 squad; see squadKeepDamage. */
export const KEEP_DMG_PER_TIER = 55;
export const KEEP_DMG_BASE_PER_ROUND = 70;
export const LORD_KEEP_DMG = 60;

/** Income at the start of `round` (round 1 is the 300 starting gold). */
export function income(round: number): number {
  return round <= 1 ? START_GOLD : Math.min(500, 200 + 25 * round);
}
/**
 * A level-up costs the same at every level: LEVEL_COST_PCT percent of the unit's cost. (It used to be unit cost x
 * level, which made a level 2-5x less gold-efficient than a new squad, so nobody levelled; see
 * docs/reviews/POSITIONING-AND-ECONOMY.md section 6.) A Lv5 squad costs 2.4x its base price in all.
 */
export const LEVEL_COST_PCT = 40;
/** What each squad level adds to every soldier (percent of the Lv1 value): life and damage. */
export const LEVEL_HP_PCT = 25;
export const LEVEL_DMG_PCT = 20;
export function levelUpCost(type: UnitType, _level: number): number {
  return Math.trunc((UNITS[type].cost * LEVEL_COST_PCT) / 100);
}
/**
 * Selling in the round of purchase is an undo: nothing has happened since, so everything spent on the squad (its
 * cost and any level-ups) comes back. A squad deployed in an earlier round refunds nothing.
 */
export function sellRefund(sq: Squad, round: number): number {
  return sq.deployedRound === round ? sq.spent : 0;
}

// ---------------------------------------------------------------- relocation and Muster (DESIGN §2)

/** How many squads from earlier rounds Muster lets a player relocate, in the round it is taken. */
export const MUSTER_MOVES = 3;
/** Each 'of the March' relic worn at the start of a round allows one relocation that round, Muster or not: at most this many. */
export const MARCH_CAP = 2;
/**
 * Is `sq` locked in place this round? Squads deployed in an earlier round are; the Lord and this round's squads are
 * not. A locked squad may still turn on the spot, and may be relocated only with a relocation (Muster).
 */
export function squadLocked(sq: Pick<Squad, 'type' | 'deployedRound'>, round: number): boolean {
  return sq.type !== 'lord' && sq.deployedRound < round;
}
/** Where a locked squad stood when the round began: its spot in the last battle. Null for squads that were not in it. */
export function squadHome(p: Pick<PlayerState, 'lastArmy'>, id: number): Vec2 | null {
  const h = p.lastArmy?.find((q) => q.id === id);
  return h ? [h.pos[0], h.pos[1]] : null;
}
/** Ids of the locked squads `p` has relocated this round (they stand somewhere other than their home). */
export function relocatedSquads(p: Pick<PlayerState, 'squads' | 'lastArmy'>, round: number): number[] {
  const out: number[] = [];
  for (const q of p.squads) {
    if (!squadLocked(q, round)) continue;
    const h = squadHome(p, q.id);
    if (h && (h[0] !== q.pos[0] || h[1] !== q.pos[1])) out.push(q.id);
  }
  return out;
}
/** Relocations `p` may still make this round (0 without Muster or an 'of the March' relic). */
export function relocationsLeft(p: Pick<PlayerState, 'squads' | 'lastArmy' | 'moveLimit'>, round: number): number {
  return Math.max(0, (p.moveLimit ?? 0) - relocatedSquads(p, round).length);
}
/** May `p` take Muster now? (The round's unlock is unspent and there is a locked squad to move.) */
export function canMuster(p: PlayerState, round: number): boolean {
  return !!p.musterOffer && !p.muster && !p.ready && p.squads.some((q) => squadLocked(q, round));
}
export const LOCKED_ERROR = 'that squad is locked in place: only squads deployed this round and the Lord move freely (take Muster instead of a unit unlock to relocate up to 3)';

export function lordLevelForXp(xp: number): number {
  let l = 1;
  while (l < MAX_LORD_LEVEL && xp >= LORD_XP_LEVELS[l]) l++;
  return l;
}

/** Deploy zone (inclusive, cm). Seat 1's is the mirror of seat 0's. */
export function deployZone(seat: Seat): { x0: number; x1: number; y0: number; y1: number } {
  return seat === 0 ? { x0: 200, x1: FIELD_W - 201, y0: 400, y1: 3999 } : { x0: 200, x1: FIELD_W - 201, y0: FIELD_H - 4000, y1: FIELD_H - 401 };
}
export function inDeployZone(seat: Seat, p: Vec2): boolean {
  const z = deployZone(seat);
  return Number.isInteger(p[0]) && Number.isInteger(p[1]) && p[0] >= z.x0 && p[0] <= z.x1 && p[1] >= z.y0 && p[1] <= z.y1;
}

/** Keep damage a surviving squad deals: tier x level factor (Lv1 = 1, +0.5 per level). */
export function squadKeepDamage(sq: Squad): number {
  if (sq.type === 'lord') return Math.trunc((LORD_KEEP_DMG * (9 + sq.level)) / 10);
  const tier = UNITS[sq.type].cost / 100;
  return Math.trunc((KEEP_DMG_PER_TIER * tier * (1 + sq.level)) / 2);
}
/** Sudden death: from round SUDDEN_DEATH_ROUND on, all keep damage grows by SUDDEN_DEATH_PCT percent per round. */
export const SUDDEN_DEATH_ROUND = 8;
export const SUDDEN_DEATH_PCT = 25;
export function suddenDeathPct(round: number): number {
  return round >= SUDDEN_DEATH_ROUND ? 100 + SUDDEN_DEATH_PCT * (round - SUDDEN_DEATH_ROUND + 1) : 100;
}
/**
 * The round bonus is paid in proportion to the winning margin (points, 0..100): a win by ROUND_BONUS_FULL_MARGIN points
 * or more earns all of it, a narrow win a share. A close round is decided by fine details nobody can plan for, so it
 * should not pay like a clear one (docs/reviews/POSITIONING-AND-ECONOMY.md section 7).
 */
export const ROUND_BONUS_FULL_MARGIN = 40;
export function roundBonus(round: number, margin: number): number {
  const m = Math.max(0, Math.min(ROUND_BONUS_FULL_MARGIN, Math.trunc(margin)));
  return Math.trunc((KEEP_DMG_BASE_PER_ROUND * round * m) / ROUND_BONUS_FULL_MARGIN);
}
/**
 * Total keep damage dealt by `seat`'s survivors (DESIGN §1). `won` (a wipe or a points win) adds the round bonus,
 * KEEP_DMG_BASE_PER_ROUND x round scaled by the winning `margin` (points; the default pays it in full);
 * `timeout` = a points draw, half the survivors' damage. Everything is scaled by the sudden-death multiplier of the
 * round. The rule is the same for both seats and does not look at who is ahead.
 */
export function keepDamageOf(squads: Squad[], survivorIds: number[], round: number, won: boolean, timeout: boolean, margin = ROUND_BONUS_FULL_MARGIN): number {
  let d = 0;
  for (const sq of squads) if (survivorIds.includes(sq.id)) d += squadKeepDamage(sq);
  const sd = suddenDeathPct(round);
  if (timeout) return Math.trunc((Math.trunc(d / 2) * sd) / 100);
  return won ? Math.trunc(((d + roundBonus(round, margin)) * sd) / 100) : 0;
}

/** Keep HP as an integer percentage of its maximum. */
export function keepPct(p: { keepHp: number; keepMax: number }): number {
  return Math.trunc((p.keepHp * 100) / Math.max(1, p.keepMax));
}

/**
 * There is no comeback bonus any more: this always returns zeros (see CATCHUP_GOLD). Kept, like
 * PlayerState.comeback, so existing callers keep working.
 * @deprecated
 */
export function comebackFor(_me?: PlayerState, _enemy?: PlayerState, _round?: number, _lost?: boolean): Comeback {
  return { gold: 0, deploys: 0, deficit: 0 };
}

function newPlayer(seat: Seat): PlayerState {
  return {
    seat, faction: null, lord: null, gold: 0, keepHp: KEEP_HP, keepMax: KEEP_HP, unlocked: [], draftOptions: [], draftPicks: 0, lootOffer: null,
    squads: [], stash: [], deploysUsed: 0, deployLimit: BASE_DEPLOY_LIMIT, lordXp: 0, ready: false, lostLast: false, lastArmy: null,
    comeback: { gold: 0, deploys: 0, deficit: 0 }, moveLimit: 0, musterOffer: false, muster: false, lastMoved: [],
  };
}

// ---------------------------------------------------------------- deploy footprints

/**
 * Ground radius (cm) a squad's formation covers: the half-extent of its soldier grid plus a body radius.
 * Two squads of one player may not overlap: centres must be at least footprint(a) + footprint(b) apart.
 * Mirrors the formation in battle.ts (cols by squad size, spacing = 2 x radius + 50).
 */
export function squadFootprint(type: SquadType): number {
  // A Swarm squad grows as it levels (squadSizeAt): it reserves the ground of its largest size, so a level-up never
  // makes it overlap a neighbour.
  const n = type === 'lord' ? 1 : squadSizeAt(type, MAX_SQUAD_LEVEL);
  const radius = type === 'lord' ? 65 : UNITS[type].radius;
  const cols = formationCols(n);
  const rows = Math.ceil(n / cols);
  const spacing = radius * 2 + 50;
  return Math.trunc((Math.max(cols, rows) - 1) * spacing / 2) + radius;
}

/** The squad of `squads` (other than `ignoreId`) whose footprint a `type` squad at `pos` would overlap, if any. */
export function overlappingSquad(squads: readonly Squad[], type: SquadType, pos: Vec2, ignoreId = -1): Squad | null {
  const r = squadFootprint(type);
  for (const q of squads) {
    if (q.id === ignoreId) continue;
    const dx = q.pos[0] - pos[0], dy = q.pos[1] - pos[1], d = r + squadFootprint(q.type);
    if (dx * dx + dy * dy < d * d) return q;
  }
  return null;
}

/**
 * The nearest legal spot to `want` for a `type` squad of `seat` (inside the deploy zone, overlapping nothing),
 * searching outwards in 1 m square rings up to 40 m. Null if the zone is full. Deterministic.
 */
export function freeSpotNear(squads: readonly Squad[], seat: Seat, type: SquadType, want: Vec2, ignoreId = -1): Vec2 | null {
  const z = deployZone(seat);
  const cx = Math.min(z.x1, Math.max(z.x0, Math.trunc(want[0]))), cy = Math.min(z.y1, Math.max(z.y0, Math.trunc(want[1])));
  const tryAt = (x: number, y: number): Vec2 | null => {
    if (x < z.x0 || x > z.x1 || y < z.y0 || y > z.y1) return null;
    return overlappingSquad(squads, type, [x, y], ignoreId) ? null : [x, y];
  };
  const sg = seat === 0 ? 1 : -1;
  for (let ring = 0; ring <= 40; ring++) {
    if (ring === 0) { const h = tryAt(cx, cy); if (h) return h; continue; }
    // Walk the ring nearest-first: offsets sorted by |dx| + |dy|.
    for (let k = 0; k <= ring; k++) {
      for (const [dx, dy] of [[k, ring], [-k, ring], [k, -ring], [-k, -ring], [ring, k], [-ring, k], [ring, -k], [-ring, -k]]) {
        // Seat 1 searches in the mirrored order, so both seats shift a blocked squad the same way relative to the
        // enemy (the bots place through this: an unmirrored order gave seat 0 a small but real edge).
        const h = tryAt(cx + sg * dx * 100, cy + sg * dy * 100);
        if (h) return h;
      }
    }
  }
  return null;
}

export function newMatch(seed: number, lords: [LordId, LordId] | null): MatchState {
  const s: MatchState = {
    v: 2, seed: seed >>> 0, round: 0, phase: 'lordPick', players: [newPlayer(0), newPlayer(1)], terrain: genTerrain(seed >>> 0),
    winner: null, history: [], nextId: 1,
  };
  if (lords) {
    setLord(s, 0, lords[0]);
    setLord(s, 1, lords[1]);
    startMatch(s);
  }
  return s;
}

function setLord(s: MatchState, seat: Seat, lord: LordId): void {
  const p = s.players[seat];
  p.lord = lord;
  p.faction = LORDS[lord].faction;
  if (lord === 'warden' || lord === 'ossuary') { p.keepMax = KEEP_HP + (lord === 'warden' ? WARDEN_KEEP_BONUS : OSSUARY_KEEP_BONUS); p.keepHp = p.keepMax; }
  const pos: Vec2 = seat === 0 ? [3999, 1200] : mirrorPos([3999, 1200]);
  p.squads = [{ id: s.nextId++, owner: seat, type: 'lord', level: 1, pos, facing: seat === 0 ? 64 : 192, items: { weapon: null, armor: null, relic: null }, deployedRound: 0, spent: 0 }];
}

function startMatch(s: MatchState): void {
  s.round = 1;
  s.phase = 'planning';
  for (const p of s.players) {
    const L = LORDS[p.lord!];
    p.unlocked = [...L.signature];
    p.gold = START_GOLD;
    // No random draft: like every round, round 1 is a free choice of one unit, here from the faction's basic units.
    p.draftOptions = unlockOptions(p, 1);
    p.draftPicks = FIRST_UNLOCKS;
    p.deploysUsed = 0;
    p.deployLimit = deployLimitFor(p, 0);
  }
}

/** Unit types unlocked in round 1 (any one of the basic pool) on top of the Lord's two signature units; every later round unlocks one more. */
export const FIRST_UNLOCKS = 1;

/**
 * The units `p` may unlock in `round`: every locked unit of the player's FACTION whose time has come (round 1: the
 * faction's basic units; later: every unit whose minRound has come). The same rule for both players; the list
 * depends only on the faction and on what is already unlocked. (`faction` defaults to the Kingdom for old callers.)
 */
export function unlockOptions(p: Pick<PlayerState, 'unlocked'> & { faction?: FactionId | null }, round: number): UnitType[] {
  const F = FACTIONS[p.faction ?? 'kingdom'];
  const pool = round <= 1 ? F.basic : F.units;
  return pool.filter((u) => !p.unlocked.includes(u) && UNITS[u].minRound <= round);
}

function deployLimitFor(p: PlayerState, commandBonus: number): number {
  return DEPLOY_BUDGET + DEPLOY_BONUS * ((p.lord === 'marshal' ? 1 : 0) + commandBonus);
}

/** Each round a player may unlock any ONE locked unit whose minRound has come: a free choice, nothing is rolled. */
function rollDraft(s: MatchState, p: PlayerState): void {
  p.draftOptions = unlockOptions(p, s.round);
  p.draftPicks = p.draftOptions.length ? 1 : 0;
}

function resolveDraft(p: PlayerState): void {
  while (p.draftPicks > 0 && p.draftOptions.length) {
    p.unlocked.push(p.draftOptions.shift()!);
    p.draftPicks--;
  }
  p.draftOptions = [];
  p.draftPicks = 0;
}

const err = (error: string): IntentResult => ({ ok: false, error });
const OK: IntentResult = { ok: true };

function findItem(p: PlayerState, id: number): { item: Item; squad: Squad | null } | null {
  const st = p.stash.find((i) => i.id === id);
  if (st) return { item: st, squad: null };
  for (const sq of p.squads) {
    for (const slot of ['weapon', 'armor', 'relic'] as Slot[]) {
      const it = sq.items[slot];
      if (it && it.id === id) return { item: it, squad: sq };
    }
  }
  return null;
}

export function slotOpen(sq: Squad, slot: Slot): boolean {
  return sq.type === 'lord' || sq.level >= SLOT_UNLOCK_LEVEL[slot];
}

/**
 * Slots this player can fill right now: some squad (or the Lord) has the slot open and empty, more such
 * empty slots than stash items already waiting for them. (Informational: offers no longer depend on it.)
 */
export function usableSlots(p: PlayerState): Slot[] {
  const out: Slot[] = [];
  for (const slot of ['weapon', 'armor', 'relic'] as Slot[]) {
    let free = 0;
    for (const q of p.squads) if (slotOpen(q, slot) && !q.items[slot]) free++;
    for (const it of p.stash) if (it.slot === slot) free--;
    if (free > 0) out.push(slot);
  }
  return out;
}

/** The unit classes in a player's army (Lord included). (Informational: offers no longer depend on it.) */
export function armyClasses(p: PlayerState): UnitClass[] {
  const out: UnitClass[] = [];
  for (const q of p.squads) for (const c of classesOf(q.type, p.lord)) if (!out.includes(c)) out.push(c);
  return out;
}

/**
 * `seat` gives up: the match ends at once and the other seat wins (overReason 'concede'). Allowed in any phase
 * once both Lords are picked or not; refused only when the match is already over.
 */
export function concede(s: MatchState, seat: Seat): IntentResult {
  if (seat !== 0 && seat !== 1) return err('bad seat');
  if (s.phase === 'over') return err('match is over');
  s.phase = 'over';
  s.winner = (1 - seat) as Seat;
  s.overReason = 'concede';
  for (const p of s.players) { p.ready = false; p.lootOffer = null; }
  return OK;
}

const validFacing = (f: unknown): boolean => f === undefined || (Number.isInteger(f) && (f as number) >= 0 && (f as number) <= 255);

/** Validate and apply one intent for `seat`. Mutates `s` only when the result is ok. */
export function applyIntent(s: MatchState, seat: Seat, intent: Intent): IntentResult {
  if (seat !== 0 && seat !== 1) return err('bad seat');
  if (!intent || typeof intent !== 'object') return err('bad intent');
  const p = s.players[seat];
  if (s.phase === 'over') return err('match is over');
  if (intent.t === 'pickFaction') {
    if (s.phase !== 'lordPick') return err('not picking lords');
    if (!FACTION_IDS.includes(intent.faction)) return err('unknown faction');
    if (p.lord) return err('lord already picked');
    p.faction = intent.faction;
    return OK;
  }
  if (intent.t === 'pickLord') {
    if (s.phase !== 'lordPick') return err('not picking lords');
    if (!LORD_IDS.includes(intent.lord)) return err('unknown lord');
    if (p.lord) return err('lord already picked');
    if (p.faction && LORDS[intent.lord].faction !== p.faction) return err(`${LORDS[intent.lord].title} ${LORDS[intent.lord].name} does not lead ${FACTIONS[p.faction].name}`);
    setLord(s, seat, intent.lord);
    if (s.players.every((q) => q.lord)) startMatch(s);
    return OK;
  }
  if (s.phase !== 'planning') return err('not in planning');
  if (intent.t === 'unready') { p.ready = false; return OK; }
  if (p.ready) return err('already ready');
  switch (intent.t) {
    case 'ready':
      p.ready = true;
      return OK;
    case 'draft': {
      if (p.draftPicks <= 0) return err('no draft pick available');
      const i = p.draftOptions.indexOf(intent.unit);
      if (i < 0) return err('not a draft option');
      p.unlocked.push(intent.unit);
      p.draftOptions.splice(i, 1);
      p.draftPicks--;
      if (p.draftPicks === 0) p.draftOptions = [];
      // The round's unlock is spent: Muster was the other choice.
      p.musterOffer = false;
      return OK;
    }
    case 'muster': {
      if (p.muster) return err('Muster is already called this round');
      if (!p.musterOffer) return err(s.round <= 1 ? 'nothing to muster yet: no squad is locked in round 1' : "Muster is taken instead of the round's unit unlock, and that is already spent");
      if (!p.squads.some((q) => squadLocked(q, s.round))) return err('nothing to muster: no squad of yours is locked');
      p.muster = true;
      p.musterOffer = false;
      p.moveLimit = (p.moveLimit ?? 0) + MUSTER_MOVES;
      p.draftOptions = [];
      p.draftPicks = 0;
      return OK;
    }
    case 'deploy': {
      const def = UNITS[intent.unit];
      if (!def) return err('unknown unit');
      if (!p.unlocked.includes(intent.unit)) return err('unit not unlocked');
      if (p.faction && def.faction !== p.faction) return err('that unit belongs to another faction');
      if (!Array.isArray(intent.pos) || !inDeployZone(seat, intent.pos)) return err('outside deploy zone');
      if (!validFacing(intent.facing)) return err('bad facing');
      if (p.deploysUsed + deployWeight(intent.unit) > p.deployLimit) return err(p.deploysUsed >= p.deployLimit ? 'deployment limit reached' : 'not enough deploy points left for that unit');
      if (p.squads.filter((q) => q.type !== 'lord').length >= ARMY_CAP) return err('army cap reached');
      if (p.gold < def.cost) return err('not enough gold');
      if (overlappingSquad(p.squads, intent.unit, intent.pos)) return err('overlaps another squad: each squad needs its own ground');
      p.gold -= def.cost;
      p.deploysUsed += deployWeight(intent.unit);
      p.squads.push({
        id: s.nextId++, owner: seat, type: intent.unit, level: 1, pos: [intent.pos[0], intent.pos[1]],
        facing: intent.facing ?? (seat === 0 ? 64 : 192), items: { weapon: null, armor: null, relic: null }, deployedRound: s.round, spent: def.cost,
      });
      return OK;
    }
    case 'move': {
      const sq = p.squads.find((q) => q.id === intent.squad);
      if (!sq) return err('no such squad');
      if (!Array.isArray(intent.pos) || !inDeployZone(seat, intent.pos)) return err('outside deploy zone');
      if (!validFacing(intent.facing)) return err('bad facing');
      const stays = intent.pos[0] === sq.pos[0] && intent.pos[1] === sq.pos[1];
      // Relocation: a squad from an earlier round only turns on the spot, unless a relocation is left (Muster). Going
      // back to where it stood, or moving a squad that is already relocated again, uses no further relocation.
      if (!stays && squadLocked(sq, s.round)) {
        const home = squadHome(p, sq.id);
        const back = !!home && home[0] === intent.pos[0] && home[1] === intent.pos[1];
        const away = !!home && (home[0] !== sq.pos[0] || home[1] !== sq.pos[1]);
        if (!back && !away && relocationsLeft(p, s.round) <= 0) return err((p.moveLimit ?? 0) > 0 ? `all ${p.moveLimit} relocations of this round are used: move a squad back to free one` : LOCKED_ERROR);
      }
      if (overlappingSquad(p.squads, sq.type, intent.pos, sq.id)) return err('overlaps another squad: each squad needs its own ground');
      sq.pos = [intent.pos[0], intent.pos[1]];
      if (intent.facing !== undefined) sq.facing = intent.facing;
      return OK;
    }
    case 'stance': {
      const lordSq = p.squads.find((q) => q.type === 'lord');
      if (!lordSq) return err('no Lord');
      if (intent.stance === 'advance') { delete lordSq.stance; return OK; }
      if (intent.stance === 'hold') { lordSq.stance = { t: 'hold' }; return OK; }
      if (intent.stance !== 'follow') return err('unknown stance');
      if (!Number.isInteger(intent.squad)) return err('follow needs a squad');
      const lead = p.squads.find((q) => q.id === intent.squad);
      if (!lead) return err('no such squad');
      if (lead.type === 'lord') return err('the Lord cannot follow himself');
      lordSq.stance = { t: 'follow', squad: lead.id };
      return OK;
    }
    case 'sell': {
      const i = p.squads.findIndex((q) => q.id === intent.squad);
      if (i < 0) return err('no such squad');
      const sq = p.squads[i];
      if (sq.type === 'lord') return err('cannot sell the Lord');
      // A Lord told to follow this squad goes back to advancing.
      for (const q of p.squads) if (q.stance?.t === 'follow' && q.stance.squad === sq.id) delete q.stance;
      p.gold += sellRefund(sq, s.round);
      if (sq.deployedRound === s.round) p.deploysUsed = Math.max(0, p.deploysUsed - deployWeight(sq.type));
      for (const slot of ['weapon', 'armor', 'relic'] as Slot[]) if (sq.items[slot]) p.stash.push(sq.items[slot]!);
      p.squads.splice(i, 1);
      return OK;
    }
    case 'levelUp': {
      const sq = p.squads.find((q) => q.id === intent.squad);
      if (!sq) return err('no such squad');
      if (sq.type === 'lord') return err('the Lord levels from XP');
      if (sq.level >= MAX_SQUAD_LEVEL) return err('max level');
      const cost = levelUpCost(sq.type, sq.level);
      if (p.gold < cost) return err('not enough gold');
      p.gold -= cost;
      sq.spent += cost;
      sq.level++;
      return OK;
    }
    case 'pickLoot': {
      if (!p.lootOffer) return err('no loot to pick');
      if (!Number.isInteger(intent.index) || intent.index < 0 || intent.index >= p.lootOffer.length) return err('bad loot index');
      p.stash.push(p.lootOffer[intent.index]);
      p.lootOffer = null;
      return OK;
    }
    case 'equip':
    case 'moveItem': {
      const found = findItem(p, intent.item);
      if (!found) return err('no such item');
      const sq = p.squads.find((q) => q.id === intent.squad);
      if (!sq) return err('no such squad');
      const slot = found.item.slot;
      if (!slotOpen(sq, slot)) return err(`${slot} slot opens at level ${SLOT_UNLOCK_LEVEL[slot]}`);
      if (found.squad === sq) return OK;
      // Skill items are class-locked: knights do not cast fireballs.
      if (!canEquip(found.item, sq.type, p.lord)) return err(classError(found.item));
      const prev = sq.items[slot];
      // Remove from source.
      if (found.squad) found.squad.items[slot] = null;
      else p.stash.splice(p.stash.indexOf(found.item), 1);
      sq.items[slot] = found.item;
      // Whatever was there goes back where the item came from.
      if (prev) {
        if (found.squad && slotOpen(found.squad, slot) && canEquip(prev, found.squad.type, p.lord)) found.squad.items[slot] = prev;
        else p.stash.push(prev);
      }
      return OK;
    }
    case 'unequip': {
      const found = findItem(p, intent.item);
      if (!found || !found.squad) return err('item is not equipped');
      found.squad.items[found.item.slot] = null;
      p.stash.push(found.item);
      return OK;
    }
  }
  return err('unknown intent');
}

export function allReady(s: MatchState): boolean {
  return s.phase === 'planning' && s.players[0].ready && s.players[1].ready;
}
/** Planning timer expired: lock both players in (pending drafts resolve to their first option). */
export function forceReady(s: MatchState): void {
  if (s.phase !== 'planning') return;
  for (const p of s.players) { resolveDraft(p); p.ready = true; }
}

const clone = <T>(x: T): T => structuredClone(x);

function enemyView(s: MatchState, seat: Seat): EnemyView {
  const e = s.players[seat];
  return {
    seat,
    faction: s.phase === 'lordPick' ? null : e.faction,
    lord: s.phase === 'lordPick' ? null : e.lord,
    keepHp: e.keepHp,
    keepMax: e.keepMax,
    ready: e.ready,
    lastArmy: e.lastArmy ? clone(e.lastArmy) : null,
    lastMoved: [...(e.lastMoved ?? [])],
  };
}

/** Hidden-information view for one seat (null = spectator). Never contains the enemy's current squads, gold, stash or offers. */
export function viewFor(s: MatchState, seat: Seat | null): PlayerView {
  const base: Omit<PlayerView, 'seat' | 'you' | 'enemy'> = { seed: s.seed, round: s.round, phase: s.phase, terrain: clone(s.terrain), winner: s.winner, history: clone(s.history) };
  if (s.overReason) base.overReason = s.overReason;
  if (seat === null) {
    const enemies: [EnemyView, EnemyView] = [enemyView(s, 0), enemyView(s, 1)];
    return { ...base, seat: null, you: null, enemy: enemies[1], enemies };
  }
  return { ...base, seat, you: clone(s.players[seat]), enemy: enemyView(s, (1 - seat) as Seat) };
}

/** Apply a battle result: keep damage, Lord XP, last-army snapshots, loot offers. Phase -> 'results' | 'over'. */
export function applyBattle(s: MatchState, r: BattleResult): void {
  if (s.phase !== 'planning') throw new Error('applyBattle outside planning');
  const before: [number, number] = [s.players[0].keepHp, s.players[1].keepHp];
  for (const seat of [0, 1] as Seat[]) {
    const p = s.players[seat];
    resolveDraft(p);
    p.keepHp = Math.max(0, p.keepHp - r.keepDamage[seat]);
    // The round winner is decided by the battle (on points for timeouts); a draw is nobody's loss.
    p.lostLast = r.winner !== null && r.winner !== seat;
    p.lordXp += r.lordXp[seat];
    const lord = p.squads.find((q) => q.type === 'lord');
    if (lord) lord.level = lordLevelForXp(p.lordXp);
    // Intel for the next planning phase: which squads stand somewhere else than in the battle before.
    const prev = p.lastArmy;
    p.lastMoved = prev ? p.squads.filter((q) => { const o = prev.find((x) => x.id === q.id); return !!o && (o.pos[0] !== q.pos[0] || o.pos[1] !== q.pos[1]); }).map((q) => q.id) : [];
    p.lastArmy = clone(p.squads);
    p.ready = false;
    // A loot offer that was never picked goes to the stash (first option).
    if (p.lootOffer) { p.stash.push(p.lootOffer[0]); p.lootOffer = null; }
  }
  for (const seat of [0, 1] as Seat[]) s.players[seat].comeback = comebackFor();
  s.history.push({
    // Clamped to the life the keep had: overkill is not damage taken.
    round: s.round, winner: r.winner, keepDamage: [Math.min(r.keepDamage[0], before[0]), Math.min(r.keepDamage[1], before[1])],
    survivors: [r.survivors[0].length, r.survivors[1].length], ticks: r.ticks,
    end: r.end ?? (r.timeout ? 'timeout' : r.winner === null ? 'mutualWipe' : 'wipe'), score: r.score ? [r.score[0], r.score[1]] : [0, 0],
    ...(r.helpless ? { helpless: [r.helpless[0], r.helpless[1]] as [boolean, boolean] } : {}),
  });
  const dead0 = s.players[0].keepHp <= 0, dead1 = s.players[1].keepHp <= 0;
  if (dead0 || dead1 || s.round >= MAX_ROUNDS) {
    s.phase = 'over';
    s.overReason = dead0 || dead1 ? 'keep' : 'rounds';
    if (dead0 && dead1) s.winner = before[0] > before[1] ? 0 : before[1] > before[0] ? 1 : 'draw';
    else if (dead0) s.winner = 1;
    else if (dead1) s.winner = 0;
    else s.winner = s.players[0].keepHp > s.players[1].keepHp ? 0 : s.players[1].keepHp > s.players[0].keepHp ? 1 : 'draw';
    return;
  }
  for (const seat of [0, 1] as Seat[]) {
    const p = s.players[seat];
    const n = p.lord === 'skylady' ? 4 : 3;
    // Both players are offered the same items (seeded by the match and the round only).
    p.lootOffer = rollLoot(s.seed, s.round, n, () => s.nextId++);
  }
  s.phase = 'results';
}

/** Results -> next round's planning: the same income for both, the deploy limit, and the round's unlock choice. */
export function nextRound(s: MatchState): void {
  if (s.phase !== 'results') throw new Error('nextRound outside results');
  s.round++;
  s.phase = 'planning';
  for (const p of s.players) {
    resolveDraft(p);
    p.gold += income(s.round);
    let command = 0, march = 0;
    for (const sq of p.squads) { const m = modsOf(sq.items); command += m.command; march += m.march; }
    p.deployLimit = deployLimitFor(p, Math.min(2, command));
    p.deploysUsed = 0;
    p.ready = false;
    rollDraft(s, p);
    // Muster is offered instead of the round's unlock (also once nothing is left to unlock: then it costs nothing).
    p.muster = false;
    p.moveLimit = Math.min(MARCH_CAP, march);
    p.musterOffer = true;
  }
}

/** A round from `seat`'s point of view (spectators: seat 0's). */
export function roundOutcome(r: Pick<RoundSummary, 'winner'>, seat: Seat | null): RoundOutcome {
  if (r.winner === null) return 'draw';
  return r.winner === (seat ?? 0) ? 'won' : 'lost';
}

/**
 * The words for a round result, so the battle banner, results screen and history all say the same thing.
 * `title` is 'Victory' / 'Defeat' / 'Victory on points' / 'Defeat on points' / 'Draw' / 'Stalemate' (a stalemate that
 * one side lost because it could no longer harm the other is a plain 'Victory' / 'Defeat': stalemateField);
 * `detail` explains it from `seat`'s point of view. Spectators (seat null) get seat 0's wording with
 * neutral pronouns; the UI should put player names in itself.
 */
/**
 * Why a stalemate was called, from `seat`'s point of view, as a sentence without the full stop: "The enemy army could
 * no longer harm yours", "Your army could no longer harm the enemy army", "Neither army could harm the other", or
 * "Neither army had landed a blow for a while". `armies` names each seat's army ("the Covenant army"); without it the
 * enemy is "the enemy army" (spectators: "Blue's army" / "Red's army"). Old results without `helpless`: "Neither...".
 */
export function stalemateCause(r: { helpless?: [boolean, boolean] }, seat: Seat | null, armies?: [string, string]): string {
  const me = (seat ?? 0) as Seat, foe = (1 - me) as Seat;
  const h = r.helpless;
  const name = armies ?? (seat === null ? ["Blue's army", "Red's army"] : seat === 0 ? ['your army', 'the enemy army'] : ['the enemy army', 'your army']);
  const cap = (x: string): string => x.charAt(0).toUpperCase() + x.slice(1);
  if (!h || (h[0] && h[1])) return 'Neither army could harm the other';
  if (!h[0] && !h[1]) return 'Neither army had landed a blow for a while';
  const stuck = h[me] ? me : foe, other = (1 - stuck) as Seat;
  // "The Covenant army could no longer harm yours" reads better than "... harm your army"
  return `${cap(name[stuck])} could no longer harm ${seat !== null && other === me ? 'yours' : name[other]}`;
}

/**
 * A stalemate that one side lost because it could no longer harm the other (and so not a points decision): whose the
 * field is, from `seat`'s point of view ("yours" / "theirs"; spectators: "Blue's" / "Red's"). Null for every other
 * ending, including old results in which the helpless side was given the round on points.
 */
export function stalemateField(r: { winner: Seat | null; end?: BattleEnd; helpless?: [boolean, boolean] }, seat: Seat | null): string | null {
  const h = r.helpless;
  if (r.end !== 'stalemate' || !h || h[0] === h[1] || r.winner === null || h[r.winner]) return null;
  if (seat === null) return r.winner === 0 ? "Blue's" : "Red's";
  return r.winner === seat ? 'yours' : 'theirs';
}

export function roundOutcomeText(r: Pick<RoundSummary, 'winner' | 'end' | 'score' | 'helpless'>, seat: Seat | null): { outcome: RoundOutcome; title: string; detail: string } {
  const outcome = roundOutcome(r, seat);
  const me = (seat ?? 0) as Seat, foe = (1 - me) as Seat;
  const sc = r.score ?? [0, 0];
  const mine = seat === null ? "Blue's army" : 'your army', theirs = seat === null ? "Red's army" : 'the enemy';
  const pts = `${sc[me]}% of ${mine} still stands, ${sc[foe]}% of ${theirs}`;
  switch (r.end) {
    case 'mutualWipe':
      return { outcome, title: 'Draw', detail: 'Both armies fell together. Neither keep is harmed.' };
    case 'timeout':
      if (outcome === 'draw') return { outcome, title: 'Draw', detail: `Time ran out with the armies even: ${pts}.` };
      return { outcome, title: outcome === 'won' ? 'Victory on points' : 'Defeat on points', detail: `Time ran out: ${pts}.` };
    case 'stalemate': {
      // One side could no longer harm the other: it lost the field. This is not a points decision.
      const field = stalemateField(r, seat);
      if (field) return { outcome, title: outcome === 'won' ? 'Victory' : 'Defeat', detail: `${stalemateCause(r, seat)}, so the field is ${field}.` };
      if (outcome === 'draw') return { outcome, title: 'Stalemate', detail: `${stalemateCause(r, seat)}, and they stood even: ${pts}.` };
      return { outcome, title: outcome === 'won' ? 'Victory on points' : 'Defeat on points', detail: `${stalemateCause(r, seat)}, so the battle ended early: ${pts}.` };
    }
    default:
      if (outcome === 'draw') return { outcome, title: 'Draw', detail: 'The field falls silent.' };
      return {
        outcome, title: outcome === 'won' ? 'Victory' : 'Defeat',
        detail: seat === null ? `${outcome === 'won' ? "Red's" : "Blue's"} army was routed.` : outcome === 'won' ? 'The enemy army was routed.' : 'Your army was routed.',
      };
  }
}

/** The Lord's stance for the coming battle ('advance' unless he was told otherwise). */
export function lordStance(p: Pick<PlayerState, 'squads'>): LordStance {
  const st = p.squads.find((q) => q.type === 'lord')?.stance;
  if (st?.t === 'follow' && !p.squads.some((q) => q.id === st.squad && q.type !== 'lord')) return { t: 'advance' };
  return st ?? { t: 'advance' };
}

/** Mirror a squad list to the other seat (tests, bots). */
export function mirrorSquads(squads: Squad[], to: Seat): Squad[] {
  return squads.map((q) => ({ ...clone(q), owner: to, pos: mirrorPos(q.pos), facing: mirrorFacing(q.facing) }));
}
