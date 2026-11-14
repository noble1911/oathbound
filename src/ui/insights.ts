// What happened in a battle, read from the replay (pure: no DOM; tested in tests/client.test.ts):
// per-squad damage dealt / taken / kills / losses for both sides, and a few plain-language lines
// that say why the round went the way it did and what to change ("Your melee couldn't reach 3
// fliers: deploy Archers", "Their Archers out-ranged you", "Your Pikemen countered their Cavaliers").
import type { DecodedReplay, LordId, Seat, SquadType, UnitType } from '../sim/types.ts';
import { UNITS } from '../sim/data/units.ts';
import { LORDS } from '../sim/data/lords.ts';
import { KEEP_SRC_BASE } from '../sim/replay.ts';
import { counters, unitName } from './gamedata.ts';

export interface SquadStat {
  id: number;
  side: Seat;
  type: SquadType;
  lord: LordId | null;
  level: number;
  /** Soldiers at the start / lost / standing at the end. */
  size: number;
  lost: number;
  dealt: number;
  taken: number;
  kills: number;
  healed: number;
  /** Total life of the squad at the start. */
  life: number;
  /** Sim tick the last soldier fell (-1 = survived). */
  wipedAt: number;
}

export interface BattleStats {
  squads: SquadStat[];
  /** Damage from squad A to squad B: `pair.get(a)?.get(b)`. */
  pair: Map<number, Map<number, number>>;
  /** Ticks of fighting and whether the clock ran out. */
  ticks: number;
  timeout: boolean;
  winner: Seat | null;
}

export function battleStats(d: DecodedReplay): BattleStats {
  const sol = d.replay.soldiers;
  const by = new Map<number, SquadStat>();
  for (const s of sol) {
    if (s.summoned || s.type === 'skeleton') continue;
    let q = by.get(s.squad);
    if (!q) by.set(s.squad, (q = { id: s.squad, side: s.side, type: s.type as SquadType, lord: s.lord ?? null, level: s.level, size: 0, lost: 0, dealt: 0, taken: 0, kills: 0, healed: 0, life: 0, wipedAt: -1 }));
    q.size++;
    q.life += s.maxHp;
  }
  const pair = new Map<number, Map<number, number>>();
  const squadOf = (i: number) => (i >= 0 && i < KEEP_SRC_BASE ? sol[i] : undefined);
  for (const e of d.events) {
    if (e.k === 'hit') {
      if (e.miss) continue;
      const a = squadOf(e.src);
      const b = squadOf(e.tgt);
      const qa = a ? by.get(a.squad) : undefined;
      const qb = b && !b.summoned ? by.get(b.squad) : undefined;
      if (qa) qa.dealt += e.dmg;
      if (qb) qb.taken += e.dmg;
      if (qa && qb) {
        let m = pair.get(qa.id);
        if (!m) pair.set(qa.id, (m = new Map()));
        m.set(qb.id, (m.get(qb.id) ?? 0) + e.dmg);
      }
    } else if (e.k === 'death') {
      const b = squadOf(e.tgt);
      const a = squadOf(e.src);
      if (a) {
        const qa = by.get(a.squad);
        if (qa) qa.kills++;
      }
      if (b && !b.summoned) {
        const qb = by.get(b.squad);
        if (qb) {
          qb.lost++;
          if (qb.lost >= qb.size) qb.wipedAt = e.tick;
        }
      }
    } else if (e.k === 'revive') {
      const b = squadOf(e.tgt);
      const qb = b && !b.summoned ? by.get(b.squad) : undefined;
      if (qb) {
        qb.lost = Math.max(0, qb.lost - 1);
        qb.wipedAt = -1;
      }
    } else if (e.k === 'heal') {
      const a = squadOf(e.src);
      const qa = a ? by.get(a.squad) : undefined;
      if (qa) qa.healed += e.amount;
    }
  }
  const r = d.replay.result;
  return { squads: [...by.values()], pair, ticks: r.ticks, timeout: r.timeout, winner: r.winner };
}

// ---------------------------------------------------------------- hints

export interface Hint { text: string; tone: 'good' | 'bad' | 'info' }

interface Traits { flier: boolean; ranged: boolean; antiAir: boolean; armored: boolean; magic: boolean; healer: boolean; range: number }

function traits(t: SquadType, lord: LordId | null): Traits {
  if (t === 'lord') {
    const L = LORDS[lord ?? 'marshal'];
    const ranged = L.range >= 400;
    return { flier: L.tags.includes('flier'), ranged, antiAir: ranged || L.tags.includes('flier') || L.weapon === 'tome' || L.weapon === 'bow', armored: L.tags.includes('armored'), magic: L.weapon === 'tome', healer: false, range: L.range };
  }
  const u = UNITS[t];
  const healer = !!u.traits?.includes('healer');
  const flier = u.tags.includes('flier');
  return {
    flier, ranged: u.range >= 400 && !healer, healer,
    antiAir: !healer && (u.weapon === 'bow' || u.damageType === 'magic' || flier || u.weapon === 'bolt'),
    armored: u.armor >= 40, magic: u.damageType === 'magic' || !!u.traits?.includes('ignoresArmor') || !!u.traits?.includes('crushing'),
    range: u.range,
  };
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const pct = (f: number) => `${Math.round(f * 100)}%`;
const clock = (ticks: number) => {
  const s = Math.floor(ticks / 20);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
function nameOf(q: SquadStat): string {
  return q.type === 'lord' ? unitName('lord', q.lord) : UNITS[q.type as UnitType].name;
}

/**
 * Up to `max` lines about the round from `me`'s point of view, most telling first. `ctx.gold` is
 * the gold the viewer still held when the battle began.
 */
export function battleHints(st: BattleStats, me: Seat, ctx: { gold?: number; max?: number } = {}): Hint[] {
  const max = ctx.max ?? 3;
  const mine = st.squads.filter((q) => q.side === me);
  const theirs = st.squads.filter((q) => q.side !== me);
  const T = new Map(st.squads.map((q) => [q.id, traits(q.type, q.lord)]));
  const sum = (l: SquadStat[], f: (q: SquadStat) => number) => l.reduce((a, q) => a + f(q), 0);
  const myDealt = Math.max(1, sum(mine, (q) => q.dealt));
  const theirDealt = Math.max(1, sum(theirs, (q) => q.dealt));
  const won = st.winner === null ? null : st.winner === me;
  const out: (Hint & { w: number })[] = [];
  const add = (w: number, tone: Hint['tone'], text: string) => out.push({ w, tone, text });

  // fliers nobody could reach
  for (const [side, army, foes] of [['me', mine, theirs], ['foe', theirs, mine]] as const) {
    const fliers = foes.filter((q) => T.get(q.id)!.flier && q.type !== 'lord');
    if (!fliers.length) continue;
    const reach = army.filter((q) => T.get(q.id)!.antiAir).length;
    const hurt = sum(fliers, (q) => q.taken) / Math.max(1, sum(fliers, (q) => q.life));
    const alive = fliers.filter((q) => q.wipedAt < 0).length;
    if (side === 'me' && alive > 0 && (reach === 0 || hurt < 0.35)) {
      const share = sum(fliers, (q) => q.dealt) / theirDealt;
      add(10 + share * 4, 'bad', reach === 0
        ? `Your army couldn't reach their ${plural(fliers.length, 'flier squad')}: only bows, magic and other fliers hit the air. Deploy Archers, Mages or fliers of your own.`
        : `Their ${plural(fliers.length, 'flier squad')} took only ${pct(hurt)} damage: you need more anti-air (Archers deal ×2 to fliers).`);
    } else if (side === 'foe' && alive === fliers.length && reach === 0) {
      add(6, 'good', `Their army had no answer to your ${plural(fliers.length, 'flier squad')}. Keep pressing from the air.`);
    }
  }

  // out-ranged
  const range = (l: SquadStat[]) => l.filter((q) => T.get(q.id)!.ranged && q.type !== 'lord');
  const theirRanged = range(theirs);
  const myRanged = range(mine);
  const theirRangedShare = sum(theirRanged, (q) => q.dealt) / theirDealt;
  const myRangedShare = sum(myRanged, (q) => q.dealt) / myDealt;
  if (theirRanged.length && theirRangedShare >= 0.45 && won !== true) {
    const top = [...theirRanged].sort((a, b) => b.dealt - a.dealt)[0]!;
    const safe = sum(theirRanged, (q) => q.taken) / Math.max(1, sum(theirRanged, (q) => q.life)) < 0.4;
    if (safe || theirRangedShare > myRangedShare + 0.25)
      add(8 + theirRangedShare * 3, 'bad', `Their ${nameOf(top)} out-ranged you: ${pct(theirRangedShare)} of their damage came from range${safe ? ' and you barely touched them' : ''}. Dive the back line with Cavaliers or fliers, or bring longer range.`);
  } else if (myRanged.length && myRangedShare >= 0.5 && won === true) {
    const top = [...myRanged].sort((a, b) => b.dealt - a.dealt)[0]!;
    add(4, 'good', `Your ${nameOf(top)} out-ranged them: ${pct(myRangedShare)} of your damage landed before they closed in.`);
  }

  // counters that decided a fight (who actually killed whom)
  const seen = new Set<string>();
  for (const a of st.squads) {
    if (a.type === 'lord') continue;
    const strong = counters(a.type as UnitType).strongVs;
    for (const [bid, dmg] of st.pair.get(a.id) ?? []) {
      const b = st.squads.find((q) => q.id === bid);
      if (!b || b.type === 'lord' || b.side === a.side || !strong.includes(b.type as UnitType)) continue;
      if (b.taken <= 0 || dmg / b.taken < 0.5 || b.lost / Math.max(1, b.size) < 0.6) continue;
      const key = `${a.side}:${a.type}>${b.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (a.side === me) add(5 + dmg / myDealt, 'good', `Your ${nameOf(a)} countered their ${nameOf(b)}.`);
      else add(7 + dmg / theirDealt, 'bad', `Their ${nameOf(a)} countered your ${nameOf(b)}: keep them apart, or answer with ${counterAdvice(a.type as UnitType)}.`);
    }
  }

  // armour that physical blows bounced off
  const walls = theirs.filter((q) => T.get(q.id)!.armored && q.wipedAt < 0 && q.taken > 0);
  if (walls.length && won !== true && !mine.some((q) => T.get(q.id)!.magic && q.type !== 'lord')) {
    const w = [...walls].sort((a, b) => b.taken - a.taken)[0]!;
    add(6, 'bad', `Their ${nameOf(w)} shrugged off your blows: armor cuts physical damage. Mages ignore armor, and Berserkers or a Trebuchet crush it.`);
  }

  // one squad carried them
  const star = [...theirs].sort((a, b) => b.dealt - a.dealt)[0];
  if (star && star.dealt / theirDealt >= 0.4 && theirs.length >= 3 && won !== true && !T.get(star.id)!.flier)
    add(5 + star.dealt / theirDealt, 'bad', `Their ${nameOf(star)} dealt ${pct(star.dealt / theirDealt)} of their damage. Make it your first target: ${star.type === 'lord' ? 'Pikemen and massed ranged fire bring a Lord down' : `answer with ${counterAdvice(star.type as UnitType)}`}.`);

  // healers
  const healed = sum(theirs, (q) => q.healed);
  if (healed > theirDealt * 0.25 && won !== true) add(5, 'bad', `Their Clerics healed ${healed.toLocaleString('en-US')} life. Kill the healers first: Cavaliers and fliers hunt the back line.`);

  // the Lord fell early
  const lord = mine.find((q) => q.type === 'lord');
  if (lord && lord.wipedAt >= 0 && lord.wipedAt < Math.min(st.ticks * 0.5, 500))
    add(4.5, 'bad', `Your Lord fell at ${clock(lord.wipedAt)}. Keep them behind the front line so the ability gets used.`);

  if (st.timeout) add(6.5, 'info', 'Time ran out at 1:30 with both armies standing, so each side dealt only half Keep damage. Bring more damage to finish the fight.');
  if (won === false && (ctx.gold ?? 0) >= 200) add(5.5, 'info', `You went into battle with ${ctx.gold} gold unspent. Level up squads (+25% life, +20% damage) when you have no deploys left.`);
  if (!out.length) {
    if (won === true) add(1, 'good', 'A clean win: your army out-fought theirs across the line.');
    else if (won === false) add(1, 'info', 'They simply had more army on the field. Level up your best squads and counter what they fielded this round.');
    else add(1, 'info', 'An even fight. Scout what they fielded and counter it next round.');
  }
  out.sort((a, b) => b.w - a.w);
  return out.slice(0, max).map(({ text, tone }) => ({ text, tone }));
}

/** "Pikemen or Archers": what to bring against a unit type. */
function counterAdvice(t: UnitType): string {
  const weak = counters(t).weakTo.slice(0, 2).map((u) => UNITS[u].name);
  return weak.length ? weak.join(' or ') : 'a different matchup';
}
