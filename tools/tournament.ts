// Bot round robin (DESIGN §8). Every (strategy, Lord) entry plays every other entry on both sides across many seeds.
// Usage: node tools/tournament.ts [--seeds 2] [--threads 16] [--strats rush,ranged,...] [--lords marshal,lich,...] [--same] [--tune N] [--tune-what units,lords,factions (default units,lords)] [--json out.json] [--best]
//   --best  also includes the 'best' strategy (the vs-AI bot) as an entry.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { aggregate, formatReport, playMatch, TOURNAMENT_STRATEGIES, type MatchRecord } from '../src/sim/tournament.ts';
import { LORDS, LORD_IDS } from '../src/sim/data/lords.ts';
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
function readBalance(): { units: Record<string, number>; lords: Record<string, number>; factions: Record<string, number> } {
  const src = readFileSync(BAL, 'utf8');
  const grab = (name: string): Record<string, number> => {
    const m = new RegExp(`export const ${name}[^=]*= \{([^}]*)\}`).exec(src)!;
    return Object.fromEntries([...m[1].matchAll(/(\w+): (\d+)/g)].map((x) => [x[1], Number(x[2])]));
  };
  return { units: grab('UNIT_POWER'), lords: grab('LORD_POWER'), factions: grab('FACTION_POWER') };
}
function writeBalance(b: { units: Record<string, number>; lords: Record<string, number>; factions: Record<string, number> }): void {
  const src = readFileSync(BAL, 'utf8');
  const fmt = (o: Record<string, number>): string => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ');
  writeFileSync(BAL, src
    .replace(/(export const UNIT_POWER[^=]*= \{)[^}]*(\})/, `$1 ${fmt(b.units)} $2`)
    .replace(/(export const LORD_POWER[^=]*= \{)[^}]*(\})/, `$1 ${fmt(b.lords)} $2`)
    .replace(/(export const FACTION_POWER[^=]*= \{)[^}]*(\})/, `$1 ${fmt(b.factions)} $2`));
}

async function main(): Promise<void> {
  const arg = (name: string, def: string): string => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? process.argv[i + 1] : def;
  };
  const seeds = Number(arg('seeds', '2'));
  const threads = Number(arg('threads', String(Math.max(1, availableParallelism() - 2))));
  const strats = (arg('strats', '') ? arg('strats', '').split(',') : [...TOURNAMENT_STRATEGIES, ...(process.argv.includes('--best') ? ['best'] : [])]) as BotStrategy[];
  const entries: [BotStrategy, LordId][] = [];
  // --lords marshal,lich,...  restricts the entries to these Lords (default: all six, i.e. all three factions).
  const lords = (arg('lords', '') ? arg('lords', '').split(',') : LORD_IDS) as LordId[];
  for (const s of strats) for (const l of lords) entries.push([s, l]);
  const jobs: Job[] = [];
  const same = process.argv.includes('--same');
  // --tune-what lords | units | both (default both): which multipliers --tune may move.
  const tuneWhat = arg('tune-what', 'both');
  let seed = Number(arg('seed0', '1000'));
  for (let k = 0; k < seeds; k++) {
    for (let a = 0; a < entries.length; a++) {
      for (let b = 0; b < entries.length; b++) {
        if (a === b) continue;
        // --same: equal-level play only (Hard vs Hard, Normal vs Normal...), which is what two humans play.
        if (same && entries[a][0] !== entries[b][0]) continue;
        jobs.push({ seed: seed++, lords: [entries[a][1], entries[b][1]], strats: [entries[a][0], entries[b][0]] });
      }
    }
  }
  const tune = Number(arg('tune', '0'));
  for (let it = 0; it <= tune; it++) {
    const t0 = performance.now();
    // Fresh seeds each tuning iteration so the tuner does not overfit one seed set.
    const js = tune ? jobs.map((j) => ({ ...j, seed: j.seed + it * 100000 })) : jobs;
    const recs = await runAll(js, threads);
    const rep = aggregate(recs);
    console.log((tune ? `--- iteration ${it}
` : '') + formatReport(rep));
    console.log(`(${js.length} matches, ${entries.length} entries, ${threads} threads, ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    const json = arg('json', '');
    if (json) writeFileSync(json, JSON.stringify(rep, null, 1));
    if (it === tune) break;
    // Nudge power multipliers towards 50% (power ~ multiplier^2, so a small step goes a long way).
    const b = readBalance();
    const step = (wr: number, k: number): number => Math.max(-0.08, Math.min(0.08, k * (0.5 - wr)));
    const what = tuneWhat === 'both' ? ['units', 'lords'] : tuneWhat.split(',');
    // Units seen in fewer than 100 round-winner samples are left alone: their rate is mostly noise.
    if (what.includes('units')) for (const [u, wr] of Object.entries(rep.units)) if (b.units[u] !== undefined && (rep.unitSamples?.[u] ?? 0) >= 100) b.units[u] = Math.max(70, Math.min(150, Math.round(b.units[u] * (1 + step(wr, 0.5)))));
    if (what.includes('factions')) {
      // Faction multipliers (per mille; small steps: 1% of power is worth about 7 points) follow the faction's win rate against the other two; Lords are then tuned towards the
      // average of their own faction's Lords (a single-Lord faction leaves its Lord alone).
      for (const [f, wr] of Object.entries(rep.factions ?? {})) if (b.factions[f] !== undefined) b.factions[f] = Math.max(900, Math.min(1100, Math.round(b.factions[f] * (1 + Math.max(-0.006, Math.min(0.006, 0.06 * (0.5 - wr)))))));
      if (what.includes('lords')) {
        const byF: Record<string, number[]> = {};
        for (const [l, wr] of Object.entries(rep.lords)) (byF[LORDS[l as LordId].faction] ??= []).push(wr);
        for (const [l, wr] of Object.entries(rep.lords)) {
          const xs = byF[LORDS[l as LordId].faction];
          if (xs.length < 2 || b.lords[l] === undefined) continue;
          const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
          b.lords[l] = Math.max(40, Math.min(180, Math.round(b.lords[l] * (1 + step(wr - mean + 0.5, 0.5)))));
        }
      }
    } else if (what.includes('lords')) for (const [l, wr] of Object.entries(rep.lords)) if (b.lords[l] !== undefined) b.lords[l] = Math.max(40, Math.min(180, Math.round(b.lords[l] * (1 + step(wr, 0.5)))));
    writeBalance(b);
    console.log('balance ->', JSON.stringify(b));
  }
}

if (!isMainThread) {
  const jobs = workerData as Job[];
  const out: MatchRecord[] = [];
  for (const j of jobs) out.push(playMatch(j.seed, j.lords, j.strats));
  parentPort!.postMessage(out);
} else {
  await main();
}
