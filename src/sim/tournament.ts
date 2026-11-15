// Headless bot-vs-bot matches and the balance report (DESIGN §8). Used by tools/tournament.ts and the smoke test.
import { FACTION_IDS } from './data/factions.ts';
import { LORDS, LORD_IDS } from './data/lords.ts';
import { UNITS, UNIT_TYPES } from './data/units.ts';
import { SKILLS, SKILL_IDS, canEquip } from './data/skills.ts';
import { botPlan } from './bot.ts';
import { simulateBattle } from './battle.ts';
import { applyBattle, keepPct, newMatch, nextRound } from './match.ts';
import type { BattleEnd, BotStrategy, LordId, Seat, UnitType } from './types.ts';

export interface BattleRecord {
  winner: Seat | null;
  ticks: number;
  /** How the battle ended (wipe / mutualWipe / timeout / stalemate). */
  end: BattleEnd;
  /** Gold invested per unit type, per seat. */
  gold: [Partial<Record<UnitType, number>>, Partial<Record<UnitType, number>>];
  legend: [string[], string[]];
  /** Item skills equipped per seat. */
  skills: [string[], string[]];
  /**
   * Control group per seat: skills S for which the army wears a Rare item WITHOUT a skill, in S's slot, on a squad
   * that could use S. Comparing "wears S" with "wears the control" isolates what the skill itself adds (who owns
   * siege engines, or which bot gears well, affects both alike).
   */
  ctl: [string[], string[]];
  /** Damage dealt per seat, and the part of it dealt by the Lord. */
  dealt: [number, number];
  lordDealt: [number, number];
}
export interface MatchRecord {
  seed: number;
  lords: [LordId, LordId];
  strats: [BotStrategy, BotStrategy];
  winner: Seat | 'draw' | null;
  rounds: number;
  battles: BattleRecord[];
  /** Keep HP percent per seat at the end of the match (the winner's is the margin of victory). */
  keepPct: [number, number];
}

export function playMatch(seed: number, lords: [LordId, LordId], strats: [BotStrategy, BotStrategy]): MatchRecord {
  const s = newMatch(seed, lords);
  const battles: BattleRecord[] = [];
  while (s.phase === 'planning') {
    botPlan(s, 0, strats[0], 1);
    botPlan(s, 1, strats[1], 2);
    const gold: BattleRecord['gold'] = [{}, {}];
    const legend: BattleRecord['legend'] = [[], []];
    const skills: BattleRecord['skills'] = [[], []];
    const ctl: BattleRecord['ctl'] = [[], []];
    for (const seat of [0, 1] as Seat[]) {
      for (const q of s.players[seat].squads) {
        if (q.type !== 'lord') gold[seat][q.type] = (gold[seat][q.type] ?? 0) + q.spent;
        for (const it of [q.items.weapon, q.items.armor, q.items.relic]) {
          if (it?.legendary && !legend[seat].includes(it.legendary)) legend[seat].push(it.legendary);
          if (it?.skill && canEquip(it, q.type, s.players[seat].lord) && !skills[seat].includes(it.skill)) skills[seat].push(it.skill);
          if (it && it.rarity === 'rare' && !it.skill) {
            for (const k of SKILL_IDS) if (SKILLS[k].slot === it.slot && canEquip({ skill: k }, q.type, s.players[seat].lord) && !ctl[seat].includes(k)) ctl[seat].push(k);
          }
        }
      }
    }
    const { result } = simulateBattle(s, { record: false });
    battles.push({ winner: result.winner, ticks: result.ticks, end: result.end, gold, legend, skills, ctl, dealt: result.damageDealt, lordDealt: result.lordDamage ?? [0, 0] });
    applyBattle(s, result);
    if ((s.phase as string) !== 'results') break;
    nextRound(s);
  }
  return { seed, lords, strats, winner: s.winner, rounds: s.round, battles, keepPct: [keepPct(s.players[0]), keepPct(s.players[1])] };
}

export interface Report {
  matches: number;
  p0: number; // P0 win share (draws half)
  lords: Record<string, number>;
  lordGames: Record<string, number>;
  strats: Record<string, number>;
  units: Record<string, number>;
  unitSamples: Record<string, number>;
  /** Same metric restricted to battles where neither army had fliers (removes the anti-air reaction confound). */
  unitsNoAir: Record<string, number>;
  legends: Record<string, number>;
  legendSamples: Record<string, number>;
  /** Item skills, measured like the legendaries (the wearer's round win rate when only one side wears it). */
  skills: Record<string, number>;
  skillSamples: Record<string, number>;
  /** Round win rate of armies wearing the skill, and of the control group (a plain Rare in its place), over all decided battles. */
  skillWith: Record<string, number>;
  skillCtl: Record<string, number>;
  skillWithSamples: Record<string, number>;
  /** Head-to-head rates (equal counts on both sides): one legendary / skill against another. */
  legendsH2H?: Record<string, number>;
  legendsH2HSamples?: Record<string, number>;
  skillsH2H?: Record<string, number>;
  skillsH2HSamples?: Record<string, number>;
  skillCtlSamples?: Record<string, number>;
  /** Share of each Lord's army damage dealt by the Lord itself (all battles), and the overall share. */
  lordShare: Record<string, number>;
  lordShareAll: number;
  /** Match length percentiles (rounds). */
  roundsP50: number;
  roundsP95: number;
  roundsP99?: number;
  /** Share of matches over in 6 rounds or fewer, and share that went past round 12. */
  roundsShort?: number;
  roundsFinal?: number;
  roundsMax: number;
  /** stratMatrix[a][b] = win rate of strategy a vs strategy b. */
  stratMatrix: Record<string, Record<string, number>>;
  /** lordMatrix[a][b] = win rate of Lord a vs Lord b. */
  lordMatrix: Record<string, Record<string, number>>;
  /** factionMatrix[a][b] = win rate of faction a vs faction b (mirrors are 50 by construction); factionRounds = average match length per pairing. */
  factionMatrix?: Record<string, Record<string, number>>;
  factionGames?: Record<string, Record<string, number>>;
  factionRounds?: Record<string, Record<string, number>>;
  /** Win rate of each faction against the other two. */
  factions?: Record<string, number>;
  rounds: number;
  battleSec: number;
  /** Share of battles that ended with both armies standing (timeout or stalemate). */
  timeouts: number;
  /** Share of battles ended early as a stalemate. */
  stalemates: number;
  draws: number;
  /** Match length histogram: rounds -> share of matches. */
  roundHist: Record<number, number>;
  /** Winner's keep HP left at the end, as a histogram over 0-24 / 25-49 / 50-74 / 75-100 percent (share of decided matches). */
  marginHist: [number, number, number, number];
  /** Mean winner's keep HP percent left (lower = closer matches). */
  margin: number;
}

export function aggregate(recs: MatchRecord[]): Report {
  const w = (r: MatchRecord, seat: Seat): number => (r.winner === seat ? 1 : r.winner === 'draw' || r.winner === null ? 0.5 : 0);
  const lords: Record<string, [number, number]> = {}, strats: Record<string, [number, number]> = {};
  const unitsNoAir: Record<string, [number, number]> = {};
  const units: Record<string, [number, number]> = {}, legends: Record<string, [number, number]> = {}, skills: Record<string, [number, number]> = {};
  const lordShare: Record<string, [number, number]> = {};
  const skillWith: Record<string, [number, number]> = {}, skillCtl: Record<string, [number, number]> = {};
  const legendsH2H: Record<string, [number, number]> = {}, skillsH2H: Record<string, [number, number]> = {};
  const lens: number[] = [];
  const sm: Record<string, Record<string, [number, number]>> = {}, lm: Record<string, Record<string, [number, number]>> = {};
  const fm: Record<string, Record<string, [number, number]>> = {}, fr: Record<string, Record<string, [number, number]>> = {};
  const factions: Record<string, [number, number]> = {};
  const add2 = (m: Record<string, Record<string, [number, number]>>, a: string, b: string, win: number): void => {
    const e = ((m[a] ??= {})[b] ??= [0, 0]);
    e[0] += win; e[1]++;
  };
  let p0 = 0, rounds = 0, ticks = 0, battles = 0, timeouts = 0, stalemates = 0, draws = 0;
  const roundHist: Record<number, number> = {};
  const marginHist: [number, number, number, number] = [0, 0, 0, 0];
  let marginSum = 0, decided = 0;
  const add = (m: Record<string, [number, number]>, k: string, win: number, n = 1): void => {
    const e = (m[k] ??= [0, 0]);
    e[0] += win * n; e[1] += n;
  };
  for (const r of recs) {
    p0 += w(r, 0);
    rounds += r.rounds;
    lens.push(r.rounds);
    roundHist[r.rounds] = (roundHist[r.rounds] ?? 0) + 1;
    if (r.winner === 'draw') draws++;
    if ((r.winner === 0 || r.winner === 1) && r.keepPct) {
      const m = r.keepPct[r.winner];
      marginHist[Math.min(3, Math.floor(m / 25))]++;
      marginSum += m;
      decided++;
    }
    for (const seat of [0, 1] as Seat[]) {
      if (r.lords[0] !== r.lords[1]) add(lords, r.lords[seat], w(r, seat));
      if (r.strats[0] !== r.strats[1]) add(strats, r.strats[seat], w(r, seat));
      add2(sm, r.strats[seat], r.strats[1 - seat], w(r, seat));
      add2(lm, r.lords[seat], r.lords[1 - seat], w(r, seat));
      const fa = LORDS[r.lords[seat]].faction, fb = LORDS[r.lords[1 - seat]].faction;
      add2(fm, fa, fb, w(r, seat));
      const e = ((fr[fa] ??= {})[fb] ??= [0, 0]);
      e[0] += r.rounds; e[1]++;
      if (fa !== fb) add(factions, fa, w(r, seat));
    }
    for (const b of r.battles) {
      battles++;
      ticks += b.ticks;
      if (b.dealt) for (const seat of [0, 1] as Seat[]) { const e = (lordShare[r.lords[seat]] ??= [0, 0]); e[0] += b.lordDealt[seat]; e[1] += b.dealt[seat]; }
      if (b.end === 'timeout' || b.end === 'stalemate') timeouts++;
      if (b.end === 'stalemate') stalemates++;
      if (b.winner === null) continue;
      const win = b.winner, lose = (1 - win) as Seat;
      const hasAir = (g: Partial<Record<UnitType, number>>): boolean => (Object.keys(g) as UnitType[]).some((u) => UNITS[u].tags.includes('flier'));
      const tot = (g: Partial<Record<UnitType, number>>): number => Object.values(g).reduce((a, x) => a + (x ?? 0), 0) || 1;
      const tw = tot(b.gold[win]), tl = tot(b.gold[lose]);
      for (const u of UNIT_TYPES) {
        const sw = (b.gold[win][u] ?? 0) / tw, sl = (b.gold[lose][u] ?? 0) / tl;
        if (sw + sl > 0) { const e = (units[u] ??= [0, 0]); e[0] += sw; e[1] += sw + sl; }
        if (sw + sl > 0 && !hasAir(b.gold[win]) && !hasAir(b.gold[lose])) { const e = (unitsNoAir[u] ??= [0, 0]); e[0] += sw; e[1] += sw + sl; }
      }
      // Legendaries and skills: both players are offered the same items, so the fair comparison is the battles where
      // exactly one side wears the item: how often does the wearer win the round? Battles between the Hard bot and a
      // weaker bot are left out (Hard wins them whatever it wears, and it gears best).
      const hard = (x: BotStrategy): boolean => x === 'best' || x === 'hard';
      const sameTier = hard(r.strats[0]) === hard(r.strats[1]);
      if (sameTier) {
        for (const l of b.legend[win]) if (!b.legend[lose].includes(l)) add(legends, l, 1);
        for (const l of b.legend[lose]) if (!b.legend[win].includes(l)) add(legends, l, 0);
      }
      // Head-to-head: both armies wear the same number (>= 1) of legendaries / skills, and this one only on one side.
      // This is "this legendary against another legendary", the comparison the 40-60% target is about.
      if (sameTier && b.legend[win].length && b.legend[win].length === b.legend[lose].length) {
        for (const l of b.legend[win]) if (!b.legend[lose].includes(l)) add(legendsH2H, l, 1);
        for (const l of b.legend[lose]) if (!b.legend[win].includes(l)) add(legendsH2H, l, 0);
      }
      if (sameTier && b.skills && b.skills[win].length && b.skills[win].length === b.skills[lose].length) {
        for (const l of b.skills[win]) if (!b.skills[lose].includes(l)) add(skillsH2H, l, 1);
        for (const l of b.skills[lose]) if (!b.skills[win].includes(l)) add(skillsH2H, l, 0);
      }
      if (b.skills && b.ctl && sameTier) {
        for (const seat of [win, lose]) {
          for (const k of b.skills[seat]) add(skillWith, k, seat === win ? 1 : 0);
          for (const k of b.ctl[seat]) if (!b.skills[seat].includes(k)) add(skillCtl, k, seat === win ? 1 : 0);
        }
      }
      if (b.skills && sameTier) {
        for (const l of b.skills[win]) if (!b.skills[lose].includes(l)) add(skills, l, 1);
        for (const l of b.skills[lose]) if (!b.skills[win].includes(l)) add(skills, l, 0);
      }
    }
  }
  const rate = (m: Record<string, [number, number]>): Record<string, number> => Object.fromEntries(Object.entries(m).map(([k, [a, n]]) => [k, n ? a / n : 0]));
  const samples = (m: Record<string, [number, number]>): Record<string, number> => Object.fromEntries(Object.entries(m).map(([k, [, n]]) => [k, n]));
  lens.sort((a, b) => a - b);
  const pctl = (q: number): number => (lens.length ? lens[Math.min(lens.length - 1, Math.floor(q * lens.length))] : 0);
  let ld = 0, ad = 0;
  for (const [a, n] of Object.values(lordShare)) { ld += a; ad += n; }
  return {
    matches: recs.length, p0: p0 / Math.max(1, recs.length), lords: rate(lords), lordGames: samples(lords), strats: rate(strats),
    units: rate(units), unitSamples: samples(units), unitsNoAir: rate(unitsNoAir), legends: rate(legends), legendSamples: samples(legends),
    skills: rate(skills), skillSamples: samples(skills), skillWith: rate(skillWith), skillCtl: rate(skillCtl), skillWithSamples: samples(skillWith), skillCtlSamples: samples(skillCtl),
    legendsH2H: rate(legendsH2H), legendsH2HSamples: samples(legendsH2H), skillsH2H: rate(skillsH2H), skillsH2HSamples: samples(skillsH2H), lordShare: rate(lordShare), lordShareAll: ad ? ld / ad : 0,
    roundsP50: pctl(0.5), roundsP95: pctl(0.95), roundsP99: pctl(0.99),
    roundsShort: lens.filter((x) => x <= 6).length / Math.max(1, lens.length), roundsFinal: lens.filter((x) => x > 12).length / Math.max(1, lens.length), roundsMax: lens.length ? lens[lens.length - 1] : 0,
    stratMatrix: Object.fromEntries(Object.entries(sm).map(([a, row]) => [a, rate(row)])),
    lordMatrix: Object.fromEntries(Object.entries(lm).map(([a, row]) => [a, rate(row)])),
    factionMatrix: Object.fromEntries(Object.entries(fm).map(([a, row]) => [a, rate(row)])),
    factionGames: Object.fromEntries(Object.entries(fm).map(([a, row]) => [a, samples(row)])),
    factionRounds: Object.fromEntries(Object.entries(fr).map(([a, row]) => [a, rate(row)])),
    factions: rate(factions),
    rounds: rounds / Math.max(1, recs.length), battleSec: ticks / Math.max(1, battles) / 20, timeouts: timeouts / Math.max(1, battles),
    stalemates: stalemates / Math.max(1, battles), draws,
    roundHist: Object.fromEntries(Object.entries(roundHist).map(([k, n]) => [k, n / Math.max(1, recs.length)])),
    marginHist: marginHist.map((n) => n / Math.max(1, decided)) as [number, number, number, number],
    margin: marginSum / Math.max(1, decided),
  };
}

const pct = (x: number): string => (100 * x).toFixed(1) + '%';
export function formatReport(r: Report): string {
  const L: string[] = [];
  L.push(`matches ${r.matches} | P0 win ${pct(r.p0)} | avg rounds ${r.rounds.toFixed(2)} | avg battle ${r.battleSec.toFixed(1)} s | timeouts ${pct(r.timeouts)} (stalemates ${pct(r.stalemates ?? 0)}) | draws ${r.draws}`);
  if (r.roundsP95) L.push(`Rounds: median ${r.roundsP50}, 95th percentile ${r.roundsP95}, 99th ${r.roundsP99 ?? '-'}, longest ${r.roundsMax}; 6 or fewer ${pct(r.roundsShort ?? 0)}, past round 12 ${pct(r.roundsFinal ?? 0)}`);
  if (r.roundHist) L.push('Match length: ' + Object.entries(r.roundHist).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}r ${pct(v)}`).join(', '));
  if (r.marginHist) L.push(`Winner keep HP left: mean ${r.margin.toFixed(1)}% | 0-24% ${pct(r.marginHist[0])}, 25-49% ${pct(r.marginHist[1])}, 50-74% ${pct(r.marginHist[2])}, 75-100% ${pct(r.marginHist[3])}`);
  L.push('Lords: ' + LORD_IDS.filter((l) => r.lords[l] !== undefined).map((l) => `${l} ${pct(r.lords[l] ?? 0)}`).join(', '));
  if (r.factions && Object.keys(r.factions).length > 1) {
    L.push('Factions (vs the other two): ' + FACTION_IDS.filter((x) => r.factions![x] !== undefined).map((x) => `${x} ${pct(r.factions![x])}`).join(', '));
    const ids = FACTION_IDS.filter((x) => r.factionMatrix![x]);
    L.push('Faction pairings (row vs column: win rate, avg rounds, games): ' + ids.map((a) => ids.map((b) => (r.factionMatrix![a][b] === undefined ? '' : `${a} v ${b} ${pct(r.factionMatrix![a][b])} ${r.factionRounds![a][b].toFixed(2)}r n=${r.factionGames![a][b]}`)).filter(Boolean).join('; ')).join(' | '));
  }
  L.push('Strategies: ' + Object.entries(r.strats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`).join(', '));
  L.push('Units (cost-normalised share in round winners): ' + UNIT_TYPES.filter((u) => r.units[u] !== undefined).map((u) => `${u} ${pct(r.units[u] ?? 0)} (n=${(r.unitSamples[u] ?? 0).toFixed(0)})`).join(', '));
  if (r.unitsNoAir) L.push('Units, battles without fliers: ' + UNIT_TYPES.filter((u) => r.unitsNoAir[u] !== undefined).map((u) => `${u} ${pct(r.unitsNoAir[u])}`).join(', '));
  L.push('Legendaries (wearer vs an army without it): ' + Object.entries(r.legends).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)} (n=${r.legendSamples[k]})`).join(', '));
  if (r.legendsH2H) L.push('Legendaries head-to-head (equal counts): ' + Object.entries(r.legendsH2H).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)} (n=${r.legendsH2HSamples![k]})`).join(', '));
  if (r.skillsH2H) L.push('Skills head-to-head (equal counts): ' + Object.entries(r.skillsH2H).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)} (n=${r.skillsH2HSamples![k]})`).join(', '));
  if (r.skills) L.push('Skills (wearer vs an army without it): ' + Object.entries(r.skills).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)} (n=${r.skillSamples[k]})`).join(', '));
  if (r.skillWith) L.push('Skills vs control (round win rate wearing it / wearing a plain Rare instead): ' + Object.keys(r.skillWith).sort((a, b) => (r.skillWith[b] - (r.skillCtl[b] ?? 0)) - (r.skillWith[a] - (r.skillCtl[a] ?? 0))).map((k) => `${k} ${(100 * (r.skillWith[k] - (r.skillCtl[k] ?? 0))).toFixed(1).replace(/^(?!-)/, '+')} (${pct(r.skillWith[k])} / ${pct(r.skillCtl[k] ?? 0)}, n=${r.skillWithSamples[k]} / ${r.skillCtlSamples?.[k] ?? 0})`).join(', '));
  if (r.lordShare) L.push(`Lord share of army damage: ${pct(r.lordShareAll)} overall; ` + LORD_IDS.filter((l) => r.lordShare[l] !== undefined).map((l) => `${l} ${pct(r.lordShare[l] ?? 0)}`).join(', '));
  const mat = (m: Record<string, Record<string, number>>, title: string): void => {
    const keys = Object.keys(m).sort();
    L.push(title.padEnd(10) + keys.map((k) => k.slice(0, 8).padStart(9)).join(''));
    for (const a of keys) L.push(a.padEnd(10) + keys.map((b) => (m[a][b] === undefined ? '-' : (100 * m[a][b]).toFixed(0)).padStart(9)).join(''));
  };
  if (r.stratMatrix) mat(r.stratMatrix, 'strat');
  if (r.lordMatrix) mat(r.lordMatrix, 'lord');
  return L.join('\n');
}

export const TOURNAMENT_STRATEGIES: BotStrategy[] = ['rush', 'ranged', 'armor', 'air', 'counter', 'random'];
