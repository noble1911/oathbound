// Worker for tools/review/lib.ts pool(): imports the experiment script and runs its `work(job)` per job.
import { parentPort, workerData } from 'node:worker_threads';

const { script, jobs } = workerData as { script: string; jobs: { idx: number; job: unknown }[] };
const mod = (await import(script)) as { work: (j: unknown) => unknown };
const out: { idx: number; r: unknown }[] = [];
for (const { idx, job } of jobs) out.push({ idx, r: mod.work(job) });
parentPort!.postMessage(out);
