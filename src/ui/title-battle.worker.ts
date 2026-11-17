// Simulates the title backdrop's battles off the main thread (the menu stays responsive on any machine).
import { titleMatchup } from './title-matchup.ts';

self.onmessage = (e: MessageEvent<{ seed: number }>) => {
  let m = null;
  try {
    m = titleMatchup(e.data.seed);
  } catch {
    /* no backdrop battle: the title keeps its static art */
  }
  (self as unknown as { postMessage(m: unknown): void }).postMessage({ seed: e.data.seed, matchup: m });
};
