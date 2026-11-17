// Relocation and levelling in bot play: how often each level calls Muster (instead of the round's unlock), how many
// locked squads it then relocates, and how far squads are levelled and geared when the match ends.
//   node tools/review/muster.ts --seeds 4 [--strats hard,normal,easy,counter]
// Every strategy plays itself, all Lord pairings. "Free" Musters are those called with nothing left to unlock.
import { isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { relocatedSquads, squadLocked } from '../../src/sim/match.ts';
import type { LordId, MatchState, Seat } from '../../src/sim/types.ts';
import { arg, botPlanX, KNOB, lordPairs, mean, playMatch, pool, type Planner } from './lib.ts';

interface Job { seed: number; lords: [LordId, LordId]; strat: string }
interface Turn { round: number; locked: number; offered: boolean; free: boolean; muster: boolean; moved: number; lost: boolean; lordMoved: boolean }
interface End { rounds: number; squads: number; level: number; lv: number[]; armor: number; relic: number; weapon: number; stash: number; won: boolean }
interface R { turns: Turn[]; ends: End[] }

export function work(j: Job): R {
  const turns: Turn[] = [];
  const mk = (seat: Seat): Planner => (s: MatchState) => {
    const p = s.players[seat];
    const locked = p.squads.filter((q) => squadLocked(q, s.round)).length;
    const offered = !!p.musterOffer && locked > 0, free = !p.draftOptions.length;
    const lord = p.squads[0].pos.join(',');
    const lost = p.lostLast;
    KNOB.noLevel = false; KNOB.noLayout = false;
    botPlanX(s, seat, j.strat as never, seat + 1);
    turns.push({ round: s.round, locked, offered, free, muster: !!p.muster, moved: relocatedSquads(p, s.round).length, lost, lordMoved: p.squads[0].pos.join(',') !== lord });
  };
  const { s } = playMatch(j.seed, j.lords, [mk(0), mk(1)]);
  const ends: End[] = s.players.map((p) => {
    const us = p.squads.filter((q) => q.type !== 'lord');
    const lv = [0, 0, 0, 0, 0, 0];
    for (const q of us) lv[q.level]++;
    return {
      rounds: s.round, squads: us.length, level: mean(us.map((q) => q.level)), lv,
      weapon: us.filter((q) => q.items.weapon).length, armor: us.filter((q) => q.items.armor).length, relic: us.filter((q) => q.items.relic).length,
      stash: p.stash.length, won: s.winner === p.seat,
    };
  });
  return { turns, ends };
}

async function main(): Promise<void> {
  const seeds = Number(arg('seeds', '4'));
  const strats = arg('strats', 'hard,normal,easy,counter').split(',');
  const jobs: Job[] = [];
  for (const strat of strats) {
    let seed = Number(arg('seed0', '41000'));
    for (let k = 0; k < seeds; k++) for (const lords of lordPairs()) jobs.push({ seed: seed++, lords, strat });
  }
  const res = await pool<Job, R>(new URL(import.meta.url), jobs);
  const pc = (a: number, b: number): string => (b ? (100 * a / b).toFixed(1) : '0.0') + '%';
  console.log(`${jobs.length} matches (${jobs.length / strats.length} per strategy, each against itself)`);
  console.log('strategy | Muster taken, of the rounds it was offered | ...when an unlock was the price | ...when free | Musters per match | relocations per Muster | squads relocated per match | after a lost round / after a won or drawn one');
  for (const strat of strats) {
    const rs = res.filter((_, i) => jobs[i].strat === strat);
    const ts = rs.flatMap((r) => r.turns).filter((t) => t.offered);
    const paid = ts.filter((t) => !t.free), free = ts.filter((t) => t.free);
    const m = ts.filter((t) => t.muster);
    const lost = ts.filter((t) => t.lost), won = ts.filter((t) => !t.lost);
    console.log(`${strat.padEnd(8)} | ${pc(m.length, ts.length)} (${m.length}/${ts.length}) | ${pc(paid.filter((t) => t.muster).length, paid.length)} | ${pc(free.filter((t) => t.muster).length, free.length)} (${free.length} free rounds) | ${(m.length / (2 * rs.length)).toFixed(2)} per seat | ${mean(m.map((t) => t.moved)).toFixed(2)} | ${(m.reduce((a, t) => a + t.moved, 0) / (2 * rs.length)).toFixed(2)} | ${pc(lost.filter((t) => t.muster).length, lost.length)} / ${pc(won.filter((t) => t.muster).length, won.length)}`);
    const byRound: string[] = [];
    for (let r = 2; r <= 12; r++) { const x = ts.filter((t) => t.round === r); if (x.length >= 20) byRound.push(`r${r} ${pc(x.filter((t) => t.muster).length, x.length)}`); }
    console.log(`           by round: ${byRound.join(', ')}`);
  }
  console.log('strategy | squads at match end | average squad level | share of squads at Lv1 / Lv2 / Lv3 / Lv4 / Lv5 | squads wearing a weapon / an armor / a relic | relics worn per army | items idle in the stash');
  for (const strat of strats) {
    const es = res.filter((_, i) => jobs[i].strat === strat).flatMap((r) => r.ends);
    const n = es.reduce((a, e) => a + e.squads, 0);
    const lv = [1, 2, 3, 4, 5].map((l) => pc(es.reduce((a, e) => a + e.lv[l], 0), n));
    const lvAll = es.reduce((a, e) => a + e.level * e.squads, 0) / Math.max(1, n);
    console.log(`${strat.padEnd(8)} | ${mean(es.map((e) => e.squads)).toFixed(1)} | ${lvAll.toFixed(2)} | ${lv.join(' / ')} | ${pc(es.reduce((a, e) => a + e.weapon, 0), n)} / ${pc(es.reduce((a, e) => a + e.armor, 0), n)} / ${pc(es.reduce((a, e) => a + e.relic, 0), n)} | ${mean(es.map((e) => e.relic)).toFixed(2)} | ${mean(es.map((e) => e.stash)).toFixed(2)}`);
  }
}

if (isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
