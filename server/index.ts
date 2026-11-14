// Oathbound v2 server: serves the built game (dist/) and runs 1v1 rooms (pvp or vs AI) with spectators.
//
//   PORT=3011 node server/index.ts         (npm run server / npm start; Node >= 24 runs TypeScript)
//
// The server is authoritative. It owns the MatchState (src/sim), validates every intent with the shared
// rules, runs the deterministic battle and ships the replay; clients only play it back. Hidden information
// is enforced here: every snapshot is viewFor(state, seatOfThatSocket), never the raw MatchState.
//
// Served under a path by the games gateway (games.noblehaus.uk/oathbound/, prefix stripped), so
// everything here is relative: the page at /, the socket at /ws.
//
// Timers (ms) are env-overridable: LORD_PICK_MS, PLANNING_MS, LOOT_BONUS_MS, BATTLE_SLACK_MS, BATTLE_CAP_MS,
// RESULTS_MS, DISCONNECT_GRACE_MS.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import * as sim from '../src/sim/index.ts';
import type { BattleResult, BotStrategy, Intent, MatchState, PlayerView, Replay, Seat as SeatNo } from '../src/sim/types.ts';
import {
  AI_STRATEGY, TAKEOVER_STRATEGY, BATTLE_SLACK_MS, DISCONNECT_GRACE_MS, LOOT_BONUS_MS, LORD_PICK_MS, MAX_SPECTATORS, PLANNING_MS, RESULTS_MS,
  type AiLevel, type ClientMsg, type RoomMode, type RoomPhase, type RoomView, type SeatInfo, type ServerMsg,
} from '../src/net/protocol.ts';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', process.env.DIST ?? 'dist');
const ROOM_TTL_MS = 15 * 60_000;
/** A lobby seat (or a spectator) whose player vanished is freed after this long. */
const LOBBY_GRACE_MS = 60_000;
/** Public-server limits: rooms in all, sockets per client address, messages per socket. */
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 300);
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP ?? 40);
const MSG_BURST = 40;
const MSG_PER_SEC = 20;
const MAX_MESSAGE_BYTES = 8 * 1024;
const TICK_MS = 50;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.map': 'application/json',
};

// ---------------------------------------------------------------- static files: caching + compression
//
// Cache policy (the gateway and Cloudflare pass these through):
//  - index.html (any .html): no-cache, i.e. always revalidated, so a deploy is picked up at once;
//  - /assets/*: Vite's content-hashed bundles, immutable for a year;
//  - JSON metadata outside /assets (manifest.json, VAT .json, asset-versions.json): no-cache, revalidated with the ETag,
//    so a redeployed manifest is seen at once;
//  - art, textures and audio requested with a version (`?v=<content hash>`): immutable for a year. The hashes come
//    from the manifest the server serves (a `hashes` map is appended to every manifest.json: file path relative to
//    the manifest -> hash) and from /asset-versions.json (every file under /models, /textures, /audio and /ui);
//  - the same files without `?v=`: no-cache (a cheap 304 via the ETag). They used to be fresh for a week, which
//    left returning players running new code against week-old models after an art redeploy;
//  - everything else: an hour, then the ETag.
// ETags are strong: a content hash (computed once per file version and cached with its mtime/size), with a
// -br / -gz suffix for the compressed variants. Text-like files (json, js, css, html, svg, VAT .bin, glb) are
// brotli/gzip-compressed on first request and the result is kept in memory; audio and images are already
// compressed and never re-encoded, and byte ranges always come from the identity bytes.

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.bin', '.glb', '.gltf', '.txt', '.md', '.map', '.wasm', '.hdr']);
const brotliP = promisify(brotliCompress);
const gzipP = promisify(gzip);

const VERSIONED_DIRS = ['models', 'textures', 'audio', 'ui'];
const isArt = (path: string): boolean => VERSIONED_DIRS.some((d) => path.startsWith(`/${d}/`));

/** `versioned` = the request carried `?v=<hash>` (the URL changes whenever the content does). */
export function cacheControlFor(path: string, ext: string, versioned = false): string {
  if (ext === '.html') return 'no-cache';
  if (path.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (ext === '.json') return 'no-cache';
  if (isArt(path)) return versioned ? 'public, max-age=31536000, immutable' : 'no-cache';
  return 'public, max-age=3600';
}

/** Content hash per file, kept by (mtime, size) so each file is read once per version. */
const hashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();
async function fileHash(file: string): Promise<string> {
  const st = await stat(file);
  const hit = hashCache.get(file);
  if (hit && hit.mtimeMs === Number(st.mtimeMs) && hit.size === Number(st.size)) return hit.hash;
  const hash = createHash('sha256').update(await readFile(file)).digest('base64url').slice(0, 12);
  hashCache.set(file, { mtimeMs: Number(st.mtimeMs), size: Number(st.size), hash });
  return hash;
}
/** path (relative to `dir`, forward slashes) -> content hash, for every file under `dir`. */
async function hashTree(dir: string, prefix = '', out: Record<string, string> = {}): Promise<Record<string, string>> {
  let names: import('node:fs').Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of names) {
    if (e.isDirectory()) await hashTree(join(dir, e.name), `${prefix}${e.name}/`, out);
    else if (e.isFile()) out[prefix + e.name] = await fileHash(join(dir, e.name));
  }
  return out;
}
/** A manifest.json as served: the file's JSON plus `hashes` for every other file in its folder. */
async function manifestWithHashes(file: string, raw: Buffer): Promise<Buffer> {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return raw;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return raw;
  const hashes = await hashTree(resolve(file, '..'));
  delete hashes['manifest.json'];
  return Buffer.from(JSON.stringify({ ...(json as Record<string, unknown>), hashes }));
}
/** /asset-versions.json: "models/v2/knight.glb" -> hash, for all art, textures and audio. */
async function assetVersions(): Promise<Buffer> {
  const out: Record<string, string> = {};
  for (const d of VERSIONED_DIRS) await hashTree(join(ROOT, d), `${d}/`, out);
  return Buffer.from(JSON.stringify(out));
}

interface StaticEntry { mtimeMs: number; size: number; body: Buffer; etag: string; br?: Promise<Buffer | null>; gzip?: Promise<Buffer | null> }
const staticCache = new Map<string, StaticEntry>();
const manifestCache = new Map<string, StaticEntry>();

async function staticEntry(file: string, mtimeMs: number, size: number): Promise<StaticEntry> {
  const hit = staticCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit;
  const body = await readFile(file);
  const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
  const e: StaticEntry = { mtimeMs, size, body, etag };
  staticCache.set(file, e);
  return e;
}

/** brotli if the client takes it, else gzip, else identity (q=0 means "not acceptable"). */
export function pickEncoding(accept: string): 'br' | 'gzip' | null {
  const allowed = (name: string): boolean => {
    const m = new RegExp(`(?:^|,)\\s*${name}\\s*(?:;\\s*q\\s*=\\s*([0-9.]+))?\\s*(?:,|$)`, 'i').exec(accept);
    return !!m && (m[1] === undefined || Number(m[1]) > 0);
  };
  return allowed('br') ? 'br' : allowed('gzip') ? 'gzip' : null;
}

/** The compressed variant (computed once, then cached), or null when compression does not pay. */
function compressedOf(e: StaticEntry, enc: 'br' | 'gzip'): Promise<Buffer | null> {
  const run = async (): Promise<Buffer | null> => {
    if (e.body.length < 1024) return null;
    const out = enc === 'br'
      ? await brotliP(e.body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: e.body.length > 1 << 20 ? 6 : 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: e.body.length } })
      : await gzipP(e.body, { level: 9 });
    return out.length < e.body.length * 0.95 ? out : null;
  };
  if (enc === 'br') return (e.br ??= run());
  return (e.gzip ??= run());
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const list = (Array.isArray(header) ? header.join(',') : header).split(',').map((x) => x.trim().replace(/^W\//, ''));
  return list.includes('*') || list.includes(etag);
}

export interface ServerOptions {
  lordPickMs?: number;
  planningMs?: number;
  lootBonusMs?: number;
  /** Battle phase = replay duration + this (unless every player sent battleDone first). */
  battleSlackMs?: number;
  /** Hard cap on the battle phase (tests). Default: none. */
  battleCapMs?: number;
  resultsMs?: number;
  graceMs?: number;
  /** Lobby seats / spectators of vanished players are freed after this long. */
  lobbyGraceMs?: number;
  /** Tests: build each new match (default sim.newMatch(seed, null)), e.g. one a round from its end. */
  newMatch?: (seed: number) => MatchState;
}

/** Someone in a room: a player (seat 0/1), the vs-AI bot, or a spectator (seat null). */
interface Member {
  id: number;
  name: string;
  token: string;
  ws: WebSocket | null;
  goneAt: number;
  seat: SeatNo | null;
  bot: boolean;
  /** A human seat the bot is playing (grace expired / left). */
  botControlled: boolean;
  graceTimer: NodeJS.Timeout | null;
  graceEndsAt: number;
  rematch: boolean;
  done: boolean;
}

interface BattleNow {
  replay: Replay;
  result: BattleResult;
  /** JSON of the replay, serialised once per battle. */
  json: string;
  startedAt: number;
}

interface Room {
  code: string;
  mode: RoomMode;
  aiLevel: AiLevel;
  seats: [Member | null, Member | null];
  spectators: Member[];
  host: Member | null;
  state: MatchState | null;
  phase: RoomPhase;
  phaseEndsAt: number;
  battle: BattleNow | null;
  timer: NodeJS.Timeout | null;
  emptySince: number;
  nextId: number;
  /** The seat that conceded the current match (null = nobody). */
  concededBy: SeatNo | null;
}

interface Conn {
  room: Room | null;
  m: Member | null;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const token = () => randomBytes(16).toString('hex');
const rawSend = (ws: WebSocket | null, s: string) => {
  if (ws && ws.readyState === 1) ws.send(s);
};
const send = (ws: WebSocket | null, msg: ServerMsg) => rawSend(ws, JSON.stringify(msg));
const online = (m: Member | null): boolean => !!m && !!m.ws && m.ws.readyState === 1;
/** The seat is played by the server (vs-AI bot, or a human seat taken over). */
const isAi = (m: Member | null) => !!m && (m.bot || m.botControlled);
const AI_NAMES: Record<AiLevel, string> = { easy: 'AI (Easy)', normal: 'AI (Normal)', hard: 'AI (Hard)' };

/**
 * Control characters (C0, DEL, C1), bidi overrides/isolates and zero-width marks: they can't be typed meaningfully
 * and are used to spoof or break layouts. Everything else, including < > & and quotes, is kept as typed: the
 * client escapes text for display (the server never treats it as HTML).
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
/** Truncate to `max` code points (never splits a surrogate pair). */
const clip = (s: string, max: number): string => Array.from(s).slice(0, max).join('');
export const MAX_NAME_CHARS = 16;
export const MAX_CHAT_CHARS = 200;

export function cleanName(n: unknown): string {
  const s = clip(String(n ?? '').replace(CONTROL, '').replace(/\s+/g, ' ').trim(), MAX_NAME_CHARS).trim();
  return s || 'Player';
}

export function cleanText(n: unknown): string {
  return clip(String(n ?? '').replace(CONTROL, ' ').trim(), MAX_CHAT_CHARS).trim();
}

const env = (k: string, d: number) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);

/** Start a server on `port` (0 = any free port). */
export function startServer(port: number, opts: ServerOptions = {}): Promise<{ port: number; close(): Promise<void> }> {
  const lordPickMs = opts.lordPickMs ?? env('LORD_PICK_MS', LORD_PICK_MS);
  const planningMs = opts.planningMs ?? env('PLANNING_MS', PLANNING_MS);
  const lootBonusMs = opts.lootBonusMs ?? env('LOOT_BONUS_MS', LOOT_BONUS_MS);
  const battleSlackMs = opts.battleSlackMs ?? env('BATTLE_SLACK_MS', BATTLE_SLACK_MS);
  const battleCapMs = opts.battleCapMs ?? env('BATTLE_CAP_MS', Infinity);
  const resultsMs = opts.resultsMs ?? env('RESULTS_MS', RESULTS_MS);
  const graceMs = opts.graceMs ?? env('DISCONNECT_GRACE_MS', DISCONNECT_GRACE_MS);
  const lobbyGraceMs = opts.lobbyGraceMs ?? LOBBY_GRACE_MS;
  const rooms = new Map<string, Room>();

  function newCode(): string {
    for (;;) {
      let c = '';
      for (const b of randomBytes(4)) c += CODE_CHARS[b % CODE_CHARS.length];
      if (!rooms.has(c)) return c;
    }
  }

  const members = (room: Room): Member[] => [...room.seats.filter((m): m is Member => !!m), ...room.spectators];
  const humansOnline = (room: Room) => members(room).some(online);
  const system = (room: Room, text: string) => {
    const s = JSON.stringify({ t: 'chat', seat: null, name: 'Server', text, system: true } satisfies ServerMsg);
    for (const m of members(room)) rawSend(m.ws, s);
  };

  // ---------------------------------------------------------------- snapshots (hidden info lives here)

  function seatInfo(room: Room, m: Member | null): SeatInfo | null {
    if (!m) return null;
    return {
      name: m.name,
      connected: m.bot || online(m),
      isBot: m.bot,
      isHost: m === room.host,
      botControlled: m.botControlled,
      graceEndsAt: m.graceTimer ? m.graceEndsAt : 0,
      rematch: m.bot || m.rematch,
    };
  }

  /** Send every connected member its own snapshot: viewFor(state, its seat), spectators viewFor(state, null). */
  function pushRoom(room: Room): void {
    const now = Date.now();
    const base = {
      code: room.code,
      mode: room.mode,
      aiLevel: room.aiLevel,
      phase: room.phase,
      phaseEndsAt: room.phaseEndsAt,
      serverNow: now,
      seats: [seatInfo(room, room.seats[0]), seatInfo(room, room.seats[1])] as RoomView['seats'],
      spectators: room.spectators.map((s) => ({ id: s.id, name: s.name, connected: online(s) })),
      ...(room.phase === 'over' && room.state ? { over: { reason: room.state.overReason ?? 'keep', by: room.state.overReason === 'concede' ? room.concededBy : null } } : {}),
    };
    const views = new Map<SeatNo | null, PlayerView | null>();
    const viewOf = (seat: SeatNo | null): PlayerView | null => {
      if (!room.state) return null;
      if (!views.has(seat)) views.set(seat, sim.viewFor(room.state, seat));
      return views.get(seat)!;
    };
    for (const m of members(room)) {
      if (!online(m)) continue;
      const room_: RoomView = { ...base, me: { seat: m.seat, spectator: m.seat === null, isHost: m === room.host }, view: viewOf(m.seat) };
      send(m.ws, { t: 'room', room: room_ });
    }
  }

  function battleMsg(b: BattleNow): string {
    const now = Date.now();
    // the replay is serialised once per battle; only the envelope differs per send
    return `{"t":"battle","startedAt":${b.startedAt},"offsetMs":${Math.max(0, now - b.startedAt)},"replay":${b.json}}`;
  }

  // ---------------------------------------------------------------- timers

  const setTimer = (room: Room, ms: number, fn: () => void) => {
    if (room.timer) clearTimeout(room.timer);
    room.phaseEndsAt = Number.isFinite(ms) ? Date.now() + ms : 0;
    room.timer = Number.isFinite(ms)
      ? setTimeout(() => {
          room.timer = null;
          guard(room, fn);
        }, ms)
      : null;
  };
  const clearTimer = (room: Room) => {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    room.phaseEndsAt = 0;
  };
  function guard(room: Room, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error('room step failed', room.code, e);
      system(room, 'The server hit an error running this match.');
    }
  }

  // ---------------------------------------------------------------- bots

  /** The vs-AI bot plays at the room's difficulty; a taken-over human seat gets the hard bot. */
  const strategyFor = (room: Room, m: Member): BotStrategy => (m.bot ? AI_STRATEGY[room.aiLevel] : TAKEOVER_STRATEGY);

  /** Let the server play every AI seat for the current phase. */
  function runBots(room: Room): void {
    const s = room.state;
    if (!s) return;
    for (const m of room.seats) {
      if (!m || !isAi(m) || m.seat === null) continue;
      const p = s.players[m.seat];
      if (room.phase === 'lordPick' && p.lord) continue;
      if (room.phase === 'planning' && p.ready) continue;
      if (room.phase !== 'lordPick' && room.phase !== 'planning') continue;
      try {
        sim.botPlan(s, m.seat, strategyFor(room, m));
      } catch (e) {
        console.error('bot failed', room.code, e);
      }
      if (room.phase === 'lordPick' && !s.players[m.seat].lord) pickRandomLord(s, m.seat);
      if (room.phase === 'planning' && s.phase === 'planning' && !s.players[m.seat].ready) sim.applyIntent(s, m.seat, { t: 'ready' });
    }
  }

  function pickRandomLord(s: MatchState, seat: SeatNo): void {
    const ids = sim.LORD_IDS;
    sim.applyIntent(s, seat, { t: 'pickLord', lord: ids[randomInt(ids.length)] });
  }

  // ---------------------------------------------------------------- phase machine

  function startMatch(room: Room): void {
    const seed = randomBytes(4).readUInt32LE(0) >>> 0;
    room.state = opts.newMatch ? opts.newMatch(seed) : sim.newMatch(seed, null);
    room.battle = null;
    room.concededBy = null;
    for (const m of room.seats) if (m) (m.rematch = false), (m.done = false);
    room.phase = 'lordPick';
    setTimer(room, lordPickMs, () => endLordPick(room));
    runBots(room);
    if (room.state.phase === 'planning') return beginPlanning(room);
    pushRoom(room);
  }

  function endLordPick(room: Room): void {
    const s = room.state;
    if (!s || room.phase !== 'lordPick') return;
    for (const seat of [0, 1] as const) if (!s.players[seat].lord) pickRandomLord(s, seat);
    if (s.phase === 'planning') return beginPlanning(room);
    // the sim refused a random pick (should not happen): try again shortly
    setTimer(room, 1000, () => endLordPick(room));
    pushRoom(room);
  }

  function beginPlanning(room: Room): void {
    const s = room.state!;
    room.phase = 'planning';
    room.battle = null;
    for (const m of room.seats) if (m) m.done = false;
    const loot = s.players.some((p) => p.lootOffer && p.lootOffer.length > 0);
    setTimer(room, planningMs + (loot ? lootBonusMs : 0), () => endPlanning(room, true));
    runBots(room);
    pushRoom(room);
    advance(room);
  }

  function endPlanning(room: Room, timedOut: boolean): void {
    const s = room.state;
    if (!s || room.phase !== 'planning' || s.phase !== 'planning') return;
    if (!humansOnline(room)) {
      // nobody is here to watch: wait for someone to come back (the room expires if none does)
      return setTimer(room, planningMs, () => endPlanning(room, true));
    }
    if (timedOut && !sim.allReady(s)) sim.forceReady(s);
    let out: { replay: Replay; result: BattleResult };
    try {
      out = sim.simulateBattle(s);
    } catch (e) {
      console.error('battle failed', room.code, e);
      system(room, 'The battle failed to simulate on the server; planning restarts.');
      return setTimer(room, planningMs, () => endPlanning(room, true));
    }
    const b: BattleNow = { replay: out.replay, result: out.result, json: JSON.stringify(out.replay), startedAt: Date.now() };
    room.battle = b;
    room.phase = 'battle';
    for (const m of room.seats) if (m) m.done = false;
    const ticks = out.replay?.ticks ?? out.result?.ticks ?? 0;
    setTimer(room, Math.min(battleCapMs, ticks * TICK_MS + battleSlackMs), () => endBattle(room));
    const msg = battleMsg(b);
    for (const m of members(room)) rawSend(m.ws, msg);
    pushRoom(room);
  }

  function endBattle(room: Room): void {
    const s = room.state;
    const b = room.battle;
    if (!s || room.phase !== 'battle' || !b) return;
    room.battle = null;
    sim.applyBattle(s, b.result);
    if (s.phase === 'over') return finish(room);
    room.phase = 'results';
    setTimer(room, resultsMs, () => endResults(room));
    pushRoom(room);
  }

  function endResults(room: Room): void {
    const s = room.state;
    if (!s || room.phase !== 'results') return;
    sim.nextRound(s);
    if (s.phase === 'over') return finish(room);
    beginPlanning(room);
  }

  function finish(room: Room): void {
    room.phase = 'over';
    clearTimer(room);
    for (const m of room.seats) if (m) m.rematch = false;
    pushRoom(room);
  }

  /**
   * A player gives up (the 'concede' message, or leaving a running match for good): the match ends now and the
   * opponent wins. False when there is no running match to concede.
   */
  function concedeMatch(room: Room, m: Member, text: string): boolean {
    const s = room.state;
    if (!s || m.seat === null || room.phase === 'lobby' || room.phase === 'over' || s.phase === 'over') return false;
    if (!sim.concede(s, m.seat).ok) return false;
    room.battle = null;
    room.concededBy = m.seat;
    system(room, text);
    finish(room);
    return true;
  }

  /** Something changed that may finish the current phase (ready flags, battleDone, a disconnect). */
  function advance(room: Room): void {
    const s = room.state;
    if (!s) return;
    if (room.phase === 'lordPick' && s.phase === 'planning') return beginPlanning(room);
    if (room.phase === 'planning' && humansOnline(room) && sim.allReady(s)) return endPlanning(room, false);
    if (room.phase === 'battle') {
      // a seat counts as done when its client said so, or nobody is there to watch (AI / disconnected)
      const done = room.seats.every((m) => !m || isAi(m) || !online(m) || m.done);
      const anyHumanPlayer = room.seats.some((m) => online(m) && !isAi(m));
      if (done && anyHumanPlayer) return endBattle(room);
    }
    if (room.phase === 'over' && room.seats.every((m) => !m || isAi(m) || m.rematch)) {
      system(room, 'Rematch! A new match begins.');
      return startMatch(room);
    }
  }

  // ---------------------------------------------------------------- membership

  function welcome(room: Room, m: Member): void {
    send(m.ws, { t: 'welcome', code: room.code, seat: m.seat, spectator: m.seat === null, token: m.token });
  }

  function newMember(room: Room, name: string, seat: SeatNo | null, bot = false): Member {
    return { id: room.nextId++, name, token: bot ? '' : token(), ws: null, goneAt: 0, seat, bot, botControlled: false, graceTimer: null, graceEndsAt: 0, rematch: false, done: false };
  }

  const stopGrace = (m: Member) => {
    if (m.graceTimer) clearTimeout(m.graceTimer);
    m.graceTimer = null;
    m.graceEndsAt = 0;
  };

  /** Attach a socket to a member (new or rejoined) and bring it up to date. */
  function attach(c: Conn, ws: WebSocket, room: Room, m: Member): void {
    if (m.ws && m.ws !== ws) m.ws.close(4000, 'replaced');
    m.ws = ws;
    m.goneAt = 0;
    c.room = room;
    c.m = m;
    room.emptySince = 0;
    const hadGrace = !!m.graceTimer;
    stopGrace(m);
    if (m.botControlled) {
      m.botControlled = false;
      system(room, `${m.name} is back and has their seat again.`);
    } else if (hadGrace) system(room, `${m.name} reconnected.`);
    pickHost(room);
    welcome(room, m);
    pushRoom(room);
    if (room.phase === 'battle' && room.battle) rawSend(ws, battleMsg(room.battle));
  }

  /** The host is the first connected human player (the creator while they're here). */
  function pickHost(room: Room): void {
    const players = room.seats.filter((m): m is Member => !!m && !m.bot);
    if (room.host && players.includes(room.host) && online(room.host)) return;
    room.host = players.find(online) ?? (room.host && players.includes(room.host) ? room.host : players[0] ?? null);
  }

  /** The connection goes away; `forGood` when the player chose to leave. */
  function leave(c: Conn, forGood: boolean): void {
    const { room, m } = c;
    c.room = null;
    c.m = null;
    if (!room || !m) return;
    m.ws = null;
    m.goneAt = Date.now();
    if (m.seat === null) {
      if (forGood) room.spectators = room.spectators.filter((x) => x !== m);
    } else if (!room.state) {
      if (forGood) room.seats[m.seat] = null;
    } else if (!m.botControlled) {
      // Leaving a running match on purpose concedes it; after the match the AI keeps the seat for a rematch.
      if (forGood) {
        if (!concedeMatch(room, m, `${m.name} left the match and concedes.`)) takeOver(room, m, `${m.name} left: the AI plays their seat.`);
      } else {
        stopGrace(m);
        m.graceEndsAt = Date.now() + graceMs;
        m.graceTimer = setTimeout(() => {
          m.graceTimer = null;
          guard(room, () => takeOver(room, m, `${m.name} is still away: the AI plays their seat until they return.`));
        }, graceMs);
        system(room, `${m.name} disconnected: the AI takes over their seat in ${Math.round(graceMs / 1000)} s unless they return.`);
      }
    }
    pickHost(room);
    if (!humansOnline(room) && !room.emptySince) room.emptySince = Date.now();
    pushRoom(room);
    advance(room);
  }

  function takeOver(room: Room, m: Member, text: string): void {
    stopGrace(m);
    if (online(m) || m.botControlled || !room.seats.includes(m)) return;
    m.botControlled = true;
    system(room, text);
    runBots(room);
    pushRoom(room);
    advance(room);
  }

  // ---------------------------------------------------------------- messages

  function handle(ws: WebSocket, c: Conn, msg: ClientMsg): void {
    const err = (error: string) => send(ws, { t: 'error', error });
    const reject = (error: string) => send(ws, { t: 'rejected', error });
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'ping':
        return send(ws, { t: 'pong' });
      case 'create': {
        if (rooms.size >= MAX_ROOMS) return err('The server is full right now: try again in a few minutes');
        const mode: RoomMode = msg.mode === 'vsAI' ? 'vsAI' : 'pvp';
        const aiLevel: AiLevel = msg.aiLevel === 'easy' || msg.aiLevel === 'normal' ? msg.aiLevel : 'hard';
        leave(c, true);
        const room: Room = {
          code: newCode(), mode, aiLevel, seats: [null, null], spectators: [], host: null, state: null,
          phase: 'lobby', phaseEndsAt: 0, battle: null, timer: null, emptySince: 0, nextId: 1, concededBy: null,
        };
        const me = newMember(room, cleanName(msg.name), 0);
        room.seats[0] = me;
        room.host = me;
        if (mode === 'vsAI') room.seats[1] = newMember(room, AI_NAMES[aiLevel], 1, true);
        rooms.set(room.code, room);
        return attach(c, ws, room, me);
      }
      case 'join': {
        const room = rooms.get(String(msg.code ?? '').toUpperCase().trim());
        if (!room) return err('No room with that code');
        // coming back to a seat (reload, lost connection)
        const back = typeof msg.token === 'string' && msg.token ? members(room).find((m) => !m.bot && m.token === msg.token) : undefined;
        if (back) {
          if (c.m !== back) leave(c, true);
          return attach(c, ws, room, back);
        }
        leave(c, true);
        const name = cleanName(msg.name);
        const free = msg.spectate ? -1 : room.seats.indexOf(null);
        if (free === 0 || free === 1) {
          const m = newMember(room, name, free);
          room.seats[free] = m;
          return attach(c, ws, room, m);
        }
        if (room.spectators.length >= MAX_SPECTATORS) return err('That room is full');
        const m = newMember(room, name, null);
        room.spectators.push(m);
        attach(c, ws, room, m);
        return system(room, `${name} is spectating.`);
      }
      case 'start': {
        const { room, m } = c;
        if (!room || !m) return;
        if (room.host !== m) return reject('only the host can start');
        if (room.phase !== 'lobby') return reject('already started');
        if (!room.seats[0] || !room.seats[1]) return reject('waiting for an opponent');
        return startMatch(room);
      }
      case 'swapSeats': {
        const { room, m } = c;
        if (!room || !m) return;
        if (room.host !== m) return reject('only the host can swap seats');
        if (room.phase !== 'lobby') return reject('seats can only be swapped in the lobby');
        room.seats = [room.seats[1], room.seats[0]];
        room.seats.forEach((x, i) => x && (x.seat = i as SeatNo));
        for (const x of room.seats) if (x && online(x)) welcome(room, x);
        return pushRoom(room);
      }
      case 'intent': {
        const { room, m } = c;
        if (!room || !m || !room.state) return reject('no match running');
        if (m.seat === null) return reject('spectators cannot act');
        if (room.phase !== 'planning' && room.phase !== 'lordPick') return reject('not in the planning phase');
        const intent = msg.intent as Intent;
        if (!intent || typeof intent !== 'object' || typeof intent.t !== 'string') return reject('bad intent');
        if (room.phase === 'lordPick' && intent.t !== 'pickLord') return reject('pick your Lord first');
        let result: ReturnType<typeof sim.applyIntent>;
        try {
          result = sim.applyIntent(room.state, m.seat, intent);
        } catch (e) {
          console.error('intent failed', intent.t, e);
          return reject('bad intent');
        }
        if (!result.ok) return reject(result.error);
        if (room.phase === 'lordPick' && room.state.phase === 'planning') return beginPlanning(room);
        pushRoom(room);
        return advance(room);
      }
      case 'battleDone': {
        const { room, m } = c;
        if (!room || !m || room.phase !== 'battle' || m.seat === null) return;
        m.done = true;
        return advance(room);
      }
      case 'rematch': {
        const { room, m } = c;
        if (!room || !m) return;
        if (m.seat === null) return reject('spectators cannot ask for a rematch');
        if (room.phase !== 'over') return reject('the match is not over');
        m.rematch = true;
        system(room, `${m.name} wants a rematch.`);
        pushRoom(room);
        return advance(room);
      }
      case 'chat': {
        const { room, m } = c;
        const text = cleanText(msg.text);
        if (!room || !m || !text) return;
        const s = JSON.stringify({ t: 'chat', seat: m.seat, name: m.name, text, system: false } satisfies ServerMsg);
        for (const x of members(room)) rawSend(x.ws, s);
        return;
      }
      case 'concede': {
        const { room, m } = c;
        if (!room || !m || !room.state) return reject('no match running');
        if (m.seat === null) return reject('spectators cannot concede');
        if (!concedeMatch(room, m, `${m.name} concedes.`)) return reject('the match is not running');
        return;
      }
      case 'leave':
        leave(c, true);
        return ws.close(1000, 'left');
    }
  }

  // ---------------------------------------------------------------- housekeeping

  function sweep(): void {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      let changed = false;
      if (!room.state) {
        for (const i of [0, 1] as const) {
          const m = room.seats[i];
          if (m && !m.bot && !online(m) && m.goneAt && now - m.goneAt > lobbyGraceMs) (room.seats[i] = null), (changed = true);
        }
      }
      const before = room.spectators.length;
      room.spectators = room.spectators.filter((s) => online(s) || !s.goneAt || now - s.goneAt <= lobbyGraceMs);
      const host = room.host;
      pickHost(room);
      if (changed || room.spectators.length !== before || room.host !== host) pushRoom(room);
      if (humansOnline(room)) room.emptySince = 0;
      else if (!room.emptySince) room.emptySince = now;
      if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) {
        if (room.timer) clearTimeout(room.timer);
        for (const m of members(room)) stopGrace(m);
        rooms.delete(room.code);
      }
    }
  }

  // ---------------------------------------------------------------- http + ws

  async function serveFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    let p: string;
    try {
      url = new URL(req.url ?? '/', 'http://x');
      p = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return void res.end('bad request');
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return void res.end('ok');
    }
    if (p === '/asset-versions.json') {
      const body = await assetVersions();
      const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
      const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ETag: etag };
      if (etagMatches(req.headers['if-none-match'], etag)) { res.writeHead(304, h); return void res.end(); }
      res.writeHead(200, { ...h, 'Content-Length': body.length });
      return void res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, normalize(p));
    // inside dist/ itself (a bare prefix check would also let in a sibling like dist-old/)
    // errors are never cached: Cloudflare otherwise holds a 404 for hours
    if (!file.startsWith(ROOT + sep)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' });
      return void res.end();
    }
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return void res.end('not found');
    }
    const ext = extname(file).toLowerCase();
    let entry = await staticEntry(file, Number(st.mtimeMs), Number(st.size));
    if (p.endsWith('/manifest.json')) {
      // The manifest as served carries the content hash of every file beside it (for `?v=` URLs).
      const body = await manifestWithHashes(file, entry.body);
      const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
      const hit = manifestCache.get(file);
      entry = hit && hit.etag === etag ? hit : { mtimeMs: entry.mtimeMs, size: body.length, body, etag };
      manifestCache.set(file, entry);
    }
    const head = req.method === 'HEAD';
    const headers: Record<string, string | number> = {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': cacheControlFor(p, ext, url.searchParams.has('v')),
      'Accept-Ranges': 'bytes',
    };
    const compressible = COMPRESSIBLE.has(ext);
    if (compressible) headers.Vary = 'Accept-Encoding';
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    // byte ranges: <audio> streams music with them (Safari refuses media without 206 support). Ranges always come
    // from the identity bytes; a stale If-Range validator gets the whole file instead.
    const m = range && (!ifRange || ifRange === entry.etag) ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m && (m[1] || m[2])) {
      const body = entry.body, size = body.length;
      let a = m[1] ? Number(m[1]) : size - Number(m[2]);
      let b = m[1] && m[2] ? Number(m[2]) : size - 1;
      a = Math.max(0, a);
      b = Math.min(size - 1, b);
      if (a > b || a >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
        return void res.end();
      }
      res.writeHead(206, { ...headers, ETag: entry.etag, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
      return void res.end(head ? undefined : body.subarray(a, b + 1));
    }
    const enc = compressible ? pickEncoding(String(req.headers['accept-encoding'] ?? '')) : null;
    let body = entry.body, etag = entry.etag;
    if (enc) {
      const packed = await compressedOf(entry, enc);
      if (packed) {
        body = packed;
        etag = entry.etag.slice(0, -1) + (enc === 'br' ? '-br"' : '-gz"');
        headers['Content-Encoding'] = enc;
      }
    }
    headers.ETag = etag;
    if (etagMatches(req.headers['if-none-match'], etag)) {
      delete headers['Content-Encoding'];
      res.writeHead(304, headers);
      return void res.end();
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(head ? undefined : body);
  }

  const http = createServer((req, res) => {
    // anything thrown while handling a request answers that request, never takes the server down
    serveFile(req, res).catch((e) => {
      console.error('request failed', req.url, e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  http.on('clientError', (_e, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: MAX_MESSAGE_BYTES, // also bounds the inflated size of a compressed frame
    // replays are a few hundred KB of JSON/base64: deflate them (browsers offer the extension themselves).
    // No context takeover keeps per-socket zlib memory small; small messages go uncompressed.
    perMessageDeflate: {
      threshold: 1024,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      zlibDeflateOptions: { level: 6, memLevel: 8 },
      concurrencyLimit: 10,
    },
  });
  // a socket error with no listener is thrown and exits the process: every room gone
  wss.on('error', (e) => console.error('websocket server error', e));
  const perIp = new Map<string, number>();
  wss.on('connection', (ws, req) => {
    ws.on('error', (e) => console.warn('socket error', e.message));
    // behind Cloudflare and the gateway every socket comes from the gateway: use the client's address
    const ip = String(req.headers['cf-connecting-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0] ?? '').trim() || req.socket.remoteAddress || '?';
    const count = (perIp.get(ip) ?? 0) + 1;
    perIp.set(ip, count);
    ws.on('close', () => {
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });
    if (count > MAX_SOCKETS_PER_IP) return ws.close(1013, 'too many connections');
    // a message budget per socket: bursts are fine, floods are dropped (and a flooder cut off)
    let tokens = MSG_BURST;
    let refilled = Date.now();
    let dropped = 0;
    const c: Conn = { room: null, m: null };
    let alive = true;
    ws.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 20_000);
    ws.on('message', (data) => {
      const now = Date.now();
      tokens = Math.min(MSG_BURST, tokens + ((now - refilled) / 1000) * MSG_PER_SEC);
      refilled = now;
      if (tokens < 1) {
        if (++dropped > 100) ws.close(1008, 'too many messages');
        return;
      }
      tokens -= 1;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      try {
        handle(ws, c, msg);
      } catch (e) {
        console.error('message failed', msg?.t, e);
      }
    });
    ws.on('close', () => {
      clearInterval(beat);
      try {
        if (c.m?.ws === ws) leave(c, false);
      } catch (e) {
        console.error('close failed', e);
      }
    });
  });

  const sweeper = setInterval(sweep, 5_000);
  return new Promise((done, fail) => {
    http.once('error', fail);
    http.listen(port, () => {
      const addr = http.address();
      done({
        port: typeof addr === 'object' && addr ? addr.port : port,
        close: () =>
          new Promise<void>((r) => {
            clearInterval(sweeper);
            for (const room of rooms.values()) {
              if (room.timer) clearTimeout(room.timer);
              for (const m of members(room)) stopGrace(m);
            }
            rooms.clear();
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            http.closeAllConnections();
            http.close(() => r());
          }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // last resort: log and carry on rather than drop every room over one bad input
  process.on('uncaughtException', (e) => console.error('uncaught', e));
  process.on('unhandledRejection', (e) => console.error('unhandled rejection', e));
  const port = Number(process.env.PORT ?? 3011);
  startServer(port).then(() => console.log(`oathbound on :${port}`));
}
