// Relocation and Muster on the planning screen (DESIGN §2): which of my squads may move, what a locked squad says
// about itself, and the guards the formation tools (drag, group, Mirror, Sync, Undo) go through so that nothing is
// shown or sent that the server would refuse. Pure functions over the sim's own rule (src/sim/match.ts).
import type { PlayerState, Squad, Vec2 } from '../sim/types.ts';
import { MUSTER_MOVES, squadHome, squadLocked } from '../sim/match.ts';
import type { Placed } from './timing.ts';

/** What the relocation rule needs of me: the squads as shown (pending moves applied), last battle's army, the Muster. */
export type RelocMe = Pick<PlayerState, 'lastArmy' | 'moveLimit' | 'muster'> & { squads: readonly Squad[] };

/** free: the Lord or a squad deployed this round. locked: stands where it fought. relocated: a locked squad moved this round. */
export type LockState = 'free' | 'locked' | 'relocated';

const away = (me: RelocMe, sq: Pick<Squad, 'id' | 'pos'>): boolean => {
  const h = squadHome(me, sq.id);
  return !!h && (h[0] !== sq.pos[0] || h[1] !== sq.pos[1]);
};

export function lockState(me: RelocMe, sq: Squad, round: number): LockState {
  if (!squadLocked(sq, round)) return 'free';
  return away(me, sq) ? 'relocated' : 'locked';
}

/** Relocations used and left this round, counted on the squads as shown. */
export function relocCount(me: RelocMe, round: number): { used: number; limit: number; left: number } {
  let used = 0;
  for (const q of me.squads) if (squadLocked(q, round) && away(me, q)) used++;
  const limit = me.moveLimit ?? 0;
  return { used, limit, left: Math.max(0, limit - used) };
}

/** The lock line of a squad (tooltips, the panel, refusals). */
export function lockedText(sq: Pick<Squad, 'deployedRound'>): string {
  return `Locked in place since round ${sq.deployedRound}. Turn it freely; take Muster instead of a unit unlock to relocate up to ${MUSTER_MOVES} squads.`;
}
export function usedUpText(limit: number): string {
  return `All ${limit} relocations used: move one back to free a move`;
}

/** Why this squad may not be dragged to a new spot now, or null (turning on the spot is always allowed). */
export function dragRefusal(me: RelocMe, id: number, round: number): string | null {
  const sq = me.squads.find((q) => q.id === id);
  if (!sq) return null;
  const st = lockState(me, sq, round);
  if (st !== 'locked') return null;
  const c = relocCount(me, round);
  if (c.left > 0) return null;
  return c.limit > 0 ? usedUpText(c.limit) : lockedText(sq);
}

/**
 * Squads of `ids` that must stay where they stand when the group is moved or turned about its centre: the locked ones
 * that are still at home, unless all of them fit in the relocations left (then the whole group moves).
 */
export function pinnedIn(me: RelocMe, ids: Iterable<number>, round: number): Set<number> {
  const home = [...ids].filter((id) => {
    const sq = me.squads.find((q) => q.id === id);
    return !!sq && lockState(me, sq, round) === 'locked';
  });
  return home.length > relocCount(me, round).left ? new Set(home) : new Set();
}

/** What Mirror moves: the Lord, this round's squads and the ones already relocated (locked squads stay). */
export function mirrorable(me: RelocMe, round: number): Squad[] {
  return me.squads.filter((q) => lockState(me, q, round) !== 'locked');
}

/**
 * Would taking my squads to `targets` leave a state the server refuses? Returns the reason, or null. The final count
 * of relocated squads must fit in this round's relocations (a squad sent home frees one).
 */
export function targetsRefusal(me: RelocMe, targets: Map<number, Placed>, round: number): string | null {
  const after = me.squads.map((q) => {
    const t = targets.get(q.id);
    return t ? { ...q, pos: [t.pos[0], t.pos[1]] as Vec2 } : q;
  });
  const next = { ...me, squads: after };
  const c = relocCount(next, round);
  if (c.used <= c.limit) return null;
  // a squad that moves only because it is pulled along is the one to name
  const moved = after.find((q) => targets.has(q.id) && lockState(next, q, round) === 'relocated' && lockState(me, me.squads.find((o) => o.id === q.id)!, round) === 'locked');
  return c.limit > 0 ? usedUpText(c.limit) : lockedText(moved ?? { deployedRound: round - 1 });
}

/**
 * Relocation-aware ordering for planMoves: may squad `id`, standing at `from`, go to `to` now, given the squads as they
 * stand at this step? (The server checks each move as it arrives.)
 */
export function moveAllowed(me: RelocMe, id: number, to: Vec2, round: number): boolean {
  const sq = me.squads.find((q) => q.id === id);
  if (!sq || !squadLocked(sq, round)) return true;
  if (sq.pos[0] === to[0] && sq.pos[1] === to[1]) return true;
  const h = squadHome(me, id);
  if (h && h[0] === to[0] && h[1] === to[1]) return true;
  if (away(me, sq)) return true;
  return relocCount(me, round).left > 0;
}

/** Does this move send a relocated squad home (it frees a relocation)? planMoves sends those first. */
export function goesHome(me: RelocMe, id: number, to: Vec2, round: number): boolean {
  const sq = me.squads.find((q) => q.id === id);
  if (!sq || !squadLocked(sq, round) || !away(me, sq)) return false;
  const h = squadHome(me, id);
  return !!h && h[0] === to[0] && h[1] === to[1];
}

/**
 * Where this round's relocations come from: Muster (MUSTER_MOVES) and relics "of the March" (one each, worn when the
 * round began). Words for the HUD, e.g. "Muster + of the March".
 */
export function relocSource(me: Pick<PlayerState, 'moveLimit' | 'muster'>): string {
  const limit = me.moveLimit ?? 0;
  const march = Math.max(0, limit - (me.muster ? MUSTER_MOVES : 0));
  return [me.muster ? 'Muster' : '', march ? 'of the March' : ''].filter(Boolean).join(' + ');
}

/** The enemy intel mark of a ghost: moved since the battle before, or new last round. */
export function ghostMark(sq: Pick<Squad, 'id' | 'type' | 'deployedRound'>, lastMoved: readonly number[] | undefined, round: number): 'moved' | 'new' | null {
  // the Lord moves freely every round, and in round 2 the whole army is new: neither is news
  if (sq.type === 'lord') return null;
  if (sq.deployedRound === round - 1) return round >= 3 ? 'new' : null;
  if (lastMoved?.includes(sq.id)) return 'moved';
  return null;
}
export const GHOST_MARK_TEXT = { moved: 'Moved since the round before', new: 'New last round' } as const;
