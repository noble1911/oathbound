// ARPG loot: seeded rarity rolls, affix rolls scaled by item level, names and tooltip lines.
import { AFFIXES, AFFIX_IDS, BASES, BASE_IDS, LEGENDARIES, LEGENDARY_IDS, LEGENDARY_MIN_ROUND, RARITIES, RARITY_WEIGHT, SLAY_TAGS } from './data/items.ts';
import { Rng, hash } from './rng.ts';
import type { Affix, AffixId, Item, ItemLine, ItemSlots, Rarity, Slot, Tag } from './types.ts';

export const RARITY_COLOR: Record<Rarity, string> = { common: '#e8e4da', magic: '#6f8cff', rare: '#ffd84a', legendary: '#ff8a1e' };

/** Value of an affix at item level `ilvl` from a roll in [0, 1000). Integer maths. */
function affixValue(id: AffixId, ilvl: number, roll: number, lo?: number, hi?: number): number {
  const a = AFFIXES[id];
  const l = lo ?? a.lo, h = hi ?? a.hi;
  const base = l + Math.trunc(((h - l + 1) * roll) / 1000);
  const v = Math.trunc((base * (100 + a.growth * (Math.max(1, ilvl) - 1))) / 100);
  return Math.max(1, v);
}

function weightedPick<T>(rng: Rng, items: readonly T[], weight: (t: T) => number): T {
  let total = 0;
  for (const it of items) total += weight(it);
  let r = rng.int(total);
  for (const it of items) {
    r -= weight(it);
    if (r < 0) return it;
  }
  return items[items.length - 1];
}

/** Rarity roll; `bump` = the round's loser rolls one tier higher (legendary only from round 3). */
export function rollRarity(rng: Rng, round: number, bump: boolean): Rarity {
  const pool = RARITIES.filter((r) => r !== 'legendary' || round >= LEGENDARY_MIN_ROUND);
  let r = weightedPick(rng, pool, (x) => RARITY_WEIGHT[x]);
  if (bump) {
    const i = RARITIES.indexOf(r);
    const up = RARITIES[Math.min(3, i + 1)];
    r = up === 'legendary' && round < LEGENDARY_MIN_ROUND ? 'rare' : up;
  }
  return r;
}

/** Roll one item. `onlySlot` forces the slot (used to bias offers toward slots the player can fill). */
export function rollItem(rng: Rng, id: number, ilvl: number, rarity: Rarity, onlySlot?: Slot): Item {
  let legendary: Item['legendary'] = null;
  let slot: Slot;
  let baseId;
  if (rarity === 'legendary') {
    legendary = rng.pick(onlySlot ? LEGENDARY_IDS.filter((l) => LEGENDARIES[l].slot === onlySlot) : LEGENDARY_IDS);
    slot = LEGENDARIES[legendary].slot;
    const bases = BASE_IDS.filter((b) => BASES[b].slot === slot);
    baseId = rng.pick(bases);
  } else {
    baseId = rng.pick(onlySlot ? BASE_IDS.filter((b) => BASES[b].slot === onlySlot) : BASE_IDS);
    slot = BASES[baseId].slot;
  }
  const base = BASES[baseId];
  const implicit: Affix = { id: base.implicit, value: affixValue(base.implicit, ilvl, rng.int(1000), base.lo, base.hi) };
  if (base.implicitTag) implicit.tag = base.implicitTag;
  const n = rarity === 'common' ? 0 : rarity === 'magic' ? 1 + rng.int(2) : rarity === 'rare' ? 3 + rng.int(2) : 2;
  const affixes: Affix[] = [];
  let prefixes = 0, suffixes = 0;
  for (let k = 0; k < n; k++) {
    const pool = AFFIX_IDS.filter((a) => {
      const d = AFFIXES[a];
      if (!d.slots.includes(slot)) return false;
      if (d.rareOnly && rarity !== 'rare' && rarity !== 'legendary') return false;
      if (affixes.some((x) => x.id === a)) return false;
      // Diablo-style: at most 2 prefixes and 2 suffixes.
      if (d.kind === 'prefix' && prefixes >= 2) return false;
      if (d.kind === 'suffix' && suffixes >= 2) return false;
      return true;
    });
    if (!pool.length) break;
    const a = weightedPick(rng, pool, (x) => AFFIXES[x].weight);
    const af: Affix = { id: a, value: affixValue(a, ilvl, rng.int(1000)) };
    if (a === 'slaying') af.tag = rng.pick(SLAY_TAGS);
    if (AFFIXES[a].kind === 'prefix') prefixes++; else suffixes++;
    affixes.push(af);
  }
  return { id, base: baseId, slot, rarity, ilvl, implicit, affixes, legendary };
}

/**
 * The loot offer for one seat after a round. Seeded by (match seed, round, seat) so it is reproducible,
 * and both seats draw from the same distribution. `count` is 3 (4 for Skylady).
 *
 * `usable` = the slots the player can fill right now (see usableSlots in match.ts). When given and non-empty,
 * all but one offer (at least 2 of 3, 3 of 4) are in a usable slot: offers in other slots are re-rolled into
 * a usable slot at the same rarity.
 */
export function rollLoot(seed: number, round: number, seat: number, bump: boolean, count: number, nextId: () => number, usable?: readonly Slot[]): Item[] {
  const rng = new Rng(hash(seed, 'loot', round, seat));
  const out: Item[] = [];
  const seenLegendary = new Set<string>();
  const need = usable && usable.length ? count - 1 : 0;
  let ok = 0;
  for (let i = 0; i < count; i++) {
    const rarity = rollRarity(rng, round, bump);
    let it = rollItem(rng, 0, round, rarity);
    const fits = (x: Item): boolean => !usable || !usable.length || usable.includes(x.slot);
    // Too many unusable offers so far: force this one into a usable slot.
    const force = !fits(it) && ok + (count - i - 1) < need;
    if (force) it = rollItem(rng, 0, round, rarity, usable![rng.int(usable!.length)]);
    const keepSlot = force || (need && fits(it)) ? it.slot : undefined;
    for (let k = 0; k < 4 && it.legendary && seenLegendary.has(it.legendary); k++) it = rollItem(rng, 0, round, rarity, keepSlot);
    if (it.legendary) seenLegendary.add(it.legendary);
    if (fits(it)) ok++;
    it.id = nextId();
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------- names & tooltips

const TAG_NAME: Record<Tag, string> = { mounted: 'Mounted', armored: 'Armored', flier: 'Flying', large: 'Large', infantry: 'Infantry' };
const SLAY_PREFIX: Record<Tag, string> = { mounted: 'Horsebane', armored: 'Plate-splitting', flier: 'Skypiercing', large: 'Giantslaying', infantry: 'Slaying' };
const RARE_A = ['Doom', 'Grim', 'Storm', 'Blood', 'Dusk', 'Iron', 'Raven', 'Wrath', 'Ash', 'Dread', 'Gale', 'Hollow', 'Oath', 'Rune', 'Soul', 'Star'];
const RARE_B = ['Bite', 'Song', 'Ward', 'Mark', 'Veil', 'Fang', 'Call', 'Brand', 'Shroud', 'Edge', 'Coil', 'Grasp', 'Crest', 'Heart', 'Thorn', 'Spire'];

function affixName(a: Affix): string {
  if (a.id === 'slaying' && a.tag) return SLAY_PREFIX[a.tag];
  return AFFIXES[a.id].name;
}

/** Display name: "Vicious Ironbark Bow of Haste" (magic), "Grim Song Steel Blade" style for rares, "Stormcaller War Axe" for legendaries. */
export function itemName(item: Item): string {
  const base = BASES[item.base].name;
  if (item.rarity === 'legendary' && item.legendary) { const n = LEGENDARIES[item.legendary].name; return n.includes(' ') ? n : `${n} ${base}`; }
  const pre = item.affixes.find((a) => AFFIXES[a.id].kind === 'prefix');
  const suf = item.affixes.find((a) => AFFIXES[a.id].kind === 'suffix');
  if (item.rarity === 'rare') {
    const h = hash(item.id, item.base, item.ilvl);
    const title = `${RARE_A[h % RARE_A.length]} ${RARE_B[(h >>> 8) % RARE_B.length]}`;
    return `${title}, ${[pre ? affixName(pre) : '', base, suf ? affixName(suf) : ''].filter(Boolean).join(' ')}`;
  }
  return [pre ? affixName(pre) : '', base, suf ? affixName(suf) : ''].filter(Boolean).join(' ');
}

function affixText(a: Affix): string {
  const d = AFFIXES[a.id];
  const v = a.id === 'farreach' ? (a.value / 100).toFixed(1).replace(/\.0$/, '') : String(a.value);
  return d.text.replace('{v}', v).replace('{tag}', a.tag ? TAG_NAME[a.tag] : '');
}

const SLOT_NAME: Record<Slot, string> = { weapon: 'Weapon', armor: 'Armor', relic: 'Relic' };
const RARITY_NAME: Record<Rarity, string> = { common: 'Common', magic: 'Magic', rare: 'Rare', legendary: 'Legendary' };

/** ARPG tooltip lines, top to bottom. */
export function itemLines(item: Item): ItemLine[] {
  const lines: ItemLine[] = [{ text: itemName(item), style: 'name' }];
  lines.push({ text: `${RARITY_NAME[item.rarity]} ${BASES[item.base].name} · ${SLOT_NAME[item.slot]}`, style: 'base' });
  lines.push({ text: `Item Level ${item.ilvl}`, style: 'meta' });
  lines.push({ text: affixText(item.implicit), style: 'implicit' });
  for (const a of item.affixes) lines.push({ text: affixText(a), style: 'affix' });
  if (item.legendary) {
    const L = LEGENDARIES[item.legendary];
    const text = item.legendary === 'sunfire' ? L.text.replace('20 (+2 per item level)', String(20 + 2 * item.ilvl))
      : item.legendary === 'ember_crown' ? L.text.replace('40 (+5 per item level)', String(40 + 5 * item.ilvl)) : L.text;
    lines.push({ text, style: 'legendary' });
    lines.push({ text: L.flavor, style: 'flavor' });
  }
  return lines;
}

/** Rough power score (percent-of-squad-value points); bots use it to rank loot. */
export function itemPower(item: Item): number {
  let p = 0;
  for (const a of [item.implicit, ...item.affixes]) p += a.value * AFFIXES[a.id].power;
  if (item.legendary) p += LEGENDARIES[item.legendary].power;
  return Math.round(p);
}

// ---------------------------------------------------------------- aggregated modifiers (used by the battle)

export interface ItemMods {
  dmg: number; hp: number; as: number; crit: number; leech: number; mr: number; move: number; thorns: number;
  armor: number; burn: number; frost: number; range: number; phoenix: boolean; command: number;
  slay: Partial<Record<Tag, number>>;
  legend: Set<string>;
  ilvl: number;
}
export function emptyMods(): ItemMods {
  return { dmg: 0, hp: 0, as: 0, crit: 0, leech: 0, mr: 0, move: 0, thorns: 0, armor: 0, burn: 0, frost: 0, range: 0, phoenix: false, command: 0, slay: {}, legend: new Set(), ilvl: 1 };
}
export function modsOf(slots: ItemSlots): ItemMods {
  const m = emptyMods();
  for (const it of [slots.weapon, slots.armor, slots.relic]) {
    if (!it) continue;
    m.ilvl = Math.max(m.ilvl, it.ilvl);
    for (const a of [it.implicit, ...it.affixes]) {
      switch (a.id) {
        case 'keen': m.crit += a.value; break;
        case 'vicious': m.dmg += a.value; break;
        case 'haste': m.as += a.value; break;
        case 'leech': m.leech += a.value; break;
        case 'stalwart': m.hp += a.value; break;
        case 'warding': m.mr += a.value; break;
        case 'fleet': m.move += a.value; break;
        case 'thorns': m.thorns += a.value; break;
        case 'slaying': if (a.tag) m.slay[a.tag] = (m.slay[a.tag] ?? 0) + a.value; break;
        case 'embers': m.burn = Math.max(m.burn, a.value); break;
        case 'frost': m.frost = Math.max(m.frost, a.value); break;
        case 'farreach': m.range += a.value; break;
        case 'phoenix': m.phoenix = true; break;
        case 'command': m.command += 1; break;
        case 'plated': m.armor += a.value; break;
      }
    }
    if (it.legendary) m.legend.add(it.legendary);
  }
  return m;
}
