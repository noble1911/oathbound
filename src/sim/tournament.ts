// Headless bot-vs-bot matches and the balance report (DESIGN §8). Used by tools/tournament.ts and the smoke test.
import { LORD_IDS } from './data/lords.ts';
import { UNIT_TYPES } from './data/units.ts';
import { botPlan } from './bot.ts';
import { simulateBattle } from './battle.ts';
import { applyBattle, newMatch, nextRound } from './match.ts';
import type { BotStrategy, LordId, Seat, UnitType } from './types.ts';

export interface BattleRecord {
  winner: Seat | null;
  ticks: number;
  /** Gold invested per unit type, per seat. */
  gold: [Partial<Record<UnitType, number>>, Partial<Record<UnitType, number>>];
  legend: [string[], string[]];
}
export interface MatchRecord {
  seed: number;
  lords: [LordId, LordId];
  strats: [BotStrategy, BotStrategy];
  winner: Seat | 'draw' | null;
  rounds: number;
  battles: BattleRecord[];
}

export function playMatch(seed: number, lords: [LordId, LordId], strats: [BotStrategy, BotStrategy]): MatchRecord {
  const s = newMatch(seed, lords);
  const battles: BattleRecord[] = [];
  while (s.phase === 'planning') {
    botPlan(s, 0, strats[0], 1);
    botPlan(s, 1, strats[1], 2);
    const gold: BattleRecord['gold'] = [{}, {}];
    const legend: BattleRecord['legend'] = [[], []];
    for (const seat of [0, 1] as Seat[]) {
      for (const q of s.players[seat].squads) {
        if (q.type !== 'lord') gold[seat][q.type] = (gold[seat][q.type] ?? 0) + q.spent;
        for (const it of [q.items.weapon, q.items.armor, q.items.relic]) if (it?.legendary && !legend[seat].includes(it.legendary)) legend[seat].push(it.legendary);
      }
    }
    const { result } = simulateBattle(s, { record: false });
    battles.push({ winner: result.winner, ticks: result.ticks, gold, legend });
    applyBattle(s, result);
    if ((s.phase as string) !== 'results') break;
    nextRound(s);
  }
  return { seed, lords, strats, winner: s.winner, rounds: s.round, battles };
}

export interface Report {
  matches: number;
  p0: number; // P0 win share (draws half)
  lords: Record<string, number>;
  lordGames: Record<string, number>;
  strats: Record<string, number>;
  units: Record<string, number>;
  unitSamples: Record<string, number>;
  /** Same metric restricted to battles where neither army had fliers (removes the anti-air reaction confound). */
  unitsNoAir: Record<string, number>;
  legends: Record<string, number>;
  legendSamples: Record<string, number>;
  /** stratMatrix[a][b] = win rate of strategy a vs strategy b. */
  stratMatrix: Record<string, Record<string, number>>;
  /** lordMatrix[a][b] = win rate of Lord a vs Lord b. */
  lordMatrix: Record<string, Record<string, number>>;
  rounds: number;
  battleSec: number;
  timeouts: number;
  draws: number;
}

export function aggregate(recs: MatchRecord[]): Report {
  const w = (r: MatchRecord, seat: Seat): number => (r.winner === seat ? 1 : r.winner === 'draw' || r.winner === null ? 0.5 : 0);
  const lords: Record<string, [number, number]> = {}, strats: Record<string, [number, number]> = {};
  const unitsNoAir: Record<string, [number, number]> = {};
  const units: Record<string, [number, number]> = {}, legends: Record<string, [number, number]> = {};
  const sm: Record<string, Record<string, [number, number]>> = {}, lm: Record<string, Record<string, [number, number]>> = {};
  const add2 = (m: Record<string, Record<string, [number, number]>>, a: string, b: string, win: number): void => {
    const e = ((m[a] ??= {})[b] ??= [0, 0]);
    e[0] += win; e[1]++;
  };
  let p0 = 0, rounds = 0, ticks = 0, battles = 0, timeouts = 0, draws = 0;
  const add = (m: Record<string, [number, number]>, k: string, win: number, n = 1): void => {
    const e = (m[k] ??= [0, 0]);
    e[0] += win * n; e[1] += n;
  };
  for (const r of recs) {
    p0 += w(r, 0);
    rounds += r.rounds;
    if (r.winner === 'draw') draws++;
    for (const seat of [0, 1] as Seat[]) {
      if (r.lords[0] !== r.lords[1]) add(lords, r.lords[seat], w(r, seat));
      if (r.strats[0] !== r.strats[1]) add(strats, r.strats[seat], w(r, seat));
      add2(sm, r.strats[seat], r.strats[1 - seat], w(r, seat));
      add2(lm, r.lords[seat], r.lords[1 - seat], w(r, seat));
    }
    for (const b of r.battles) {
      battles++;
      ticks += b.ticks;
      if (b.winner === null) { timeouts++; continue; }
      const win = b.winner, lose = (1 - win) as Seat;
      const hasAir = (g: Partial<Record<UnitType, number>>): boolean => !!(g.pegasus || g.wyvern || g.dragon);
      const tot = (g: Partial<Record<UnitType, number>>): number => Object.values(g).reduce((a, x) => a + (x ?? 0), 0) || 1;
      const tw = tot(b.gold[win]), tl = tot(b.gold[lose]);
      for (const u of UNIT_TYPES) {
        const sw = (b.gold[win][u] ?? 0) / tw, sl = (b.gold[lose][u] ?? 0) / tl;
        if (sw + sl > 0) { const e = (units[u] ??= [0, 0]); e[0] += sw; e[1] += sw + sl; }
        if (sw + sl > 0 && !hasAir(b.gold[win]) && !hasAir(b.gold[lose])) { const e = (unitsNoAir[u] ??= [0, 0]); e[0] += sw; e[1] += sw + sl; }
      }
      // Legendaries are compared head-to-head: only battles where both armies hold the same number (>= 1) of
      // legendaries count, which removes the catch-up bias (round losers roll legendaries more often).
      if (b.legend[win].length && b.legend[win].length === b.legend[lose].length) {
        for (const l of b.legend[win]) if (!b.legend[lose].includes(l)) add(legends, l, 1);
        for (const l of b.legend[lose]) if (!b.legend[win].includes(l)) add(legends, l, 0);
      }
    }
  }
  const rate = (m: Record<string, [number, number]>): Record<string, number> => Object.fromEntries(Object.entries(m).map(([k, [a, n]]) => [k, n ? a / n : 0]));
  const samples = (m: Record<string, [number, number]>): Record<string, number> => Object.fromEntries(Object.entries(m).map(([k, [, n]]) => [k, n]));
  return {
    matches: recs.length, p0: p0 / Math.max(1, recs.length), lords: rate(lords), lordGames: samples(lords), strats: rate(strats),
    units: rate(units), unitSamples: samples(units), unitsNoAir: rate(unitsNoAir), legends: rate(legends), legendSamples: samples(legends),
    stratMatrix: Object.fromEntries(Object.entries(sm).map(([a, row]) => [a, rate(row)])),
    lordMatrix: Object.fromEntries(Object.entries(lm).map(([a, row]) => [a, rate(row)])),
    rounds: rounds / Math.max(1, recs.length), battleSec: ticks / Math.max(1, battles) / 20, timeouts: timeouts / Math.max(1, battles), draws,
  };
}

const pct = (x: number): string => (100 * x).toFixed(1) + '%';
export function formatReport(r: Report): string {
  const L: string[] = [];
  L.push(`matches ${r.matches} | P0 win ${pct(r.p0)} | avg rounds ${r.rounds.toFixed(2)} | avg battle ${r.battleSec.toFixed(1)} s | timeouts ${pct(r.timeouts)} | draws ${r.draws}`);
  L.push('Lords: ' + LORD_IDS.map((l) => `${l} ${pct(r.lords[l] ?? 0)}`).join(', '));
  L.push('Strategies: ' + Object.entries(r.strats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`).join(', '));
  L.push('Units (cost-normalised share in round winners): ' + UNIT_TYPES.map((u) => `${u} ${pct(r.units[u] ?? 0)} (n=${(r.unitSamples[u] ?? 0).toFixed(0)})`).join(', '));
  if (r.unitsNoAir) L.push('Units, battles without fliers: ' + UNIT_TYPES.filter((u) => r.unitsNoAir[u] !== undefined).map((u) => `${u} ${pct(r.unitsNoAir[u])}`).join(', '));
  L.push('Legendaries: ' + Object.entries(r.legends).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)} (n=${r.legendSamples[k]})`).join(', '));
  const mat = (m: Record<string, Record<string, number>>, title: string): void => {
    const keys = Object.keys(m).sort();
    L.push(title.padEnd(10) + keys.map((k) => k.slice(0, 8).padStart(9)).join(''));
    for (const a of keys) L.push(a.padEnd(10) + keys.map((b) => (m[a][b] === undefined ? '-' : (100 * m[a][b]).toFixed(0)).padStart(9)).join(''));
  };
  if (r.stratMatrix) mat(r.stratMatrix, 'strat');
  if (r.lordMatrix) mat(r.lordMatrix, 'lord');
  return L.join('\n');
}

export const TOURNAMENT_STRATEGIES: BotStrategy[] = ['rush', 'ranged', 'armor', 'air', 'counter', 'random'];
