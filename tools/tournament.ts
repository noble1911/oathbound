// Bot round robin (DESIGN §8). Every (strategy, Lord) entry plays every other entry on both sides across many seeds.
// Usage: node tools/tournament.ts [--seeds 2] [--fields hard:40,normal:40,classic:1 [--full]] [--gain 0.5] [--threads 16] [--strats rush,ranged,...] [--lords marshal,lich,...] [--same] [--tune N] [--tune-what units,lords,factions (default units,lords)] [--json out.json] [--best]
//   --best  also includes the 'best' strategy (the vs-AI bot) as an entry.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { aggregate, formatReport, playMatch, TOURNAMENT_STRATEGIES, type MatchRecord, type Report } from '../src/sim/tournament.ts';
import { LORDS, LORD_IDS } from '../src/sim/data/lords.ts';
import { setBotKnobs } from '../src/sim/bot.ts';
import type { BotStrategy, LordId } from '../src/sim/types.ts';

type Job = { seed: number; lords: [LordId, LordId]; strats: [BotStrategy, BotStrategy] };


async function runAll(jobs: Job[], threads: number): Promise<MatchRecord[]> {
  const chunks: Job[][] = Array.from({ length: threads }, () => []);
  jobs.forEach((j, i) => chunks[i % threads].push(j));
  const results = await Promise.all(
    chunks.filter((c) => c.length).map((c) => new Promise<MatchRecord[]>((res, rej) => {
      const w = new Worker(new URL(import.meta.url), { workerData: c });
      w.once('message', res);
      w.once('error', rej);
    })),
  );
  return results.flat();
}

const BAL = new URL('../src/sim/data/balance.ts', import.meta.url);
type Bal = { units: Record<string, number>; lords: Record<string, number>; factions: Record<string, number>; normalReserve: Record<string, number>; classicReserve: Record<string, number> };
function readBalance(): Bal {
  const src = readFileSync(BAL, 'utf8');
  const grab = (name: string): Record<string, number> => {
    const m = new RegExp(`export const ${name}[^=]*= \{([^}]*)\}`).exec(src)!;
    return Object.fromEntries([...m[1].matchAll(/(\w+): (\d+)/g)].map((x) => [x[1], Number(x[2])]));
  };
  return { units: grab('UNIT_POWER'), lords: grab('LORD_POWER'), factions: grab('FACTION_POWER'), normalReserve: grab('NORMAL_RESERVE'), classicReserve: grab('CLASSIC_RESERVE') };
}
function writeBalance(b: Bal): void {
  const src = readFileSync(BAL, 'utf8');
  const fmt = (o: Record<string, number>): string => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ');
  writeFileSync(BAL, src
    .replace(/(export const UNIT_POWER[^=]*= \{)[^}]*(\})/, `$1 ${fmt(b.units)} $2`)
    .replace(/(export const LORD_POWER[^=]*= \{)[^}]*(\})/, `$1 ${fmt(b.lords)} $2`)
    .replace(/(export const FACTION_POWER[^=]*= \{)[^}]*(\})/, `$1 ${fmt(b.factions)} $2`)
    .replace(/(export const NORMAL_RESERVE[^=]*= \{)[^}]*(\})/, `$1 ${fmt(b.normalReserve)} $2`)
    .replace(/(export const CLASSIC_RESERVE[^=]*= \{)[^}]*(\})/, `$1 ${fmt(b.classicReserve)} $2`));
}

/** One line per gate for a field (the --fields summary). */
function gateLine(name: string, rep: Report): string {
  const p = (x: number): string => (100 * x).toFixed(1);
  const lords = LORD_IDS.filter((l) => rep.lords[l] !== undefined);
  const us = Object.keys(rep.units).filter((u) => (rep.unitSamples[u] ?? 0) >= 100);
  const ls = Object.keys(rep.legends).filter((l) => (rep.legendSamples[l] ?? 0) >= 100);
  const ext = (ks: string[], m: Record<string, number>): string => {
    if (!ks.length) return '-';
    const lo = ks.reduce((a, k) => (m[k] < m[a] ? k : a)), hi = ks.reduce((a, k) => (m[k] > m[a] ? k : a));
    return `${p(m[lo])} ${lo} .. ${p(m[hi])} ${hi}`;
  };
  return `[${name}] n=${rep.matches} seat0 ${p(rep.p0)} | rounds ${rep.rounds.toFixed(2)} (p95 ${rep.roundsP95}, past 12: ${p(rep.roundsFinal ?? 0)}%) | blowouts ${p(rep.marginHist[3])}%\n`
    + `  factions ${Object.entries(rep.factions ?? {}).map(([k, v]) => `${k} ${p(v)}`).join(', ')}\n`
    + `  lords ${lords.map((l) => `${l} ${p(rep.lords[l])}`).join(', ')}\n`
    + `  units ${ext(us, rep.units)} | legendaries ${ext(ls, rep.legends)}`;
}

async function main(): Promise<void> {
  const arg = (name: string, def: string): string => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? process.argv[i + 1] : def;
  };
  const seeds = Number(arg('seeds', '2'));
  const threads = Number(arg('threads', String(Math.max(1, Number(process.env.OB_THREADS) || availableParallelism() - 2))));
  // --lords marshal,lich,...  restricts the entries to these Lords (default: all twelve, i.e. all three factions).
  const lords = (arg('lords', '') ? arg('lords', '').split(',') : LORD_IDS) as LordId[];
  const same = process.argv.includes('--same');
  // --tune-what lords | units | both (default both): which multipliers --tune may move.
  const tuneWhat = arg('tune-what', 'both');
  const seed0 = Number(arg('seed0', '1000'));
  const roundRobin = (strats: BotStrategy[], n: number, from: number): Job[] => {
    const entries: [BotStrategy, LordId][] = [];
    for (const s of strats) for (const l of lords) entries.push([s, l]);
    const jobs: Job[] = [];
    let seed = from;
    for (let k = 0; k < n; k++) {
      for (let a = 0; a < entries.length; a++) {
        for (let b = 0; b < entries.length; b++) {
          if (a === b) continue;
          // --same: equal-level play only (Hard vs Hard, Normal vs Normal...), which is what two humans play.
          if (same && entries[a][0] !== entries[b][0]) continue;
          jobs.push({ seed: seed++, lords: [entries[a][1], entries[b][1]], strats: [entries[a][0], entries[b][0]] });
        }
      }
    }
    return jobs;
  };
  // --fields hard:40,normal:40,classic:1  runs several fields in one go (name:seeds; 'classic' is the mixed field of the
  // six tournament strategies, any other name one strategy against itself) and prints one gate summary per field. With
  // --tune, the multipliers follow the MEAN of the fields' rates, so one set of numbers is balanced for every bot level.
  const fieldArg = arg('fields', '');
  const fields: { name: string; jobs: Job[] }[] = fieldArg
    ? fieldArg.split(',').map((f, i) => {
      const [name, n] = f.split(':');
      return { name, jobs: roundRobin(name === 'classic' ? TOURNAMENT_STRATEGIES : [name as BotStrategy], Number(n ?? seeds), seed0 + i * 1000000) };
    })
    : [{ name: '', jobs: roundRobin((arg('strats', '') ? arg('strats', '').split(',') : [...TOURNAMENT_STRATEGIES, ...(process.argv.includes('--best') ? ['best'] : [])]) as BotStrategy[], seeds, seed0) }];
  const tune = Number(arg('tune', '0'));
  for (let it = 0; it <= tune; it++) {
    const t0 = performance.now();
    const reps: Report[] = [];
    let played = 0;
    if (tune) console.log(`--- iteration ${it}`);
    for (const f of fields) {
      // Fresh seeds each tuning iteration so the tuner does not overfit one seed set.
      const js = tune ? f.jobs.map((j) => ({ ...j, seed: j.seed + it * 100000 })) : f.jobs;
      const rep = aggregate(await runAll(js, threads));
      reps.push(rep);
      played += js.length;
      if (!fieldArg || process.argv.includes('--full')) console.log((fieldArg ? `===== field ${f.name}\n` : '') + formatReport(rep));
      if (fieldArg) console.log(gateLine(f.name, rep));
      const json = arg('json', '');
      if (json) writeFileSync(fieldArg ? json.replace(/(\.json)?$/, `.${f.name}.json`) : json, JSON.stringify(rep, null, 1));
    }
    console.log(`(${played} matches, ${threads} threads, ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    if (it === tune) break;
    // The rates the tuner follows: the mean over the fields (a unit counts in a field once it has 100 samples there).
    const mean = (pick: (r: Report) => Record<string, number> | undefined, ok: (r: Report, k: string) => boolean = () => true): Record<string, number> => {
      const sum: Record<string, [number, number]> = {};
      for (const r of reps) for (const [k, v] of Object.entries(pick(r) ?? {})) if (ok(r, k)) { const e = (sum[k] ??= [0, 0]); e[0] += v; e[1]++; }
      return Object.fromEntries(Object.entries(sum).map(([k, [a, n]]) => [k, a / n]));
    };
    const rep = { units: mean((r) => r.units, (r, k) => (r.unitSamples?.[k] ?? 0) >= 100), lords: mean((r) => r.lords), factions: mean((r) => r.factions) };
    // Nudge power multipliers towards 50% (power ~ multiplier^2, so a small step goes a long way).
    const b = readBalance();
    const gain = Number(arg('gain', '0.5'));
    const step = (wr: number, k: number): number => Math.max(-0.08, Math.min(0.08, k * (0.5 - wr)));
    const what = tuneWhat === 'both' ? ['units', 'lords'] : tuneWhat.split(',');
    // Units seen in fewer than 100 round-winner samples are left alone: their rate is mostly noise.
    if (what.includes('units')) for (const [u, wr] of Object.entries(rep.units)) if (b.units[u] !== undefined) b.units[u] = Math.max(60, Math.min(170, Math.round(b.units[u] * (1 + step(wr, gain / 2)))));
    if (what.includes('factions')) {
      // Faction multipliers (per mille; small steps: 1% of power is worth about 7 points) follow the faction's win rate against the other two; Lords are then tuned towards the
      // average of their own faction's Lords (a single-Lord faction leaves its Lord alone).
      for (const [f, wr] of Object.entries(rep.factions ?? {})) if (b.factions[f] !== undefined) b.factions[f] = Math.max(900, Math.min(1100, Math.round(b.factions[f] * (1 + Math.max(-0.008, Math.min(0.008, 0.1 * (0.5 - wr)))))));
      if (what.includes('lords')) {
        const byF: Record<string, number[]> = {};
        for (const [l, wr] of Object.entries(rep.lords)) (byF[LORDS[l as LordId].faction] ??= []).push(wr);
        for (const [l, wr] of Object.entries(rep.lords)) {
          const xs = byF[LORDS[l as LordId].faction];
          if (xs.length < 2 || b.lords[l] === undefined) continue;
          const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
          b.lords[l] = Math.max(40, Math.min(200, Math.round(b.lords[l] * (1 + step(wr - mean + 0.5, gain)))));
        }
      }
    } else if (what.includes('lords')) for (const [l, wr] of Object.entries(rep.lords)) if (b.lords[l] !== undefined) b.lords[l] = Math.max(40, Math.min(200, Math.round(b.lords[l] * (1 + step(wr, gain)))));
    // --tune-what reserve: the bots' per-Lord reserve (per mille of gold; NORMAL_RESERVE for a 'normal' field, CLASSIC_RESERVE
    // for 'classic'). A Lord that wins too much keeps more gold back: 6 per mille per point of win rate, at most 30 a step,
    // and the table's mean stays where it was unless a Lord would need less than nothing.
    if (what.includes('reserve')) {
      fields.forEach((f, i) => {
        const tab = f.name === 'normal' ? b.normalReserve : f.name === 'classic' ? b.classicReserve : null;
        if (!tab) return;
        const before = Object.values(tab).reduce((a, x) => a + x, 0) / Object.keys(tab).length;
        for (const [l, wr] of Object.entries(reps[i].lords)) if (tab[l] !== undefined) tab[l] += Math.max(-30, Math.min(30, 600 * gain * 2 * (wr - 0.5)));
        const after = Object.values(tab).reduce((a, x) => a + x, 0) / Object.keys(tab).length;
        for (const l of Object.keys(tab)) tab[l] = Math.round(tab[l] + before - after);
        // A Lord that is still too weak with no reserve at all: everyone else keeps more instead (the table shifts up).
        const low = Math.min(...Object.values(tab));
        for (const l of Object.keys(tab)) tab[l] = Math.max(0, Math.min(400, tab[l] - Math.min(0, low)));
      });
    }
    writeBalance(b);
    console.log('balance ->', JSON.stringify(b));
  }
}

// OB_KNOBS='{"musterMin":4000}' sets the experimental bot knobs of the 'hardx' strategy (src/sim/bot.ts BotKnobs):
//   OB_KNOBS='{"noMuster":true}' node tools/tournament.ts --strats hard,hardx --seeds 2
if (process.env.OB_KNOBS) setBotKnobs(JSON.parse(process.env.OB_KNOBS));
if (!isMainThread) {
  const jobs = workerData as Job[];
  const out: MatchRecord[] = [];
  for (const j of jobs) out.push(playMatch(j.seed, j.lords, j.strats));
  parentPort!.postMessage(out);
} else {
  await main();
}
