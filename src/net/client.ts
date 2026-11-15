/**
 * Oathbound v2 net client — the browser's end of the socket.
 *
 * ============================ API (stable; the UI codes against this) ============================
 *
 *   import { Net, socketURL, type NetHandlers, type NetStatus } from './net/client.ts';
 *   import type { RoomView, RoomMode, AiLevel, RoomPhase, SeatInfo } from './net/protocol.ts';
 *
 *   const net = new Net({
 *     onRoom(room: RoomView, mySeat: Seat | null) {},  // every change; room.view = MY filtered PlayerView (null in lobby)
 *     onBattle(replay: Replay, offsetMs: number) {},   // once per battle; start playback at offsetMs (0, or >0 when
 *                                                      //   joining/rejoining mid-battle). Call net.battleDone() at the end.
 *                                                      //   clock = the shared playback timeline (speed, requests).
 *     onSpeed(clock: BattleClock) {},                  // the shared playback speed or a player's request changed
 *     onRejected(error: string) {},                    // an intent/command was refused (toast it)
 *     onChat(seat: Seat | null, name: string, text: string, system: boolean) {},
 *                                                      //   system = server notice, e.g. "Bob disconnected: the AI takes over in 60 s"
 *     onError(error: string) {},                       // join failed (bad code / full) or "seat opened in another tab"
 *     onStatus(s: NetStatus) {},                       // 'connecting' | 'open' | 'closed'
 *   });
 *
 *   net.create(name, mode: 'pvp' | 'vsAI', aiLevel?: 'easy' | 'normal' | 'hard')   // you become host, seat 0
 *   net.join(code, name, spectate = false)   // takes the empty player seat, else becomes a spectator (max 6)
 *   net.resume(): boolean                    // rejoin the seat saved in sessionStorage (after reload); false if none
 *   Net.savedSeat(): {code, name, token} | null
 *   net.start()                              // host, lobby: start the match (pvp needs 2 players) -> phase 'lordPick'
 *   net.swapSeats()                          // host, lobby: swap seat 0 <-> seat 1
 *   net.intent(i: Intent)                    // players: {t:'pickLord'} in lordPick; deploy/move/.../ready in planning
 *   net.battleDone()                         // playback finished or skipped
 *   net.speed(s: 1 | 2 | 4 | 'skip')         // players, battle: request a playback speed (both players must agree)
 *   net.rematch()                            // phase 'over': vote for a rematch (same seats)
 *   net.chat(text)
 *   net.leave()                              // give up the seat and close
 *   net.code: string | null;  net.seat: Seat | null;  net.spectator: boolean   (set on welcome)
 *   socketURL(): string                      // ws(s)://<page dir>/ws, from location.href
 *
 *   Phases (room.phase): lobby -> lordPick (30 s) -> planning (60 s, +15 s with a loot pick; ends early when both
 *   ready) -> battle (replay; ends when both players sent battleDone or duration + 10 s) -> results (6 s) ->
 *   planning ... -> over (rematch). Timer: show room.phaseEndsAt - room.serverNow (+ local elapsed since receipt).
 *   During 'battle', room.view.phase is still 'planning' (the sim has no battle phase) — use room.phase.
 *   Seats: room.seats[0|1] = SeatInfo {name, connected, isBot, isHost, botControlled, graceEndsAt, rematch} | null.
 *   A dropped connection auto-reconnects with backoff and rejoins with the token; the server keeps the seat
 *   (after 60 s away the AI plays it, until you're back).
 * ==================================================================================================
 */

import type { Intent, Replay, Seat } from '../sim/types.ts';
import type { AiLevel, BattleClock, BattleSpeed, ClientMsg, RoomMode, RoomView, ServerMsg } from './protocol.ts';

export type NetStatus = 'connecting' | 'open' | 'closed';

export interface NetHandlers {
  onRoom(room: RoomView, mySeat: Seat | null): void;
  onBattle(replay: Replay, offsetMs: number, clock?: BattleClock): void;
  onSpeed(clock: BattleClock): void;
  onRejected(error: string): void;
  onChat(seat: Seat | null, name: string, text: string, system: boolean): void;
  onError(error: string): void;
  onStatus(s: NetStatus): void;
}

/** The socket sits next to the page (games.noblehaus.uk/oathbound/ws), never at the site root. */
export function socketURL(): string {
  const u = new URL('ws', location.href);
  u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  u.search = '';
  u.hash = '';
  return u.toString();
}

const SEAT_KEY = 'oathbound.v2.seat';

export interface SavedSeat { code: string; name: string; token: string }

function loadSeat(): SavedSeat | null {
  try {
    const raw = sessionStorage.getItem(SEAT_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && typeof s.code === 'string' && typeof s.name === 'string' && typeof s.token === 'string' && s.token ? s : null;
  } catch {
    return null;
  }
}

function storeSeat(seat: SavedSeat | null): void {
  try {
    if (seat) sessionStorage.setItem(SEAT_KEY, JSON.stringify(seat));
    else sessionStorage.removeItem(SEAT_KEY);
  } catch {
    /* storage unavailable: the seat just won't survive a reload */
  }
}

export class Net {
  code: string | null = null;
  seat: Seat | null = null;
  spectator = false;
  private handlers: NetHandlers;
  private ws: WebSocket | null = null;
  private saved: SavedSeat | null = null;
  /** What to send once the socket opens when there's no seat yet (create / join). */
  private pending: ClientMsg | null = null;
  private retry = 0;
  private wanted = false;
  private welcomed = false;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private heard = 0;

  constructor(handlers: NetHandlers) {
    this.handlers = handlers;
  }

  static savedSeat(): SavedSeat | null {
    return loadSeat();
  }

  /** Rejoin the saved seat, if any. */
  resume(): boolean {
    const seat = loadSeat();
    if (!seat) return false;
    this.saved = seat;
    this.code = seat.code;
    this.pending = null;
    this.connect();
    return true;
  }

  create(name: string, mode: RoomMode, aiLevel?: AiLevel): void {
    this.forget();
    this.pending = aiLevel ? { t: 'create', name, mode, aiLevel } : { t: 'create', name, mode };
    this.saved = { code: '', name, token: '' };
    this.connect();
  }

  join(code: string, name: string, spectate = false): void {
    this.forget();
    code = code.trim().toUpperCase();
    this.pending = spectate ? { t: 'join', code, name, spectate: true } : { t: 'join', code, name };
    this.saved = { code, name, token: '' };
    this.connect();
  }

  start(): void { this.send({ t: 'start' }); }
  swapSeats(): void { this.send({ t: 'swapSeats' }); }
  intent(i: Intent): void { this.send({ t: 'intent', intent: i }); }
  battleDone(): void { this.send({ t: 'battleDone' }); }
  speed(s: BattleSpeed): void { this.send({ t: 'speed', speed: s }); }
  rematch(): void { this.send({ t: 'rematch' }); }
  chat(text: string): void { this.send({ t: 'chat', text }); }

  /** Forget the seat and close. */
  leave(): void {
    this.send({ t: 'leave' });
    this.forget();
    this.wanted = false;
    this.teardown();
    this.handlers.onStatus('closed');
  }

  private forget(): void {
    this.saved = null;
    this.pending = null;
    this.code = null;
    this.seat = null;
    this.spectator = false;
    this.welcomed = false;
    storeSeat(null);
  }

  private connect(): void {
    this.wanted = true;
    this.retry = 0;
    this.teardown();
    this.open();
  }

  private teardown(): void {
    if (this.pinger) clearInterval(this.pinger);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.pinger = this.reconnect = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
  }

  private open(): void {
    this.handlers.onStatus('connecting');
    this.welcomed = false;
    let ws: WebSocket;
    try {
      // browsers offer permessage-deflate by themselves; the server accepts it (replays compress ~5-10x)
      ws = new WebSocket(socketURL());
    } catch {
      return this.lost();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.heard = Date.now();
      this.handlers.onStatus('open');
      const seat = this.saved;
      if (seat && seat.token) ws.send(JSON.stringify({ t: 'join', code: seat.code, name: seat.name, token: seat.token } satisfies ClientMsg));
      else if (this.pending) ws.send(JSON.stringify(this.pending));
      // Ping every 10 s; the server answers. A phone that moved networks can keep a dead socket
      // that never reports closing: after 25 s of silence give up on it and connect afresh.
      this.pinger = setInterval(() => {
        if (Date.now() - this.heard > 25_000) {
          this.teardown();
          return this.lost();
        }
        this.send({ t: 'ping' });
      }, 10_000);
    };
    ws.onmessage = (e) => {
      this.heard = Date.now();
      let m: ServerMsg;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      this.onMessage(m);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      if (this.pinger) clearInterval(this.pinger);
      this.pinger = null;
      this.ws = null;
      if (e.code === 4000) {
        // this seat was opened in another tab, which now has it: don't fight for it
        this.wanted = false;
        this.handlers.onError('This seat was opened in another tab');
        return this.handlers.onStatus('closed');
      }
      this.lost();
    };
  }

  private lost(): void {
    if (!this.wanted) return this.handlers.onStatus('closed');
    this.handlers.onStatus('connecting');
    const wait = Math.min(8000, 500 * 2 ** this.retry++);
    this.reconnect = setTimeout(() => this.wanted && this.open(), wait);
  }

  private onMessage(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome':
        this.welcomed = true;
        this.pending = null;
        this.code = m.code;
        this.seat = m.seat;
        this.spectator = m.spectator;
        this.saved = { code: m.code, name: this.saved?.name ?? 'Player', token: m.token };
        storeSeat(this.saved);
        return;
      case 'room':
        this.seat = m.room.me.seat;
        this.spectator = m.room.me.spectator;
        return this.handlers.onRoom(m.room, this.seat);
      case 'battle':
        return this.handlers.onBattle(m.replay, m.offsetMs, m.clock);
      case 'speed':
        return this.handlers.onSpeed(m.clock);
      case 'rejected':
        return this.handlers.onRejected(m.error);
      case 'chat':
        return this.handlers.onChat(m.seat, m.name, m.text, m.system);
      case 'error':
        // a failed join (bad code, room full) means this seat is no good: forget it
        if (!this.welcomed) {
          this.forget();
          this.wanted = false;
          this.teardown();
          this.handlers.onError(m.error);
          return this.handlers.onStatus('closed');
        }
        return this.handlers.onError(m.error);
      case 'pong':
        return;
    }
  }

  private send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}
