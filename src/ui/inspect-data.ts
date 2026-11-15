// The battle inspector's data, with no DOM in it (src/ui/inspector.ts draws it; the tests read it).
// One squad of a replay at a tick: who it is, how it is doing (the sim's ledger, src/sim/stats.ts),
// where its damage comes from, how it ranks on its side, what it can do and what each ability has
// done so far, and its sheet (base -> effective stats, items). Plus the pair view for compare mode.
import type { DecodedReplay, FactionId, LordId, ReplaySquad, Seat, SkillId, SkillInfo, SquadType, StatCause } from '../sim/types.ts';
import { UNITS } from '../sim/data/units.ts';
import { LORDS, LORD_ABILITY_IDS } from '../sim/data/lords.ts';
import { LEGENDARIES } from '../sim/data/items.ts';
import { SKILLS } from '../sim/data/skills.ts';
import { replaySquadSheet, type SquadSheet } from '../sim/sheet.ts';
import { replaySquads, squadDamagePairs, type BattleStatsAt, type SquadStats } from '../sim/stats.ts';
import { unitName } from './gamedata.ts';

export interface CauseShare {
  cause: StatCause | 'other';
  label: string;
  value: number;
  /** 0..1 of the squad's damage dealt. */
  share: number;
}

export interface SkillRow {
  info: SkillInfo;
  /** Times it fired so far: item skills from the ledger, Lord abilities from their events. Null = a passive. */
  casts: number | null;
  damage: number;
  healing: number;
  hits: number;
}

export interface InspectModel {
  row: number;
  squad: number;
  side: Seat;
  type: SquadType;
  lord: LordId | null;
  name: string;
  role: string;
  level: number;
  alive: number;
  soldiers: number;
  hp: number;
  hpMax: number;
  /** Sim tick its last soldier fell, -1 while it stands. */
  wipedAt: number;
  dealt: number;
  taken: number;
  mitigated: number;
  healingDone: number;
  healingReceived: number;
  kills: number;
  losses: number;
  keepDamage: number;
  /** Largest first, at most five and then "Other". */
  causes: CauseShare[];
  /** The squad's faction (a Lord's own; a unit's roster), for the header. */
  faction: FactionId;
  /** "2nd-highest damage on your side", or '' before anybody has done anything. */
  rank: string;
  /** Still standing and untouched: it has neither dealt nor taken nor healed anything (Lords and the back line early on). */
  idle: boolean;
  skills: SkillRow[];
  /** Total life once per second from the start to now. */
  series: number[];
  sheet: SquadSheet | null;
}

const CAUSE_LABEL: Partial<Record<StatCause, string>> = {
  attack: 'Attacks', burn: 'Burning', thorns: 'Thorns', tower: 'Keep towers', chain: LEGENDARIES.stormcaller?.name ?? 'Chain lightning',
  ember_burst: 'Ember Crown', sunfire: 'Sunfire Mantle', meteor: 'Meteor', skyfall: 'Skyfall', rout: 'Rout',
  heal: 'Healing', leech: 'Lifesteal', lifebinder: 'Lifebinder', bloodthirst: 'Bloodthirst', revive: 'Revive',
  radiance: 'Radiance', regen: 'Regeneration',
  soul_reap: 'Soul Reaping', plague_breath: 'Plague Breath', whirlwind: 'Djinn Whirlwind', stampede: 'Stampede', talon: 'Talon Strike',
};

export function causeLabel(c: StatCause | 'other'): string {
  if (c === 'other') return 'Other';
  return CAUSE_LABEL[c] ?? SKILLS[c as SkillId]?.name ?? c;
}

/** "1st", "2nd", "3rd", "4th", "11th", "22nd". */
export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

interface Index { rowOf: Int32Array; lordCasts: { tick: number; row: number; ability: string }[] }
const INDEX = new WeakMap<DecodedReplay, Index>();
const LORD_ABILITIES: ReadonlySet<string> = new Set(LORD_ABILITY_IDS);

function index(d: DecodedReplay): Index {
  let ix = INDEX.get(d);
  if (ix) return ix;
  const rows = replaySquads(d);
  const rowOf = new Int32Array(d.replay.soldiers.length).fill(-1);
  for (const q of rows) for (const i of q.soldiers) if (i >= 0 && i < rowOf.length) rowOf[i] = q.row;
  const lordCasts: Index['lordCasts'] = [];
  for (const e of d.events) if (e.k === 'ability' && LORD_ABILITIES.has(e.ability) && !(e.ability === 'grave_taunt' && e.radius === 0) && d.replay.soldiers[e.src]?.type === 'lord' && rowOf[e.src] !== undefined && rowOf[e.src]! >= 0) lordCasts.push({ tick: e.tick, row: rowOf[e.src]!, ability: e.ability });
  INDEX.set(d, (ix = { rowOf, lordCasts }));
  return ix;
}

/** A raised band (skeletons) is inspected as the squad that raised it. */
export function inspectRow(d: DecodedReplay, row: number): number {
  const rows = replaySquads(d);
  const q = rows[row];
  if (!q) return -1;
  if (!q.summoned) return row;
  const owner = rows.find((x) => x.id === q.id && x.side === q.side && !x.summoned);
  return owner ? owner.row : -1;
}

/** The inspectable row of a replay soldier (the engine's pick), or -1. */
export function rowOfSoldier(d: DecodedReplay, soldier: number): number {
  const r = index(d).rowOf[soldier];
  return r === undefined || r < 0 ? -1 : inspectRow(d, r);
}

/** The inspectable row of a MatchState squad id (battle report rows), or -1. */
export function rowOfSquad(d: DecodedReplay, squadId: number, side?: Seat): number {
  const q = replaySquads(d).find((x) => x.id === squadId && !x.summoned && (side === undefined || x.side === side));
  return q ? q.row : -1;
}

/** Tab order: the viewer's side first, each side with its Lord first and then by row. */
export function cycleRows(d: DecodedReplay, viewer: Seat | null): number[] {
  const me = viewer ?? 0;
  const rank = (q: ReplaySquad): number => (q.side === me ? 0 : 1000) + (q.type === 'lord' ? 0 : 1 + q.row);
  return replaySquads(d).filter((q) => !q.summoned).sort((a, b) => rank(a) - rank(b)).map((q) => q.row);
}

/** "Your" / "Enemy", or the commander's name for a spectator. */
export function sideWord(side: Seat, viewer: Seat | null, names: [string, string], possessive = true): string {
  if (viewer === null) return possessive ? `${names[side]}'s` : names[side];
  return side === viewer ? (possessive ? 'your' : 'you') : possessive ? 'the enemy' : 'the enemy';
}

/**
 * Where the squad stands among its own side. Damage for fighters; healing for a squad that has
 * healed more than it has hurt. Squads that have done nothing yet get no rank.
 */
export function rankHint(st: BattleStatsAt, row: number, viewer: Seat | null, names: [string, string]): string {
  const me = st.squads[row];
  if (!me) return '';
  const healer = me.healingDone > me.dealt;
  const val = (q: SquadStats): number => (healer ? q.healingDone : q.dealt);
  if (val(me) <= 0) return '';
  const peers = st.squads.filter((q) => !q.summoned);
  const side = peers.filter((q) => q.side === me.side);
  const place = 1 + side.filter((q) => val(q) > val(me)).length;
  const what = healer ? 'healing' : 'damage';
  const where = viewer === null ? `${names[me.side]}'s side` : me.side === viewer ? 'your side' : 'the enemy side';
  if (place === 1 && !peers.some((q) => val(q) > val(me)) && peers.length > side.length) return `Highest ${what} on the field`;
  if (place === 1) return `Highest ${what} on ${where}`;
  return `${ordinal(place)}-highest ${what} on ${where} (of ${side.length})`;
}

export function causeShares(byCause: SquadStats['byCause'], max = 5): CauseShare[] {
  const all = (Object.entries(byCause) as [StatCause, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = all.reduce((a, [, v]) => a + v, 0);
  if (!total) return [];
  const out: CauseShare[] = all.slice(0, max).map(([cause, value]) => ({ cause, label: causeLabel(cause), value, share: value / total }));
  const rest = all.slice(max).reduce((a, [, v]) => a + v, 0);
  if (rest > 0) out.push({ cause: 'other', label: 'Other', value: rest, share: rest / total });
  return out;
}

/** Everything the inspector shows for squad `row` at the tick `st` was taken at. Null for a bad row. */
export function inspectModel(d: DecodedReplay, st: BattleStatsAt, row: number, viewer: Seat | null, names: [string, string] = ['Blue', 'Red']): InspectModel | null {
  const q = st.squads[row];
  const info = replaySquads(d)[row];
  if (!q || !info || q.summoned) return null;
  const type = q.type as SquadType;
  const lord = type === 'lord' ? (q.lord ?? info.ownerLord ?? null) : null;
  const sheet = d.replay.squads?.length ? replaySquadSheet(d.replay, row) : null;
  const L = lord ? LORDS[lord] : null;
  const ix = index(d);
  const skills: SkillRow[] = (sheet?.skills ?? []).map((k) => {
    if (k.skill) {
      const s = q.skills.find((x) => x.skill === k.skill);
      return { info: k, casts: s?.casts ?? 0, damage: s?.damage ?? 0, healing: s?.healing ?? 0, hits: s?.hits ?? 0 };
    }
    if (k.source === 'lord' && k.kind === 'active') {
      let casts = 0;
      for (const c of ix.lordCasts) { if (c.tick > st.tick) break; if (c.row === row && c.ability === k.id) casts++; }
      return { info: k, casts, damage: q.byCause[k.id as StatCause] ?? 0, healing: 0, hits: 0 };
    }
    return { info: k, casts: null, damage: q.byCause[k.id as StatCause] ?? 0, healing: 0, hits: 0 };
  });
  return {
    row, squad: q.squad, side: q.side, type, lord, faction: type === 'lord' ? (lord ? LORDS[lord].faction : 'kingdom') : UNITS[type].faction,
    name: L ? `${L.title} ${L.name}` : unitName(type, lord), role: sheet?.role ?? (type === 'lord' ? 'Lord' : ''), level: q.level,
    alive: Math.max(0, q.alive), soldiers: q.soldiers, hp: q.hp, hpMax: q.hpMax, wipedAt: q.wipedAt,
    dealt: q.dealt, taken: q.taken, mitigated: q.mitigated, healingDone: q.healingDone, healingReceived: q.healingReceived,
    kills: q.kills, losses: q.losses, keepDamage: q.keepDamage,
    causes: causeShares(q.byCause), rank: rankHint(st, row, viewer, names), idle: q.alive > 0 && q.dealt + q.taken + q.healingDone + q.healingReceived + q.keepDamage === 0,
    skills, series: Array.from(q.hpSeries), sheet,
  };
}

/** The item-skill and Lord-ability casts of the replay in tick order, for the kill feed and chip flashes. */
export interface CastEvent { tick: number; row: number; id: string; name: string; lord: boolean }
const CASTS = new WeakMap<DecodedReplay, CastEvent[]>();
export function castEvents(d: DecodedReplay): CastEvent[] {
  let out = CASTS.get(d);
  if (out) return out;
  out = [];
  for (const e of d.skills ?? []) {
    const row = inspectRow(d, e.squad);
    if (row >= 0) out.push({ tick: e.tick, row, id: e.skill, name: SKILLS[e.skill]?.name ?? e.skill, lord: false });
  }
  for (const c of index(d).lordCasts) {
    const q = replaySquads(d)[c.row];
    const lord = q?.lord ?? q?.ownerLord ?? null;
    out.push({ tick: c.tick, row: c.row, id: c.ability, name: lord ? LORDS[lord].abilityName : c.ability, lord: true });
  }
  out.sort((a, b) => a.tick - b.tick);
  CASTS.set(d, out);
  return out;
}

export interface PairModel {
  /** Damage A has done to B, and B to A, so far. */
  aToB: number;
  bToA: number;
  /** That damage as a share of the victim's full life (0..1+): "your knights took 38% of their life from these pikemen". */
  aToBShare: number;
  bToAShare: number;
}

export function pairModel(d: DecodedReplay, st: BattleStatsAt, a: number, b: number): PairModel {
  const pairs = squadDamagePairs(d, st.tick);
  // a raised band's damage counts for the squad that raised it
  const rows = replaySquads(d);
  const fam = (row: number): number[] => rows.filter((q) => q.row === row || (q.summoned && inspectRow(d, q.row) === row)).map((q) => q.row);
  const sum = (from: number[], to: number[]): number => from.reduce((acc, f) => acc + to.reduce((x, t) => x + (pairs.get(f)?.get(t) ?? 0), 0), 0);
  const aToB = sum(fam(a), fam(b)), bToA = sum(fam(b), fam(a));
  const life = (row: number): number => Math.max(1, st.squads[row]?.hpMax ?? 1);
  return { aToB, bToA, aToBShare: aToB / life(b), bToAShare: bToA / life(a) };
}

/** The sparkline shows at least this many seconds, so the first moments of a battle are not one stretched sample. */
export const SPARK_MIN_S = 20;

/**
 * An SVG path of a life series in a w x h box: the line, and the same closed to the baseline for a
 * fill. The x axis is the battle so far (`span` seconds, at least the number of samples), so the
 * line always ends at "now" on the right when `span` is left out; `pad` keeps a full-life line off
 * the top edge and an empty one off the bottom, where the box border would hide it.
 */
export function sparkPath(series: ArrayLike<number>, max: number, w: number, h: number, span = 0, pad = 0): { line: string; area: string } {
  const n = series.length;
  if (n === 0 || max <= 0) return { line: '', area: '' };
  const steps = Math.max(1, span > 0 ? span : n - 1, n - 1);
  const yOf = (v: number): number => pad + (1 - Math.max(0, Math.min(1, v / max))) * (h - 2 * pad);
  const pt = (i: number): string => `${((i / steps) * w).toFixed(1)},${yOf(series[i]!).toFixed(1)}`;
  let line = `M${pt(0)}`;
  for (let i = 1; i < n; i++) line += `L${pt(i)}`;
  // a lone sample is drawn as a short level stroke rather than an invisible point
  const lastX = n === 1 ? Math.min(w, w / steps) : ((n - 1) / steps) * w;
  if (n === 1) line += `L${lastX.toFixed(1)},${yOf(series[0]!).toFixed(1)}`;
  return { line, area: `${line}L${lastX.toFixed(1)},${h}L0,${h}Z` };
}

/** "0:42" for a sim tick. */
export function tickClock(tick: number, hz = 20): string {
  const s = Math.max(0, Math.floor(tick / hz));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
