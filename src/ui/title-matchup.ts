// The battle behind the title menu: a real one, from the real sim. Two bot players of different
// factions are rolled forward to a mid-game round (so there are levelled squads, late units, items
// and both Lords' abilities) and that round's battle is recorded. Pure and deterministic per seed;
// it runs in a worker (title-battle.worker.ts), or on the main thread if there is none.
import type { BotStrategy, FactionId, LordId, Replay } from '../sim/types.ts';
import { newMatch, botPlan, simulateBattle, applyBattle, nextRound, LORD_IDS, factionOfLord, TICK_MS } from '../sim/index.ts';
import { Rng } from '../sim/rng.ts';

export interface TitleMatchup {
  seed: number;
  lords: [LordId, LordId];
  factions: [FactionId, FactionId];
  round: number;
  replay: Replay;
  /** A moment with the fight well under way (ms): the frame shown when the battle may not move. */
  stillMs: number;
}

const STYLES: BotStrategy[] = ['best', 'best', 'counter', 'armor', 'air', 'ranged'];
/** Shorter than this (ms) is a rout, not a scene. */
const MIN_MS = 25_000;

function attempt(seed: number): TitleMatchup | null {
  const rng = new Rng(seed);
  const a = rng.pick(LORD_IDS as LordId[]);
  // the other host flies another faction's colours
  const b = rng.pick((LORD_IDS as LordId[]).filter((l) => factionOfLord(l) !== factionOfLord(a)));
  const lords: [LordId, LordId] = [a, b];
  const round = 5 + rng.int(4);
  const styles: [BotStrategy, BotStrategy] = [rng.pick(STYLES), rng.pick(STYLES)];
  const s = newMatch(seed, lords);
  while (s.round < round && s.phase === 'planning') {
    botPlan(s, 0, styles[0], 7);
    botPlan(s, 1, styles[1], 3);
    const { result } = simulateBattle(s, { record: false });
    applyBattle(s, result);
    if ((s.phase as string) !== 'results') return null; // the match ended early
    nextRound(s);
  }
  if (s.phase !== 'planning') return null;
  botPlan(s, 0, styles[0], 7);
  botPlan(s, 1, styles[1], 3);
  const { replay } = simulateBattle(s);
  if (replay.ticks * TICK_MS < MIN_MS || replay.soldiers.length < 40) return null;
  // the still: a little before the middle of the fighting, never in the closing march
  const total = replay.ticks * TICK_MS;
  const fought = replay.result.ticks * TICK_MS;
  const stillMs = Math.round(Math.min(total * 0.6, Math.max(8000, fought * 0.45)));
  return { seed, lords, factions: [factionOfLord(a), factionOfLord(b)], round: s.round, replay, stillMs };
}

/** A matchup for `seed` (a few derived seeds are tried if one gives a rout or an ended match). */
export function titleMatchup(seed: number): TitleMatchup | null {
  for (let i = 0; i < 6; i++) {
    const m = attempt((seed + i * 7919) >>> 0);
    if (m) return m;
  }
  return null;
}
