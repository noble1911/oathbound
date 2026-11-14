// Match rules (DESIGN §1, §2, §4, §5): lords, economy, unlock drafts, deployment limits, level-ups, loot and items,
// intent validation, the hidden-information view, and applying battle results.
import { FIELD_H, FIELD_W, mirrorPos, mirrorFacing } from './constants.ts';
import { SLOT_UNLOCK_LEVEL } from './data/items.ts';
import { LORDS, LORD_IDS } from './data/lords.ts';
import { BASIC_POOL, UNITS, UNIT_TYPES } from './data/units.ts';
import { modsOf, rollLoot } from './loot.ts';
import { Rng, hash } from './rng.ts';
import { genTerrain } from './terrain.ts';
import type {
  BattleResult, Comeback, EnemyView, Intent, IntentResult, Item, LordId, MatchState, PlayerState, PlayerView, RoundOutcome, RoundSummary, Seat, Slot,
  Squad, SquadType, UnitType, Vec2,
} from './types.ts';

export const START_GOLD = 300;
export const KEEP_HP = 4000;
export const WARDEN_KEEP_BONUS = 800;
export const ARMY_CAP = 16;
export const BASE_DEPLOY_LIMIT = 2;
export const MAX_SQUAD_LEVEL = 5;
export const MAX_LORD_LEVEL = 10;
/** Catch-up gold for losing a round: CATCHUP_GOLD + CATCHUP_PER_ROUND x round + CATCHUP_PER_DEFICIT x keep-HP deficit (points). */
export const CATCHUP_GOLD = 75;
export const CATCHUP_PER_ROUND = 10;
export const CATCHUP_PER_DEFICIT = 3;
/** Keep-HP deficit (percentage points) at which the trailing player gets +1 squad deployment next round. */
export const UNDERDOG_DEFICIT = 25;
/** Cumulative XP needed for Lord levels 1..10. */
export const LORD_XP_LEVELS = [0, 30, 75, 135, 210, 300, 410, 540, 690, 860];
/** Safety valve: after this round the higher keep wins. */
export const MAX_ROUNDS = 30;
/** Keep damage per cost tier (cost / 100) of a surviving Lv1 squad; see squadKeepDamage. */
export const KEEP_DMG_PER_TIER = 22;
export const KEEP_DMG_BASE_PER_ROUND = 70;
export const LORD_KEEP_DMG = 30;

/** Income at the start of `round` (round 1 is the 300 starting gold). */
export function income(round: number): number {
  return round <= 1 ? START_GOLD : Math.min(500, 200 + 25 * round);
}
export function levelUpCost(type: UnitType, level: number): number {
  return UNITS[type].cost * level;
}
export function sellRefund(sq: Squad, round: number): number {
  return sq.deployedRound === round ? Math.floor(sq.spent / 2) : 0;
}
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
/** Total keep damage dealt by `seat`'s survivors (DESIGN §1). `won` adds 70 x round (DESIGN: 50, see BALANCE.md); timeout halves it. */
export function keepDamageOf(squads: Squad[], survivorIds: number[], round: number, won: boolean, timeout: boolean): number {
  let d = 0;
  for (const sq of squads) if (survivorIds.includes(sq.id)) d += squadKeepDamage(sq);
  if (timeout) return Math.trunc(d / 2);
  return won ? d + KEEP_DMG_BASE_PER_ROUND * round : 0;
}

/** Keep HP as an integer percentage of its maximum. */
export function keepPct(p: { keepHp: number; keepMax: number }): number {
  return Math.trunc((p.keepHp * 100) / Math.max(1, p.keepMax));
}

/**
 * The comeback bonus for `me` after a round (paid at the start of the next one). Symmetric in the seats:
 *  - lost the round: CATCHUP_GOLD + CATCHUP_PER_ROUND x round + CATCHUP_PER_DEFICIT x (keep-HP deficit in points);
 *  - keep-HP deficit >= UNDERDOG_DEFICIT points: +1 squad deployment, won or lost.
 */
export function comebackFor(me: PlayerState, enemy: PlayerState, round: number, lost: boolean): Comeback {
  const deficit = Math.max(0, keepPct(enemy) - keepPct(me));
  const gold = lost ? CATCHUP_GOLD + CATCHUP_PER_ROUND * round + CATCHUP_PER_DEFICIT * deficit : 0;
  return { gold, deploys: deficit >= UNDERDOG_DEFICIT ? 1 : 0, deficit };
}

function newPlayer(seat: Seat): PlayerState {
  return {
    seat, lord: null, gold: 0, keepHp: KEEP_HP, keepMax: KEEP_HP, unlocked: [], draftOptions: [], draftPicks: 0, lootOffer: null,
    squads: [], stash: [], deploysUsed: 0, deployLimit: BASE_DEPLOY_LIMIT, lordXp: 0, ready: false, lostLast: false, lastArmy: null,
    comeback: { gold: 0, deploys: 0, deficit: 0 },
  };
}

// ---------------------------------------------------------------- deploy footprints

/**
 * Ground radius (cm) a squad's formation covers: the half-extent of its soldier grid plus a body radius.
 * Two squads of one player may not overlap: centres must be at least footprint(a) + footprint(b) apart.
 * Mirrors the formation in battle.ts (cols by squad size, spacing = 2 x radius + 50).
 */
export function squadFootprint(type: SquadType): number {
  const n = type === 'lord' ? 1 : UNITS[type].squadSize;
  const radius = type === 'lord' ? 65 : UNITS[type].radius;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
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
  for (let ring = 0; ring <= 40; ring++) {
    if (ring === 0) { const h = tryAt(cx, cy); if (h) return h; continue; }
    // Walk the ring nearest-first: offsets sorted by |dx| + |dy|.
    for (let k = 0; k <= ring; k++) {
      for (const [dx, dy] of [[k, ring], [-k, ring], [k, -ring], [-k, -ring], [ring, k], [-ring, k], [ring, -k], [-ring, -k]]) {
        const h = tryAt(cx + dx * 100, cy + dy * 100);
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
  if (lord === 'warden') { p.keepMax = KEEP_HP + WARDEN_KEEP_BONUS; p.keepHp = p.keepMax; }
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
    const pool = BASIC_POOL.filter((u) => !p.unlocked.includes(u));
    const rng = new Rng(hash(s.seed, 'draft', 1, p.seat));
    p.draftOptions = rng.shuffle([...pool]).slice(0, 3);
    p.draftPicks = 2;
    p.deploysUsed = 0;
    p.deployLimit = deployLimitFor(p, 0);
  }
}

function deployLimitFor(p: PlayerState, commandBonus: number): number {
  return BASE_DEPLOY_LIMIT + (p.lord === 'marshal' ? 1 : 0) + commandBonus;
}

function rollDraft(s: MatchState, p: PlayerState): void {
  const locked = UNIT_TYPES.filter((u) => !p.unlocked.includes(u) && UNITS[u].minRound <= s.round);
  const rng = new Rng(hash(s.seed, 'draft', s.round, p.seat));
  p.draftOptions = rng.shuffle([...locked]).slice(0, 2);
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
 * empty slots than stash items already waiting for them. Loot offers are biased toward these.
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

const validFacing = (f: unknown): boolean => f === undefined || (Number.isInteger(f) && (f as number) >= 0 && (f as number) <= 255);

/** Validate and apply one intent for `seat`. Mutates `s` only when the result is ok. */
export function applyIntent(s: MatchState, seat: Seat, intent: Intent): IntentResult {
  if (seat !== 0 && seat !== 1) return err('bad seat');
  if (!intent || typeof intent !== 'object') return err('bad intent');
  const p = s.players[seat];
  if (s.phase === 'over') return err('match is over');
  if (intent.t === 'pickLord') {
    if (s.phase !== 'lordPick') return err('not picking lords');
    if (!LORD_IDS.includes(intent.lord)) return err('unknown lord');
    if (p.lord) return err('lord already picked');
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
      return OK;
    }
    case 'deploy': {
      const def = UNITS[intent.unit];
      if (!def) return err('unknown unit');
      if (!p.unlocked.includes(intent.unit)) return err('unit not unlocked');
      if (!Array.isArray(intent.pos) || !inDeployZone(seat, intent.pos)) return err('outside deploy zone');
      if (!validFacing(intent.facing)) return err('bad facing');
      if (p.deploysUsed >= p.deployLimit) return err('deployment limit reached');
      if (p.squads.filter((q) => q.type !== 'lord').length >= ARMY_CAP) return err('army cap reached');
      if (p.gold < def.cost) return err('not enough gold');
      if (overlappingSquad(p.squads, intent.unit, intent.pos)) return err('overlaps another squad: each squad needs its own ground');
      p.gold -= def.cost;
      p.deploysUsed++;
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
      if (overlappingSquad(p.squads, sq.type, intent.pos, sq.id)) return err('overlaps another squad: each squad needs its own ground');
      sq.pos = [intent.pos[0], intent.pos[1]];
      if (intent.facing !== undefined) sq.facing = intent.facing;
      return OK;
    }
    case 'sell': {
      const i = p.squads.findIndex((q) => q.id === intent.squad);
      if (i < 0) return err('no such squad');
      const sq = p.squads[i];
      if (sq.type === 'lord') return err('cannot sell the Lord');
      p.gold += sellRefund(sq, s.round);
      if (sq.deployedRound === s.round) p.deploysUsed = Math.max(0, p.deploysUsed - 1);
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
      const prev = sq.items[slot];
      // Remove from source.
      if (found.squad) found.squad.items[slot] = null;
      else p.stash.splice(p.stash.indexOf(found.item), 1);
      sq.items[slot] = found.item;
      // Whatever was there goes back where the item came from.
      if (prev) {
        if (found.squad && slotOpen(found.squad, slot)) found.squad.items[slot] = prev;
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
    lord: s.phase === 'lordPick' ? null : e.lord,
    keepHp: e.keepHp,
    keepMax: e.keepMax,
    ready: e.ready,
    lastArmy: e.lastArmy ? clone(e.lastArmy) : null,
  };
}

/** Hidden-information view for one seat (null = spectator). Never contains the enemy's current squads, gold, stash or offers. */
export function viewFor(s: MatchState, seat: Seat | null): PlayerView {
  const base = { seed: s.seed, round: s.round, phase: s.phase, terrain: clone(s.terrain), winner: s.winner, history: clone(s.history) };
  if (seat === null) {
    const enemies: [EnemyView, EnemyView] = [enemyView(s, 0), enemyView(s, 1)];
    return { ...base, seat: null, you: null, enemy: enemies[1], enemies };
  }
  return { ...base, seat, you: clone(s.players[seat]), enemy: enemyView(s, (1 - seat) as Seat) };
}

/** Apply a battle result: keep damage, catch-up flags, Lord XP, last-army snapshots, loot offers. Phase -> 'results' | 'over'. */
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
    p.lastArmy = clone(p.squads);
    p.ready = false;
    // A loot offer that was never picked goes to the stash (first option).
    if (p.lootOffer) { p.stash.push(p.lootOffer[0]); p.lootOffer = null; }
  }
  for (const seat of [0, 1] as Seat[]) s.players[seat].comeback = comebackFor(s.players[seat], s.players[1 - seat], s.round, s.players[seat].lostLast);
  s.history.push({
    round: s.round, winner: r.winner, keepDamage: [r.keepDamage[0], r.keepDamage[1]],
    survivors: [r.survivors[0].length, r.survivors[1].length], ticks: r.ticks,
    end: r.end ?? (r.timeout ? 'timeout' : r.winner === null ? 'mutualWipe' : 'wipe'), score: r.score ? [r.score[0], r.score[1]] : [0, 0],
  });
  const dead0 = s.players[0].keepHp <= 0, dead1 = s.players[1].keepHp <= 0;
  if (dead0 || dead1 || s.round >= MAX_ROUNDS) {
    s.phase = 'over';
    if (dead0 && dead1) s.winner = before[0] > before[1] ? 0 : before[1] > before[0] ? 1 : 'draw';
    else if (dead0) s.winner = 1;
    else if (dead1) s.winner = 0;
    else s.winner = s.players[0].keepHp > s.players[1].keepHp ? 0 : s.players[1].keepHp > s.players[0].keepHp ? 1 : 'draw';
    return;
  }
  for (const seat of [0, 1] as Seat[]) {
    const p = s.players[seat];
    const n = p.lord === 'skylady' ? 4 : 3;
    p.lootOffer = rollLoot(s.seed, s.round, seat, p.lostLast, n, () => s.nextId++, usableSlots(p));
  }
  s.phase = 'results';
}

/** Results -> next round's planning: income plus the comeback bonus (gold, deploys), deploy limit, a new unlock draft. */
export function nextRound(s: MatchState): void {
  if (s.phase !== 'results') throw new Error('nextRound outside results');
  s.round++;
  s.phase = 'planning';
  for (const p of s.players) {
    resolveDraft(p);
    p.gold += income(s.round) + p.comeback.gold;
    let command = 0;
    for (const sq of p.squads) command += modsOf(sq.items).command;
    p.deployLimit = deployLimitFor(p, Math.min(2, command)) + p.comeback.deploys;
    p.deploysUsed = 0;
    p.ready = false;
    rollDraft(s, p);
  }
}

/** A round from `seat`'s point of view (spectators: seat 0's). */
export function roundOutcome(r: Pick<RoundSummary, 'winner'>, seat: Seat | null): RoundOutcome {
  if (r.winner === null) return 'draw';
  return r.winner === (seat ?? 0) ? 'won' : 'lost';
}

/**
 * The words for a round result, so the battle banner, results screen and history all say the same thing.
 * `title` is 'Victory' / 'Defeat' / 'Victory on points' / 'Defeat on points' / 'Draw' / 'Stalemate';
 * `detail` explains it from `seat`'s point of view. Spectators (seat null) get seat 0's wording with
 * neutral pronouns; the UI should put player names in itself.
 */
export function roundOutcomeText(r: Pick<RoundSummary, 'winner' | 'end' | 'score'>, seat: Seat | null): { outcome: RoundOutcome; title: string; detail: string } {
  const outcome = roundOutcome(r, seat);
  const me = (seat ?? 0) as Seat, foe = (1 - me) as Seat;
  const sc = r.score ?? [0, 0];
  const mine = seat === null ? "Blue's army" : 'your army', theirs = seat === null ? "Red's army" : 'the enemy';
  const pts = `${sc[me]}% of ${mine} still stands, ${sc[foe]}% of ${theirs}`;
  switch (r.end) {
    case 'mutualWipe':
      return { outcome, title: 'Draw', detail: 'Both armies fell together. Neither side earns catch-up gold.' };
    case 'timeout':
      if (outcome === 'draw') return { outcome, title: 'Draw', detail: `Time ran out with the armies even: ${pts}.` };
      return { outcome, title: outcome === 'won' ? 'Victory on points' : 'Defeat on points', detail: `Time ran out: ${pts}.` };
    case 'stalemate':
      if (outcome === 'draw') return { outcome, title: 'Stalemate', detail: `Neither army could harm the other, and they stood even: ${pts}.` };
      return { outcome, title: outcome === 'won' ? 'Victory on points' : 'Defeat on points', detail: `Neither army could harm the other, so the battle ended early: ${pts}.` };
    default:
      if (outcome === 'draw') return { outcome, title: 'Draw', detail: 'The field falls silent.' };
      return {
        outcome, title: outcome === 'won' ? 'Victory' : 'Defeat',
        detail: seat === null ? `${outcome === 'won' ? "Red's" : "Blue's"} army was routed.` : outcome === 'won' ? 'The enemy army was routed.' : 'Your army was routed.',
      };
  }
}

/** Mirror a squad list to the other seat (tests, bots). */
export function mirrorSquads(squads: Squad[], to: Seat): Squad[] {
  return squads.map((q) => ({ ...clone(q), owner: to, pos: mirrorPos(q.pos), facing: mirrorFacing(q.facing) }));
}
