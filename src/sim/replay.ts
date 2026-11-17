// Replay wire format (encoder used by battle.ts, decoder + sampler used by the client).
// See the `Replay` doc comment in types.ts for the layout. Everything is varint/zigzag binary, base64 on the wire.
import { KEYFRAME_TICKS, TICK_MS } from './constants.ts';
import type {
  AbilityEventKind, ArcType, DecodedReplay, ProjectileKind, Replay, ReplayEvent, Seat, SkillEvent, SkillId, SoldierTransforms, StatCause, TallyEvent, WeaponKind,
} from './types.ts';

/** Wire version of the replay; decodeReplay refuses any other. */
export const REPLAY_VERSION = 3 as const;
/** Length (ticks) of one window of the statistics ledger ('tally' events). */
export const TALLY_TICKS = 10;
import { ANIM_STATES, EVENT_KINDS } from './types.ts';

/** `src` id for keep towers (n = 0, 1) and the keep itself (n = 2) of `seat`. */
export const KEEP_SRC_BASE = 1_000_000;
export function keepSource(seat: Seat, n: number): number {
  return KEEP_SRC_BASE + seat * 4 + n;
}

export const WEAPON_CODES: readonly (WeaponKind | 'tower')[] = ['sword', 'axe', 'lance', 'bow', 'tome', 'staff', 'bolt', 'stone', 'fists', 'breath', 'tower', 'beam'];
export const PROJ_CODES: readonly ProjectileKind[] = ['none', 'arrow', 'bolt', 'stone', 'fireball', 'firebreath', 'lightning', 'tower_arrow', 'sunbeam'];
export const ARC_CODES: readonly ArcType[] = ['line', 'arc', 'high_arc'];
export const ABILITY_CODES: readonly AbilityEventKind[] = [
  'rally', 'meteor', 'bulwark', 'skyfall', 'chain', 'burn', 'frost', 'ember_burst', 'reflect', 'stomp', 'charge', 'brace',
  'earthshaker', 'bloodthirst', 'sunfire', 'lifebinder', 'levelup', 'knockback', 'shield_wall', 'war_cry', 'cleave', 'necromancy', 'radiance',
  'soul_reap', 'grave_taunt', 'plague_breath', 'whirlwind', 'stampede', 'talon',
];
/** Wire order of the skills (append only). */
export const SKILL_CODES: readonly SkillId[] = [
  'fireball', 'chain_lightning', 'frost_nova', 'mending_light', 'shield_wall', 'war_cry', 'cleave', 'fire_arrows', 'pinning_shot', 'rain_of_arrows',
  'thunderous_charge', 'trample', 'dive_strike', 'incendiary_payload',
];
/** Wire order of the ledger causes (append only; fewer than 64). */
export const STAT_CAUSES: readonly StatCause[] = [
  'attack', 'burn', 'thorns', 'tower', 'chain', 'ember_burst', 'sunfire', 'meteor', 'skyfall', 'heal', 'leech', 'lifebinder', 'bloodthirst', 'revive', 'rout',
  ...SKILL_CODES,
  'radiance', 'regen',
  'soul_reap', 'plague_breath', 'whirlwind', 'stampede', 'talon',
];
export const REVIVE_CODES = ['undying_oath', 'phoenix'] as const;
/** Kinds in the binary event stream: the classic eleven, then skill casts and ledger entries (decoded into their own lists). */
export const WIRE_KINDS = [...EVENT_KINDS, 'skill', 'tally'] as const;
export const EK: Record<(typeof WIRE_KINDS)[number], number> = Object.fromEntries(WIRE_KINDS.map((k, i) => [k, i])) as never;

// ---------------------------------------------------------------- bytes

export class ByteWriter {
  buf = new Uint8Array(1 << 16);
  len = 0;
  private grow(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  byte(v: number): void {
    this.grow(1);
    this.buf[this.len++] = v & 255;
  }
  /** Unsigned varint (v >= 0, < 2^35). */
  uv(v: number): void {
    this.grow(6);
    while (v >= 128) {
      this.buf[this.len++] = (v % 128) | 128;
      v = Math.trunc(v / 128);
    }
    this.buf[this.len++] = v;
  }
  /** Signed zigzag varint. */
  sv(v: number): void {
    this.uv(v >= 0 ? v * 2 : -v * 2 - 1);
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

class ByteReader {
  pos = 0;
  b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  byte(): number {
    return this.b[this.pos++];
  }
  uv(): number {
    let v = 0, mul = 1, c: number;
    do {
      c = this.b[this.pos++];
      v += (c & 127) * mul;
      mul *= 128;
    } while (c & 128);
    return v;
  }
  sv(): number {
    const u = this.uv();
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
  }
  get done(): boolean {
    return this.pos >= this.b.length;
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();
export function toBase64(b: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
    if (chunk.length > 8192) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  return parts.join('');
}
export function fromBase64(s: string): Uint8Array {
  let pad = 0;
  if (s.endsWith('==')) pad = 2; else if (s.endsWith('=')) pad = 1;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64_INV[s.charCodeAt(i)] << 18) | (B64_INV[s.charCodeAt(i + 1)] << 12) | ((B64_INV[s.charCodeAt(i + 2)] & 63) << 6) | (B64_INV[s.charCodeAt(i + 3)] & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

// ---------------------------------------------------------------- frame encoder (used by battle.ts)

/** Keyframe positions are quantised with a 3 cm deadband (exact again whenever the animation state changes). */
export const POS_DEADBAND = 3;

export class FrameEncoder {
  w = new ByteWriter();
  frames = 0;
  private px = new Int32Array(512);
  private py = new Int32Array(512);
  private pf = new Int32Array(512);
  private ph = new Int32Array(512);
  private pa = new Int32Array(512).fill(255);
  private ensure(n: number): void {
    if (n <= this.px.length) return;
    const g = (a: Int32Array, fill: number): Int32Array<ArrayBuffer> => { const b = new Int32Array(n * 2).fill(fill); b.set(a); return b; };
    this.px = g(this.px, 0); this.py = g(this.py, 0); this.pf = g(this.pf, 0); this.ph = g(this.ph, 0); this.pa = g(this.pa, 255);
  }
  /** Write one frame for soldiers [0, n). `spawned(i)` false = skipped. */
  frame(n: number, spawned: (i: number) => boolean, x: (i: number) => number, y: (i: number) => number, f: (i: number) => number, hp: (i: number) => number, anim: (i: number) => number): void {
    this.ensure(n);
    const w = this.w;
    let run = 0;
    const flush = (): void => {
      while (run > 0) { const r = Math.min(127, run); w.byte(128 | r); run -= r; }
    };
    for (let i = 0; i < n; i++) {
      if (!spawned(i)) continue;
      const X = x(i), Y = y(i), F = f(i), H = hp(i), A = anim(i);
      let flags = 0;
      // Positions move in the stream only when they drift > POS_DEADBAND cm from the last written value (kills jitter).
      const ddx = X - this.px[i], ddy = Y - this.py[i];
      if (ddx > POS_DEADBAND || ddx < -POS_DEADBAND || ddy > POS_DEADBAND || ddy < -POS_DEADBAND || (A !== this.pa[i] && (ddx || ddy))) flags |= 1;
      if (F !== this.pf[i]) flags |= 2;
      if (H !== this.ph[i]) flags |= 4;
      if (A !== this.pa[i]) flags |= 8;
      if (!flags) { run++; continue; }
      flush();
      w.byte(flags);
      if (flags & 1) { w.sv(X - this.px[i]); w.sv(Y - this.py[i]); this.px[i] = X; this.py[i] = Y; }
      if (flags & 2) { let d = (F - this.pf[i]) & 255; if (d > 127) d -= 256; w.sv(d); this.pf[i] = F; }
      if (flags & 4) { w.uv(H); this.ph[i] = H; }
      if (flags & 8) { w.byte(A); this.pa[i] = A; }
    }
    flush();
    this.frames++;
  }
}

// ---------------------------------------------------------------- decode

/** Decode a wire replay into typed arrays + event objects (client side, once per battle). */
export function decodeReplay(r: Replay): DecodedReplay {
  if (r.v !== REPLAY_VERSION) throw new Error(`unsupported replay version ${String(r.v)} (this build reads ${REPLAY_VERSION})`);
  const n = r.soldiers.length, F = r.frameCount;
  const x = new Int16Array(n * F), y = new Int16Array(n * F), facing = new Uint8Array(n * F), hp = new Uint16Array(n * F), anim = new Uint8Array(n * F).fill(255);
  const rd = new ByteReader(fromBase64(r.frames));
  const cx = new Int32Array(n), cy = new Int32Array(n), cf = new Int32Array(n), ch = new Int32Array(n), ca = new Int32Array(n).fill(255);
  for (let fr = 0; fr < F && !rd.done; fr++) {
    const tick = fr * r.frameTicks;
    let skip = 0;
    for (let i = 0; i < n; i++) {
      if (r.soldiers[i].spawnTick > tick) continue;
      if (skip > 0) { skip--; }
      else {
        const flags = rd.byte();
        if (flags & 128) { skip = (flags & 127) - 1; }
        else {
          if (flags & 1) { cx[i] += rd.sv(); cy[i] += rd.sv(); }
          if (flags & 2) cf[i] = (cf[i] + rd.sv()) & 255;
          if (flags & 4) ch[i] = rd.uv();
          if (flags & 8) ca[i] = rd.byte();
        }
      }
      const k = fr * n + i;
      x[k] = cx[i]; y[k] = cy[i]; facing[k] = cf[i]; hp[k] = ch[i]; anim[k] = ca[i];
    }
  }
  const ev = decodeAllEvents(r);
  return { replay: r, soldierCount: n, frameCount: F, x, y, facing, hp, anim, events: ev.events, skills: ev.skills, tallies: ev.tallies };
}

/**
 * Event field codecs per kind (EVENT_KINDS order), one char per field:
 *  u = unsigned varint, r = soldier/keep ref as uv(v + 1) (so -1 = 0), X/Y = absolute cm (zigzag),
 *  x/y = cm relative to the preceding X/Y in the same event, I = projectile id as zigzag delta from the previous
 *  projectile id, J = impact id as zigzag delta from the latest projectile id, P/Q = impact point relative to that
 *  projectile's target point.
 */
export const EVENT_CODEC: readonly string[] = ['rruuu', 'IrruuXYxyu', 'JPQuu', 'rruu', 'rru', 'rr', 'rruXYuu', 'uruuu', 'uu', 'ruu', 'rrXY', 'ruurrXYuu', 'rruuuuu'];

/** Encode the flat event list [tickDelta, kind, ...fields] (see battle.ts) into bytes. */
export function encodeEvents(ev: readonly number[]): Uint8Array {
  const w = new ByteWriter();
  const projTo = new Map<number, [number, number]>();
  let lastPid = 0, ax = 0, ay = 0, px = 0, py = 0;
  let i = 0;
  while (i < ev.length) {
    // Header byte: low nibble = kind, high nibble = tick delta (15 = escape, followed by a varint delta).
    const kind = ev[i + 1], dt = ev[i];
    if (dt < 15) w.byte(kind | (dt << 4));
    else { w.byte(kind | 0xf0); w.uv(dt); }
    const spec = EVENT_CODEC[kind];
    let pid = 0;
    for (let j = 0; j < spec.length; j++) {
      const v = ev[i + 2 + j];
      switch (spec[j]) {
        case 'u': w.uv(v); break;
        case 'r': w.uv(v + 1); break;
        case 'X': w.sv(v); ax = v; break;
        case 'Y': w.sv(v); ay = v; break;
        case 'x': w.sv(v - ax); px = v; break;
        case 'y': w.sv(v - ay); py = v; projTo.set(pid, [px, v]); break;
        case 'I': w.sv(v - lastPid); lastPid = v; pid = v; break;
        case 'J': { w.sv(v - lastPid); pid = v; const t = projTo.get(v) ?? [0, 0]; px = t[0]; py = t[1]; projTo.delete(v); break; }
        case 'P': w.sv(v - px); break;
        case 'Q': w.sv(v - py); break;
        default: w.sv(v);
      }
    }
    i += 2 + spec.length;
  }
  return w.bytes();
}

export function decodeEvents(r: Replay): ReplayEvent[] {
  return decodeAllEvents(r).events;
}

export function decodeAllEvents(r: Replay): { events: ReplayEvent[]; skills: SkillEvent[]; tallies: TallyEvent[] } {
  const rd = new ByteReader(fromBase64(r.events));
  const out: ReplayEvent[] = [];
  const skills: SkillEvent[] = [], tallies: TallyEvent[] = [];
  const projTo = new Map<number, [number, number]>();
  let tick = 0, lastPid = 0;
  const f: number[] = [];
  while (!rd.done) {
    const hb = rd.byte();
    const kind = hb & 15;
    tick += hb >> 4 === 15 ? rd.uv() : hb >> 4;
    const spec = EVENT_CODEC[kind];
    let ax = 0, ay = 0, px = 0, py = 0, pid = 0;
    f.length = 0;
    for (let j = 0; j < spec.length; j++) {
      let v: number;
      switch (spec[j]) {
        case 'u': v = rd.uv(); break;
        case 'r': v = rd.uv() - 1; break;
        case 'X': v = ax = rd.sv(); break;
        case 'Y': v = ay = rd.sv(); break;
        case 'x': v = px = ax + rd.sv(); break;
        case 'y': v = py = ay + rd.sv(); projTo.set(pid, [px, py]); break;
        case 'I': v = pid = lastPid = lastPid + rd.sv(); break;
        case 'J': { v = pid = lastPid + rd.sv(); const t = projTo.get(v) ?? [0, 0]; px = t[0]; py = t[1]; projTo.delete(v); break; }
        case 'P': v = px + rd.sv(); break;
        case 'Q': v = py + rd.sv(); break;
        default: v = rd.sv();
      }
      f.push(v);
    }
    const k = WIRE_KINDS[kind];
    switch (k) {
      case 'attack': out.push({ k, tick, src: f[0], tgt: f[1], weapon: WEAPON_CODES[f[2]], projectile: PROJ_CODES[f[3]], hitTick: tick + f[4] }); break;
      case 'projectile': out.push({ k, tick, id: f[0], src: f[1], tgt: f[2], kind: PROJ_CODES[f[3]], arc: ARC_CODES[f[4]], from: [f[5], f[6]], to: [f[7], f[8]], flight: f[9] }); break;
      case 'impact': out.push({ k, tick, id: f[0], pos: [f[1], f[2]], kind: PROJ_CODES[f[3]], splash: f[4] }); break;
      case 'hit': out.push({ k, tick, src: f[0], tgt: f[1], dmg: f[2], crit: !!(f[3] & 1), effective: !!(f[3] & 2), miss: !!(f[3] & 4), triangle: (((f[3] >> 3) & 3) - 1) as -1 | 0 | 1 }); break;
      case 'heal': out.push({ k, tick, src: f[0], tgt: f[1], amount: f[2] }); break;
      case 'death': out.push({ k, tick, tgt: f[0], src: f[1] }); break;
      case 'ability': out.push({ k, tick, src: f[0], tgt: f[1], ability: ABILITY_CODES[f[2]], pos: [f[3], f[4]], radius: f[5], dur: f[6] }); break;
      case 'keepHit': out.push({ k, tick, seat: f[0] as Seat, src: f[1], dmg: f[2], hpAfter: f[3], final: f[4] === 1 }); break;
      case 'keepStage': out.push({ k, tick, seat: f[0] as Seat, stage: f[1] }); break;
      case 'revive': out.push({ k, tick, tgt: f[0], hp: f[1], cause: REVIVE_CODES[f[2]] }); break;
      case 'summon': out.push({ k, tick, tgt: f[0], src: f[1], pos: [f[2], f[3]] }); break;
      case 'skill': skills.push({ k, tick, src: f[0], squad: f[1], skill: SKILL_CODES[f[2]], tgt: f[3], tgtSquad: f[4], pos: [f[5], f[6]], radius: f[7], dur: f[8] }); break;
      case 'tally': tallies.push({ k, tick, src: f[0], tgt: f[1], cause: STAT_CAUSES[f[2]], dmg: f[3], mit: f[4], heal: f[5], n: f[6] }); break;
      default: throw new Error('bad replay event');
    }
  }
  return { events: out, skills, tallies };
}

// ---------------------------------------------------------------- playback sampling

export function makeTransforms(n: number): SoldierTransforms {
  return {
    count: n, x: new Float32Array(n), y: new Float32Array(n), facing: new Float32Array(n), hp: new Float32Array(n),
    anim: new Uint8Array(n), visible: new Uint8Array(n),
  };
}

const RAD_PER_UNIT = (2 * 3.141592653589793) / 256;

/**
 * Interpolated soldier transforms at `timeMs` (0 = battle start). Linear between keyframes; facing along the
 * shortest arc. Writes into `out` (from makeTransforms) and returns it. No allocations.
 */
export function sampleReplay(d: DecodedReplay, timeMs: number, out: SoldierTransforms): SoldierTransforms {
  const n = d.soldierCount;
  const frameMs = TICK_MS * (d.replay.frameTicks || KEYFRAME_TICKS);
  let ft = timeMs / frameMs;
  if (ft < 0) ft = 0;
  const maxF = d.frameCount - 1;
  if (ft > maxF) ft = maxF;
  const f0 = Math.floor(ft), f1 = f0 < maxF ? f0 + 1 : f0, a = ft - f0;
  const o0 = f0 * n, o1 = f1 * n;
  for (let i = 0; i < n && i < out.count; i++) {
    const an0 = d.anim[o0 + i];
    if (an0 === 255) { out.visible[i] = 0; out.anim[i] = 255; continue; }
    const an1 = d.anim[o1 + i] === 255 ? an0 : d.anim[o1 + i];
    out.visible[i] = 1;
    out.anim[i] = an0;
    const x0 = d.x[o0 + i], y0 = d.y[o0 + i];
    const x1 = an1 === 255 ? x0 : d.x[o1 + i], y1 = an1 === 255 ? y0 : d.y[o1 + i];
    out.x[i] = x0 + (x1 - x0) * a + 0.5;
    out.y[i] = y0 + (y1 - y0) * a + 0.5;
    let df = d.facing[o1 + i] - d.facing[o0 + i];
    if (df > 128) df -= 256; else if (df < -128) df += 256;
    out.facing[i] = (d.facing[o0 + i] + df * a) * RAD_PER_UNIT;
    out.hp[i] = d.hp[o0 + i] + (d.hp[o1 + i] - d.hp[o0 + i]) * a;
  }
  return out;
}

/** FNV-1a hash of the wire replay (frames + events + result), for determinism tests. */
export function replayHash(r: Replay): number {
  const s = r.frames + '|' + r.events + '|' + JSON.stringify(r.result) + '|' + JSON.stringify(r.soldiers) + '|' + JSON.stringify(r.squads);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export { ANIM_STATES };
