// ARPG item presentation: the rarity-framed icon and the Diablo-style tooltip built from the sim's
// `itemLines()` (name in rarity colour, base type, implicit, affixes, orange legendary power and
// italic flavour), with an optional comparison block against the equipped item.
import type { BaseId, Item, ItemLine, LordId, Slot, SquadType } from '../sim/types.ts';
import { itemLines } from '../sim/loot.ts';
import { esc } from './dom.ts';
import { art } from './art.ts';
import { icon } from './icons.ts';
import { compareItems, deadLines, RARITY_CSS, SLOT_LABEL, unitName } from './gamedata.ts';
import { SLOT_UNLOCK_LEVEL } from '../sim/data/items.ts';

/** The squad a tooltip is judged against: lines that do nothing there are greyed. */
export interface ItemTarget { type: SquadType; lord?: LordId | null }

const BASE_ICON: Record<BaseId, string> = {
  steel_blade: 'sword', ironbark_bow: 'bow', war_axe: 'axe', ash_spear: 'lance', grimoire: 'tome',
  mail_hauberk: 'armor', warded_robe: 'armor', plate_cuirass: 'shield', leather_jerkin: 'armor',
  bone_charm: 'skull', sun_medallion: 'star', oath_ring: 'relic', war_banner: 'crown',
};

export function itemIcon(item: Item | null, opts: { slot?: Slot; size?: 'sm' | 'md' | 'lg'; locked?: number; drag?: boolean; extra?: string } = {}): string {
  const size = opts.size ?? 'md';
  if (!item) {
    const slot = opts.slot ?? 'weapon';
    if (opts.locked) return `<div class="islot locked ${size}" data-slot="${slot}" data-tip="${SLOT_LABEL[slot]} slot opens at squad level ${opts.locked}. Level the squad up to use it.">${icon('lock')}<small>Lv${opts.locked}</small></div>`;
    return `<div class="islot empty ${size}" data-slot="${slot}" data-tip="Empty ${SLOT_LABEL[slot].toLowerCase()} slot: drag an item here" ${opts.extra ?? ''}>${icon(slot)}</div>`;
  }
  return `<div class="islot item ${size} r-${item.rarity}${item.legendary ? ' leg' : ''}" style="--rar:${RARITY_CSS[item.rarity]}" data-item="${item.id}" data-slot="${item.slot}" ${opts.drag ? 'data-drag="1"' : ''} ${opts.extra ?? ''}>${art(`item_${item.base}`) ? `<i class="islot-img" style="background-image:url(${art(`item_${item.base}`)})"></i>` : icon(BASE_ICON[item.base] ?? item.slot)}</div>`;
}

/** One wording everywhere: the sim's affix text says "Flying units", the HUD says "Flier". */
function wording(t: string): string {
  return t.replace(/Flying units/g, 'Fliers').replace(/Flying/g, 'Flier');
}

function line(l: ItemLine, item: Item, dead: string | null = null): string {
  const t = esc(wording(l.text));
  const off = dead ? ` dead" data-tip="No effect on this squad: ${esc(dead)}` : '';
  const note = dead ? `<small class="it-dead">no effect: ${esc(dead)}</small>` : '';
  switch (l.style) {
    case 'name': return `<div class="it-name" style="color:${RARITY_CSS[item.rarity]}">${t}</div>`;
    case 'base': return `<div class="it-base" style="color:${RARITY_CSS[item.rarity]}">${t}</div>`;
    case 'meta': return `<div class="it-meta">${t}</div>`;
    case 'implicit': return `<div class="it-implicit${off}">${t}${note}</div><div class="it-rule"></div>`;
    case 'affix': return `<div class="it-affix${off}">${t}${note}</div>`;
    case 'legendary': return `<div class="it-rule"></div><div class="it-leg${off}">${icon('star')}<span>${t}${note}</span></div>`;
    case 'flavor': return `<div class="it-flavor">${t}</div>`;
  }
}

/**
 * The tooltip card. `compare` = the item currently in that slot (null = slot empty), undefined = no
 * comparison. `on` = the squad it is judged against: affixes that do nothing there (range on a
 * melee squad, damage on healers) are greyed and say why.
 */
export function itemTooltip(item: Item, opts: { compare?: Item | null; compareLabel?: string; hint?: string; on?: ItemTarget | null } = {}): string {
  const lines = itemLines(item);
  const dead = opts.on ? deadLines(item, opts.on.type, opts.on.lord) : null;
  let body = '';
  // the header (name + base) goes in the banner; the rest below
  const head = lines.filter((l) => l.style === 'name' || l.style === 'base');
  const rest = lines.filter((l) => l.style !== 'name' && l.style !== 'base');
  let ai = 0;
  const why = (l: ItemLine): string | null => {
    if (!dead) return null;
    if (l.style === 'implicit' || l.style === 'affix') return dead.affix[ai++] ?? null;
    if (l.style === 'legendary') return dead.legendary;
    return null;
  };
  body += `<div class="it-head">${head.map((l) => line(l, item)).join('')}</div>`;
  body += `<div class="it-body">${rest.map((l) => line(l, item, why(l))).join('')}`;
  if (opts.compare !== undefined) {
    const deltas = compareItems(item, opts.compare);
    body += `<div class="it-cmp"><div class="it-cmp-h">${esc(opts.compareLabel ?? (opts.compare ? 'If equipped instead' : 'Slot is empty'))}</div>`;
    body += deltas.length ? deltas.map((d) => `<div class="${d.good ? 'up' : 'down'}">${d.good ? '▲' : '▼'} ${esc(wording(d.text))}</div>`).join('') : '<div class="same">No change</div>';
    body += '</div>';
  }
  if (opts.hint) body += `<div class="it-hint">${esc(opts.hint)}</div>`;
  body += '</div>';
  return `<div class="itip r-${item.rarity}" style="--rar:${RARITY_CSS[item.rarity]}">${body}</div>`;
}

/** "Armor slot opens at squad level 2". */
export function slotLockText(slot: Slot): string {
  return `${SLOT_LABEL[slot]} slot opens at squad level ${SLOT_UNLOCK_LEVEL[slot]}`;
}

/** Why an item is a poor match for a squad, in one line, or null when every line works. */
export function deadSummary(item: Item, on: ItemTarget): string | null {
  const d = deadLines(item, on.type, on.lord);
  const n = d.affix.filter(Boolean).length + (d.legendary ? 1 : 0);
  if (!n) return null;
  const why = d.affix.find(Boolean) ?? d.legendary!;
  return `${n} line${n === 1 ? '' : 's'} do${n === 1 ? 'es' : ''} nothing on ${unitName(on.type, on.lord)} (${why})`;
}

/** Two tooltips side by side: the hovered item and what it would replace. */
export function itemTooltipPair(item: Item, equipped: Item | null, hint?: string, on?: ItemTarget | null): string {
  const main = itemTooltip(item, { compare: equipped, hint, on });
  if (!equipped) return main;
  return `<div class="itip-pair">${main}<div class="itip-eq"><div class="itip-eq-h">Equipped</div>${itemTooltip(equipped, { on })}</div></div>`;
}
