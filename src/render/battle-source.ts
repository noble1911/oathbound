// What the renderer needs to play a battle back. It mirrors the sim's replay contract
// (src/sim/types.ts, type-only imports, so the renderer has no runtime dependency on the sim):
//
//   const d = decodeReplay(replay);                       // from src/sim
//   const src = replaySource(d, sampleReplay, makeTransforms);
//   view.playBattle(src);
//
// Anything that can fill `SoldierTransforms` for a time and list its events can drive playback
// (the showcase's fake battle does exactly that).
import type { DecodedReplay, KeepInfo, ReplayEvent, ReplaySoldier, SkillEvent, SoldierTransforms, Terrain, AnimState } from '../sim/types.ts';

export type { DecodedReplay, KeepInfo, ReplayEvent, ReplaySoldier, SkillEvent, SoldierTransforms, Terrain, AnimState };

/** ANIM_STATES order from the sim contract (index stored in `SoldierTransforms.anim`). */
export const ANIM: readonly AnimState[] = ['idle', 'move', 'attack', 'cast', 'dead'];
export const ANIM_HIDDEN = 255;
export const TICK_MS = 50;

export interface BattleSource {
  soldiers: ReplaySoldier[];
  keeps: [KeepInfo, KeepInfo];
  terrain: Terrain;
  /** Total length in ms. */
  durationMs: number;
  /** Sorted by tick. */
  events: ReplayEvent[];
  /** Item-skill casts (replay v3 `DecodedReplay.skills`), sorted by tick; `pos` in field cm like the events'. */
  skills?: SkillEvent[];
  /** Fill `out` for time `ms` (interpolated). Must not allocate. */
  sample(ms: number, out: SoldierTransforms): void;
  /** Output buffers sized for this source. */
  makeTransforms(): SoldierTransforms;
}

export function makeTransforms(n: number): SoldierTransforms {
  return {
    count: n,
    x: new Float32Array(n),
    y: new Float32Array(n),
    facing: new Float32Array(n),
    hp: new Float32Array(n),
    anim: new Uint8Array(n),
    visible: new Uint8Array(n),
  };
}

/** Wrap the sim's decoded replay. Pass `sampleReplay` (and optionally `makeTransforms`) from src/sim. */
export function replaySource(
  d: DecodedReplay,
  sample: (d: DecodedReplay, ms: number, out: SoldierTransforms) => SoldierTransforms,
  make: (n: number) => SoldierTransforms = makeTransforms,
): BattleSource {
  const r = d.replay;
  return {
    soldiers: r.soldiers,
    keeps: r.keeps,
    terrain: r.terrain,
    durationMs: r.ticks * TICK_MS,
    events: d.events,
    skills: d.skills ?? [],
    sample: (ms, out) => void sample(d, ms, out),
    makeTransforms: () => make(d.soldierCount),
  };
}

/**
 * A reference sampler over a DecodedReplay-shaped keyframe store (frame-major typed arrays),
 * matching the sim's `sampleReplay` semantics: lerp x/y/hp between keyframes, shortest-arc facing
 * (0..255 → radians), anim from the earlier keyframe, hidden when 255. Used by the showcase.
 */
export function sampleKeyframes(d: DecodedReplay, ms: number, out: SoldierTransforms, frameTicks = 4): SoldierTransforms {
  const n = d.soldierCount;
  const fpos = ms / (TICK_MS * frameTicks);
  const f0 = Math.max(0, Math.min(d.frameCount - 1, Math.floor(fpos)));
  const f1 = Math.min(d.frameCount - 1, f0 + 1);
  const k = Math.max(0, Math.min(1, fpos - f0));
  const a = f0 * n;
  const b = f1 * n;
  const TAU = Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const an = d.anim[a + i];
    out.anim[i] = an;
    if (an === ANIM_HIDDEN) {
      out.visible[i] = 0;
      continue;
    }
    out.visible[i] = 1;
    const bHidden = d.anim[b + i] === ANIM_HIDDEN;
    const kk = bHidden ? 0 : k;
    out.x[i] = d.x[a + i] + (d.x[b + i] - d.x[a + i]) * kk;
    out.y[i] = d.y[a + i] + (d.y[b + i] - d.y[a + i]) * kk;
    out.hp[i] = d.hp[a + i] + (d.hp[b + i] - d.hp[a + i]) * kk;
    let df = d.facing[b + i] - d.facing[a + i];
    if (df > 128) df -= 256;
    else if (df < -128) df += 256;
    out.facing[i] = (((d.facing[a + i] + df * kk) / 256) * TAU) % TAU;
  }
  out.count = n;
  return out;
}
