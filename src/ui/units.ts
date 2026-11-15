// Unit presentation: crest portraits (placeholders until the art agent's portraits land), role
// icons, the unit tooltip (stats, traits, counters) and the squad tooltip for the battlefield.
import { FACTIONS } from '../sim/data/factions.ts';
import { unitSkills } from '../sim/data/skills.ts';
import type { Item, LordId, SkillInfo, Squad, SquadType, UnitType } from '../sim/types.ts';
import type { SquadSheet, StatKey, StatLine } from '../sim/sheet.ts';
import { UNITS } from '../sim/data/units.ts';
import { LORDS } from '../sim/data/lords.ts';
import { esc } from './dom.ts';
import { art, glyphVars } from './art.ts';
import { icon } from './icons.ts';
import { cooldownText, skillGlyph } from './items.ts';
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

export const LORD_HUE: Record<LordId, string> = {
  marshal: '#b98a2e', archmage: '#6a4fb0', warden: '#3f7a48', skylady: '#3f86c4', lich: '#4fbf7a', sultana: '#2fa7a0',
  deathknight: '#7f9a5a', ossuary: '#a89f86', drakerider: '#5a8f7a', vizier: '#4f86c9', rajah: '#c9873a', rocrider: '#d0a24a',
};

/**
 * A crest: the woodcut portrait in a shield. It also carries the unit's battlefield glyph (class `gl` + sprite
 * variables); the stylesheet swaps to the glyph, in a round disc, wherever a crest is drawn too small for a
 * portrait to read (`.crest.sm` and a few compact surfaces: see "glyph crests" in style.css).
 */
export function crest(t: SquadType, lord?: LordId | null, size: 'sm' | 'md' | 'lg' = 'md'): string {
  const id = t === 'lord' ? `lord_${lord ?? 'marshal'}` : `unit_${t}`;
  const img = art(id);
  const g = glyphVars(id);
  const gl = g ? ' gl' : '';
  if (t === 'lord') {
    const L = LORDS[lord ?? 'marshal'];
    if (img) return `<div class="crest ${size} lord art${gl}" style="--hue:${LORD_HUE[L.id]};--img:url(${img});${g}"><i class="crest-crown">${icon('crown')}</i></div>`;
    return `<div class="crest ${size} lord${gl}" style="--hue:${LORD_HUE[L.id]};${g}">${icon(L.weapon)}<i class="crest-crown">${icon('crown')}</i></div>`;
  }
  const d = UNITS[t];
  if (img) return `<div class="crest ${size} art ${TIER_CLASS[costTier(d.cost)]}${gl}" style="--img:url(${img});${g}"></div>`;
  return `<div class="crest ${size} ${TIER_CLASS[costTier(d.cost)]}${gl}" style="${g}">${icon(d.weapon)}</div>`;
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

const SHEET_ROW: Record<StatKey, [label: string, icon: string]> = {
  soldiers: ['Soldiers', 'squads'], hp: ['Life', 'heart'], damage: ['Damage', 'sword'], attackInterval: ['Attack every', 'timer'], dps: ['DPS', 'flame'],
  heal: ['Heal', 'heart'], range: ['Range', 'bow'], armor: ['Armor', 'shield'], magicResist: ['Magic res.', 'staff'], speed: ['Speed', 'move'],
  crit: ['Critical rate', 'star'], lifesteal: ['Lifesteal', 'heart'],
};

function sheetValue(l: StatLine, v: number): string {
  if (l.key === 'range') return v < 4 ? 'Melee' : `${v} m`;
  return l.unit === '%' ? `${v}%` : l.unit ? `${v} ${l.unit}` : String(v);
}

/**
 * The stat table of a squad sheet (src/sim/sheet.ts): one number where level and items change
 * nothing, else "base → now" with the effective value marked better (green) or worse (red).
 * `base` is the same squad at level 1 with no items.
 */
const ordinalOf = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
export function sheetStats(sheet: SquadSheet): string {
  const rows = sheet.stats
    .filter((l) => l.base !== 0 || l.value !== 0 || (l.key !== 'crit' && l.key !== 'lifesteal'))
    .map((l) => {
      const [label, ic] = SHEET_ROW[l.key];
      const base = sheetValue(l, l.base);
      const now = sheetValue(l, l.value);
      // crits are counted, not rolled: say how often
      const full = l.key === 'crit' ? `Critical rate${l.value > 0 ? `: every ${ordinalOf(Math.round(100 / l.value))} attack of each soldier is critical (×1.5)` : ''}` : l.label;
      if (base === now) return `<div class="st" data-tip="${esc(full)}"><span>${icon(ic)}${label}</span><b>${now}</b></div>`;
      const better = l.value > l.base === l.higherIsBetter;
      return `<div class="st chg" data-tip="${esc(full)}${l.key === 'crit' ? '. ' : ': '}${base} at level 1 with no items, ${now} now"><span>${icon(ic)}${label}</span><b><small class="st-base">${base}</small><i class="st-to">→</i><em class="${better ? 'up' : 'down'}">${now}</em></b></div>`;
    });
  return `<div class="stats">${rows.join('')}</div>`;
}

const SKILL_SOURCE: Record<SkillInfo['source'], string> = { innate: 'Innate', lord: 'Lord', item: 'Item' };
/** The glyph of an innate or Lord ability (item skills have their own, see items.ts). */
export const INNATE_ICON: Record<string, string> = {
  heal: 'heart', brace: 'shield', charge: 'mounted', raider: 'move', lifesteal: 'heart', pierce: 'bolt', stomp: 'large', cone: 'breath', splash: 'stone',
  magic: 'tome', crushing: 'fists', min_range: 'stone', flier: 'flier', armored: 'armored', resist: 'staff', ranged: 'bow',
  rally: 'flag', bulwark: 'shield', meteor: 'flame', skyfall: 'flier', necromancy: 'skull', radiance: 'star',
  soul_reap: 'heart', grave_taunt: 'shield', plague_breath: 'breath', whirlwind: 'staff', stampede: 'large', talon: 'flier',
};
function skillIcon(k: SkillInfo): string {
  if (k.skill) return skillGlyph(k.skill);
  const ic = INNATE_ICON[k.id] ?? (k.id.startsWith('anti_') ? 'sword' : k.source === 'lord' ? 'crown' : 'star');
  return `<i class="sk-i">${icon(ic)}</i>`;
}

/**
 * A squad's abilities (squadSkills: innate, Lord and item-granted) as glyph tokens: actives first,
 * an item-granted one marked with its item's rarity. Each token carries `data-sk` = its index in
 * `skills`, for the tooltip (skillTooltip) that names it.
 */
export function skillChips(skills: SkillInfo[], items: (Item | null)[] = []): string {
  return skills
    .map((k, i) => ({ k, i }))
    .sort((a, b) => Number(b.k.kind === 'active') - Number(a.k.kind === 'active') || a.i - b.i)
    .map(({ k, i }) => {
      const it = k.item !== undefined ? items.find((x) => x?.id === k.item) : null;
      return `<span class="sk-chip ${k.kind}${it ? ' item' : ''}" data-sk="${i}" aria-label="${esc(k.name)}"${it ? ` style="--rar:${RARITY_CSS[it.rarity]}"` : ''}>${skillIcon(k)}</span>`;
    })
    .join('');
}

/** Name, source, cooldown and text of one ability. */
export function skillTooltip(k: SkillInfo, item?: Item | null): string {
  const src = item ? `<span style="color:${RARITY_CSS[item.rarity]}">${esc(itemName(item))}</span>` : SKILL_SOURCE[k.source];
  // item skills: "<effect>. Cast when: <trigger>."
  const cut = k.text.indexOf('. Cast when: ');
  const effect = cut < 0 ? k.text : k.text.slice(0, cut + 1);
  const when = cut < 0 ? '' : k.text.slice(cut + 2);
  return `<div class="utip sk-tip">
    <div class="utip-h">${skillIcon(k)}<div><b>${esc(k.name)}</b><small>${k.kind === 'active' ? 'Active' : 'Passive'} · ${item ? 'from ' : ''}${src}</small></div>${k.cooldown !== undefined ? `<span class="sk-cd">${icon('timer')}${cooldownText(k.cooldown)}</span>` : ''}</div>
    <p>${esc(effect)}</p>${when ? `<p class="sk-when">${esc(when)}</p>` : ''}
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
  // what the unit does, in the sim's words (raise dead, ethereal, plague, sun blessing, regeneration...), then the plain traits
  const known = new Set<string>();
  const innate = unitSkills(t).filter((k) => !['ranged', 'magic', 'flier', 'armored', 'resist'].includes(k.id)).map((k) => (known.add(k.id), `${k.name}: ${k.text}`));
  const traits = innate.concat(d.traits.filter((x) => !known.has(x) && x !== 'healer' && x !== 'raider' && x !== 'charge').map((x) => TRAIT_TEXT[x]).filter((x): x is string => !!x));
  return `<div class="utip">
    <div class="utip-h">${crest(t, null, 'md')}<div><b>${esc(d.name)}</b><small>${esc(FACTIONS[d.faction].short)} · ${esc(d.role)} · ${WEAPON_LABEL[d.weapon]} · ${d.damageType === 'magic' ? 'Magic' : 'Physical'}</small></div>
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
