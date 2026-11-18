// Shared helpers for the positioning-and-economy review (docs/reviews/POSITIONING-AND-ECONOMY.md).
// Analysis only: nothing here is used by the game. Run the experiment scripts next to this file with node.
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { mirrorPos } from '../../src/sim/constants.ts';
import { simulateBattle } from '../../src/sim/battle.ts';
import { applyBattle, freeSpotNear, newMatch, nextRound } from '../../src/sim/match.ts';
import { LORD_IDS } from '../../src/sim/data/lords.ts';
import { UNITS } from '../../src/sim/data/units.ts';
import { KNOB, botPlan as botPlanX, placeFor } from './botx.ts';
import type { BattleResult, LordId, MatchState, Seat, Squad, Vec2 } from '../../src/sim/types.ts';

export const ALL_LORDS = LORD_IDS as readonly LordId[];
export type Planner = (s: MatchState, seat: Seat) => void;

/** Every ordered pair of distinct Lords (30), the tournament's pairing set. */
export function lordPairs(): [LordId, LordId][] {
  const out: [LordId, LordId][] = [];
  for (const a of ALL_LORDS) for (const b of ALL_LORDS) if (a !== b) out.push([a, b]);
  return out;
}

export function arg(name: string, def: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

/** Hard (the real bot, via the review copy so knobs are reset to the shipped behaviour). */
export const hard: Planner = (s, seat) => { KNOB.noLevel = false; KNOB.noLayout = false; botPlanX(s, seat, 'hard', seat + 1); };
export const normal: Planner = (s, seat) => botPlanX(s, seat, 'normal', seat + 1);

/** Squad position in the seat's own frame (own zone is low y, the enemy is at high y). */
export const own = (seat: Seat, p: Vec2): Vec2 => (seat === 0 ? [p[0], p[1]] : mirrorPos(p));
export const world = own; // the mirror is its own inverse

/**
 * Re-place every squad of `seat` at `want(q)` (seat-local frame), in order, through freeSpotNear so the result is
 * always legal. Squads not returned by `want` (null) keep their spot.
 */
export function relayout(s: MatchState, seat: Seat, want: (q: Squad, i: number) => Vec2 | null): void {
  const p = s.players[seat];
  const placed: Squad[] = [];
  const order = [...p.squads];
  const targets = order.map((q, i) => want(q, i));
  // squads that keep their spot are placed first
  for (let i = 0; i < order.length; i++) if (!targets[i]) placed.push(order[i]);
  for (let i = 0; i < order.length; i++) {
    const t = targets[i];
    if (!t) continue;
    const q = order[i];
    const spot = freeSpotNear(placed, seat, q.type, world(seat, [Math.round(t[0]), Math.round(t[1])]), q.id);
    if (spot) q.pos = spot;
    placed.push(q);
  }
}

export interface Round { round: number; result: BattleResult; before: MatchState }

/**
 * Play one match between two planners. `pre(s)` may alter the planned state just before the battle (it gets a
 * clone it may keep). Returns per-round records.
 */
export function playMatch(seed: number, lords: [LordId, LordId], plan: [Planner, Planner], opt: { record?: boolean; pre?: (s: MatchState) => void; keep?: boolean; post?: (s: MatchState, r: BattleResult, before: MatchState | null) => void } = {}): { s: MatchState; rounds: Round[] } {
  const s = newMatch(seed, lords);
  const rounds: Round[] = [];
  while (s.phase === 'planning') {
    plan[0](s, 0);
    plan[1](s, 1);
    if (opt.pre) opt.pre(s);
    const before = opt.keep ? structuredClone(s) : null;
    const { result } = simulateBattle(s, { record: !!opt.record });
    if (opt.post) opt.post(s, result, before);
    if (before) rounds.push({ round: s.round, result, before });
    applyBattle(s, result);
    if ((s.phase as string) !== 'results') break;
    nextRound(s);
  }
  return { s, rounds };
}

/** Battle value of a result for `seat`: keep damage dealt minus taken (the currency of the match). */
export function swing(r: BattleResult, seat: Seat): number {
  return r.keepDamage[1 - seat] - r.keepDamage[seat];
}
export function outcome(r: BattleResult, seat: Seat): 1 | 0.5 | 0 {
  return r.winner === null ? 0.5 : r.winner === seat ? 1 : 0;
}

/** Run `jobs` through `script`'s exported `work(job)` on worker threads; results in job order. */
export async function pool<J, R>(script: URL, jobs: J[], threads = Math.max(1, Number(process.env.OB_THREADS) || availableParallelism() - 4)): Promise<R[]> {
  const chunks: { idx: number; job: J }[][] = Array.from({ length: threads }, () => []);
  jobs.forEach((job, idx) => chunks[idx % threads].push({ idx, job }));
  const out: R[] = new Array(jobs.length);
  await Promise.all(chunks.filter((c) => c.length).map((c) => new Promise<void>((res, rej) => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { script: script.href, jobs: c } });
    w.once('message', (rs: { idx: number; r: R }[]) => { for (const x of rs) out[x.idx] = x.r; res(); });
    w.once('error', rej);
  })));
  return out;
}

export const unitSpeed = (t: Squad['type']): number => (t === 'lord' ? 0 : UNITS[t].speed);
export { placeFor, KNOB, botPlanX };

export const pct = (x: number, d = 1): string => (100 * x).toFixed(d) + '%';
export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** 95% half-width of a proportion. */
export const ci = (p: number, n: number): number => 1.96 * Math.sqrt(Math.max(1e-9, p * (1 - p)) / Math.max(1, n));
