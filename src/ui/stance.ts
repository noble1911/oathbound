// The Lord's battle stance on the planning screen (DESIGN §4): Advance (the default), Hold his post, or Follow one of
// your squads. Pure helpers over the sim's own rule (src/sim/match.ts lordStance, src/sim/battle.ts HOLD_WATCH /
// HOLD_LEASH / FOLLOW_BEHIND / buildStats): the words the control and tooltips use, the watch ring, the leash and the
// follow spot the field markers draw, and the intel line on the enemy Lord's ghost (the stance he fought the LAST battle with).
import { FOLLOW_BEHIND, HOLD_LEASH, HOLD_WATCH, buildStats } from '../sim/battle.ts';
import { FIELD_H } from '../sim/constants.ts';
import { lordStance } from '../sim/match.ts';
import type { Intent, LordId, LordStance, LordStanceKind, Seat, Squad, Vec2 } from '../sim/types.ts';
import { unitName } from './gamedata.ts';
import type { StanceSpec } from './scene-adapter.ts';

export const STANCE_KINDS: readonly LordStanceKind[] = ['advance', 'hold', 'follow'];
export const STANCE_LABEL: Record<LordStanceKind, string> = { advance: 'Advance', hold: 'Hold', follow: 'Follow' };
/** Icon names (src/ui/icons.ts). */
export const STANCE_ICON: Record<LordStanceKind, string> = { advance: 'st_advance', hold: 'st_hold', follow: 'st_follow' };

/** Metres, kept on one line with their number. */
const m = (cm: number) => `${Math.round(cm / 100)}\u00a0m`;
/** A ranged Lord's leash is his range plus this (cm). The sim's leash test (src/sim/battle.ts) adds it inline, as its
 *  ranged aggro does; tests/client.stance.test.ts checks the two agree. */
export const RANGED_LEASH_PLUS = 300;

/** The effective stance of my army as shown: a pending one (sent, not yet confirmed) wins over the snapshot's. */
export function shownStance(squads: readonly Squad[], pending: LordStance | null): LordStance {
  const st = pending ?? lordStance({ squads: squads as Squad[] });
  // a follow whose squad is gone (sold) is an advance, as in the sim
  if (st.t === 'follow' && !squads.some((q) => q.id === st.squad && q.type !== 'lord')) return { t: 'advance' };
  return st;
}

/** How far from his spot a following Lord goes after an enemy (cm): 14 m, or a ranged Lord's range + 3 m. */
export function stanceLeash(lordSq: Pick<Squad, 'type' | 'level' | 'items'>, lord: LordId | null): number {
  const st = buildStats(lordSq, lord);
  return st.ranged ? st.range + RANGED_LEASH_PLUS : HOLD_LEASH;
}

/** Where a following Lord stands: FOLLOW_BEHIND behind the squad he follows, towards his own Keep. */
export function followSpot(lead: Pick<Squad, 'pos'>, seat: Seat): Vec2 {
  const y = lead.pos[1] - (seat === 0 ? 1 : -1) * FOLLOW_BEHIND;
  return [lead.pos[0], Math.max(0, Math.min(FIELD_H - 1, y))];
}

/** The intent that sets `st`. */
export function stanceIntent(st: LordStance): Intent {
  return st.t === 'follow' ? { t: 'stance', stance: 'follow', squad: st.squad } : { t: 'stance', stance: st.t };
}

export function sameStance(a: LordStance, b: LordStance): boolean {
  return a.t === b.t && (a.t !== 'follow' || a.squad === (b as { squad: number }).squad);
}

/** A squad's name as the stance control names it ("Knights Lv 2"). */
export function leadName(sq: Pick<Squad, 'type' | 'level'>): string {
  return `${unitName(sq.type)}${sq.level > 1 ? ` Lv ${sq.level}` : ''}`;
}

/** The squads a Lord may be told to follow: my own, not the Lord. */
export function followable(squads: readonly Squad[]): Squad[] {
  return squads.filter((q) => q.type !== 'lord');
}

/** Tooltips of the three buttons, in the leash numbers of this Lord. */
export function stanceTip(kind: LordStanceKind, leash: number): string {
  if (kind === 'advance') return 'Advance: he marches on the nearest enemy squad, like any squad. The default.';
  if (kind === 'hold') return `Hold: he waits on the spot you put him on until an enemy comes within ${m(HOLD_WATCH)} of it, or no other squad of yours is left. Then he fights as usual. Best near the front edge, to let the enemy come to him: posted deep, he arrives late.`;
  return `Follow: pick one of your squads. He stays ${m(FOLLOW_BEHIND)} behind it and fights what comes within ${m(leash)} of that spot. If the squad falls, he advances.`;
}

/** One line under the control: what he will do in the coming battle. */
export function stanceLine(st: LordStance, squads: readonly Squad[], leash: number): string {
  if (st.t === 'advance') return 'Marches on the nearest enemy squad';
  if (st.t === 'hold') return `Waits here until an enemy comes within ${m(HOLD_WATCH)}, then fights`;
  const lead = squads.find((q) => q.id === st.squad);
  return `Follows ${lead ? leadName(lead) : 'a squad'}, ${m(FOLLOW_BEHIND)} behind it; advances if it falls`;
}

/**
 * The intel on the enemy Lord's ghost: the stance he fought the last battle with (public, like positions; never this
 * round's). `army` is that last-round army, to name the squad he followed (a follow of a squad not in it was an advance).
 */
export function ghostStanceText(lordSq: Pick<Squad, 'stance'>, army: readonly Squad[]): { kind: LordStanceKind; short: string; line: string } {
  const st = lordSq.stance;
  if (st?.t === 'hold') return { kind: 'hold', short: 'Held', line: 'Held his post last battle' };
  const lead = st?.t === 'follow' ? army.find((q) => q.id === st.squad && q.type !== 'lord') : undefined;
  if (lead) return { kind: 'follow', short: 'Followed', line: `Followed their ${unitName(lead.type)} last battle` };
  return { kind: 'advance', short: 'Advanced', line: 'Advanced on the nearest enemy last battle' };
}

/** What the field markers draw for my Lord's stance (sim cm), or null for Advance. */
export type StanceMarker = StanceSpec;

export function stanceMarker(st: LordStance, squads: readonly Squad[], lord: LordId | null, seat: Seat, focus: boolean): StanceMarker | null {
  const lsq = squads.find((q) => q.type === 'lord');
  if (!lsq || st.t === 'advance') return null;
  const leash = stanceLeash(lsq, lord);
  // hold: the ring is the watch (the same for every Lord): an enemy inside it, and he leaves his post
  if (st.t === 'hold') return { kind: 'hold', lord: lsq.pos, post: lsq.pos, leash: HOLD_WATCH, focus, label: `Hold · watches ${m(HOLD_WATCH)}` };
  const lead = squads.find((q) => q.id === st.squad && q.type !== 'lord');
  if (!lead) return null;
  return { kind: 'follow', lord: lsq.pos, post: followSpot(lead, seat), lead: lead.pos, leash, focus, label: `Follow ${unitName(lead.type)}` };
}
