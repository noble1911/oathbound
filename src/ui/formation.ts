// A squad's formation on the planning screen (DESIGN §3): Wide (a line) or Deep (a block, the sim's default). Pure helpers over the
// sim's own rule (src/sim/data/units.ts hasFormation / formationGrid and the formation numbers, src/sim/match.ts
// {t:'formation'}): every word the control, the tooltips, the keys help, the tutorial, the codex and the ghost intel say
// about formations is built here from those constants, so a balance change to the numbers changes the copy too.
//
// Which formation is the default (the one a squad has when Squad.formation is absent) is the sim's DEFAULT_FORMATION
// and formationOf; which one carries the modifiers is the EFFECT table below. Nothing else in the client may assume
// either (no `formation ?? 'wide'` anywhere: use formationOf / withFormation / marked).
import { DEFAULT_FORMATION, FORMATION_MIN_SIZE, WIDE_AREA_PCT, WIDE_MELEE_PCT, formationOf as simFormationOf, hasFormation } from '../sim/data/units.ts';
import type { Formation, Intent, Squad, SquadType } from '../sim/types.ts';

/** The formation of a squad whose Squad.formation is absent (the sim's; a deploy from the shop stands so). */
export { DEFAULT_FORMATION };
export const FORMATIONS: readonly Formation[] = ['wide', 'deep'];
export const FORMATION_LABEL: Record<Formation, string> = { wide: 'Wide', deep: 'Deep' };
/** Icon names (src/ui/icons.ts). */
export const FORMATION_ICON: Record<Formation, string> = { wide: 'fm_wide', deep: 'fm_deep' };
/** The hotkey that flips the selected squads between the two (F is full screen everywhere; R was free once the turn keys went). */
export const FORMATION_KEY = 'R';

/** How each formation stands (geometry: formationGrid; it does not change with the balance). */
const SHAPE: Record<Formation, string> = { wide: 'a line, one to three ranks deep', deep: 'a block, one to four files wide' };
/** The shape in two words (the tutorial line). */
const SHAPE_SHORT: Record<Formation, string> = { wide: 'a line', deep: 'a block' };
/**
 * What each formation does in battle, from the sim's numbers: `mods` its modifiers (none: empty), `plain` what its shape
 * does on its own, `short` the one line under the control. When the rule moves, this table is the one place to change.
 */
const EFFECT: Record<Formation, { mods: string[]; plain: string; short: string }> = {
  wide: {
    mods: [`takes ${WIDE_AREA_PCT}% less damage from area hits (splash, cones, blasts)`, `${WIDE_MELEE_PCT}% more from melee blows`],
    plain: 'Every soldier reaches the enemy at once, but no rank stands behind the first.',
    short: `${WIDE_AREA_PCT}% less from splash, ${WIDE_MELEE_PCT}% more from melee`,
  },
  deep: {
    mods: [],
    plain: 'The squad as its numbers say: packed, so a splash catches most of it, and its front ranks fight first.',
    short: 'Packed: plain numbers, splash catches most',
  },
};
const dflt = (f: Formation): string => (f === DEFAULT_FORMATION ? ' (the default)' : '');
const modsText = (f: Formation, b = false): string =>
  EFFECT[f].mods.length ? `It ${EFFECT[f].mods.map((m) => (b ? `<b>${m}</b>` : m)).join(' and ')}. ` : '';

/** Does a squad of this type have the choice? (Squads of FORMATION_MIN_SIZE soldiers or more; never the Lord.) */
export function canForm(type: SquadType): boolean {
  return hasFormation(type);
}

/** A squad's formation as the battle reads it: absent (or a type without the choice) is DEFAULT_FORMATION. */
export function formationOf(sq: Pick<Squad, 'type' | 'formation'>): Formation {
  return simFormationOf(sq);
}

/** A copy of `sq` standing in `f`, stored as the sim stores it (the default is the field left out). */
export function withFormation<T extends Pick<Squad, 'formation'>>(sq: T, f: Formation): T {
  const q = { ...sq };
  if (f === DEFAULT_FORMATION) delete q.formation;
  else q.formation = f;
  return q;
}

/** Is `f` worth a mark on the field and in tooltips (the formation that is not the default)? */
export function marked(f: Formation): boolean {
  return f !== DEFAULT_FORMATION;
}

/** The intent that sets it. */
export function formationIntent(squad: number, formation: Formation): Intent {
  return { t: 'formation', squad, formation };
}

/** The other one (the hotkey flips). */
export function otherFormation(f: Formation): Formation {
  return f === 'wide' ? 'deep' : 'wide';
}

/**
 * What the group key and the group buttons do to a selection: if any squad that has the choice stands in the default
 * formation, all take the other one; otherwise all go back to the default. Null when none of them has a formation.
 */
export function groupTarget(squads: readonly Pick<Squad, 'type' | 'formation'>[]): Formation | null {
  const able = squads.filter((q) => hasFormation(q.type));
  if (!able.length) return null;
  return able.some((q) => formationOf(q) === DEFAULT_FORMATION) ? otherFormation(DEFAULT_FORMATION) : DEFAULT_FORMATION;
}

/** Tooltips of the two buttons (with the hotkey). */
export function formationTip(f: Formation): string {
  return `${FORMATION_LABEL[f]}${dflt(f)}: ${SHAPE[f]}. ${modsText(f)}${EFFECT[f].plain} [${FORMATION_KEY}]`;
}

/** One line under the control: what this formation does in the coming battle. */
export function formationLine(f: Formation): string {
  return EFFECT[f].short;
}

/** Said once under the control: changing it is always free, also for a squad locked in place. */
export const FORMATION_FREE = 'Free to change, even when locked in place';

/** The intel on an enemy ghost: how it stood in the last battle (public, like positions; never this round's). */
export function ghostFormationText(sq: Pick<Squad, 'type' | 'formation'>): string | null {
  if (!hasFormation(sq.type)) return null;
  return `Stood ${FORMATION_LABEL[formationOf(sq)].toLowerCase()} last battle`;
}

/** The tutorial's lines: on deploying (what a squad's formation is), and on locked squads (it stays free). */
export function formationCoach(): string {
  const one = (f: Formation): string => `<b>${FORMATION_LABEL[f]}</b>${dflt(f)} is ${SHAPE_SHORT[f]}: ${EFFECT[f].short.toLowerCase()}`;
  return `Select a squad to set its <b>formation</b> (<kbd>${FORMATION_KEY}</kbd>). ${FORMATIONS.map(one).join('. ')}.`;
}
export function formationLockedCoach(): string {
  return `Their <b>formation</b> is still free to change (<kbd>${FORMATION_KEY}</kbd>).`;
}

/** The codex section (src/ui/rules.ts, "The match" page). */
export function formationRules(): string {
  const items = FORMATIONS.map((f) => `<li><b>${FORMATION_LABEL[f]}</b>${dflt(f)}: ${SHAPE[f]}. ${modsText(f, true)}${EFFECT[f].plain}</li>`).join('\n          ');
  return `<h3>Formation: wide or deep</h3>
        <p>Every squad of ${FORMATION_MIN_SIZE} or more soldiers stands in one of two formations, and always faces the enemy. Pick it on the squad's panel or press <kbd>${FORMATION_KEY}</kbd> (on a selection: all of them).</p>
        <ul class="rl-list">
          ${items}
          <li>Changing it is <b>free</b>, as often as you like, <b>even for a squad locked in place</b>: it changes how the squad stands, not where. Its ground is the same either way.</li>
          <li>Squads of one or two soldiers and the Lord have no formation. The enemy sees your formations only as they fought the last battle.</li>
        </ul>`;
}
