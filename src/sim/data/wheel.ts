// The counter wheel (DESIGN §3): eight classes in a ring, each beating the next one around it.
//   Swarm > Giant > Line > Cavalry > Ranged > Air > Siege > Magic > Swarm
// A unit deals COUNTER_PCT (constants.ts) damage to the class it beats; every other pairing is neutral. Every unit
// (UnitDef.class) and every Lord (LordDef.class: the class of its body or mount) belongs to exactly one class.
import type { WheelClass } from '../types.ts';

/** The ring, in order: WHEEL[i] beats WHEEL[i + 1] (and the last beats the first). */
export const WHEEL: readonly WheelClass[] = ['swarm', 'giant', 'line', 'cavalry', 'ranged', 'air', 'siege', 'magic'];

export const WHEEL_NAME: Record<WheelClass, string> = {
  swarm: 'Swarm', giant: 'Giant', line: 'Line', cavalry: 'Cavalry', ranged: 'Ranged', air: 'Air', siege: 'Siege', magic: 'Magic',
};
/** Why a class beats the next one (the help screen and the tooltips quote these). */
export const WHEEL_WHY: Record<WheelClass, string> = {
  swarm: 'many bodies drag a giant down, and each huge blow kills only one man',
  giant: 'tramples a packed formation',
  line: 'braced pikes and shields stop the charge',
  cavalry: 'rides down the archers',
  ranged: 'shoots fliers out of the sky',
  air: 'dives on crews who cannot aim upwards',
  siege: 'outranges and splashes fragile casters',
  magic: 'splash on packed, weak men',
};

const IDX: Record<WheelClass, number> = Object.fromEntries(WHEEL.map((c, i) => [c, i])) as Record<WheelClass, number>;

/** The class `c` beats. */
export function beatsClass(c: WheelClass): WheelClass {
  return WHEEL[(IDX[c] + 1) % WHEEL.length];
}
/** The class that beats `c`. */
export function beatenBy(c: WheelClass): WheelClass {
  return WHEEL[(IDX[c] + WHEEL.length - 1) % WHEEL.length];
}
/** Does class `a` beat class `b` (and so deal COUNTER_PCT damage to it)? */
export function classBeats(a: WheelClass, b: WheelClass): boolean {
  return beatsClass(a) === b;
}
/** Index of a class on the ring (0..7): the battle compares these as small ints. */
export function wheelIndex(c: WheelClass): number {
  return IDX[c];
}
