// What Hard unlocks, deploys and picks from loot. node tools/review/picks.ts --seeds 4
import { isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { UNITS } from '../../src/sim/data/units.ts';
import type { LordId, MatchState, Seat } from '../../src/sim/types.ts';
import { arg, botPlanX, KNOB, lordPairs, playMatch, pool, type Planner } from './lib.ts';
interface Job { seed: number; lords: [LordId, LordId] }
interface R { unlocks: [number, string][]; deploys: [number, string][]; loot: { round: number; offered: string[]; took: string }[]; win: Seat | null; seat: Seat }
export function work(j: Job): R[] {
  const out: R[] = [0, 1].map((seat) => ({ unlocks: [], deploys: [], loot: [], win: null, seat: seat as Seat }));
  const mk = (seat: Seat): Planner => (s: MatchState) => {
    const p = s.players[seat];
    const ul = new Set(p.unlocked), ids = new Set(p.squads.map((q) => q.id));
    const offer = p.lootOffer ? p.lootOffer.map((i) => i.rarity) : null;
    const offerIds = p.lootOffer ? p.lootOffer.map((i) => i.id) : [];
    KNOB.noLevel = false; KNOB.noLayout = false;
    botPlanX(s, seat, 'hard', seat + 1);
    for (const u of p.unlocked) if (!ul.has(u)) out[seat].unlocks.push([s.round, u]);
    for (const q of p.squads) if (!ids.has(q.id) && q.type !== 'lord') out[seat].deploys.push([s.round, q.type]);
    if (offer) {
      const owned = new Set([...p.stash.map((i) => i.id), ...p.squads.flatMap((q) => Object.values(q.items).filter(Boolean).map((i) => i!.id))]);
      const k = offerIds.findIndex((id) => owned.has(id));
      out[seat].loot.push({ round: s.round, offered: offer, took: k >= 0 ? offer[k] : 'none' });
    }
  };
  const { s } = playMatch(j.seed, j.lords, [mk(0), mk(1)]);
  for (const o of out) o.win = (s as any).winner ?? null;
  return out;
}
async function main(): Promise<void> {
  const jobs: Job[] = []; let seed = 31000;
  for (let k = 0; k < Number(arg('seeds', '4')); k++) for (const lords of lordPairs()) jobs.push({ seed: seed++, lords });
  const rs = (await pool<Job, R[]>(new URL(import.meta.url), jobs)).flat();
  const cnt = (xs: [number, string][]) => { const m = new Map<string, number>(); for (const [, u] of xs) m.set(u, (m.get(u) ?? 0) + 1); return m; };
  const U = cnt(rs.flatMap((r) => r.unlocks)), D = cnt(rs.flatMap((r) => r.deploys));
  const byCost = new Map<number, [number, number]>();
  for (const [u, n] of D) { const c = UNITS[u as keyof typeof UNITS].cost; const v = byCost.get(c) ?? [0, 0]; v[0] += n; byCost.set(c, v); }
  for (const [u, n] of U) { const c = UNITS[u as keyof typeof UNITS].cost; const v = byCost.get(c) ?? [0, 0]; v[1] += n; byCost.set(c, v); }
  const tot = [...D.values()].reduce((a, b) => a + b, 0);
  console.log(`${jobs.length} matches, ${tot} deploys`);
  console.log('cost | share of deploys | unlocks'); for (const [c, [d, u]] of [...byCost].sort((a, b) => a[0] - b[0])) console.log(c, (100 * d / tot).toFixed(1) + '%', u);
  console.log('unit | deploys | unlocks'); for (const [u, n] of [...D].sort((a, b) => b[1] - a[1])) console.log(u, UNITS[u as keyof typeof UNITS].cost, n, U.get(u) ?? 0);
  // deploy share of cheap units by round
  for (let r = 1; r <= 10; r++) { const d = rs.flatMap((x) => x.deploys).filter((x) => x[0] === r); if (d.length) console.log('round', r, 'cheap(100) share', (100 * d.filter((x) => UNITS[x[1] as keyof typeof UNITS].cost <= 100).length / d.length).toFixed(0) + '%', 'n', d.length); }
  const L = rs.flatMap((r) => r.loot); const top = (o: string[]) => ['legendary', 'rare', 'magic'].find((t) => o.includes(t));
  const took = L.filter((l) => l.took !== 'none'); const best = took.filter((l) => l.took === top(l.offered)).length;
  console.log(`loot picks ${took.length}, took the highest rarity ${(100 * best / took.length).toFixed(1)}%`);
  const leg = took.filter((l) => l.offered.includes('legendary')); console.log(`legendary offered ${leg.length}, taken ${(100 * leg.filter((l) => l.took === 'legendary').length / leg.length).toFixed(1)}%`);
  const mixed = took.filter((l) => l.offered.includes('rare') && l.offered.includes('magic') && !l.offered.includes('legendary')); console.log(`rare+magic offers ${mixed.length}, took rare ${(100 * mixed.filter((l) => l.took === 'rare').length / mixed.length).toFixed(1)}%`);
}
if (isMainThread && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
