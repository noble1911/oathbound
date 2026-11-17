// Pure mapping from the sim's debuff / buff ability events to the effect the playback draws.
// No three.js here, so it can be unit-tested (tests/render.abilityfx.test.ts).
//
// The sim emits one event when a window STARTS on soldier `tgt` (refreshes are not repeated) and
// carries its real length in `dur` ticks:
//   'frost'   - a slow, dur = the slow's remaining ticks          -> chill tint + frost motes
//   'burn'    - a burn / the Corpse Catapult's plague, dur 60      -> flames (or plague) on the soldier
//               (a refreshed burn gets a follow-up event as each window ends, dur = what is left)
//   'war_cry' - radius 0: a Sun Priest's blessing on one soldier   -> a small per-soldier gold glow
//               radius > 0: an area war cry                        -> the big shockwave
import type { AbilityEventKind, SkillId } from '../sim/types.ts';
import { TICK_MS } from './battle-source.ts';

export type AbilityFxSpec =
  /** Slowed for `sec`: cold (or sand) cast; `burst` = also a one-off frost burst on him (single-target slows). */
  | { kind: 'chill'; sec: number; sand: boolean; burst: boolean }
  /** Burning for `sec` (flames following him), or festering with plague. */
  | { kind: 'burn'; sec: number; plague: boolean }
  /** Blessed for `sec`: a soft gold glow on the one soldier. */
  | { kind: 'bless'; sec: number }
  /** The area war-cry shockwave over `radiusM`. */
  | { kind: 'warCry'; radiusM: number };

export interface AbilityFxEvent {
  ability: AbilityEventKind;
  /** cm (0 = single soldier). */
  radius: number;
  /** ticks. */
  dur: number;
}

export interface AbilityFxContext {
  /** Unit type of the event's source soldier (undefined: none / a keep). */
  srcType?: string;
  /** Item skill the source's squad cast on this very tick (its area visual is already drawn), if any. */
  srcSkill?: SkillId | null;
}

const sec = (ticks: number): number => Math.max(0, (ticks * TICK_MS) / 1000);

/** The effect for a debuff / buff ability event, or null when the event is not one of those windows. */
export function abilityFx(e: AbilityFxEvent, ctx: AbilityFxContext = {}): AbilityFxSpec | null {
  switch (e.ability) {
    case 'frost': {
      // a whirlwind (Djinn-Binder) or a trample kicks up sand; everything else is cold
      const sand = ctx.srcType === 'djinn_binder' || ctx.srcSkill === 'trample';
      // a skill that slows a crowd (Frost Nova, Trample, ...) draws its own area effect: no burst per soldier
      return { kind: 'chill', sec: sec(e.dur), sand, burst: !sand && !ctx.srcSkill };
    }
    case 'burn':
      return { kind: 'burn', sec: sec(e.dur), plague: ctx.srcType === 'corpse_catapult' };
    case 'war_cry':
      return e.radius > 0 ? { kind: 'warCry', radiusM: Math.max(4, e.radius / 100) } : { kind: 'bless', sec: sec(e.dur) };
    default:
      return null;
  }
}
