// The squad sheet for the inspector: a squad's stats "base -> effective" (after level, items and the Lord's
// passive), its items with tooltip lines, and everything it can do (squadSkills).
//
//   squadSheet(view, squadId)            planning / results: your squads, or the enemy's last-round army
//   replaySquadSheet(replay, row)        during a battle: any squad of the replay (both armies are public then)
//   sheetOf(squad, lordId)               the core, for any Squad-like value
import { TICK_HZ } from './constants.ts';
import { buildStats, squadSize } from './battle.ts';
import { SLOT_UNLOCK_LEVEL } from './data/items.ts';
import { LORDS } from './data/lords.ts';
import { classesOf, squadSkills } from './data/skills.ts';
import { UNITS } from './data/units.ts';
import { itemLines } from './loot.ts';
import type { Item, ItemLine, ItemSlots, LordId, PlayerView, Replay, SkillInfo, Slot, Squad, SquadType, UnitClass } from './types.ts';

export type StatKey = 'hp' | 'damage' | 'attackInterval' | 'dps' | 'range' | 'armor' | 'magicResist' | 'speed' | 'crit' | 'lifesteal' | 'heal' | 'soldiers';

/** One stat row. `base` = the same squad at level 1 with no items; `value` = now. Show "base -> value" when they differ. */
export interface StatLine {
  key: StatKey;
  label: string;
  base: number;
  value: number;
  /** '' = plain number, '%' = percent points, 'm' = metres, 's' = seconds, 'm/s'. */
  unit: '' | '%' | 'm' | 's' | 'm/s';
  /** Is a higher number better? (false for the attack interval.) */
  higherIsBetter: boolean;
}

export interface SheetItem { slot: Slot; item: Item | null; /** Is the slot unlocked at this level? */ open: boolean; /** Level that opens it. */ opensAt: number; lines: ItemLine[] }

export interface SquadSheet {
  squad: number;
  type: SquadType;
  lord: LordId | null;
  name: string;
  role: string;
  level: number;
  classes: UnitClass[];
  /** Per-soldier stats, plus 'soldiers' (squad size) and 'dps' (the whole squad's damage per second on paper). */
  stats: StatLine[];
  items: SheetItem[];
  skills: SkillInfo[];
}

const EMPTY: ItemSlots = { weapon: null, armor: null, relic: null };
const r1 = (x: number): number => Math.round(x * 10) / 10;

export function sheetOf(sq: Pick<Squad, 'id' | 'type' | 'level' | 'items'>, lord: LordId | null): SquadSheet {
  const now = buildStats(sq, lord);
  const base = buildStats({ type: sq.type, level: 1, items: EMPTY }, lord);
  const nNow = squadSize(sq), nBase = squadSize({ type: sq.type, items: EMPTY });
  const stats: StatLine[] = [];
  const add = (key: StatKey, label: string, b: number, v: number, unit: StatLine['unit'], higherIsBetter = true): void => {
    stats.push({ key, label, base: b, value: v, unit, higherIsBetter });
  };
  const dps = (st: typeof now, n: number): number => Math.round((st.dmg / 100) * (TICK_HZ / st.atk) * n);
  add('soldiers', 'Soldiers', nBase, nNow, '');
  add('hp', 'Life', Math.ceil(base.hp / 100), Math.ceil(now.hp / 100), '');
  add('damage', 'Damage', Math.round(base.dmg / 100), Math.round(now.dmg / 100), '');
  add('attackInterval', 'Attack every', r1(base.atk / TICK_HZ), r1(now.atk / TICK_HZ), 's', false);
  add('dps', 'Squad damage per second', dps(base, nBase), dps(now, nNow), '');
  if (now.healer) add('heal', 'Heal', Math.round(base.heal / 100), Math.round(now.heal / 100), '');
  add('range', 'Range', r1(base.range / 100), r1(now.range / 100), 'm');
  add('armor', 'Armor', base.armor, now.armor, '%');
  add('magicResist', 'Magic resistance', base.mr, now.mr, '%');
  add('speed', 'Speed', r1((base.speed * TICK_HZ) / 100), r1((now.speed * TICK_HZ) / 100), 'm/s');
  add('crit', 'Critical chance', base.crit, now.crit, '%');
  add('lifesteal', 'Lifesteal', base.leech, now.leech, '%');
  const items: SheetItem[] = (['weapon', 'armor', 'relic'] as Slot[]).map((slot) => {
    const item = sq.items[slot];
    return { slot, item, open: sq.type === 'lord' || sq.level >= SLOT_UNLOCK_LEVEL[slot], opensAt: sq.type === 'lord' ? 1 : SLOT_UNLOCK_LEVEL[slot], lines: item ? itemLines(item) : [] };
  });
  const L = sq.type === 'lord' && lord ? LORDS[lord] : null;
  return {
    squad: sq.id, type: sq.type, lord: sq.type === 'lord' ? lord : null,
    name: L ? `${L.title} ${L.name}` : sq.type === 'lord' ? 'Lord' : UNITS[sq.type].name,
    role: L ? 'Lord' : sq.type === 'lord' ? 'Lord' : UNITS[sq.type].role,
    level: sq.level, classes: classesOf(sq.type, lord), stats, items, skills: squadSkills(sq, lord),
  };
}

/**
 * The sheet of squad `squadId` as `view` may see it: one of your own squads (current state), or a squad of the
 * enemy's last-round army. Null if the view holds no such squad.
 */
export function squadSheet(view: PlayerView, squadId: number): SquadSheet | null {
  const mine = view.you?.squads.find((q) => q.id === squadId);
  if (mine && view.you) return sheetOf(mine, view.you.lord);
  for (const e of view.enemies ?? [view.enemy]) {
    const q = e.lastArmy?.find((x) => x.id === squadId);
    if (q) return sheetOf(q, e.lord);
  }
  return null;
}

/** The sheet of a squad in a battle replay (`row` = index in Replay.squads). Null for skeleton bands and bad rows. */
export function replaySquadSheet(replay: Replay, row: number): SquadSheet | null {
  const q = replay.squads?.[row];
  if (!q || q.summoned) return null;
  const lord = q.ownerLord ?? null;
  return sheetOf({ id: q.id, type: q.type, level: q.level, items: q.items ?? EMPTY }, lord);
}
