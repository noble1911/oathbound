// Experiment 3: whole matches of a Hard variant against the shipped Hard bot, every Lord pairing, from both seats.
//   node tools/review/matches.ts --seeds 10 --variants static,flip,oracle,...
// Placement variants: how much re-forming, intel and formation quality are worth over a match.
// Economy variants: banking, wide (no level-ups), tall (one deployment a round).
import { isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { FIELD_W } from '../../src/sim/constants.ts';
import { hash } from '../../src/sim/rng.ts';
import type { LordId, MatchState, Seat, Squad, Vec2 } from '../../src/sim/types.ts';
import { VARIANTS as FORM } from './formations.ts';
import { KNOB, applyLayout, hardLayout, threatsOf } from './botx.ts';
import { arg, botPlanX, ci, hard, lordPairs, mean, own, playMatch, pool, relayout, type Planner } from './lib.ts';

const H = (s: MatchState, seat: Seat, knobs: Partial<typeof KNOB> = {}): void => {
  KNOB.noLevel = !!knobs.noLevel; KNOB.noLayout = !!knobs.noLayout;
  botPlanX(s, seat, 'hard', seat + 1);
  KNOB.noLevel = false; KNOB.noLayout = false;
};

const SYNC = (s: MatchState, seat: Seat): void => FORM.speedSync(s, seat);
export const VARIANTS: Record<string, Planner> = {
  hard: (s, seat) => H(s, seat),
  // never re-forms: squads placed in an earlier round go back to where they stood
  static: (s, seat) => {
    const old = new Map(s.players[seat].squads.map((q) => [q.id, own(seat, q.pos)] as [number, Vec2]));
    H(s, seat);
    relayout(s, seat, (q) => old.get(q.id) ?? null);
  },
  // Hard's buying, Normal's fixed role lanes (never reacts to the enemy's formation)
  lanes: (s, seat) => H(s, seat, { noLayout: true }),
  // Hard's formation, mirrored left-right every round (counters end up opposite the wrong enemy squads)
  flip: (s, seat) => { H(s, seat); relayout(s, seat, (q) => { const [x, y] = own(seat, q.pos); return [FIELD_W - 1 - x, y]; }); },
  // random positions among its own squads each round (a careless placer)
  shuffle: (s, seat) => {
    H(s, seat);
    const us = s.players[seat].squads.filter((q) => q.type !== 'lord');
    const spots = us.map((q) => own(seat, q.pos));
    const order = spots.map((_, i) => i).sort((a, b) => (hash(s.seed, s.round, seat, a, 'sh') % 1000) - (hash(s.seed, s.round, seat, b, 'sh') % 1000) || a - b);
    const want = new Map(us.map((q, i) => [q.id, spots[order[i]]] as [number, Vec2]));
    relayout(s, seat, (q) => want.get(q.id) ?? null);
  },
  // perfect intel: Hard's formation computed against the enemy's CURRENT positions (needs the enemy to plan first)
  oracle: (s, seat) => {
    H(s, seat);
    const e = s.players[1 - seat];
    s.players[seat].ready = false;
    applyLayout(s, seat, hardLayout(s.players[seat], threatsOf(seat, e.squads as Squad[], e.lord)));
    s.players[seat].ready = true;
  },
  // Hard, then its melee squads staggered in depth by speed so they reach the river together (formations.ts speedSync)
  sync: (s, seat) => { H(s, seat); SYNC(s, seat); },
  // economy: banks 40% of its gold in rounds 1-4 (no interest exists, so this only delays spending)
  bank: (s, seat) => {
    const p = s.players[seat];
    const hold = s.round <= 4 ? Math.floor(p.gold * 0.4) : 0;
    p.gold -= hold; H(s, seat); p.gold += hold;
  },
  // economy: wide (never levels; leftover gold is banked for later deployments)
  wide: (s, seat) => H(s, seat, { noLevel: true }),
  // economy: tall (one deployment a round, the rest goes into levels)
  tall: (s, seat) => { const p = s.players[seat]; const lim = p.deployLimit; p.deployLimit = Math.min(lim, p.deploysUsed + 1); H(s, seat); p.deployLimit = lim; },
  // economy: level nothing until round 6, then normal
  lateLevel: (s, seat) => H(s, seat, { noLevel: s.round < 6 }),
  // economy: level nothing in rounds 1-3 (the first squads are worth more than their levels), then normal
  lateLevel4: (s, seat) => H(s, seat, { noLevel: s.round < 4 }),
};

interface Job { seed: number; lords: [LordId, LordId]; v: string; seat: Seat }
interface Res { win: number; rounds: number; keep: number; roundsWon: number; roundsPlayed: number }

export function work(j: Job): Res {
  const plan: [Planner, Planner] = j.seat === 0 ? [VARIANTS[j.v], hard] : [hard, VARIANTS[j.v]];
  // the oracle plans after its opponent
  const order: [Planner, Planner] = plan;
  const wrapped: [Planner, Planner] = j.v === 'oracle'
    ? (j.seat === 0 ? [(s) => { order[1](s, 1); order[0](s, 0); }, () => {}] : [(s) => { order[0](s, 0); order[1](s, 1); }, () => {}])
    : plan;
  let roundsWon = 0, roundsPlayed = 0;
  const { s } = playMatch(j.seed, j.lords, wrapped, { post: (_s, r) => { roundsPlayed++; if (r.winner === j.seat) roundsWon++; else if (r.winner === null) roundsWon += 0.5; } });
  const me = s.players[j.seat], foe = s.players[1 - j.seat];
  return { win: s.winner === j.seat ? 1 : s.winner === 'draw' || s.winner === null ? 0.5 : 0, rounds: s.round, keep: me.keepHp / me.keepMax - foe.keepHp / foe.keepMax, roundsWon, roundsPlayed };
}

async function main(): Promise<void> {
  const seeds = Number(arg('seeds', '10'));
  const vs = arg('variants', Object.keys(VARIANTS).join(',')).split(',');
  const jobs: Job[] = [];
  for (const v of vs) {
    let seed = Number(arg('seed0', '9000'));
    for (let k = 0; k < seeds; k++) for (const lords of lordPairs()) { for (const seat of [0, 1] as Seat[]) jobs.push({ seed, lords, v, seat }); seed++; }
  }
  const t0 = performance.now();
  const res = await pool<Job, Res>(new URL(import.meta.url), jobs);
  console.log(`${jobs.length} matches (${((performance.now() - t0) / 1000).toFixed(0)} s). Each variant plays the shipped Hard bot, all 30 Lord pairings, both seats, same seeds.`);
  console.log('variant    | match win % (±95%) | round win % | avg rounds | keep margin');
  for (const v of vs) {
    const rs = res.filter((_, i) => jobs[i].v === v);
    const w = mean(rs.map((r) => r.win));
    console.log(`${v.padEnd(10)} | ${(100 * w).toFixed(1).padStart(5)} ± ${(100 * ci(w, rs.length)).toFixed(1)} | ${(100 * rs.reduce((a, r) => a + r.roundsWon, 0) / rs.reduce((a, r) => a + r.roundsPlayed, 0)).toFixed(1).padStart(5)} | ${mean(rs.map((r) => r.rounds)).toFixed(2)} | ${(100 * mean(rs.map((r) => r.keep))).toFixed(1)}`);
  }
}

if (isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
