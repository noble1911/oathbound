// ARPG loot: seeded rarity rolls, affix rolls scaled by item level, names and tooltip lines.
import { AFFIXES, AFFIX_IDS, BASES, BASE_IDS, LEGENDARIES, LEGENDARY_EVERY, LEGENDARY_IDS, SLAY_TAGS } from './data/items.ts';
import { SKILLS, SKILL_IDS, legendaryText, skillCooldownSec, skillText, usableByText } from './data/skills.ts';
import { Rng, hash } from './rng.ts';
import type { Affix, AffixId, Item, ItemLine, ItemSlots, Rarity, SkillId, Slot, Tag, UnitClass } from './types.ts';

/** Chance (percent) that a Rare item grants an active skill; the skill takes the place of one affix. */
export const SKILL_CHANCE = 50;

/** Does `item` suit an army with these classes? (Plain items suit everyone.) */
export function skillFits(item: Pick<Item, 'skill'>, classes: readonly UnitClass[] | undefined): boolean {
  return !item.skill || !classes || SKILLS[item.skill].classes.some((c) => classes.includes(c));
}

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

const LOOT_SLOTS: readonly Slot[] = ['weapon', 'armor', 'relic'];

/**
 * The fixed rarity schedule of a round's offer, the same for both players: [best, second, third] item.
 *  - rounds 1-2: three Magic items;
 *  - rounds 3-5: one Rare and two Magic;
 *  - rounds 6-8: two Rare and one Magic;
 *  - round 9 on: three Rare;
 *  - every LEGENDARY_EVERY-th round (3, 6, 9, 12...): the best item is a Legendary instead.
 * Nothing is rolled: no player ever gets a luckier tier than the other.
 */
export function lootSchedule(round: number): [Rarity, Rarity, Rarity] {
  const out: [Rarity, Rarity, Rarity] = round <= 2 ? ['magic', 'magic', 'magic'] : round <= 5 ? ['rare', 'magic', 'magic'] : round <= 8 ? ['rare', 'rare', 'magic'] : ['rare', 'rare', 'rare'];
  if (round >= LEGENDARY_EVERY && round % LEGENDARY_EVERY === 0) out[0] = 'legendary';
  return out;
}

/**
 * The slot of the round's best item. It rotates so that every slot gets its turn: the Legendary rounds (3, 6, 9)
 * visit the three slots in order, and so do the rounds in between. Where the rotation starts is set by the match
 * seed (the same for both players), so matches differ but the players never do.
 */
export function lootTopSlot(seed: number, round: number): Slot {
  const start = hash(seed, 'lootslot') % 3;
  const legendary = round >= LEGENDARY_EVERY && round % LEGENDARY_EVERY === 0;
  return LOOT_SLOTS[(start + (legendary ? round / LEGENDARY_EVERY : round)) % 3];
}

/**
 * Roll one item. `onlySlot` forces the slot (used to bias offers toward slots the player can fill).
 * Rare items have a SKILL_CHANCE% chance to grant an active skill of their slot instead of their last affix.
 * `classes` (optional, not used by match loot): restrict the skill to those these unit classes can use.
 */
export function rollItem(rng: Rng, id: number, ilvl: number, rarity: Rarity, onlySlot?: Slot, classes?: readonly UnitClass[]): Item {
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
  const item: Item = { id, base: baseId, slot, rarity, ilvl, implicit, affixes, legendary };
  if (rarity === 'rare' && rng.int(100) < SKILL_CHANCE) {
    const pool = SKILL_IDS.filter((k) => SKILLS[k].slot === slot && (!classes || SKILLS[k].classes.some((c) => classes.includes(c))));
    if (pool.length) {
      item.skill = rng.pick(pool);
      if (affixes.length > 2) affixes.pop();
    }
  }
  return item;
}

/**
 * The loot offer of a round. It is seeded by (match seed, round) only, so BOTH players are offered exactly the same
 * items (apart from the item ids): one per slot (weapon, armor, relic), with the rarities of lootSchedule(round).
 * The slot that gets the best item rotates with the round (lootTopSlot). `count` 4 (Skylady's passive) adds a fourth item of the
 * round's lowest tier in a rolled slot; two Skyladies see the same fourth item.
 * Affix values, legendary powers and skills still vary from round to round, but never between the players.
 */
export function rollLoot(seed: number, round: number, count: number, nextId: () => number): Item[] {
  const rng = new Rng(hash(seed, 'loot', round));
  const tiers = lootSchedule(round);
  const top = LOOT_SLOTS.indexOf(lootTopSlot(seed, round));
  const out: Item[] = [];
  for (let i = 0; i < count; i++) {
    // Item k of the schedule goes k slots after the round's top slot.
    const rarity = i < 3 ? tiers[i] : tiers[2];
    const slot = i < 3 ? LOOT_SLOTS[(top + i) % 3] : LOOT_SLOTS[rng.int(3)];
    let it = rollItem(rng, 0, round, rarity, slot);
    // One offer never shows the same legendary power or the same skill twice.
    for (let k = 0; k < 6 && out.some((o) => (it.legendary && o.legendary === it.legendary) || (it.skill && o.skill === it.skill)); k++) it = rollItem(rng, 0, round, rarity, slot);
    out.push(it);
  }
  // Listed weapon, armor, relic (then the extra item).
  const head = out.slice(0, 3).sort((x, y) => LOOT_SLOTS.indexOf(x.slot) - LOOT_SLOTS.indexOf(y.slot));
  const all = [...head, ...out.slice(3)];
  for (const it of all) it.id = nextId();
  return all;
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
  // A granted skill names the item: "Doom Brand, Vicious Grimoire of Fireball".
  const tail = item.skill ? SKILLS[item.skill].suffix : suf ? affixName(suf) : '';
  if (item.rarity === 'rare') {
    // Named from what the item is (not its id), so both players see the same name for the same offer.
    const h = hash(item.base, item.ilvl, item.implicit.value, item.affixes.map((x) => `${x.id}${x.value}${x.tag ?? ''}`).join(','), item.skill ?? '');
    const title = `${RARE_A[h % RARE_A.length]} ${RARE_B[(h >>> 8) % RARE_B.length]}`;
    return `${title}, ${[pre ? affixName(pre) : '', base, tail].filter(Boolean).join(' ')}`;
  }
  return [pre ? affixName(pre) : '', base, tail].filter(Boolean).join(' ');
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
  if (item.skill) {
    // The skill block: name + cooldown, what it does and when it is cast, and who can use it.
    const d = SKILLS[item.skill];
    lines.push({ text: `Grants ${d.name} (${skillCooldownSec(d.id)} s cooldown)`, style: 'affix', kind: 'skill' });
    lines.push({ text: `${skillText(d.id, item.ilvl)}. Cast when: ${d.trigger}.`, style: 'affix', kind: 'skillText' });
    lines.push({ text: `Usable by: ${usableByText(d.id)}`, style: 'meta', kind: 'usable' });
  }
  if (item.legendary) {
    const L = LEGENDARIES[item.legendary];
    lines.push({ text: legendaryText(item.legendary, item.ilvl), style: 'legendary' });
    lines.push({ text: L.flavor, style: 'flavor' });
  }
  return lines;
}

/** Rough power score (percent-of-squad-value points); bots use it to rank loot. */
export function itemPower(item: Item): number {
  let p = 0;
  for (const a of [item.implicit, ...item.affixes]) p += a.value * AFFIXES[a.id].power;
  if (item.legendary) p += LEGENDARIES[item.legendary].power;
  if (item.skill) p += SKILLS[item.skill].power;
  return Math.round(p);
}

// ---------------------------------------------------------------- aggregated modifiers (used by the battle)

export interface ItemMods {
  dmg: number; hp: number; as: number; crit: number; leech: number; mr: number; move: number; thorns: number;
  armor: number; burn: number; frost: number; range: number; phoenix: boolean; command: number;
  slay: Partial<Record<Tag, number>>;
  legend: Set<string>;
  ilvl: number;
  /** Item-granted active skills with the level of the item that grants each. */
  skills: { id: SkillId; ilvl: number }[];
}
export function emptyMods(): ItemMods {
  return { dmg: 0, hp: 0, as: 0, crit: 0, leech: 0, mr: 0, move: 0, thorns: 0, armor: 0, burn: 0, frost: 0, range: 0, phoenix: false, command: 0, slay: {}, legend: new Set(), ilvl: 1, skills: [] };
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
    if (it.skill && !m.skills.some((k) => k.id === it.skill)) m.skills.push({ id: it.skill, ilvl: it.ilvl });
  }
  return m;
}
