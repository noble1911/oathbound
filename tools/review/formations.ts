// Experiment 1: does placement decide battles? Hard vs Hard matches; before every battle, one seat's army (the
// same squads, items and levels) is re-placed in a different formation and the battle is re-run against the same
// enemy. Reports how often the round result changes and the keep-damage swing.
//   node tools/review/formations.ts --seeds 5
import { isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { FIELD_W } from '../../src/sim/constants.ts';
import { simulateBattle } from '../../src/sim/battle.ts';
import { hash } from '../../src/sim/rng.ts';
import { UNITS } from '../../src/sim/data/units.ts';
import type { LordId, MatchState, Seat, Squad, Vec2 } from '../../src/sim/types.ts';
import { arg, hard, lordPairs, mean, outcome, own, placeFor, playMatch, pool, relayout, swing } from './lib.ts';

type V = (s: MatchState, seat: Seat) => void;
const xy = (seat: Seat, q: Squad): Vec2 => own(seat, q.pos);
const map = (f: (x: number, y: number, q: Squad) => Vec2, units = true, lord = true): V => (s, seat) =>
  relayout(s, seat, (q) => ((q.type === 'lord' ? lord : units) ? f(...xy(seat, q), q) : null));

export const VARIANTS: Record<string, V> = {
  mirrorX: map((x, y) => [FIELD_W - 1 - x, y]),
  hugLeft: map((x, y) => [200 + (x - 200) * 0.4, y]),
  hugRight: map((x, y) => [7799 - (7799 - x) * 0.4, y]),
  blob: map((x, y) => [4000 + (x - 4000) * 0.4, y]),
  wide: map((x, y) => [4000 + (x - 4000) * 1.6, y]),
  forward: map((x, y) => [x, y + 1000]),
  back: map((x, y) => [x, y - 1500]),
  flatLine: map((x, y) => [x, 3000 + (y - 3000) * 0.25]),
  depthFlip: map((x, y) => [x, 4399 - y]),
  lanes: (s, seat) => {
    const placed: Squad[] = [];
    const p = s.players[seat];
    relayout(s, seat, (q) => { const w = placeFor(q.type, placed, p.lord); placed.push(q); return w; });
  },
  oneRow: (s, seat) => {
    let n = 0;
    relayout(s, seat, (q) => (q.type === 'lord' ? null : [1000 + ((n++ * 900) % 6000), 2800]));
  },
  shuffle: (s, seat) => {
    const p = s.players[seat];
    const us = p.squads.filter((q) => q.type !== 'lord');
    const spots = us.map((q) => xy(seat, q));
    const order = spots.map((_, i) => i).sort((a, b) => (hash(s.seed, s.round, seat, a, 'sh') % 1000) - (hash(s.seed, s.round, seat, b, 'sh') % 1000) || a - b);
    const want = new Map(us.map((q, i) => [q.id, spots[order[i]]]));
    relayout(s, seat, (q) => want.get(q.id) ?? null);
  },
  nudge1m: map((x, y) => [x + 100, y]),
  nudgeOne: (s, seat) => { const q = s.players[seat].squads.find((x) => x.type !== 'lord'); relayout(s, seat, (x) => (x === q ? [own(seat, x.pos)[0] + 100, own(seat, x.pos)[1]] : null)); },
  // Mechabellum-style timing: melee squads are staggered in depth by speed so that they reach the river together
  // (the slowest at the front edge of the zone, faster ones further back); ranged squads keep their spot.
  speedSync: (s, seat) => {
    const melee = s.players[seat].squads.filter((q) => q.type !== 'lord' && UNITS[q.type].range <= 400);
    if (!melee.length) return;
    const vmin = Math.min(...melee.map((q) => UNITS[q.type as keyof typeof UNITS].speed));
    const T = (6000 - 3999) / vmin;
    relayout(s, seat, (q) => (melee.includes(q) ? [own(seat, q.pos)[0], Math.max(400, 6000 - T * UNITS[q.type as keyof typeof UNITS].speed)] : null));
  },
  face90: (s, seat) => { for (const q of s.players[seat].squads) q.facing = (q.facing + 64) & 255; },
  lordFront: map((x) => [x, 3900], false, true),
  lordCorner: map(() => [300, 450], false, true),
  lordFlank: map(() => [7600, 3200], false, true),
};

const ONLY = arg('only', '') ? arg('only', '').split(',') : [];
interface Job { seed: number; lords: [LordId, LordId] }
interface Row { round: number; base: [number, number][]; v: Record<string, [number, number][]>; size: number }

export function work(j: Job): Row[] {
  const rows: Row[] = [];
  playMatch(j.seed, j.lords, [hard, hard], {
    post: (s, base) => {
      const row: Row = { round: s.round, base: [[outcome(base, 0), swing(base, 0)], [outcome(base, 1), swing(base, 1)]], v: {}, size: s.players[0].squads.length };
      for (const [name, f] of Object.entries(VARIANTS).filter(([n]) => ONLY.length === 0 || ONLY.includes(n))) {
        row.v[name] = ([0, 1] as Seat[]).map((seat) => {
          const c = structuredClone(s);
          f(c, seat);
          const { result } = simulateBattle(c, { record: false });
          return [outcome(result, seat), swing(result, seat)] as [number, number];
        });
      }
      rows.push(row);
    },
  });
  return rows;
}

async function main(): Promise<void> {
  const seeds = Number(arg('seeds', '5'));
  const jobs: Job[] = [];
  let seed = Number(arg('seed0', '5000'));
  for (let k = 0; k < seeds; k++) for (const lords of lordPairs()) jobs.push({ seed: seed++, lords });
  const t0 = performance.now();
  const all = (await pool<Job, Row[]>(new URL(import.meta.url), jobs)).flat();
  console.log(`${jobs.length} matches, ${all.length} battles x ${Object.keys(VARIANTS).length} variants x 2 seats (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  const buckets: [string, (r: number) => boolean][] = [['all', () => true], ['r1-3', (r) => r <= 3], ['r4-6', (r) => r >= 4 && r <= 6], ['r7+', (r) => r >= 7]];
  for (const [bn, inB] of buckets) {
    const rs = all.filter((r) => inB(r.round));
    console.log(`\n== ${bn}: ${rs.length} battles (x2 seats) | base timeouts/stalls n/a`);
    console.log('variant      | win% (base 50) | result changed | better | worse | mean keep swing vs base');
    for (const name of Object.keys(VARIANTS).filter((n) => ONLY.length === 0 || ONLY.includes(n))) {
      const o: number[] = [], ch: number[] = [], up: number[] = [], dn: number[] = [], sw: number[] = [];
      for (const r of rs) for (const seat of [0, 1]) {
        const [vo, vs] = r.v[name][seat], [bo, bs] = r.base[seat];
        o.push(vo); ch.push(vo !== bo ? 1 : 0); up.push(vo > bo ? 1 : 0); dn.push(vo < bo ? 1 : 0); sw.push(vs - bs);
      }
      console.log(`${name.padEnd(12)} | ${(100 * mean(o)).toFixed(1).padStart(5)} | ${(100 * mean(ch)).toFixed(1).padStart(5)}% | ${(100 * mean(up)).toFixed(1).padStart(5)}% | ${(100 * mean(dn)).toFixed(1).padStart(5)}% | ${mean(sw).toFixed(0).padStart(5)}`);
    }
    // Best-of-formations: could the side that lost (or drew) the base battle have won with one of the army-wide formations?
    const pos = Object.keys(VARIANTS).filter((n) => !n.startsWith('lord') && !n.startsWith('nudge') && n !== 'speedSync' && (ONLY.length === 0 || ONLY.includes(n)));
    let flippable = 0, notWon = 0, anyChange = 0, n = 0;
    for (const r of rs) for (const seat of [0, 1]) {
      n++;
      const outs = pos.map((k) => r.v[k][seat][0]);
      if (Math.max(...outs) !== Math.min(...outs) || outs.some((x) => x !== r.base[seat][0])) anyChange++;
      if (r.base[seat][0] < 1) { notWon++; if (Math.max(...outs) === 1) flippable++; }
    }
    console.log(`Some formation gives a different result: ${(100 * anyChange / n).toFixed(1)}% | a round not won could be won by one of the ${pos.length} formations: ${(100 * flippable / Math.max(1, notWon)).toFixed(1)}% (n=${notWon})`);
  }
}

if (isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
