// Oathbound v2 wire protocol: JSON messages tagged with `t`. Shared by server/index.ts and src/net/client.ts.
//
// The server is authoritative. It holds the full MatchState and never sends it: every snapshot a socket
// receives carries `view = viewFor(state, thatSocketsSeat)` (spectators: viewFor(state, null)), so the
// enemy's current-round deploys / items / gold never leave the server before the battle.
import type { Intent, PlayerView, Replay, Seat } from '../sim/types.ts';

export type RoomMode = 'pvp' | 'vsAI';
/**
 * vsAI difficulty -> bot strategy (src/sim/bot.ts). Three distinct players, all limited to viewFor() information:
 *  - easy: under-spends (~65% of its gold), rarely levels up, random drafts/loot/equips, no counter-picking, naive row;
 *  - normal: counter-picks the enemy's last army, sensible spending (~15% reserve), basic equipping, fixed lanes;
 *  - hard (default): full spend, counter-placement of the whole army against the enemy's last formation,
 *    item-aware gearing, slot-aware level-ups and counter drafts.
 * A disconnected human's seat is played by 'hard'.
 */
export type AiLevel = 'easy' | 'normal' | 'hard';
export const AI_STRATEGY = { easy: 'easy', normal: 'normal', hard: 'hard' } as const;
/** The strategy that plays a human seat after the disconnect grace period. */
export const TAKEOVER_STRATEGY = 'hard' as const;

/**
 * The room's phase. `lobby` = no match yet (seats can be swapped, host starts). `battle` is a server-only
 * phase (the sim's MatchState stays in 'planning' while the replay plays; `view.phase` is then 'planning').
 */
export type RoomPhase = 'lobby' | 'lordPick' | 'planning' | 'battle' | 'results' | 'over';

export interface SeatInfo {
  name: string;
  /** A human's socket is open (bots: always true). */
  connected: boolean;
  /** The vsAI opponent. */
  isBot: boolean;
  isHost: boolean;
  /** A human seat whose player has been gone longer than the grace period: the bot is playing it until they rejoin. */
  botControlled: boolean;
  /** Epoch ms when a disconnected human's grace period ends and the bot takes over (0 = not pending). */
  graceEndsAt: number;
  /** Has asked for a rematch (phase 'over'). Bots always have. */
  rematch: boolean;
}

export interface SpectatorInfo { id: number; name: string; connected: boolean }

export interface RoomView {
  /** 4 chars from ABCDEFGHJKLMNPQRSTUVWXYZ23456789. */
  code: string;
  mode: RoomMode;
  aiLevel: AiLevel;
  phase: RoomPhase;
  /** Epoch ms (server clock) when the current phase times out; 0 = no timer (lobby, over). */
  phaseEndsAt: number;
  /** Server clock at send time, so clients can correct for skew: remaining = phaseEndsAt - serverNow. */
  serverNow: number;
  /** [seat 0, seat 1]; null = empty (pvp lobby waiting for an opponent). */
  seats: [SeatInfo | null, SeatInfo | null];
  spectators: SpectatorInfo[];
  /** Who this snapshot is for. seat null = spectator. */
  me: { seat: Seat | null; spectator: boolean; isHost: boolean };
  /** The hidden-info filtered match view for `me`; null in the lobby. */
  view: PlayerView | null;
  /**
   * Set in phase 'over': why the match ended. reason 'keep' = a Keep fell, 'rounds' = the round limit,
   * 'concede' = seat `by` gave up (or left the match); `by` is null unless reason is 'concede'.
   */
  over?: { reason: 'keep' | 'rounds' | 'concede'; by: Seat | null };
}

export type ClientMsg =
  | { t: 'create'; name: string; mode: RoomMode; aiLevel?: AiLevel }
  /** token = rejoin my seat (or spectator slot). spectate = join as a spectator even if a seat is free. */
  | { t: 'join'; code: string; name: string; token?: string; spectate?: boolean }
  /** Host only, lobby only. pvp needs both seats filled. */
  | { t: 'start' }
  /** Host only, lobby only: swap seat 0 and seat 1 (either may be empty or the bot). */
  | { t: 'swapSeats' }
  /** Players only. lordPick phase: {t:'pickLord'}; planning phase: everything else (incl. ready/unready). */
  | { t: 'intent'; intent: Intent }
  /** I finished watching (or skipped) the battle playback. */
  | { t: 'battleDone' }
  /** Players only, phase 'over': vote for a rematch; when every human player has, a new match starts with the same seats. */
  | { t: 'rematch' }
  | { t: 'chat'; text: string }
  /**
   * Give up my seat. Lobby: the seat is freed. In a running match this is a concession: the match ends at once
   * and the opponent wins (same as 'concede'). After the match (phase 'over') the bot takes the seat for a rematch.
   * A lost connection is NOT a concession: the AI takes over after the grace period until the player returns.
   */
  | { t: 'leave' }
  /**
   * Players only, in a running match (lordPick / planning / battle / results): give up. The room goes to phase
   * 'over' with the opponent as the winner; RoomView.over = { reason: 'concede', by: <my seat> } and
   * view.overReason = 'concede'. The conceding player stays in the room (and may ask for a rematch).
   */
  | { t: 'concede' }
  | { t: 'ping' };

export type ServerMsg =
  /** You are in a room. seat null = spectator. Keep `token` to rejoin. Re-sent when seats are swapped. */
  | { t: 'welcome'; code: string; seat: Seat | null; spectator: boolean; token: string }
  /** Full snapshot after every change (filtered per socket). */
  | { t: 'room'; room: RoomView }
  /**
   * The battle replay, once per battle (again on join/rejoin mid-battle). startedAt = server epoch ms when
   * playback began; offsetMs = how far into the playback the server already was when it sent this (0 when
   * the battle starts) — seek to it.
   */
  | { t: 'battle'; replay: Replay; startedAt: number; offsetMs: number }
  /** An intent or command that was refused. */
  | { t: 'rejected'; error: string }
  /** seat null + system true = a server notice ("Bob disconnected: the AI takes over in 60 s"). */
  | { t: 'chat'; seat: Seat | null; name: string; text: string; system: boolean }
  /** Fatal for this join attempt (bad code, room full) or a server-side failure. */
  | { t: 'error'; error: string }
  | { t: 'pong' };

export const SEAT_COLORS = ['#4fa3ff', '#e0464f'] as const;
export const MAX_SPECTATORS = 6;

// Default timings (ms). The server owns the timers (env-overridable); clients only display phaseEndsAt.
export const LORD_PICK_MS = 30_000;
export const PLANNING_MS = 120_000;
/** Added to planning when a loot pick is pending. */
export const LOOT_BONUS_MS = 15_000;
/** The battle phase ends when every player sent battleDone, or after the replay's duration + this. */
export const BATTLE_SLACK_MS = 10_000;
export const RESULTS_MS = 6_000;
/** A disconnected player's seat is played by the bot after this long (until they rejoin). */
export const DISCONNECT_GRACE_MS = 60_000;
