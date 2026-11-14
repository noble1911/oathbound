// ARPG item presentation: the rarity-framed icon and the Diablo-style tooltip built from the sim's
// `itemLines()` (name in rarity colour, base type, implicit, affixes, orange legendary power and
// italic flavour), with an optional comparison block against the equipped item.
import type { BaseId, Item, ItemLine, Slot } from '../sim/types.ts';
import { itemLines } from '../sim/loot.ts';
import { esc } from './dom.ts';
import { art } from './art.ts';
import { icon } from './icons.ts';
import { compareItems, RARITY_CSS, SLOT_LABEL } from './gamedata.ts';

const BASE_ICON: Record<BaseId, string> = {
  steel_blade: 'sword', ironbark_bow: 'bow', war_axe: 'axe', ash_spear: 'lance', grimoire: 'tome',
  mail_hauberk: 'armor', warded_robe: 'armor', plate_cuirass: 'shield', leather_jerkin: 'armor',
  bone_charm: 'skull', sun_medallion: 'star', oath_ring: 'relic', war_banner: 'crown',
};

export function itemIcon(item: Item | null, opts: { slot?: Slot; size?: 'sm' | 'md' | 'lg'; locked?: number; drag?: boolean; extra?: string } = {}): string {
  const size = opts.size ?? 'md';
  if (!item) {
    const slot = opts.slot ?? 'weapon';
    if (opts.locked) return `<div class="islot locked ${size}" data-slot="${slot}" data-tip="${SLOT_LABEL[slot]} slot opens at squad level ${opts.locked}">${icon('lock')}<small>Lv${opts.locked}</small></div>`;
    return `<div class="islot empty ${size}" data-slot="${slot}" ${opts.extra ?? ''}>${icon(slot)}<small>${SLOT_LABEL[slot]}</small></div>`;
  }
  return `<div class="islot item ${size} r-${item.rarity}${item.legendary ? ' leg' : ''}" style="--rar:${RARITY_CSS[item.rarity]}" data-item="${item.id}" data-slot="${item.slot}" ${opts.drag ? 'data-drag="1"' : ''} ${opts.extra ?? ''}>${art(`item_${item.base}`) ? `<i class="islot-img" style="background-image:url(${art(`item_${item.base}`)})"></i>` : icon(BASE_ICON[item.base] ?? item.slot)}</div>`;
}

function line(l: ItemLine, item: Item): string {
  const t = esc(l.text);
  switch (l.style) {
    case 'name': return `<div class="it-name" style="color:${RARITY_CSS[item.rarity]}">${t}</div>`;
    case 'base': return `<div class="it-base" style="color:${RARITY_CSS[item.rarity]}">${t}</div>`;
    case 'meta': return `<div class="it-meta">${t}</div>`;
    case 'implicit': return `<div class="it-implicit">${t}</div><div class="it-rule"></div>`;
    case 'affix': return `<div class="it-affix">${t}</div>`;
    case 'legendary': return `<div class="it-rule"></div><div class="it-leg">${icon('star')}<span>${t}</span></div>`;
    case 'flavor': return `<div class="it-flavor">${t}</div>`;
  }
}

/** The tooltip card. `compare` = the item currently in that slot (null = slot empty), undefined = no comparison. */
export function itemTooltip(item: Item, opts: { compare?: Item | null; compareLabel?: string; hint?: string } = {}): string {
  const lines = itemLines(item);
  let body = '';
  // the header (name + base) goes in the banner; the rest below
  const head = lines.filter((l) => l.style === 'name' || l.style === 'base');
  const rest = lines.filter((l) => l.style !== 'name' && l.style !== 'base');
  body += `<div class="it-head">${head.map((l) => line(l, item)).join('')}</div>`;
  body += `<div class="it-body">${rest.map((l) => line(l, item)).join('')}`;
  if (opts.compare !== undefined) {
    const deltas = compareItems(item, opts.compare);
    body += `<div class="it-cmp"><div class="it-cmp-h">${esc(opts.compareLabel ?? (opts.compare ? 'If equipped instead' : 'Slot is empty'))}</div>`;
    body += deltas.length ? deltas.map((d) => `<div class="${d.good ? 'up' : 'down'}">${d.good ? '▲' : '▼'} ${esc(d.text)}</div>`).join('') : '<div class="same">No change</div>';
    body += '</div>';
  }
  if (opts.hint) body += `<div class="it-hint">${esc(opts.hint)}</div>`;
  body += '</div>';
  return `<div class="itip r-${item.rarity}" style="--rar:${RARITY_CSS[item.rarity]}">${body}</div>`;
}

/** Two tooltips side by side: the hovered item and what it would replace. */
export function itemTooltipPair(item: Item, equipped: Item | null, hint?: string): string {
  const main = itemTooltip(item, { compare: equipped, hint });
  if (!equipped) return main;
  return `<div class="itip-pair">${main}<div class="itip-eq"><div class="itip-eq-h">Equipped</div>${itemTooltip(equipped)}</div></div>`;
}
