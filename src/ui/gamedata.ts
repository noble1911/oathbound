// UI-side readings of the sim's data tables: counters, level stats, formations for the deploy
// ghost, item stat totals and comparison deltas. Pure (no DOM), unit-tested in tests/client.test.ts.
import type { Affix, Item, LordId, Rarity, Seat, Slot, Squad, SquadType, Tag, UnitDef, UnitType, Vec2, WeaponKind } from '../sim/types.ts';
import { UNITS, UNIT_TYPES } from '../sim/data/units.ts';
import { LORDS } from '../sim/data/lords.ts';
import { AFFIXES, LEGENDARIES, SLOT_UNLOCK_LEVEL } from '../sim/data/items.ts';

export const RARITY_CSS: Record<Rarity, string> = { common: '#e3ddd3', magic: '#7e9cff', rare: '#ffe35c', legendary: '#ff8a1e' };
export const RARITY_LABEL: Record<Rarity, string> = { common: 'Common', magic: 'Magic', rare: 'Rare', legendary: 'Legendary' };
export const SLOTS: readonly Slot[] = ['weapon', 'armor', 'relic'];
export const SLOT_LABEL: Record<Slot, string> = { weapon: 'Weapon', armor: 'Armor', relic: 'Relic' };
export const TAG_LABEL: Record<Tag, string> = { mounted: 'Mounted', armored: 'Armored', flier: 'Flier', large: 'Large', infantry: 'Infantry' };
export const WEAPON_LABEL: Record<WeaponKind, string> = {
  sword: 'Sword', axe: 'Axe', lance: 'Lance', bow: 'Bow', tome: 'Tome', staff: 'Staff', bolt: 'Bolt', stone: 'Stone', fists: 'Fists', breath: 'Breath',
};

/** Sword > Axe > Lance > Sword. */
const BEATS: Partial<Record<WeaponKind, WeaponKind>> = { sword: 'axe', axe: 'lance', lance: 'sword' };
export function triangle(a: WeaponKind, b: WeaponKind): -1 | 0 | 1 {
  if (BEATS[a] === b) return 1;
  if (BEATS[b] === a) return -1;
  return 0;
}

export function unitName(t: SquadType, lord?: LordId | null): string {
  if (t === 'lord') return lord ? `${LORDS[lord].title} ${LORDS[lord].name}` : 'Lord';
  return UNITS[t].name;
}

/** Stats of one soldier of a squad (Lv bonuses: +25% HP and +20% damage per level; Lords use their own growth). */
export function soldierStats(t: SquadType, level: number, lord?: LordId | null) {
  if (t === 'lord') {
    const L = LORDS[lord ?? 'marshal'];
    const f = level - 1;
    return { hp: Math.round(L.hp * (1 + 0.1 * f)), dmg: Math.round(L.dmg * (1 + 0.08 * f)), attackTicks: L.attackTicks, range: L.range, minRange: 0, speed: L.speed, armor: L.armor, magicResist: L.magicResist, size: 1, splash: L.splash };
  }
  const d = UNITS[t];
  const f = level - 1;
  return { hp: Math.round(d.hp * (1 + 0.25 * f)), dmg: Math.round(d.dmg * (1 + 0.2 * f)), attackTicks: d.attackTicks, range: d.range, minRange: d.minRange, speed: d.speed, armor: d.armor, magicResist: d.magicResist, size: d.squadSize, splash: d.splash };
}

/** Damage per second of one soldier. */
export function dps(dmg: number, attackTicks: number): number {
  return attackTicks > 0 ? (dmg * 20) / attackTicks : 0;
}

export function slotOpen(sq: Pick<Squad, 'type' | 'level'>, slot: Slot): boolean {
  return sq.type === 'lord' || sq.level >= SLOT_UNLOCK_LEVEL[slot];
}

export function tagsOf(t: SquadType, lord?: LordId | null): Tag[] {
  return t === 'lord' ? LORDS[lord ?? 'marshal'].tags : UNITS[t].tags;
}

function canHit(att: UnitDef, def: UnitDef): boolean {
  // fliers are only hit by bows, magic and other fliers
  if (!def.tags.includes('flier')) return true;
  return att.weapon === 'bow' || att.damageType === 'magic' || att.tags.includes('flier') || att.weapon === 'bolt';
}

/** How strongly `a` counters `b` (0 = not a counter). */
function counterScore(a: UnitDef, b: UnitDef): number {
  if (!canHit(a, b) || a.dmg === 0 || a.traits.includes('healer')) return 0;
  let s = 0;
  for (const tag of b.tags) {
    const m = a.effective[tag];
    if (m && m > 100) s += (m - 100) / 50;
  }
  if (triangle(a.weapon, b.weapon) === 1) s += 1.5;
  // fast melee divers reach fragile backliners
  if (b.traits.includes('backline') && a.range < 400 && a.speed >= 20) s += 1.5;
  if (b.tags.includes('armored') && (a.damageType === 'magic' || a.traits.includes('ignoresArmor') || a.traits.includes('crushing'))) s += 1.5;
  if (b.tags.includes('flier') && !canHit(b, a)) s += 1;
  // splash shreds big squads of small soldiers
  if (a.splash >= 250 && b.squadSize >= 8) s += 1.5;
  return s;
}

export interface Counters {
  /** Readable advantages, e.g. "×2.5 vs Mounted". */
  bonuses: string[];
  strongVs: UnitType[];
  weakTo: UnitType[];
}

export function counters(t: UnitType): Counters {
  const d = UNITS[t];
  const bonuses: string[] = [];
  for (const [tag, m] of Object.entries(d.effective) as [Tag, number][]) if (m > 100) bonuses.push(`×${(m / 100).toFixed(m % 100 ? 1 : 0)} vs ${TAG_LABEL[tag]}`);
  if (BEATS[d.weapon]) bonuses.push(`${WEAPON_LABEL[d.weapon]} beats ${WEAPON_LABEL[BEATS[d.weapon]!]}`);
  if (d.traits.includes('ignoresArmor')) bonuses.push('Ignores armor');
  if (d.splash) bonuses.push(`${(d.splash / 100).toFixed(0)} m splash`);
  const others = UNIT_TYPES.filter((u) => u !== t);
  const strongVs = others.filter((u) => counterScore(d, UNITS[u]) >= 1.5).sort((a, b) => counterScore(d, UNITS[b]) - counterScore(d, UNITS[a])).slice(0, 4);
  const weakTo = others.filter((u) => counterScore(UNITS[u], d) >= 1.5).sort((a, b) => counterScore(UNITS[b], d) - counterScore(UNITS[a], d)).slice(0, 4);
  return { bonuses, strongVs, weakTo };
}

export function costTier(cost: number): number {
  return cost >= 500 ? 4 : cost >= 300 ? 3 : cost >= 200 ? 2 : 1;
}

// ---------------------------------------------------------------- formation preview

const FACE = (f: number) => (f / 256) * Math.PI * 2;

/** Soldier offsets (cm, field axes) of a squad formation centred on 0,0 facing `facing`. */
export function formation(t: SquadType, facing: number, lord?: LordId | null): Vec2[] {
  const n = t === 'lord' ? 1 : UNITS[t].squadSize;
  const r = t === 'lord' ? 60 : UNITS[t].radius;
  const gap = Math.max(110, r * 2.6);
  const cols = n <= 1 ? 1 : n <= 4 ? n : Math.ceil(Math.sqrt(n * 2));
  const rows = Math.ceil(n / cols);
  const a = FACE(facing);
  // forward = (cos a, sin a); right = (sin a, -cos a)
  const fx = Math.cos(a), fy = Math.sin(a);
  const rx = fy, ry = -fx;
  const out: Vec2[] = [];
  void lord;
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const col = i % cols;
    const side = (col - (inRow - 1) / 2) * gap;
    const fwd = ((rows - 1) / 2 - row) * gap * 0.9;
    out.push([Math.round(side * rx + fwd * fx), Math.round(side * ry + fwd * fy)]);
  }
  return out;
}

/** Radius (cm) that covers a squad's formation, for picking and selection rings. */
export function squadRadius(t: SquadType): number {
  const offs = formation(t, 64);
  let m = 0;
  for (const [x, y] of offs) m = Math.max(m, Math.hypot(x, y));
  const r = t === 'lord' ? 60 : UNITS[t].radius;
  return Math.round(m + r + 60);
}

export function defaultFacing(seat: Seat): number {
  return seat === 0 ? 64 : 192;
}

// ---------------------------------------------------------------- item stats & comparison

/** Key for summing affixes: slaying keeps its tag apart. */
function statKey(a: Affix): string {
  return a.id === 'slaying' ? `slaying:${a.tag ?? 'large'}` : a.id;
}

export function itemStats(item: Item | null): Map<string, number> {
  const m = new Map<string, number>();
  if (!item) return m;
  for (const a of [item.implicit, ...item.affixes]) m.set(statKey(a), (m.get(statKey(a)) ?? 0) + a.value);
  return m;
}

function statText(key: string, v: number): string {
  const [id, tag] = key.split(':') as [keyof typeof AFFIXES, Tag | undefined];
  const def = AFFIXES[id];
  if (!def) return `${key} ${v}`;
  const shown = id === 'farreach' ? +(v / 100).toFixed(1) : v;
  let t = def.text.replace('{v}', String(Math.abs(shown))).replace('{tag}', tag ? TAG_LABEL[tag] : 'large');
  if (v < 0) t = t.replace(/^\+/, '−').replace(/^(\d)/, '−$1');
  return t;
}

export interface Delta { text: string; good: boolean }

/** What changes if `next` replaces `cur` (green = gained, red = lost). */
export function compareItems(next: Item, cur: Item | null): Delta[] {
  const a = itemStats(next);
  const b = itemStats(cur);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const out: Delta[] = [];
  for (const k of keys) {
    const d = (a.get(k) ?? 0) - (b.get(k) ?? 0);
    if (d === 0) continue;
    const flag = ['phoenix', 'command', 'frost'].includes(k.split(':')[0]!);
    if (flag) out.push({ text: (d > 0 ? 'Gains: ' : 'Loses: ') + statText(k, Math.abs(a.get(k) || b.get(k) || 1)), good: d > 0 });
    else out.push({ text: statText(k, d).replace(/^(?=\d)/, d > 0 ? '+' : ''), good: d > 0 });
  }
  if (next.legendary !== (cur?.legendary ?? null)) {
    if (next.legendary) out.push({ text: `Gains: ${LEGENDARIES[next.legendary].name}`, good: true });
    if (cur?.legendary) out.push({ text: `Loses: ${LEGENDARIES[cur.legendary].name}`, good: false });
  }
  out.sort((x, y) => Number(y.good) - Number(x.good));
  return out;
}

export function rarityRank(r: Rarity): number {
  return r === 'legendary' ? 3 : r === 'rare' ? 2 : r === 'magic' ? 1 : 0;
}

/** Squads that can take this item right now (slot open). */
export function canEquip(sq: Pick<Squad, 'type' | 'level'>, item: Item): boolean {
  return slotOpen(sq, item.slot);
}

export function allItems(squads: Squad[]): { item: Item; squad: Squad }[] {
  const out: { item: Item; squad: Squad }[] = [];
  for (const s of squads) for (const slot of SLOTS) if (s.items[slot]) out.push({ item: s.items[slot]!, squad: s });
  return out;
}
