// Unit presentation: crest portraits (placeholders until the art agent's portraits land), role
// icons, the unit tooltip (stats, traits, counters) and the squad tooltip for the battlefield.
import type { LordId, Squad, SquadType, UnitType } from '../sim/types.ts';
import { UNITS } from '../sim/data/units.ts';
import { LORDS } from '../sim/data/lords.ts';
import { esc } from './dom.ts';
import { art } from './art.ts';
import { icon } from './icons.ts';
import { costTier, counters, dps, soldierStats, tagsOf, TAG_LABEL, unitName, WEAPON_LABEL, RARITY_CSS, SLOTS } from './gamedata.ts';

const TIER_CLASS = ['', 't1', 't2', 't3', 't4'];
const TRAIT_TEXT: Record<string, string> = {
  brace: 'Brace: braced against charges',
  charge: 'Charge: first hit deals ×2',
  pierce: 'Pierce: bolts pass through lines',
  stomp: 'Stomp: melee hits splash',
  cone: 'Cone breath attack',
  slowTurn: 'Slow to turn',
  healer: 'Heals the nearest wounded ally squad',
  ignoresArmor: 'Ignores armor',
  crushing: 'Crushing blows vs armor',
  backline: 'Holds back behind the front line',
};

export const LORD_HUE: Record<LordId, string> = { marshal: '#d9a441', archmage: '#9a6bff', warden: '#6fae6a', skylady: '#5fb8ff' };

/** A crest portrait: tier-coloured shield with the weapon glyph. */
export function crest(t: SquadType, lord?: LordId | null, size: 'sm' | 'md' | 'lg' = 'md'): string {
  const img = art(t === 'lord' ? `lord_${lord ?? 'marshal'}` : `unit_${t}`);
  if (t === 'lord') {
    const L = LORDS[lord ?? 'marshal'];
    if (img) return `<div class="crest ${size} lord art" style="--hue:${LORD_HUE[L.id]};--img:url(${img})"><i class="crest-crown">${icon('crown')}</i></div>`;
    return `<div class="crest ${size} lord" style="--hue:${LORD_HUE[L.id]}">${icon(L.weapon)}<i class="crest-crown">${icon('crown')}</i></div>`;
  }
  const d = UNITS[t];
  if (img) return `<div class="crest ${size} art ${TIER_CLASS[costTier(d.cost)]}" style="--img:url(${img})"></div>`;
  return `<div class="crest ${size} ${TIER_CLASS[costTier(d.cost)]}">${icon(d.weapon)}</div>`;
}

export function tagIcons(t: SquadType, lord?: LordId | null): string {
  return tagsOf(t, lord)
    .filter((g) => g !== 'infantry')
    .map((g) => `<span class="tagi" data-tip="${TAG_LABEL[g]}">${icon(g)}</span>`)
    .join('');
}

function statRow(label: string, v: string, ic?: string): string {
  return `<div class="st"><span>${ic ? icon(ic) : ''}${label}</span><b>${v}</b></div>`;
}

export function statBlock(t: SquadType, level: number, lord?: LordId | null): string {
  const s = soldierStats(t, level, lord);
  const range = s.range >= 400 ? `${(s.range / 100).toFixed(0)} m${s.minRange ? ` (min ${s.minRange / 100})` : ''}` : 'Melee';
  return `<div class="stats">
    ${statRow('Soldiers', String(s.size), 'squads')}
    ${statRow('Life', `${s.hp}`, 'heart')}
    ${statRow('Damage', `${s.dmg}`, 'sword')}
    ${statRow('DPS', dps(s.dmg, s.attackTicks).toFixed(1), 'flame')}
    ${statRow('Range', range, 'bow')}
    ${statRow('Speed', `${((s.speed * 20) / 100).toFixed(1)} m/s`, 'move')}
    ${statRow('Armor', `${s.armor}%`, 'shield')}
    ${statRow('Magic res.', `${s.magicResist}%`, 'staff')}
  </div>`;
}

function unitChips(list: UnitType[]): string {
  return list.map((u) => `<span class="uchip">${crest(u, null, 'sm')}${esc(UNITS[u].name)}</span>`).join('');
}

export function countersBlock(t: UnitType): string {
  const c = counters(t);
  return `<div class="ctr">
    ${c.bonuses.length ? `<div class="ctr-b">${c.bonuses.map((b) => `<span>${esc(b)}</span>`).join('')}</div>` : ''}
    ${c.strongVs.length ? `<div class="ctr-row good"><small>Strong vs</small><div>${unitChips(c.strongVs)}</div></div>` : ''}
    ${c.weakTo.length ? `<div class="ctr-row bad"><small>Countered by</small><div>${unitChips(c.weakTo)}</div></div>` : ''}
  </div>`;
}

/** Shop / draft tooltip for a unit type. */
export function unitTooltip(t: UnitType, extra = ''): string {
  const d = UNITS[t];
  const traits = d.traits.map((x) => TRAIT_TEXT[x]).filter(Boolean);
  return `<div class="utip">
    <div class="utip-h">${crest(t, null, 'md')}<div><b>${esc(d.name)}</b><small>${esc(d.role)} · ${WEAPON_LABEL[d.weapon]} · ${d.damageType === 'magic' ? 'Magic' : 'Physical'}</small></div>
      <div class="utip-cost">${icon('gold')}${d.cost}</div></div>
    <div class="utip-tags">${tagsOf(t).map((g) => `<span class="tg">${icon(g)}${TAG_LABEL[g]}</span>`).join('')}</div>
    ${statBlock(t, 1)}
    ${traits.length ? `<ul class="traits">${traits.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${countersBlock(t)}
    ${extra}
  </div>`;
}

export function lordTooltip(lord: LordId, level = 1): string {
  const L = LORDS[lord];
  return `<div class="utip">
    <div class="utip-h">${crest('lord', lord, 'md')}<div><b>${esc(L.title)} ${esc(L.name)}</b><small>Lord · Lv ${level} · ${WEAPON_LABEL[L.weapon]}</small></div></div>
    ${statBlock('lord', level, lord)}
    <div class="lt-pass"><small>Passive</small>${esc(L.passive)}</div>
    <div class="lt-abil"><small>${esc(L.abilityName)}</small>${esc(L.abilityText)}</div>
  </div>`;
}

/** Compact tooltip for a squad on the field (own or ghost). */
export function squadTooltip(sq: Squad, lord: LordId | null, opts: { ghost?: boolean; hint?: string } = {}): string {
  const name = unitName(sq.type, lord);
  const items = SLOTS.map((s) => sq.items[s]).filter(Boolean);
  const s = soldierStats(sq.type, sq.level, lord);
  return `<div class="sqtip ${opts.ghost ? 'ghost' : ''}">
    <div class="utip-h">${crest(sq.type, lord, 'sm')}<div><b>${esc(name)}</b><small>${opts.ghost ? 'Enemy · last round · ' : ''}Level ${sq.level}${sq.type !== 'lord' ? ` · ${s.size} soldiers` : ''}</small></div></div>
    <div class="sqtip-st"><span>${icon('heart')}${s.hp}</span><span>${icon('sword')}${dps(s.dmg, s.attackTicks).toFixed(1)} dps</span><span>${icon('bow')}${s.range >= 400 ? (s.range / 100).toFixed(0) + ' m' : 'melee'}</span></div>
    ${items.length ? `<div class="sqtip-items">${items.map((it) => `<span style="color:${RARITY_CSS[it!.rarity]}">${esc(itemShort(it!))}</span>`).join('')}</div>` : ''}
    ${opts.hint ? `<div class="it-hint">${esc(opts.hint)}</div>` : ''}
  </div>`;
}

import { itemName } from '../sim/loot.ts';
function itemShort(it: Parameters<typeof itemName>[0]): string {
  return itemName(it);
}
