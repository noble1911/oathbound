// What happened in a battle, read from the replay (pure: no DOM; tested in tests/client.ux.test.ts):
// per-squad damage dealt / taken / healing / kills / losses for both sides (the sim's ledger,
// src/sim/stats.ts), and a few plain-language lines
// that say why the round went the way it did and what to change ("Your melee couldn't reach 3
// fliers: deploy Archers", "Their Archers out-ranged you", "Your Pikemen countered their Cavaliers").
import type { BattleEnd, DecodedReplay, FactionId, LordId, Seat, SquadType, UnitType } from '../sim/types.ts';
import { stalemateCause } from '../sim/match.ts';
import { UNITS } from '../sim/data/units.ts';
import { LORDS } from '../sim/data/lords.ts';
import { replaySquads, squadDamagePairs, squadStatsAt } from '../sim/stats.ts';
import { classOf, factionContext, unitName, unitsOfClass } from './gamedata.ts';
import { FACTIONS } from '../sim/data/factions.ts';
import { UNIT_TYPES } from '../sim/data/units.ts';
import { WHEEL_NAME, beatenBy, classBeats } from '../sim/data/wheel.ts';

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
  /** Life it restored on allies and itself (heals, lifesteal, regeneration, revives). */
  healed: number;
  /** Total life of the squad at full strength. */
  life: number;
  /** Sim tick the last soldier fell (-1 = survived). */
  wipedAt: number;
}

export interface BattleStats {
  squads: SquadStat[];
  /** Damage from squad A to squad B: `pair.get(a)?.get(b)`. */
  pair: Map<number, Map<number, number>>;
  /** Ticks of fighting, and whether both armies still stood at the end (the clock ran out, or a stalemate was called). */
  ticks: number;
  timeout: boolean;
  /** How the battle ended ('timeout' = the full 1:30; 'stalemate' = called early). */
  end: BattleEnd;
  winner: Seat | null;
  /** Stalemates: which army could no longer harm the other (BattleResult.helpless). */
  helpless?: [boolean, boolean];
  /** Each seat's faction, read off its army. */
  factions: [FactionId | null, FactionId | null];
}

/** Each side's faction, read off its army (the Lord, else any soldier's unit type). */
export function replayFactions(soldiers: { side: 0 | 1; type: string; lord?: string }[]): [FactionId | null, FactionId | null] {
  const out: [FactionId | null, FactionId | null] = [null, null];
  for (const s of soldiers) {
    if (out[s.side]) continue;
    const lord = s.lord ? (LORDS as Record<string, { faction: FactionId } | undefined>)[s.lord] : undefined;
    const unit = (UNITS as Record<string, { faction: FactionId } | undefined>)[s.type];
    out[s.side] = lord?.faction ?? unit?.faction ?? null;
    if (out[0] && out[1]) break;
  }
  return out;
}

/**
 * What to call each seat's army in a sentence, from `seat`'s point of view: "your army", and the other by its faction
 * ("the Covenant army") unless both fight for the same faction ("the enemy army"). Spectators: the faction names, or
 * "Blue's army" / "Red's army" in a mirror.
 */
export function armyNames(f: [FactionId | null, FactionId | null], seat: Seat | null): [string, string] {
  const by = (i: Seat, fallback: string): string => { const x = f[i]; return x && f[0] !== f[1] ? `the ${FACTIONS[x].short} army` : fallback; };
  if (seat === null) return [by(0, "Blue's army"), by(1, "Red's army")];
  const out: [string, string] = ['', ''];
  out[seat] = 'your army';
  out[1 - seat] = by((1 - seat) as Seat, 'the enemy army');
  return out;
}

export function battleStats(d: DecodedReplay): BattleStats {
  // the sim's ledger (src/sim/stats.ts): every point of life removed or restored, by source squad,
  // with burns, thorns, lifesteal and skills included and no overkill
  const at = squadStatsAt(d, d.replay.ticks);
  const rows = replaySquads(d);
  const by = new Map<number, SquadStat>();
  for (const q of at.squads) {
    if (q.summoned) continue;
    const size = rows[q.row]?.soldiers.length ?? q.soldiers;
    by.set(q.squad, { id: q.squad, side: q.side, type: q.type as SquadType, lord: q.lord, level: q.level, size, lost: q.losses, dealt: q.dealt, taken: q.taken, kills: q.kills, healed: q.healingDone, life: q.hpMax, wipedAt: q.wipedAt });
  }
  // a raised band (skeletons) fights for the squad that raised it: its damage, kills and healing are that squad's
  const idOf = (row: number): number | undefined => {
    const q = at.squads[row];
    return q && by.has(q.squad) && by.get(q.squad)!.side === q.side ? q.squad : undefined;
  };
  for (const q of at.squads) {
    if (!q.summoned) continue;
    const owner = by.get(idOf(q.row) ?? -1);
    if (!owner) continue;
    owner.dealt += q.dealt;
    owner.kills += q.kills;
    owner.healed += q.healingDone;
  }
  // the ledger counts every death; a soldier brought back (Undying Oath, Phoenix) is not lost
  const sol = d.replay.soldiers;
  for (const e of d.events) {
    if (e.k !== 'revive') continue;
    const s = sol[e.tgt];
    const q = s && !s.summoned ? by.get(s.squad) : undefined;
    if (!q || q.side !== s!.side) continue;
    q.lost = Math.max(0, q.lost - 1);
  }
  for (const q of by.values()) if (q.lost < q.size) q.wipedAt = -1;
  const pair = new Map<number, Map<number, number>>();
  for (const [ra, m] of squadDamagePairs(d, d.replay.ticks)) {
    const a = idOf(ra);
    if (a === undefined) continue;
    for (const [rb, dmg] of m) {
      const tgt = at.squads[rb];
      if (!tgt || tgt.summoned || !by.has(tgt.squad) || !dmg) continue;
      let out = pair.get(a);
      if (!out) pair.set(a, (out = new Map()));
      out.set(tgt.squad, (out.get(tgt.squad) ?? 0) + dmg);
    }
  }
  const r = d.replay.result;
  // older replays carry no `end`: both armies standing means the clock, unless it stopped short of 1:30
  const end: BattleEnd = r.end ?? (r.timeout ? (r.ticks >= TIME_LIMIT_TICKS ? 'timeout' : 'stalemate') : r.winner === null ? 'mutualWipe' : 'wipe');
  return { squads: [...by.values()], pair, ticks: r.ticks, timeout: r.timeout, end, winner: r.winner, helpless: r.helpless, factions: replayFactions(d.replay.soldiers) };
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
    antiAir: !healer && (u.weapon === 'bow' || u.damageType === 'magic' || flier || u.weapon === 'bolt' || u.weapon === 'beam'),
    armored: u.armor >= 40, magic: u.damageType === 'magic' || !!u.traits?.includes('ignoresArmor') || !!u.traits?.includes('crushing'),
    range: u.range,
  };
}

/** The battle clock: 1:30 at 20 ticks a second. */
export const TIME_LIMIT_TICKS = 1800;
/** "1:23" for a tick count. */
export const battleClock = (ticks: number): string => {
  const s = Math.floor(ticks / 20);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const pct = (f: number) => `${Math.round(f * 100)}%`;
const clock = battleClock;
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

  // wheel counters that decided a fight (who actually killed whom)
  const seen = new Set<string>();
  for (const a of st.squads) {
    if (a.type === 'lord' || UNITS[a.type as UnitType].traits.includes('healer')) continue;
    const cls = classOf(a.type);
    for (const [bid, dmg] of st.pair.get(a.id) ?? []) {
      const b = st.squads.find((q) => q.id === bid);
      if (!b || b.type === 'lord' || b.side === a.side || !classBeats(cls, classOf(b.type))) continue;
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

  // both armies still standing: say which of the two endings it was, with the real time
  if (st.end === 'timeout') add(6.5, 'info', 'Time ran out at 1:30 with both armies standing, so each side dealt only half Keep damage. Bring more damage to finish the fight.');
  else if (st.end === 'stalemate') {
    // the sim says which side was stuck: the advice follows from it
    const h = st.helpless;
    const cause = stalemateCause(st, me, armyNames(st.factions ?? [null, null], me));
    const tip = h && !h[me] && h[1 - me]
      ? 'You won the round. Routing them outright pays the full round bonus.'
      : h && !h[0] && !h[1]
        ? 'Both armies stood off without a blow landing: send something that closes in.'
        : 'Bring something that can reach what they had left (bows, magic and fliers hit the air).';
    // exactly one side stuck: it lost the round (the sim's rule); otherwise the stalemate was settled on points
    const oneSided = !!h && h[0] !== h[1];
    const verdict = oneSided ? (h![me] ? 'so the field went to the enemy' : 'so the field was yours') : 'so the round was settled on points';
    add(6.5, 'info', `The battle was called at ${clock(st.ticks)}: ${cause.charAt(0).toLowerCase() + cause.slice(1)}, ${verdict}. ${tip}`);
  }
  if (won === false && (ctx.gold ?? 0) >= 200) add(5.5, 'info', `You went into battle with ${ctx.gold} gold unspent. Level up squads (more life and damage, or more soldiers for a Swarm) when you have no deploys left.`);
  if (!out.length) {
    if (won === true) add(1, 'good', 'A clean win: your army out-fought theirs across the line.');
    else if (won === false) add(1, 'info', 'They simply had more army on the field. Level up your best squads and counter what they fielded this round.');
    else add(1, 'info', 'An even fight. Scout what they fielded and counter it next round.');
  }
  out.sort((a, b) => b.w - a.w);
  return out.slice(0, max).map(({ text, tone }) => ({ text, tone }));
}

/** "Giant (Stone Golem or War Elephant)": the wheel class that beats a unit type, with your faction's units of it. */
function counterAdvice(t: UnitType): string {
  const c = beatenBy(classOf(t));
  const mine = factionContext().mine;
  const own = unitsOfClass(c, mine ? FACTIONS[mine].units : UNIT_TYPES).slice(0, 2).map((u) => UNITS[u].name);
  return own.length ? `${WHEEL_NAME[c]} (${own.join(' or ')})` : `${WHEEL_NAME[c]} units`;
}
