// Orders: the Lord's stance (advance / hold / follow) and the squads' formation (wide / deep) in bot play.
//   node tools/review/orders.ts --seeds 6 [--probe hold,front,ranged,near] [--lords marshal,lich] [--strat hard]
//     Probe: a Hard whose orders are overridden after it has planned (`--probe`), against a Hard that keeps every order at its
//     default (advance, the default formation). One line per Lord, one column per override. 'auto' is the bot's own choice.
//   node tools/review/orders.ts --usage --seeds 4 [--strats hard,normal,easy]
//     Usage: each level against itself: how often each stance and each formation is chosen (per Lord / per unit).
// Overrides: default | auto | hold | front (follow the dearest melee ground squad) | ranged (follow the dearest ranged
// squad) | near (follow the squad nearest the Lord) | wide | deep (every squad) | deepfront (melee squads deep) ...
import { isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { applyIntent, freeSpotNear, lordStance } from '../../src/sim/match.ts';
import { FIELD_W, mirrorPos } from '../../src/sim/constants.ts';
import { UNITS, setFormationNumbers } from '../../src/sim/data/units.ts';
import { LORD_IDS } from '../../src/sim/data/lords.ts';
import type { LordId, MatchState, Seat, Squad } from '../../src/sim/types.ts';
import { arg, botPlanX, ci, KNOB, playMatch, pool, type Planner } from './lib.ts';

interface Job { nums?: { wideArea?: number; wideMelee?: number }; seed: number; lords: [LordId, LordId]; probe: string; probeSeat: Seat; strat: string; usage: boolean; against?: string }
interface Use { lord: LordId; stance: string; round: number; forms: [string, string][] }
interface R { win: number; uses: Use[] }

const isFlier = (q: Squad): boolean => q.type !== 'lord' && UNITS[q.type].tags.includes('flier');
const isMelee = (q: Squad): boolean => q.type !== 'lord' && UNITS[q.type].range <= 400 && !UNITS[q.type].traits.includes('healer');
const dearest = (qs: Squad[]): Squad | null => qs.reduce<Squad | null>((a, q) => (!a || q.spent > a.spent || (q.spent === a.spent && q.id < a.id) ? q : a), null);

type Formation = 'wide' | 'deep';
/** Squad.formation and the {t:'formation'} intent arrive with the formation feature; until then these are no-ops. */
const setFormation = (s: MatchState, seat: Seat, q: Squad, f: Formation): void => { applyIntent(s, seat, { t: 'formation', squad: q.id, formation: f } as never); };
const formationOf = (q: Squad): string => (q as unknown as { formation?: string }).formation ?? 'default';

/** Apply an override to a planned (ready) seat. */
function override(s: MatchState, seat: Seat, what: string): void {
  if (what === 'auto') return;
  const p = s.players[seat];
  applyIntent(s, seat, { t: 'unready' });
  const us = p.squads.filter((q) => q.type !== 'lord');
  const lord = p.squads.find((q) => q.type === 'lord')!;
  const follow = (q: Squad | null): void => { applyIntent(s, seat, q ? { t: 'stance', stance: 'follow', squad: q.id } : { t: 'stance', stance: 'advance' }); };
  for (const w of what.split('+')) {
    if (w === 'default') { applyIntent(s, seat, { t: 'stance', stance: 'advance' }); for (const q of us) setFormation(s, seat, q, 'deep'); }
    else if (w === 'advance') applyIntent(s, seat, { t: 'stance', stance: 'advance' });
    else if (w === 'hold') applyIntent(s, seat, { t: 'stance', stance: 'hold' });
    else if (w.startsWith('holdat')) {
      // hold at a depth (m from the own edge), in the Lord's lane
      const y = Number(w.slice(6)) * 100, x = seat === 0 ? lord.pos[0] : FIELD_W - 1 - lord.pos[0];
      const spot = freeSpotNear(p.squads, seat, 'lord', seat === 0 ? [x, y] : mirrorPos([x, y]), lord.id);
      if (spot) applyIntent(s, seat, { t: 'move', squad: lord.id, pos: spot });
      applyIntent(s, seat, { t: 'stance', stance: 'hold' });
    }
    else if (w.startsWith('guard')) {
      // when the enemy's last army was at least N% raiders (cavalry and fliers) by gold: post the Lord with the dearest ranged squad and hold
      const foe = (s.players[1 - seat].lastArmy ?? []).filter((q) => q.type !== 'lord');
      const raid = foe.filter((q) => UNITS[q.type as 'militia'].class === 'cavalry' || UNITS[q.type as 'militia'].tags.includes('flier')).reduce((a, q) => a + q.spent, 0);
      const all = foe.reduce((a, q) => a + q.spent, 0);
      const back = dearest(us.filter((q) => !isMelee(q)));
      if (all > 0 && back && raid * 100 >= all * Number(w.slice(5))) {
        const spot = freeSpotNear(p.squads, seat, 'lord', [back.pos[0], back.pos[1] + (seat === 0 ? 400 : -400)], lord.id);
        if (spot) applyIntent(s, seat, { t: 'move', squad: lord.id, pos: spot });
        applyIntent(s, seat, { t: 'stance', stance: 'hold' });
      }
    }
    else if (w === 'slow') follow(us.filter((q) => isMelee(q) && !isFlier(q)).reduce<Squad | null>((a, q) => (!a || UNITS[q.type as 'militia'].speed < UNITS[a.type as 'militia'].speed || (UNITS[q.type as 'militia'].speed === UNITS[a.type as 'militia'].speed && q.spent > a.spent) ? q : a), null));
    else if (w === 'front') follow(dearest(us.filter((q) => isMelee(q) && !isFlier(q))));
    else if (w === 'ranged') follow(dearest(us.filter((q) => !isMelee(q))));
    else if (w === 'near') follow(us.reduce<Squad | null>((a, q) => { const d = (o: Squad): number => (o.pos[0] - lord.pos[0]) ** 2 + (o.pos[1] - lord.pos[1]) ** 2; return !a || d(q) < d(a) ? q : a; }, null));
    else if (w === 'wide' || w === 'deep') for (const q of us) setFormation(s, seat, q, w);
    else if (w.startsWith('smart')) {
      // melee squads stand deep unless at least N% of the enemy's last army (by gold) splashes; ranged squads stand wide
      const foe = (s.players[1 - seat].lastArmy ?? []).filter((q) => q.type !== 'lord');
      const all = foe.reduce((a, q) => a + q.spent, 0);
      const splash = foe.filter((q) => UNITS[q.type as 'militia'].splash > 0).reduce((a, q) => a + q.spent, 0);
      const deep = all === 0 || splash * 100 < all * Number(w.slice(5));
      for (const q of us) setFormation(s, seat, q, deep ? 'deep' : 'wide');
    }
    else if (w.startsWith('msmart') || w.startsWith('rsmart')) {
      // as smart, but only the melee (msmart) or only the ranged (rsmart) squads ever go wide
      const foe = (s.players[1 - seat].lastArmy ?? []).filter((q) => q.type !== 'lord');
      const all = foe.reduce((a, q) => a + q.spent, 0);
      const splash = foe.filter((q) => UNITS[q.type as 'militia'].splash > 0).reduce((a, q) => a + q.spent, 0);
      const deep = all === 0 || splash * 100 < all * Number(w.slice(6));
      for (const q of us) setFormation(s, seat, q, deep || isMelee(q) !== w.startsWith('m') ? 'deep' : 'wide');
    }
    else if (w.startsWith('combo')) {
      // melee squads go wide when 35% of the enemy's gold splashes; ranged squads stand wide unless N% of it raids (cavalry, fliers)
      const foe = (s.players[1 - seat].lastArmy ?? []).filter((q) => q.type !== 'lord');
      const all = foe.reduce((a, q) => a + q.spent, 0);
      const splash = foe.filter((q) => UNITS[q.type as 'militia'].splash > 0).reduce((a, q) => a + q.spent, 0);
      const raid = foe.filter((q) => UNITS[q.type as 'militia'].class === 'cavalry' || UNITS[q.type as 'militia'].tags.includes('flier')).reduce((a, q) => a + q.spent, 0);
      for (const q of us) setFormation(s, seat, q, isMelee(q) ? (all > 0 && splash * 100 >= all * 35 ? 'wide' : 'deep') : (all > 0 && raid * 100 >= all * Number(w.slice(5)) ? 'deep' : 'wide'));
    }
    else if (w === 'deepmelee') for (const q of us) setFormation(s, seat, q, isMelee(q) ? 'deep' : 'wide');
    else if (w === 'deepranged') for (const q of us) setFormation(s, seat, q, isMelee(q) ? 'wide' : 'deep');
    else if (w === 'stancedefault') applyIntent(s, seat, { t: 'stance', stance: 'advance' });
    else if (w === 'formdefault') for (const q of us) setFormation(s, seat, q, 'deep');
    else throw new Error(`unknown override ${w}`);
  }
  applyIntent(s, seat, { t: 'ready' });
}

export function work(j: Job): R {
  if (j.nums) setFormationNumbers(j.nums);
  const uses: Use[] = [];
  const mk = (seat: Seat): Planner => (s: MatchState) => {
    KNOB.noLevel = false; KNOB.noLayout = false;
    botPlanX(s, seat, j.strat as never, seat + 1);
    if (!j.usage) override(s, seat, seat === j.probeSeat ? j.probe : (j.against ?? 'default'));
    const p = s.players[seat];
    if (j.usage) uses.push({ lord: p.lord!, stance: lordStance(p).t, round: s.round, forms: p.squads.filter((q) => q.type !== 'lord').map((q) => [q.type, formationOf(q)]) });
  };
  const { s } = playMatch(j.seed, j.lords, [mk(0), mk(1)]);
  return { win: s.winner === j.probeSeat ? 1 : s.winner === 'draw' || s.winner === null ? 0.5 : 0, uses };
}

async function main(): Promise<void> {
  const seeds = Number(arg('seeds', '4'));
  const seed0 = Number(arg('seed0', '61000'));
  const lords = (arg('lords', '') ? arg('lords', '').split(',') : [...LORD_IDS]) as LordId[];
  const pc = (a: number, b: number): string => (b ? (100 * a / b).toFixed(1) : '0.0') + '%';
  if (process.argv.includes('--usage')) {
    const strats = arg('strats', 'hard,normal,easy').split(',');
    const jobs: Job[] = [];
    for (const strat of strats) {
      let seed = seed0;
      for (let k = 0; k < seeds; k++) for (const a of LORD_IDS) for (const b of LORD_IDS) if (a !== b) jobs.push({ seed: seed++, lords: [a, b], probe: 'auto', probeSeat: 0, strat, usage: true });
    }
    const res = await pool<Job, R>(new URL(import.meta.url), jobs);
    for (const strat of strats) {
      const us = res.filter((_, i) => jobs[i].strat === strat).flatMap((r) => r.uses);
      const kinds = ['advance', 'hold', 'follow'];
      console.log(`${strat}: ${us.length} planning turns. Stance: ${kinds.map((k) => `${k} ${pc(us.filter((u) => u.stance === k).length, us.length)}`).join(', ')}`);
      for (const l of LORD_IDS) {
        const x = us.filter((u) => u.lord === l);
        console.log(`  ${l.padEnd(12)} ${kinds.map((k) => `${k} ${pc(x.filter((u) => u.stance === k).length, x.length)}`).join(', ')}`);
      }
      const forms = us.flatMap((u) => u.forms);
      const fk = [...new Set(forms.map((f) => f[1]))].sort();
      console.log(`  Formation, per squad per turn (${forms.length}): ${fk.map((k) => `${k} ${pc(forms.filter((f) => f[1] === k).length, forms.length)}`).join(', ')}`);
      if (fk.length > 1) {
        for (const t of [...new Set(forms.map((f) => f[0]))].sort()) {
          const x = forms.filter((f) => f[0] === t);
          console.log(`    ${t.padEnd(16)} ${fk.map((k) => `${k} ${pc(x.filter((f) => f[1] === k).length, x.length)}`).join(', ')} (${x.length})`);
        }
      }
    }
    return;
  }
  const probes = arg('probe', 'hold,front,ranged').split(',');
  const strat = arg('strat', 'hard');
  const jobs: Job[] = [];
  for (const probe of probes) {
    let seed = seed0;
    for (let k = 0; k < seeds; k++) for (const a of lords) for (const b of LORD_IDS) if (a !== b) for (const probeSeat of [0, 1] as Seat[]) {
      jobs.push({ seed: seed++, lords: probeSeat === 0 ? [a, b] : [b, a], probe, probeSeat, strat, usage: false, against: arg('against', 'default'), nums: arg('nums', '') ? JSON.parse(arg('nums', '')) : undefined });
    }
  }
  const res = await pool<Job, R>(new URL(import.meta.url), jobs);
  console.log(`${strat} with the override against ${strat} on '${arg('against', 'default')}': win rate of the override (${jobs.length / probes.length} matches per column, ${jobs.length / probes.length / lords.length} per cell)`);
  console.log(`${'lord'.padEnd(12)} | ${probes.map((p) => p.padStart(10)).join(' | ')}`);
  const cell = (probe: string, l: LordId | null): string => {
    const idx = jobs.map((j, i) => (j.probe === probe && (l === null || j.lords[j.probeSeat] === l) ? i : -1)).filter((i) => i >= 0);
    const w = idx.reduce((a, i) => a + res[i].win, 0) / Math.max(1, idx.length);
    return `${(100 * w).toFixed(1)}±${(100 * ci(w, idx.length)).toFixed(1)}`.padStart(10);
  };
  for (const l of lords) console.log(`${l.padEnd(12)} | ${probes.map((p) => cell(p, l)).join(' | ')}`);
  console.log(`${'all'.padEnd(12)} | ${probes.map((p) => cell(p, null)).join(' | ')}`);
}

if (isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
