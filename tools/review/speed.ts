// Experiment 2: march speed, arrival order and the river crossings, from recorded Hard vs Hard battles.
//   node tools/review/speed.ts --seeds 3
// Per squad: the tick it first deals or takes damage ("contact"), when it is wiped, and how far ahead of its own
// army's main body (value-weighted median contact) it arrived. Per ground soldier: where it crossed the river.
import { isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { simulateBattle } from '../../src/sim/battle.ts';
import { decodeReplay } from '../../src/sim/replay.ts';
import { squadStatsAt } from '../../src/sim/stats.ts';
import { UNITS } from '../../src/sim/data/units.ts';
import { LORDS } from '../../src/sim/data/lords.ts';
import { RIVER_Y0, RIVER_Y1 } from '../../src/sim/terrain.ts';
import type { LordId, Seat } from '../../src/sim/types.ts';
import { arg, hard, lordPairs, mean, playMatch, pool } from './lib.ts';

interface Job { seed: number; lords: [LordId, LordId] }
interface SqRec { type: string; side: Seat; contact: number; lead: number; wiped: number; aloneDeath: boolean; value: number; round: number }
interface Out { sq: SqRec[]; firstContactS: number[]; contactY: number[]; cross: { kind: string; n: number }[]; ticks: number[]; crossedByFirst: string[] }

const isFlier = (type: string, lord: LordId | null | undefined): boolean => (type === 'lord' ? LORDS[lord!].tags.includes('flier') : UNITS[type as keyof typeof UNITS].tags.includes('flier'));

export function work(j: Job): Out {
  const out: Out = { sq: [], firstContactS: [], contactY: [], cross: [], ticks: [], crossedByFirst: [] };
  // the battle is re-simulated with a replay (the match itself runs without one)
  playMatch(j.seed, j.lords, [hard, hard], {
    post: (s) => {
      const { replay } = simulateBattle(s, { record: true });
      const d = decodeReplay(replay);
      const st = squadStatsAt(d, replay.ticks);
      // contact tick per row from the ledger
      const first = new Map<number, number>();
      for (const t of d.tallies ?? []) {
        if (t.dmg <= 0) continue;
        for (const row of [t.src, t.tgt]) if (row >= 0 && row < 1_000_000 && !first.has(row)) first.set(row, t.tick);
      }
      const rows = replay.squads.filter((q) => !q.summoned);
      const value = (q: (typeof rows)[number]): number => (q.type === 'lord' ? 300 : UNITS[q.type as keyof typeof UNITS].cost * q.level);
      const median: [number, number] = [0, 0];
      for (const side of [0, 1] as Seat[]) {
        const xs = rows.filter((q) => q.side === side && first.has(q.row)).map((q) => ({ t: first.get(q.row)!, v: value(q) })).sort((a, b) => a.t - b.t);
        const tot = xs.reduce((a, x) => a + x.v, 0);
        let acc = 0;
        median[side] = xs.length ? xs[xs.length - 1].t : 0;
        for (const x of xs) { acc += x.v; if (acc * 2 >= tot) { median[side] = x.t; break; } }
      }
      let fc = Infinity, fcRow = -1;
      for (const [row, t] of first) if (t < fc) { fc = t; fcRow = row; }
      if (fc < Infinity) {
        out.firstContactS.push(fc / 20);
        // where the first contact happened (seat 0 frame), from the contacting squad's soldiers
        const fr = Math.min(d.frameCount - 1, Math.floor(fc / replay.frameTicks));
        const sq = replay.squads[fcRow];
        const ys = sq.soldiers.map((i) => d.y[fr * d.soldierCount + i]).filter((y) => y > 0);
        if (ys.length) out.contactY.push(mean(ys) / 100);
        out.crossedByFirst.push(sq.type);
      }
      out.ticks.push(replay.result.ticks);
      for (const q of rows) {
        const ss = st.squads.find((x) => x.row === q.row);
        const c = first.get(q.row) ?? -1;
        const wiped = ss ? ss.wipedAt : -1;
        out.sq.push({
          type: q.type === 'lord' ? 'lord:' + (q.lord ?? '') : q.type, side: q.side, contact: c, lead: c >= 0 ? (median[q.side] - c) / 20 : NaN,
          wiped, aloneDeath: wiped >= 0 && wiped < median[q.side], value: value(q), round: s.round,
        });
      }
      // river crossings by ground soldiers: x where they first enter the river band
      const crossings = s.terrain.features.filter((f) => f.kind === 'bridge' || f.kind === 'ford');
      for (const q of rows) {
        if (isFlier(q.type, q.lord ?? null)) continue;
        for (const i of q.soldiers) {
          let kind = 'never';
          for (let fr = 0; fr < d.frameCount; fr++) {
            const y = d.y[fr * d.soldierCount + i], x = d.x[fr * d.soldierCount + i];
            if (d.anim[fr * d.soldierCount + i] === 4) break; // dead
            if (y >= RIVER_Y0 && y <= RIVER_Y1) {
              const c = crossings.find((f) => x >= f.x && x < f.x + f.w);
              kind = c ? (c.kind === 'bridge' && c.x === 3600 ? 'centre bridge' : c.kind) : 'wade';
              break;
            }
          }
          const e = out.cross.find((z) => z.kind === kind);
          if (e) e.n++; else out.cross.push({ kind, n: 1 });
        }
      }
    },
  });
  return out;
}

async function main(): Promise<void> {
  const seeds = Number(arg('seeds', '3'));
  const jobs: Job[] = [];
  let seed = Number(arg('seed0', '7000'));
  for (let k = 0; k < seeds; k++) for (const lords of lordPairs()) jobs.push({ seed: seed++, lords });
  const outs = await pool<Job, Out>(new URL(import.meta.url), jobs);
  const sq = outs.flatMap((o) => o.sq);
  const fcs = outs.flatMap((o) => o.firstContactS), ys = outs.flatMap((o) => o.contactY);
  console.log(`${jobs.length} matches, ${outs.reduce((a, o) => a + o.ticks.length, 0)} battles`);
  console.log(`First contact: mean ${mean(fcs).toFixed(1)} s, median ${fcs.sort((a, b) => a - b)[fcs.length >> 1].toFixed(1)} s. Battle length mean ${(mean(outs.flatMap((o) => o.ticks)) / 20).toFixed(1)} s`);
  const yb: Record<string, number> = {};
  for (const y of ys) { const k = y < 40 ? '<40 (inside seat 0 zone)' : y < 55 ? '40-55 (seat 0 side of river)' : y <= 65 ? '55-65 (river)' : y <= 80 ? '65-80 (seat 1 side)' : '>80 (inside seat 1 zone)'; yb[k] = (yb[k] ?? 0) + 1; }
  console.log('First-contact y (m): ' + Object.entries(yb).map(([k, n]) => `${k} ${(100 * n / ys.length).toFixed(1)}%`).join(', '));
  const fb: Record<string, number> = {};
  for (const t of outs.flatMap((o) => o.crossedByFirst)) fb[t] = (fb[t] ?? 0) + 1;
  console.log('Squad type making first contact: ' + Object.entries(fb).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} ${(100 * n / fcs.length).toFixed(1)}%`).join(', '));
  const cr: Record<string, number> = {};
  for (const o of outs) for (const c of o.cross) cr[c.kind] = (cr[c.kind] ?? 0) + c.n;
  const tot = Object.values(cr).reduce((a, b) => a + b, 0);
  const crossed = tot - (cr.never ?? 0);
  console.log('Ground soldiers entering the river band, by where: ' + Object.entries(cr).filter(([k]) => k !== 'never').sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${(100 * n / crossed).toFixed(1)}%`).join(', ') + ` | never reached the river: ${(100 * (cr.never ?? 0) / tot).toFixed(1)}% of ${tot}`);
  console.log('\nunit            speed m/s | squads | contact s | lead vs main body s | wiped % | wiped before own main body engaged %');
  const types = [...new Set(sq.map((q) => q.type))];
  const rowsOut = types.map((t) => {
    const xs = sq.filter((q) => q.type === t);
    const c = xs.filter((q) => q.contact >= 0);
    const sp = t.startsWith('lord:') ? LORDS[t.slice(5) as LordId].speed : UNITS[t as keyof typeof UNITS].speed;
    return { t, sp: sp * 20 / 100, n: xs.length, contact: mean(c.map((q) => q.contact / 20)), lead: mean(c.map((q) => q.lead)), wiped: mean(xs.map((q) => (q.wiped >= 0 ? 1 : 0))), alone: mean(xs.map((q) => (q.aloneDeath ? 1 : 0))) };
  }).filter((r) => r.n >= 30).sort((a, b) => b.sp - a.sp);
  for (const r of rowsOut) console.log(`${r.t.padEnd(16)} ${r.sp.toFixed(1).padStart(5)} | ${String(r.n).padStart(6)} | ${r.contact.toFixed(1).padStart(8)} | ${r.lead.toFixed(1).padStart(8)} | ${(100 * r.wiped).toFixed(0).padStart(5)} | ${(100 * r.alone).toFixed(0).padStart(5)}`);
}

if (isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
