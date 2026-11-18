// UI-side readings of the sim's data tables: the counter wheel, deploy weights, level stats, formations for the deploy
// ghost, item stat totals and comparison deltas. Pure (no DOM), unit-tested in tests/client.test.ts.
import type { Affix, Item, ItemSlots, LordId, Rarity, Seat, Slot, Squad, SquadType, Tag, UnitType, Vec2, WeaponKind, FactionId, WheelClass } from '../sim/types.ts';
import { UNITS, UNIT_TYPES, formationCols, squadSizeAt, growsBySize } from '../sim/data/units.ts';
import { WHEEL_NAME, beatsClass, beatenBy } from '../sim/data/wheel.ts';
import { COUNTER_PCT } from '../sim/constants.ts';
import { LORDS } from '../sim/data/lords.ts';
import { AFFIXES, LEGENDARIES } from '../sim/data/items.ts';
import { bestOnText, legendaryFits } from '../sim/loot.ts';
import { slotOpen as simSlotOpen, deployWeight, deployPointsText } from '../sim/match.ts';
import { SKILLS, canEquip as classFits } from '../sim/data/skills.ts';
import { buildStats } from '../sim/battle.ts';
import { sheetOf, type StatKey } from '../sim/sheet.ts';
import { TICK_HZ } from '../sim/constants.ts';

export const RARITY_CSS: Record<Rarity, string> = { common: '#bfc3c9', magic: '#6f9dff', rare: '#e6bd3c', legendary: '#f58b25' };
export const RARITY_LABEL: Record<Rarity, string> = { common: 'Common', magic: 'Magic', rare: 'Rare', legendary: 'Legendary' };
export const SLOTS: readonly Slot[] = ['weapon', 'armor', 'relic'];
export const SLOT_LABEL: Record<Slot, string> = { weapon: 'Weapon', armor: 'Armor', relic: 'Relic' };
export const TAG_LABEL: Record<Tag, string> = { mounted: 'Mounted', armored: 'Armored', flier: 'Flier', large: 'Large', infantry: 'Infantry' };
export const WEAPON_LABEL: Record<WeaponKind, string> = {
  sword: 'Sword', axe: 'Axe', lance: 'Lance', bow: 'Bow', tome: 'Tome', staff: 'Staff', bolt: 'Bolt', stone: 'Stone', fists: 'Fists', breath: 'Breath', beam: 'Sunbeam',
};

export function unitName(t: SquadType, lord?: LordId | null): string {
  if (t === 'lord') return lord ? `${LORDS[lord].title} ${LORDS[lord].name}` : 'Lord';
  return UNITS[t].name;
}

// ---------------------------------------------------------------- the counter wheel

/** A unit's (or a Lord's) class on the counter wheel. */
export function classOf(t: SquadType, lord?: LordId | null): WheelClass {
  return t === 'lord' ? LORDS[lord ?? 'marshal'].class : UNITS[t].class;
}
export interface WheelPlace {
  cls: WheelClass;
  /** The class it deals COUNTER_PCT damage to. */
  beats: WheelClass;
  /** The class that deals COUNTER_PCT damage to it. */
  weakTo: WheelClass;
}
export function wheelOf(t: SquadType, lord?: LordId | null): WheelPlace {
  const cls = classOf(t, lord);
  return { cls, beats: beatsClass(cls), weakTo: beatenBy(cls) };
}
/** "×1.5" for COUNTER_PCT. */
export const COUNTER_TEXT = `×${(COUNTER_PCT / 100).toFixed(COUNTER_PCT % 100 ? (COUNTER_PCT % 10 ? 2 : 1) : 0)}`;
/** "Line · Beats Cavalry · Weak to Giant": the one-line wheel summary of a unit. */
export function wheelText(t: SquadType, lord?: LordId | null): string {
  const w = wheelOf(t, lord);
  return `${WHEEL_NAME[w.cls]} · Beats ${WHEEL_NAME[w.beats]} · Weak to ${WHEEL_NAME[w.weakTo]}`;
}
/** The unit types of class `c` among `pool` (the enemy roster when known, see rivals). */
export function unitsOfClass(c: WheelClass, pool: readonly UnitType[] = UNIT_TYPES): UnitType[] {
  return pool.filter((u) => UNITS[u].class === c);
}

// ---------------------------------------------------------------- deploy weight

/** "1", "2" or "3": the deploy points a unit costs (the sim's deployWeight). */
export function deployCostText(u: UnitType): string {
  return deployPointsText(deployWeight(u));
}
/**
 * Why a unit does not fit the deploy points left this round ("Needs 3 deploy points, 1 left"), or null.
 * `used` and `limit` are the PlayerState deploy points.
 */
export function deployRefusal(u: UnitType, used: number, limit: number): string | null {
  const left = Math.max(0, limit - used);
  const w = deployWeight(u);
  if (used + w <= limit) return null;
  if (left === 0) return `No deploy points left this round (${deployPointsText(limit)} used)`;
  return `Needs ${deployPointsText(w)} deploy point${w === 1 ? '' : 's'}, ${deployPointsText(left)} left`;
}

// ---------------------------------------------------------------- levels

/**
 * What one level-up gives a squad: Swarm squads gain soldiers ("+3 soldiers"), every other unit +25% life and
 * +20% damage per soldier. `level` is the level it has now.
 */
export function levelGainText(t: UnitType, level: number): string {
  if (growsBySize(t)) {
    const n = squadSizeAt(t, level + 1) - squadSizeAt(t, level);
    return `+${n} soldier${n === 1 ? '' : 's'}`;
  }
  return '+25% life, +20% damage';
}

/** What every stat display reads (see effectiveStats): one soldier's battle numbers plus the squad's. */
export interface SoldierStats {
  /** Life of one soldier (as the squad panel shows it: whole HP, rounded up). */
  hp: number;
  /** Damage of one strike, whole HP. */
  dmg: number;
  /** Ticks between strikes, after haste. */
  attackTicks: number;
  /** cm. */
  range: number;
  minRange: number;
  /** cm per tick. */
  speed: number;
  armor: number;
  magicResist: number;
  /** Soldiers in the squad (after Warhorn). */
  size: number;
  splash: number;
  /** Damage per second of one soldier, unrounded. */
  dps: number;
  /** The whole squad's damage per second: the sheet's 'dps' line, the number the squad panel prints. */
  squadDps: number;
}

const NO_ITEMS: ItemSlots = { weapon: null, armor: null, relic: null };

/**
 * The numbers a squad fights with, read from the sim itself (sheetOf / buildStats: level, items, the Lord's passive,
 * the unit and faction power multipliers and the damage scale), so the shop, tooltips, cards, Lord pick and the
 * squad panel all show the same values and follow every balance change. `lord` is the owner's Lord (its passive
 * applies to the whole army); for a Lord squad it is that Lord.
 */
export function effectiveStats(sq: { type: SquadType; level: number; items?: ItemSlots }, lord?: LordId | null): SoldierStats {
  const lordId = sq.type === 'lord' ? (lord ?? 'marshal') : (lord ?? null);
  const items = sq.items ?? NO_ITEMS;
  const sheet = sheetOf({ id: -1, type: sq.type, level: sq.level, items }, lordId);
  const line = (k: StatKey): number => sheet.stats.find((l) => l.key === k)?.value ?? 0;
  const st = buildStats({ type: sq.type, level: sq.level, items }, lordId);
  return {
    hp: line('hp'), dmg: line('damage'), attackTicks: st.atk, range: st.range, minRange: st.minRange, speed: st.speed,
    armor: line('armor'), magicResist: line('magicResist'), size: line('soldiers'), splash: st.splash,
    dps: st.atk > 0 ? ((st.dmg / 100) * TICK_HZ) / st.atk : 0, squadDps: line('dps'),
  };
}

/** Stats of one soldier of a squad of `t` at `level` with no items (effectiveStats). */
export function soldierStats(t: SquadType, level: number, lord?: LordId | null): SoldierStats {
  return effectiveStats({ type: t, level }, lord);
}

/** The sim's own rule (never a copy of the unlock levels). */
export function slotOpen(sq: Pick<Squad, 'type' | 'level'>, slot: Slot): boolean {
  return simSlotOpen(sq as Squad, slot);
}

export function tagsOf(t: SquadType, lord?: LordId | null): Tag[] {
  return t === 'lord' ? LORDS[lord ?? 'marshal'].tags : UNITS[t].tags;
}

/**
 * Whose units a counter list names: the enemy faction's roster once it is known (after the reveal),
 * else every faction's. Set by the app from the room view; the codex and the cards read it.
 */
let factionCtx: () => { mine: FactionId | null; enemy: FactionId | null } = () => ({ mine: null, enemy: null });
export function setFactionContext(f: () => { mine: FactionId | null; enemy: FactionId | null }): void {
  factionCtx = f;
}
export function factionContext(): { mine: FactionId | null; enemy: FactionId | null } {
  return factionCtx();
}
/** The units `t` is compared with: the enemy roster when known, plus nothing of its own faction's unknowns. */
export function rivals(t: UnitType, enemy: FactionId | null = factionCtx().enemy): UnitType[] {
  return (enemy ? UNIT_TYPES.filter((u) => UNITS[u].faction === enemy) : UNIT_TYPES).filter((u) => u !== t);
}

export interface Counters extends WheelPlace {
  /** Facts about how it fights that are not the wheel: "Ignores armor", "3 m splash". */
  facts: string[];
  /** Units of the class it beats / is beaten by, among its rivals (the enemy roster when known). */
  prey: UnitType[];
  threats: UnitType[];
}

/** The wheel place of a unit, with the rival units in the classes it beats and fears. */
export function counters(t: UnitType, enemy: FactionId | null = factionCtx().enemy): Counters {
  const d = UNITS[t];
  const w = wheelOf(t);
  const facts: string[] = [];
  if (d.traits.includes('ignoresArmor')) facts.push('Ignores armor');
  if (d.traits.includes('crushing')) facts.push('Ignores half of armor');
  if (d.damageType === 'magic' && !d.traits.includes('healer')) facts.push('Magic damage');
  if (d.splash) facts.push(`${(d.splash / 100).toFixed(0)} m splash`);
  const others = rivals(t, enemy);
  // a healer is Magic on the wheel but never attacks: it hunts nothing
  const prey = d.traits.includes('healer') ? [] : unitsOfClass(w.beats, others);
  return { ...w, facts, prey, threats: unitsOfClass(w.weakTo, others) };
}

export function costTier(cost: number): number {
  return cost >= 500 ? 4 : cost >= 300 ? 3 : cost >= 200 ? 2 : 1;
}

// ---------------------------------------------------------------- formation preview

const FACE = (f: number) => (f / 256) * Math.PI * 2;

/**
 * Soldier offsets (cm, field axes) of a squad formation centred on 0,0 facing `facing`. `size` is the squad's
 * soldier count (the sim's squadSize: grown Swarm squads, Warhorn), default the level-1 size.
 */
export function formation(t: SquadType, facing: number, lord?: LordId | null, size?: number): Vec2[] {
  const n = t === 'lord' ? 1 : size ?? UNITS[t].squadSize;
  const r = t === 'lord' ? 60 : UNITS[t].radius;
  // the sim's starting formation (battle.ts): what the footprint keeps clear, and where the battle starts it
  const gap = r * 2 + 50;
  const cols = formationCols(n);
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
    const fwd = ((rows - 1) / 2 - row) * gap;
    out.push([Math.round(side * rx + fwd * fx), Math.round(side * ry + fwd * fy)]);
  }
  return out;
}

/** Radius (cm) that covers a squad's formation, for picking and selection rings. */
export function squadRadius(t: SquadType, size?: number): number {
  const offs = formation(t, 64, null, size);
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
    const flag = ['phoenix', 'command', 'marching'].includes(k.split(':')[0]!);
    if (flag) out.push({ text: (d > 0 ? 'Gains: ' : 'Loses: ') + statText(k, Math.abs(a.get(k) || b.get(k) || 1)), good: d > 0 });
    else out.push({ text: statText(k, d).replace(/^(?=\d)/, d > 0 ? '+' : ''), good: d > 0 });
  }
  if (next.legendary !== (cur?.legendary ?? null)) {
    if (next.legendary) out.push({ text: `Gains: ${LEGENDARIES[next.legendary].name}`, good: true });
    if (cur?.legendary) out.push({ text: `Loses: ${LEGENDARIES[cur.legendary].name}`, good: false });
  }
  if ((next.skill ?? null) !== (cur?.skill ?? null)) {
    if (next.skill) out.push({ text: `Gains ability: ${SKILLS[next.skill].name}`, good: true });
    if (cur?.skill) out.push({ text: `Loses ability: ${SKILLS[cur.skill].name}`, good: false });
  }
  out.sort((x, y) => Number(y.good) - Number(x.good));
  return out;
}

export function rarityRank(r: Rarity): number {
  return r === 'legendary' ? 3 : r === 'rare' ? 2 : r === 'magic' ? 1 : 0;
}

/** Squads that can take this item right now: the slot is open and, for a skill item, the class fits. */
export function canEquip(sq: Pick<Squad, 'type' | 'level'>, item: Item, lord?: LordId | null): boolean {
  return slotOpen(sq, item.slot) && classFits(item, sq.type, lord);
}

export function allItems(squads: Squad[]): { item: Item; squad: Squad }[] {
  const out: { item: Item; squad: Squad }[] = [];
  for (const s of squads) for (const slot of SLOTS) if (s.items[slot]) out.push({ item: s.items[slot]!, squad: s });
  return out;
}

// ---------------------------------------------------------------- does an item help that squad?

const OFFENSIVE = new Set(['keen', 'vicious', 'leech', 'slaying', 'embers', 'frost']);
const OFFENSIVE_LEGENDS = new Set(['stormcaller', 'kingsbane', 'bloodthirst', 'earthshaker', 'frostheart', 'hydra_volley', 'gravebloom']);

function isHealer(t: SquadType): boolean {
  return t !== 'lord' && !!UNITS[t].traits?.includes('healer');
}

/** Why an affix does nothing on this squad, or null if it works. */
export function affixDead(a: Affix, t: SquadType, lord?: LordId | null): string | null {
  if (a.id === 'farreach' && soldierStats(t, 1, lord).range < 400) return 'melee: no range to extend';
  if (OFFENSIVE.has(a.id) && isHealer(t)) return 'healers never attack';
  return null;
}

/** Why an item's legendary power does nothing on this squad (not a class it is built for; healers never attack), or null. */
export function legendaryDead(item: Item, t: SquadType, lord?: LordId | null): string | null {
  if (!item.legendary) return null;
  if (!legendaryFits(item.legendary, t, lord)) return `built for ${bestOnText(item.legendary)} squads`;
  return OFFENSIVE_LEGENDS.has(item.legendary) && isHealer(t) ? 'healers never attack' : null;
}

/** Which of an item's lines are dead on a squad: [implicit, ...affixes] in tooltip order, and the legendary power. */
export function deadLines(item: Item, t: SquadType, lord?: LordId | null): { affix: (string | null)[]; legendary: string | null } {
  return { affix: [item.implicit, ...item.affixes].map((a) => affixDead(a, t, lord)), legendary: legendaryDead(item, t, lord) };
}

/** What the squad is worth on the field (gold-ish): items are worth more on bigger squads. */
function squadWorth(sq: Pick<Squad, 'type' | 'level'>): number {
  if (sq.type === 'lord') return 320 * (1 + 0.1 * (sq.level - 1));
  return UNITS[sq.type].cost * (1 + 0.5 * (sq.level - 1));
}

/** Usefulness of an item on a squad: the budget of the affixes that actually work there, times the squad's worth. */
export function itemUse(item: Item, sq: Pick<Squad, 'type' | 'level'>, lord?: LordId | null): number {
  let p = 0;
  for (const a of [item.implicit, ...item.affixes]) if (!affixDead(a, sq.type, lord)) p += a.value * AFFIXES[a.id].power;
  if (item.legendary && !legendaryDead(item, sq.type, lord)) p += LEGENDARIES[item.legendary].power;
  if (item.skill && classFits(item, sq.type, lord)) p += SKILLS[item.skill].power;
  return (p * squadWorth(sq)) / 100;
}

export interface Fit {
  squad: Squad;
  /** Usefulness gained over what is in the slot now. */
  gain: number;
  replaces: Item | null;
  /** Lines of the item that do nothing there. */
  dead: number;
}

/**
 * The squad an item helps most right now (its slot must be open): the biggest usefulness gain over
 * what is already equipped. Null when no squad has that slot open, or nothing would improve.
 */
export function bestFit(item: Item, squads: Squad[], lord?: LordId | null): Fit | null {
  let best: Fit | null = null;
  for (const sq of squads) {
    // a skill item only fits the classes of its skill
    if (!slotOpen(sq, item.slot) || !classFits(item, sq.type, lord)) continue;
    const cur = sq.items[item.slot] ?? null;
    const gain = itemUse(item, sq, lord) - (cur ? itemUse(cur, sq, lord) : 0);
    if (gain <= 0) continue;
    const d = deadLines(item, sq.type, lord);
    const dead = d.affix.filter(Boolean).length + (d.legendary ? 1 : 0);
    if (!best || gain > best.gain) best = { squad: sq, gain, replaces: cur, dead };
  }
  return best;
}

/** Keys that pick shop cards: 1-9, then 0, -, =. */
export const SHOP_KEYS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
