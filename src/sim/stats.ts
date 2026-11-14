// Per-squad battle statistics, read from a decoded replay. Pure and cheap: the single source of truth for
// "damage dealt / taken / healed / kills" in the inspector, the battle report and the insights.
//
//   const st = squadStatsAt(decoded, tick)        // call at ~4 Hz during playback; incremental + cached
//   st.squads[row]                                 // one SquadStats per Replay.squads row (skeleton bands have their own)
//   squadStatsOf(st, side, squadId)                // the row of a MatchState squad id
//
// Numbers come from the replay's statistics ledger ('tally' events, DecodedReplay.tallies): every point of
// life removed or restored is attributed to a source squad, a target squad and a cause, with no overkill and no
// overheal, so for every squad:  life at start - damage taken + healing received = life now  (see the tests).
// The ledger is written every TALLY_TICKS (0.5 s); kills, losses, soldier counts and skill casts are exact to the tick.
import { TICK_HZ } from './constants.ts';
import { KEEP_SRC_BASE, TALLY_TICKS } from './replay.ts';
import type { DecodedReplay, LordId, ReplaySquad, Seat, SkillId, SoldierType, StatCause } from './types.ts';

export interface SkillStat {
  skill: SkillId;
  casts: number;
  /** Life removed / restored by the skill (HP), and the number of soldier hits ("Fireball hit 7 soldiers for 340"). */
  damage: number;
  healing: number;
  hits: number;
}

export interface SquadStats {
  /** Row in Replay.squads. */
  row: number;
  /** MatchState squad id (skeleton bands: the squad that raised them). */
  squad: number;
  side: Seat;
  type: SoldierType;
  lord: LordId | null;
  level: number;
  summoned: boolean;
  /** Life removed from enemies (HP; no overkill). Includes burns, procs, Lord abilities and item skills. */
  dealt: number;
  /** Life this squad lost. */
  taken: number;
  /** Damage its armour, resistance and shields (Bulwark, Shield Wall, cover) absorbed. */
  mitigated: number;
  /** Life it restored on allies and itself (heals, lifesteal, regeneration, revives), and life restored on it. */
  healingDone: number;
  healingReceived: number;
  /** Damage it dealt to the enemy Keep during the march. */
  keepDamage: number;
  kills: number;
  losses: number;
  /** Soldiers standing now / fielded so far (summons join when they rise). */
  alive: number;
  soldiers: number;
  /** Sim tick at which its last soldier fell (-1 = still standing). */
  wipedAt: number;
  /** Total life now and at full strength (HP). */
  hp: number;
  hpMax: number;
  /** Damage dealt, split by cause (HP): 'attack', 'burn', 'meteor', a SkillId... Only causes that did something. */
  byCause: Partial<Record<StatCause, number>>;
  /** One entry per item skill the squad has (present even before the first cast). */
  skills: SkillStat[];
  /** The squad's total life sampled once per second from the start up to `tick` (index = second), for a sparkline. */
  hpSeries: Uint32Array;
}

export interface BattleStatsAt {
  tick: number;
  squads: SquadStats[];
  /** Per seat: damage dealt / taken, healing done, soldiers lost, damage dealt to the enemy Keep (all sources). */
  sides: [SideStats, SideStats];
}
export interface SideStats { dealt: number; taken: number; healing: number; losses: number; keepDamage: number; towerDamage: number }

interface Row {
  info: ReplaySquad;
  dealt: number; taken: number; mit: number; healD: number; healR: number; keep: number; kills: number; losses: number; spawned: number; wipedAt: number;
  cause: Map<StatCause, number>;
  skills: Map<SkillId, [number, number, number, number]>; // casts, damage, healing, hits
  series: Uint32Array;
  hpMax: number;
}
interface Cache {
  rows: Row[];
  rowOfSol: Int32Array;
  /** Classic events that matter (death / keepHit / hit / heal fallback), and cursors into the three streams. */
  ev: DecodedReplay['events'];
  iEv: number; iTally: number; iSkill: number; iSpawn: number;
  spawnOrder: number[];
  tick: number;
  towerDamage: [number, number];
  keepAll: [number, number];
  last: BattleStatsAt | null;
  fallback: boolean;
}

const CACHE = new WeakMap<DecodedReplay, Cache>();

/** Replay.squads, or (hand-built replays without it) one row per (side, squad id, summoned) derived from the soldiers. */
export function replaySquads(d: DecodedReplay): ReplaySquad[] {
  const r = d.replay;
  if (r.squads && r.squads.length) return r.squads;
  const out: ReplaySquad[] = [];
  const idx = new Map<string, ReplaySquad>();
  for (const s of r.soldiers) {
    const key = `${s.side}:${s.squad}:${s.summoned ? 1 : 0}`;
    let q = idx.get(key);
    if (!q) {
      q = { row: out.length, id: s.squad, side: s.side, type: s.type, level: s.level, summoned: s.summoned, soldiers: [], skills: s.skills ?? [] };
      if (s.lord) q.lord = s.lord;
      idx.set(key, q);
      out.push(q);
    }
    q.soldiers.push(s.id);
  }
  return out;
}

function build(d: DecodedReplay): Cache {
  const squads = replaySquads(d);
  const n = d.soldierCount;
  const rowOfSol = new Int32Array(n).fill(-1);
  const seconds = Math.floor(d.replay.ticks / TICK_HZ) + 1;
  const ft = d.replay.frameTicks || 4;
  const rows: Row[] = squads.map((info) => {
    const series = new Uint32Array(seconds);
    let hpMax = 0;
    for (const i of info.soldiers) { rowOfSol[i] = info.row; hpMax += d.replay.soldiers[i].maxHp; }
    for (let s = 0; s < seconds; s++) {
      const f = Math.min(d.frameCount - 1, Math.floor((s * TICK_HZ) / ft));
      let hp = 0;
      if (f >= 0) for (const i of info.soldiers) if (d.anim[f * n + i] !== 255) hp += d.hp[f * n + i];
      series[s] = hp;
    }
    const skills = new Map<SkillId, [number, number, number, number]>();
    for (const k of info.skills) skills.set(k, [0, 0, 0, 0]);
    return { info, dealt: 0, taken: 0, mit: 0, healD: 0, healR: 0, keep: 0, kills: 0, losses: 0, spawned: 0, wipedAt: -1, cause: new Map(), skills, series, hpMax };
  });
  const fallback = !d.tallies;
  const ev = d.events.filter((e) => e.k === 'death' || e.k === 'keepHit' || (fallback && (e.k === 'hit' || e.k === 'heal')));
  const spawnOrder = d.replay.soldiers.map((s) => s.id).sort((a, b) => d.replay.soldiers[a].spawnTick - d.replay.soldiers[b].spawnTick || a - b);
  return { rows, rowOfSol, ev, iEv: 0, iTally: 0, iSkill: 0, iSpawn: 0, spawnOrder, tick: -1, towerDamage: [0, 0], keepAll: [0, 0], last: null, fallback };
}

function reset(c: Cache): void {
  for (const r of c.rows) {
    r.dealt = r.taken = r.mit = r.healD = r.healR = r.keep = r.kills = r.losses = r.spawned = 0;
    r.wipedAt = -1;
    r.cause.clear();
    for (const v of r.skills.values()) v.fill(0);
  }
  c.iEv = c.iTally = c.iSkill = c.iSpawn = 0;
  c.tick = -1;
  c.towerDamage = [0, 0];
  c.keepAll = [0, 0];
}

function entry(d: DecodedReplay, c: Cache, src: number, tgt: number, cause: StatCause, dmg: number, mit: number, heal: number, hits: number): void {
  const T = c.rows[tgt];
  if (!T) return;
  T.taken += dmg; T.mit += mit; T.healR += heal;
  if (src >= KEEP_SRC_BASE) { c.towerDamage[((src - KEEP_SRC_BASE) >> 2) as Seat] += dmg; return; }
  const S = c.rows[src];
  if (!S) return;
  S.dealt += dmg; S.healD += heal;
  if (dmg) S.cause.set(cause, (S.cause.get(cause) ?? 0) + dmg);
  const sk = S.skills.get(cause as SkillId);
  if (sk) { sk[1] += dmg; sk[2] += heal; sk[3] += hits; }
}

function advance(d: DecodedReplay, c: Cache, tick: number): void {
  const sol = d.replay.soldiers;
  while (c.iSpawn < c.spawnOrder.length && sol[c.spawnOrder[c.iSpawn]].spawnTick <= tick) {
    const r = c.rows[c.rowOfSol[c.spawnOrder[c.iSpawn]]];
    if (r) { r.spawned++; r.wipedAt = -1; }
    c.iSpawn++;
  }
  const tl = d.tallies;
  if (tl) {
    for (; c.iTally < tl.length && tl[c.iTally].tick <= tick; c.iTally++) {
      const e = tl[c.iTally];
      entry(d, c, e.src, e.tgt, e.cause, e.dmg, e.mit, e.heal, e.n);
    }
  }
  const sk = d.skills;
  if (sk) {
    for (; c.iSkill < sk.length && sk[c.iSkill].tick <= tick; c.iSkill++) {
      const e = sk[c.iSkill];
      const r = c.rows[e.squad];
      if (!r) continue;
      let v = r.skills.get(e.skill);
      if (!v) r.skills.set(e.skill, (v = [0, 0, 0, 0]));
      v[0]++;
    }
  }
  const ev = c.ev;
  for (; c.iEv < ev.length && ev[c.iEv].tick <= tick; c.iEv++) {
    const e = ev[c.iEv];
    if (e.k === 'death') {
      const T = c.rows[c.rowOfSol[e.tgt] ?? -1];
      if (T) { T.losses++; if (T.losses >= T.spawned) T.wipedAt = e.tick; }
      const S = e.src >= 0 && e.src < KEEP_SRC_BASE ? c.rows[c.rowOfSol[e.src]] : undefined;
      if (S) S.kills++;
    } else if (e.k === 'keepHit') {
      // `seat` owns the keep that was hit: the damage belongs to the other side.
      c.keepAll[(1 - e.seat) as Seat] += e.dmg;
      const S = e.src >= 0 && e.src < KEEP_SRC_BASE ? c.rows[c.rowOfSol[e.src]] : undefined;
      if (S) S.keep += e.dmg;
    } else if (e.k === 'hit') {
      // Fallback for replays without a ledger: classic hit events (whole HP, overkill included).
      if (!e.miss && e.tgt < KEEP_SRC_BASE) entry(d, c, e.src >= KEEP_SRC_BASE ? e.src : c.rowOfSol[e.src] ?? -1, c.rowOfSol[e.tgt] ?? -1, e.src >= KEEP_SRC_BASE ? 'tower' : 'attack', e.dmg * 100, 0, 0, 1);
    } else if (e.k === 'heal') {
      entry(d, c, c.rowOfSol[e.src] ?? -1, c.rowOfSol[e.tgt] ?? -1, 'heal', 0, 0, e.amount * 100, 0);
    }
  }
  c.tick = tick;
}

const hp = (centi: number): number => Math.round(centi / 100);

/**
 * Statistics of every squad up to and including sim tick `tick` (clamped to the replay). Incremental: calling it
 * with increasing ticks only reads the new events; seeking backwards rebuilds from the start (still well under a
 * millisecond for a full battle). The returned object is fresh on every call (and cached for a repeated tick).
 */
export function squadStatsAt(d: DecodedReplay, tick: number): BattleStatsAt {
  let c = CACHE.get(d);
  if (!c) CACHE.set(d, (c = build(d)));
  const t = Math.max(0, Math.min(Math.floor(tick), d.replay.ticks));
  if (c.last && c.last.tick === t) return c.last;
  if (t < c.tick) reset(c);
  advance(d, c, t);
  const n = d.soldierCount, ft = d.replay.frameTicks || 4;
  const f = Math.max(0, Math.min(d.frameCount - 1, Math.floor(t / ft)));
  const sides: [SideStats, SideStats] = [
    { dealt: 0, taken: 0, healing: 0, losses: 0, keepDamage: c.keepAll[0], towerDamage: hp(c.towerDamage[0]) },
    { dealt: 0, taken: 0, healing: 0, losses: 0, keepDamage: c.keepAll[1], towerDamage: hp(c.towerDamage[1]) },
  ];
  const squads: SquadStats[] = c.rows.map((r) => {
    let now = 0;
    if (d.frameCount > 0) for (const i of r.info.soldiers) if (d.anim[f * n + i] !== 255) now += d.hp[f * n + i];
    const byCause: SquadStats['byCause'] = {};
    for (const [k, v] of r.cause) byCause[k] = hp(v);
    const skills: SkillStat[] = [];
    for (const [k, v] of r.skills) skills.push({ skill: k, casts: v[0], damage: hp(v[1]), healing: hp(v[2]), hits: v[3] });
    const s = sides[r.info.side];
    s.dealt += r.dealt; s.taken += r.taken; s.healing += r.healD;
    if (!r.info.summoned) s.losses += r.losses;
    return {
      row: r.info.row, squad: r.info.id, side: r.info.side, type: r.info.type, lord: r.info.lord ?? null, level: r.info.level, summoned: r.info.summoned,
      dealt: hp(r.dealt), taken: hp(r.taken), mitigated: hp(r.mit), healingDone: hp(r.healD), healingReceived: hp(r.healR), keepDamage: r.keep,
      kills: r.kills, losses: r.losses, alive: r.spawned - r.losses, soldiers: r.spawned, wipedAt: r.wipedAt, hp: now, hpMax: r.hpMax, byCause, skills,
      hpSeries: r.series.subarray(0, Math.min(r.series.length, Math.floor(t / TICK_HZ) + 1)),
    };
  });
  for (const s of sides) { s.dealt = hp(s.dealt); s.taken = hp(s.taken); s.healing = hp(s.healing); }
  c.last = { tick: t, squads, sides };
  return c.last;
}

/**
 * Who hurt whom: damage (HP) from squad row A to squad row B up to `tick`, as `pairs.get(a)?.get(b)`.
 * (Tower damage and friendly thorns are left out.) Not cached: call it for a report, not every frame.
 */
export function squadDamagePairs(d: DecodedReplay, tick: number): Map<number, Map<number, number>> {
  const raw = new Map<number, Map<number, number>>();
  const add = (a: number, b: number, dmg: number): void => {
    if (a < 0 || a >= KEEP_SRC_BASE || b < 0 || !dmg) return;
    let m = raw.get(a);
    if (!m) raw.set(a, (m = new Map()));
    m.set(b, (m.get(b) ?? 0) + dmg);
  };
  if (d.tallies) {
    for (const e of d.tallies) { if (e.tick > tick) break; add(e.src, e.tgt, e.dmg); }
  } else {
    const rows = replaySquads(d), rowOf = new Map<number, number>();
    for (const q of rows) for (const i of q.soldiers) rowOf.set(i, q.row);
    for (const e of d.events) { if (e.tick > tick) break; if (e.k === 'hit' && !e.miss) add(rowOf.get(e.src) ?? -1, rowOf.get(e.tgt) ?? -1, e.dmg * 100); }
  }
  for (const m of raw.values()) for (const [k, v] of m) m.set(k, hp(v));
  return raw;
}

/** The stats row of a MatchState squad id (not its skeleton band). */
export function squadStatsOf(st: BattleStatsAt, side: Seat, squadId: number): SquadStats | null {
  for (const q of st.squads) if (q.side === side && q.squad === squadId && !q.summoned) return q;
  return null;
}

export { TALLY_TICKS };
