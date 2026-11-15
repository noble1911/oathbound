// Planning bots for the tournament and the vs-AI mode. Bots see only viewFor() (no hidden information: their own
// state plus the enemy's public view, i.e. the army as it fought LAST round) and act only through applyIntent, so
// they obey exactly the same rules as players.
//
// The vs-AI difficulties (src/net/protocol.ts AI_STRATEGY) are three genuinely different players:
//  - 'easy':   spends only ~65% of its gold, rarely levels up, drafts / loots / equips at random, ignores the enemy
//              army when buying, and lines everything up in one naive row.
//  - 'normal': the counter-picker. Buys counters to the enemy's last army, keeps a frontline, spends sensibly (keeps a
//              ~12% reserve, half that for the Marshal), levels a squad instead of a weak buy, equips each item on its
//              most valuable squad, and places squads in fixed role lanes (slow melee a little further forward, fast
//              melee further back), except its archers, which move under the enemy's fliers.
//  - 'hard':   ('best' is an alias) spends everything, choosing each time between the best counter-buy and levelling a
//              squad that counters the enemy, re-forms the whole army every round against the enemy's last formation
//              (pikes in front of enemy cavalry, raiders on the flank with the enemy backline, archers under enemy
//              fliers...) with its melee staggered in depth by speed so it reaches the river together, and puts each
//              item on the squad its affixes suit.
import { mirrorPos } from './constants.ts';
import { LORDS, LORD_IDS } from './data/lords.ts';
import { AFFIXES, SLOT_UNLOCK_LEVEL } from './data/items.ts';
import { SKILLS, canEquip } from './data/skills.ts';
import { UNITS } from './data/units.ts';
import { itemPower } from './loot.ts';
import { ARMY_CAP, MAX_SQUAD_LEVEL, applyIntent, deployZone, freeSpotNear, levelUpCost, slotOpen, squadFootprint, viewFor } from './match.ts';
import { hash } from './rng.ts';
import type { BotStrategy, Item, KingdomUnit, LordId, MatchState, PlayerState, Seat, Slot, Squad, SquadType, Tag, UnitType, Vec2 } from './types.ts';

/**
 * Every faction's units are understood through the Kingdom unit they play like (UnitDef.like): the preference and
 * counter tables below are written once, for the Kingdom roster, and K() maps any unit onto them.
 */
const K = (u: UnitType): KingdomUnit => UNITS[u].like;
const KT = (t: SquadType): KingdomUnit | 'lord' => (t === 'lord' ? 'lord' : UNITS[t].like);

export const BOT_STRATEGIES: readonly BotStrategy[] = ['rush', 'ranged', 'armor', 'air', 'counter', 'random', 'best', 'easy', 'normal', 'hard'];

type Flavour = 'rush' | 'ranged' | 'armor' | 'air';
/** Preference weights per strategy (unlisted units get weight 1; 'random' is flat). */
const PREF: Record<Flavour, Partial<Record<UnitType, number>>> = {
  rush: { militia: 4, berserkers: 4, cavaliers: 4, pikemen: 2, knights: 2, wyvern: 2, golem: 1, archers: 2 },
  ranged: { archers: 4, mages: 4, ballista: 3, trebuchet: 3, clerics: 2, pikemen: 2, knights: 2, militia: 2 },
  armor: { knights: 4, golem: 4, pikemen: 3, clerics: 3, mages: 2, militia: 2, berserkers: 1 },
  air: { pegasus: 4, wyvern: 4, dragon: 5, archers: 2, clerics: 1, militia: 2, knights: 1 },
};

/** COUNTER[a][b] = how well unit a beats unit b (0..3). */
const C: Partial<Record<UnitType, Partial<Record<UnitType, number>>>> = {
  militia: { berserkers: 2, golem: 1, ballista: 1, trebuchet: 1 },
  pikemen: { cavaliers: 3, militia: 1, knights: 1 },
  berserkers: { pikemen: 2, knights: 2, militia: 1, clerics: 1 },
  archers: { pegasus: 3, wyvern: 3, dragon: 2, pikemen: 1, militia: 1, berserkers: 1 },
  knights: { archers: 2, militia: 2, berserkers: 1, ballista: 1 },
  cavaliers: { archers: 2, mages: 3, trebuchet: 3, ballista: 2, clerics: 2, berserkers: 1 },
  mages: { knights: 3, militia: 2, pikemen: 2, archers: 1, golem: 1 },
  pegasus: { mages: 2, trebuchet: 3, ballista: 2, clerics: 2, knights: 1, golem: 1 },
  ballista: { golem: 3, wyvern: 3, dragon: 3, trebuchet: 1, knights: 1 },
  trebuchet: { militia: 2, pikemen: 2, archers: 2, knights: 2, mages: 1 },
  golem: { knights: 2, militia: 2, berserkers: 2, pikemen: 2, cavaliers: 1 },
  wyvern: { knights: 2, golem: 2, pikemen: 2, berserkers: 2, militia: 1, mages: 1 },
  dragon: { militia: 2, pikemen: 2, berserkers: 2, knights: 2, golem: 1, mages: 1 },
  clerics: {},
};
/** The plain counter table through the "plays like" mapping. */
const cv = (a: UnitType, b: UnitType): number => C[K(a)]?.[K(b)] ?? 0;

/**
 * How well unit a beats unit b (0..4): the table entry of the Kingdom units they play like, corrected by what the two
 * units really are when either is from another faction. The "like" mapping is only a role; these corrections keep the
 * bots from buying an answer that does not work (pikes against spectral riders, bolt-throwers against a Djinn...).
 * Used by the classic planner (Normal and the tournament strategies). Hard keeps the plain table (`cv`): its own
 * cover logic was tuned on it, and with the corrections its faction balance tested much worse (see BALANCE.md).
 */
function cvReal(a: UnitType, b: UnitType): number {
  const ka = K(a), kb = K(b);
  let v = C[ka]?.[kb] ?? 0;
  const A = UNITS[a], B = UNITS[b];
  if (A.faction === 'kingdom' && B.faction === 'kingdom') return v;
  // A counter that rests on a tag bonus is worth nothing when the target does not carry the tag.
  if ((A.effective.mounted ?? 0) > 100 && kb !== 'pikemen' && (kb === 'cavaliers' || kb === 'pegasus') && !B.tags.includes('mounted')) v = Math.min(v, 1);
  if ((A.effective.large ?? 0) > 100 && !B.tags.includes('large')) v = Math.min(v, 1);
  // ...and a tag bonus the table does not know about is worth something.
  if ((A.effective.mounted ?? 0) > 100 && B.tags.includes('mounted') && B.range <= 400 && v < 2) v = 2; // melee riders only: mounted bowmen shoot the spearmen down
  // Armour and resistance as they really are: steel against heavy armour (or ethereal riders) is poor, magic against
  // an ethereal or unwarded target is good, magic against a warded one is poor.
  const magic = A.damageType === 'magic' || A.traits.includes('ignoresArmor');
  if (!magic && B.armor >= 45 && !A.traits.includes('crushing')) v -= 1;
  if (magic && B.magicResist < 0) v += 1.5;
  if (magic && B.armor >= 45) v += 0.5;
  if (A.damageType === 'magic' && B.magicResist >= 40) v -= 1;
  // Ground melee cannot touch a flier at all.
  if (B.tags.includes('flier') && A.range <= 400 && !A.tags.includes('flier') && !A.traits.includes('howdah')) v = 0;
  return v < 0 ? 0 : v;
}

/** Units that hold a line on the ground. Fliers are not a frontline: ground troops walk under them to the archers. */
/**
 * Faction-aware composition for the classic planner (Normal and the tournament strategies): how much it wants a unit
 * beyond what the counter table says. The Caliphate wins in these bots' hands with its casters, its sword line and
 * its Djinn, not with a mass of Spear Levy and unsupported Mamluks (which need Hard's flanking to pay off).
 */
const CLASSIC_PREF: Partial<Record<UnitType, number>> = {
  djinn_binder: 1.35, scimitar: 1.25, djinn: 1.2, spear_levy: 0.8, mamluk: 0.85,
  // The Covenant: fewer Skeleton Spearmen (splash fodder), more of what stands up to it.
  skeleton: 0.7, grave_knight: 1.0, bone_archer: 1.3, wraith_rider: 1.0, bone_drake: 1.3,
};

const FRONT: ReadonlySet<UnitType> = new Set(['militia', 'pikemen', 'berserkers', 'knights', 'cavaliers', 'golem']);

/** sqrt by Newton iteration (src/sim avoids Math.sqrt so the grep test stays strict; bots only use it for weights). */
function fsqrt(x: number): number {
  if (x <= 0) return 0;
  let r = x > 1 ? x : 1;
  for (let i = 0; i < 30; i++) r = 0.5 * (r + x / r);
  return r;
}

function rnd01(...parts: (string | number)[]): number {
  return (hash(...parts) % 10000) / 10000;
}

/** How much more the classic planner wants casters under the Archmage (her passive multiplies their damage). */
const ARCHMAGE_CASTERS = 1.15;

function unitScore(s: MatchState, seat: Seat, strat: BotStrategy, u: UnitType, salt: number, mine: Squad[], enemy: Squad[] | null): number {
  const def = UNITS[u];
  // Counter score vs the enemy's last army (only public information).
  let counter = 1;
  if (enemy && enemy.length) {
    let num = 0, den = 0;
    for (const e of enemy) {
      if (e.type === 'lord') continue;
      const val = UNITS[e.type].cost * e.level;
      num += val * (cvReal(u, e.type) - 0.7 * cvReal(e.type, u));
      den += val;
    }
    counter = Math.max(0.2, 1.2 + (2 * num) / Math.max(1, den));
  }
  let w: number;
  if (strat === 'random') w = (1 + 2 * rnd01(s.seed, s.round, seat, u, salt, 'r')) * fsqrt(counter);
  else if (strat === 'counter' || strat === 'normal' || strat === 'best' || strat === 'hard') w = counter;
  // Flavoured strategies still counter-pick a little ("random-but-sensible").
  else w = (PREF[strat as Flavour][K(u)] ?? 0.5) * fsqrt(counter);
  // Sensible play for every strategy: answer enemy fliers with anti-air, and answer enemy cavalry with pikes.
  if (enemy && enemy.length) {
    let air = 0, mounted = 0, all = 0, bigAir = 0;
    for (const e of enemy) {
      if (e.type === 'lord') continue;
      const d = UNITS[e.type], val = d.cost * e.level;
      all += val;
      if (d.tags.includes('flier') && d.tags.includes('large')) bigAir += val;
      if (d.tags.includes('flier')) air += val;
      else if (d.tags.includes('mounted')) mounted += val;
    }
    const fa = air / Math.max(1, all), fm = mounted / Math.max(1, all);
    // Anti-air is ranged fire, or a Large flier of one's own. A small flier is no answer (Pegasus and Djinn cannot
    // trade with a Wyvern), and buying one invites the enemy's archers: the Caliphate used to answer every Wyvern
    // with Djinn and lose them to a wall of Archers, while its Camel Archers stayed home.
    const antiAir = def.range > 400 && def.weapon !== 'stone' && !def.traits.includes('healer') || def.tags.includes('flier') && def.tags.includes('large');
    // (From 5% of the enemy's value in the air: a single Dragon is reason enough to keep an answer.)
    if (fa > 0.05) w *= antiAir ? 1 + 2.5 * fa + 0.15 : 1 - 0.5 * fa;
    // A Dragon, Wyvern or Bone Drake overhead: bolt-throwers (bonus against Large) and Large fliers of one's own are the answer.
    if (bigAir > 0) {
      const fb = bigAir / Math.max(1, all);
      if ((def.effective.large ?? 0) > 100) w *= 1.3 + 4 * fb;
      else if (def.tags.includes('flier') && def.tags.includes('large')) w *= 1.15 + fb;
    }
    if (fm > 0.15 && K(u) === 'pikemen') w *= 1 + 3 * fm;
  }
  // Keep a frontline: at least ~half the squads must be front units.
  const front = mine.filter((q) => q.type !== 'lord' && FRONT.has(K(q.type as UnitType))).length;
  const total = mine.filter((q) => q.type !== 'lord').length;
  if (FRONT.has(K(u)) && front < Math.ceil((total + 1) / 2)) w *= 1.8;
  if (!FRONT.has(K(u)) && front < Math.ceil((total + 1) / 2)) w *= 0.6;
  if (K(u) === 'clerics' && mine.filter((q) => KT(q.type) === 'clerics').length >= 1) w *= 0.25;
  // A healer is worth something only once there is an army to heal: none in the first few squads.
  if (K(u) === 'clerics' && total < 3) w *= 0.5;
  // Diminishing returns on stacking one type.
  const same = mine.filter((q) => q.type === u).length;
  w /= 1 + 0.25 * same;
  // Signature units of your Lord are cheaper to love.
  const lord = s.players[seat].lord;
  if (lord && LORDS[lord].signature.includes(u)) w *= 1.25;
  // Play to the Lord's passive: the Archmage's magic bonus makes her casters worth far more than anyone else's.
  if (lord === 'archmage' && def.damageType === 'magic' && !def.traits.includes('healer')) w *= ARCHMAGE_CASTERS;
  // What the classic planner has learnt about a roster that the Kingdom counter table does not say (CLASSIC_PREF).
  w *= CLASSIC_PREF[u] ?? 1;
  w *= 0.9 + 0.2 * rnd01(s.seed, s.round, seat, u, salt, 'j');
  return w;
}

// ---------------------------------------------------------------- shared helpers

/** Does Hard read the counter table corrected by real unit mechanics (cvReal)? 'hardx' is always the opposite. */
const HARD_USES_REAL = true;
let hardCv: (a: UnitType, b: UnitType) => number = cv;

type Level = 'easy' | 'normal' | 'hard' | 'classic';
/** Which planner a strategy uses: the three vs-AI levels, or the classic tournament planner (flavours, random, counter). */
function levelOf(strat: BotStrategy): Level {
  if (strat === 'easy') return 'easy';
  if (strat === 'normal') return 'normal';
  if (strat === 'hard' || strat === 'best' || strat === 'hardx') return 'hard';
  return 'classic';
}

/** Seat-local frame: the bot's own deploy zone is low y and the enemy is at high y (seat 1 works mirrored). */
const own = (seat: Seat, p: Vec2): Vec2 => (seat === 0 ? [p[0], p[1]] : mirrorPos(p));

const units = (sq: readonly Squad[]): Squad[] => sq.filter((q) => q.type !== 'lord');
const valueOf = (q: Squad): number => (q.type === 'lord' ? 450 : UNITS[q.type].cost * (1 + 0.5 * (q.level - 1)));

/** Deterministic slot for a new squad by its role, in seat 0 coordinates: lanes across the field in deploy order, rows by role. */
function placeFor(u: UnitType | 'lord', squads: readonly Squad[], lord: LordId | null): Vec2 {
  const k = squads.filter((q) => q.type !== 'lord').length;
  const lanes = [3999, 2600, 5400, 1300, 6700, 3300, 4700, 2000, 6000];
  const x = lanes[k % lanes.length];
  if (u === 'lord') return lord && LORDS[lord].range > 400 ? [3999, 1500] : [3999, 2600];
  const def = UNITS[u], ku = K(u);
  let y: number;
  if (ku === 'trebuchet') y = 700;
  else if (ku === 'ballista' || ku === 'clerics') y = 1500;
  else if (def.range > 400) y = 2100;
  else if (ku === 'cavaliers' || ku === 'pegasus' || ku === 'wyvern') y = 2900;
  else y = 3500;
  const row = Math.floor(k / lanes.length);
  return [x, Math.max(400, y - row * 600)];
}

/**
 * Normal's weaker version of Hard's speed stagger (speedStagger): a melee squad is set back by its march speed
 * against a fixed reference (a Knight's pace), half-way from its lane's row, so slow squads stand in front and fast
 * ones further back. Normal never re-forms, so this happens once, when the squad is deployed.
 */
const NORMAL_STAGGER_REF = 11;
const NORMAL_STAGGER_PCT = 50;
function normalDepth(u: UnitType, want: Vec2): Vec2 {
  const d = UNITS[u];
  if (d.range > 400) return want;
  const synced = 6000 - Math.round((2500 * d.speed) / NORMAL_STAGGER_REF);
  const y = Math.round((want[1] * (100 - NORMAL_STAGGER_PCT) + Math.max(400, Math.min(3500, synced)) * NORMAL_STAGGER_PCT) / 100);
  return [want[0], Math.max(400, Math.min(3500, y))];
}

/** Deploy `u` as near `want` (seat 0 frame) as the footprint rule allows. */
function deployNear(s: MatchState, seat: Seat, u: UnitType, want: Vec2): boolean {
  const p = s.players[seat];
  const spot = freeSpotNear(p.squads, seat, u, seat === 0 ? want : mirrorPos(want));
  return !!spot && applyIntent(s, seat, { t: 'deploy', unit: u, pos: spot }).ok;
}

/**
 * How much the classic planner values the Warden's hero when choosing who wears an item (percent of his squad value).
 * His hero outlasts nearly every Normal army; with the full value he wore the best of everything and read 60% at
 * Normal (50% at Hard). Spreading his gear over his squads is what a sensible Warden player does (see BALANCE.md).
 */
const WARDEN_GEAR = 25;
function bestSquadFor(item: Item, squads: Squad[], lord: LordId | null): Squad | null {
  let best: Squad | null = null, bestV = -1;
  for (const q of squads) {
    if (q.type !== 'lord' && q.level < SLOT_UNLOCK_LEVEL[item.slot]) continue;
    // Skill items only go on a squad of the right class.
    if (!canEquip(item, q.type, lord)) continue;
    const cur = q.items[item.slot];
    if (cur && itemPower(cur) >= itemPower(item)) continue;
    // The Warden's hero already outlasts most armies it meets: he shares more of his gear with the squads around him.
    const value = q.type === 'lord' && lord === 'warden' ? WARDEN_GEAR * valueOf(q) / 100 : valueOf(q);
    const v = value - (cur ? itemPower(cur) * 5 : 0);
    if (v > bestV) { bestV = v; best = q; }
  }
  return best;
}

function pickDrafts(s: MatchState, seat: Seat, choose: (opts: UnitType[]) => UnitType): void {
  for (let guard = 0; guard < 4 && s.players[seat].draftPicks > 0 && s.players[seat].draftOptions.length; guard++) {
    if (!applyIntent(s, seat, { t: 'draft', unit: choose(s.players[seat].draftOptions) }).ok) break;
  }
}

const canDeploy = (p: PlayerState): boolean => p.deploysUsed < p.deployLimit && units(p.squads).length < ARMY_CAP;

// ---------------------------------------------------------------- easy

function planEasy(s: MatchState, seat: Seat, salt: number): void {
  const p = s.players[seat];
  const r = (...k: (string | number)[]): number => rnd01(s.seed, s.round, seat, salt, 'easy', ...k);
  pickDrafts(s, seat, (opts) => opts[Math.floor(r('draft', opts.length) * opts.length)]);
  if (p.lootOffer) applyIntent(s, seat, { t: 'pickLoot', index: Math.floor(r('loot') * p.lootOffer.length) });
  // Under-spends: only ~65% of the purse this round.
  let budget = Math.floor(p.gold * (0.6 + 0.1 * r('budget')));
  for (let k = 0; k < 6 && canDeploy(p); k++) {
    const opts = p.unlocked.filter((u) => UNITS[u].cost <= Math.min(budget, p.gold));
    if (!opts.length) break;
    const u = opts[Math.floor(r('unit', k) * opts.length)];
    // Naive placement: one row across the middle of the zone, whatever the unit.
    const n = units(p.squads).length;
    if (!deployNear(s, seat, u, [1000 + ((n * 900) % 6000), 2800])) break;
    budget -= UNITS[u].cost;
  }
  // Rarely levels up: one random squad, one round in four.
  if (r('lvl') < 0.25) {
    const cands = units(p.squads).filter((q) => q.level < 5 && levelUpCost(q.type as UnitType, q.level) <= Math.min(budget, p.gold));
    if (cands.length) applyIntent(s, seat, { t: 'levelUp', squad: cands[Math.floor(r('lvlq') * cands.length)].id });
  }
  // Random equips: each stash item onto a random squad with that slot free (sometimes not at all).
  for (const it of [...p.stash]) {
    if (r('eq', it.id) < 0.3) continue;
    const free = p.squads.filter((q) => slotOpen(q, it.slot) && !q.items[it.slot]);
    if (free.length) applyIntent(s, seat, { t: 'equip', item: it.id, squad: free[Math.floor(r('eqq', it.id) * free.length)].id });
  }
  applyIntent(s, seat, { t: 'ready' });
}

// ---------------------------------------------------------------- normal + the classic tournament planner

/** Normal's version of HARD_LEVEL_BIAS (see planClassic). */
const NORMAL_LEVEL_BIAS = 0.4;

function planClassic(s: MatchState, seat: Seat, strat: BotStrategy, salt: number, reserveFrac: number): void {
  const v = viewFor(s, seat);
  const enemy = v.enemy.lastArmy;
  const p = s.players[seat];
  // (Tried and rejected: letting Normal choose units with Hard's scoring, and wing lanes for cavalry. Both swung the
  // Normal-vs-Normal faction pairings by 20-40 points; see docs/BALANCE.md.)
  const score = (u: UnitType, sl: number): number => unitScore(s, seat, strat, u, sl, p.squads, enemy);
  // 1. Drafts.
  pickDrafts(s, seat, (opts) => {
    let best = opts[0], bw = -1;
    for (const u of opts) { const w = score(u, salt + 7); if (w > bw) { bw = w; best = u; } }
    return best;
  });
  // 2. Loot: take the strongest item.
  if (p.lootOffer) {
    let bi = 0, bp = -1;
    // A skill item nobody in the army could ever use is worth nothing.
    p.lootOffer.forEach((it, i) => { const pw = p.squads.some((q) => canEquip(it, q.type, p.lord)) ? itemPower(it) : 0; if (pw > bp) { bp = pw; bi = i; } });
    applyIntent(s, seat, { t: 'pickLoot', index: bi });
  }
  // The Marshal's passive is an extra deployment a round; a full reserve left him a squad short (45% at Normal).
  const reserve = Math.floor(p.gold * (p.lord === 'marshal' ? reserveFrac / 2 : reserveFrac));
  // 3. Spend: deploy up to the limit, then level up. Normal also weighs a level-up against each deployment, like
  //    Hard but by its own unit scores: a squad that counters the enemy well is worth levelling over a weak buy.
  const levelBias = strat === 'normal' ? NORMAL_LEVEL_BIAS : 0;
  for (let guard = 0; guard < 16 && canDeploy(p); guard++) {
    let best: UnitType | null = null, bw = -1;
    for (const u of p.unlocked) {
      // The reserve holds for deployments as for level-ups (it used to spare a Lord with more deployments, the Marshal).
      if (UNITS[u].cost > p.gold - reserve) continue;
      const w = score(u, salt);
      if (w > bw) { bw = w; best = u; }
    }
    if (!best) break;
    if (levelBias > 0) {
      let lq: Squad | null = null, lw = -1;
      for (const q of units(p.squads)) {
        if (q.level >= MAX_SQUAD_LEVEL || levelUpCost(q.type as UnitType, q.level) > p.gold - reserve) continue;
        const w = unitScore(s, seat, strat, q.type as UnitType, salt + 3, p.squads.filter((o) => o !== q), enemy) / (1 + 0.25 * (q.level - 1));
        if (w > lw) { lw = w; lq = q; }
      }
      if (lq && lw * levelBias > bw) { if (!applyIntent(s, seat, { t: 'levelUp', squad: lq.id }).ok) break; continue; }
    }
    const at = placeFor(best, p.squads, p.lord);
    if (!deployNear(s, seat, best, strat === 'normal' ? normalDepth(best, at) : at)) break;
  }
  // Level-ups: cheapest relative upgrade first (lowest level, then higher cost tier).
  for (let guard = 0; guard < 40; guard++) {
    let best: Squad | null = null, bestScore = Infinity;
    for (const q of p.squads) {
      if (q.type === 'lord' || q.level >= 5) continue;
      const cost = levelUpCost(q.type, q.level);
      if (cost > p.gold - reserve) continue;
      const score = q.level * 10 - UNITS[q.type].cost / 100 + (q.level === 1 || q.level === 3 ? -3 : 0);
      if (score < bestScore) { bestScore = score; best = q; }
    }
    if (!best) break;
    applyIntent(s, seat, { t: 'levelUp', squad: best.id });
  }
  // 4. Equip everything in the stash where it helps most.
  for (const it of [...p.stash]) {
    const q = bestSquadFor(it, p.squads, p.lord);
    if (q) applyIntent(s, seat, { t: 'equip', item: it.id, squad: q.id });
  }
  // 4b. Anti-air where the air is: when the enemy flew last round, archer-type squads (Archers, Bone Archers, Camel
  //     Archers) move under where its fliers were, as Hard's formation does. The rest of the army keeps its lanes:
  //     re-forming it all like Hard, or sending the cavalry to a flank, swung the faction pairings by 10-25 points.
  antiAirPlacement(s, seat, threatsOf(seat, enemy, v.enemy.lord));
  // 5. Lord placement.
  const lord = p.squads.find((q) => q.type === 'lord');
  if (lord && s.round === 1) {
    const spot = freeSpotNear(p.squads, seat, 'lord', seat === 0 ? placeFor('lord', p.squads, p.lord) : mirrorPos(placeFor('lord', p.squads, p.lord)), lord.id);
    if (spot) applyIntent(s, seat, { t: 'move', squad: lord.id, pos: spot });
  }
  applyIntent(s, seat, { t: 'ready' });
}

// ---------------------------------------------------------------- hard

/** What the enemy fielded last round, in this bot's frame. */
interface Threat { type: UnitType | 'lord'; value: number; x: number; y: number; tags: Tag[]; magic: boolean; ranged: boolean; backline: boolean }

function threatsOf(seat: Seat, enemy: Squad[] | null, enemyLord: LordId | null): Threat[] {
  if (!enemy) return [];
  return enemy.map((q) => {
    const [x, y] = own(seat, q.pos);
    if (q.type === 'lord') {
      const L = LORDS[enemyLord ?? 'marshal'];
      return { type: 'lord', value: valueOf(q), x, y, tags: L.tags, magic: L.damageType === 'magic', ranged: L.range > 400, backline: L.range > 400 };
    }
    const d = UNITS[q.type];
    return { type: q.type, value: valueOf(q), x, y, tags: d.tags, magic: d.damageType === 'magic', ranged: d.range > 400, backline: d.traits.includes('backline') };
  });
}

/**
 * Hard's unit choice: counter value against the part of the enemy army that its own army does not already answer,
 * plus the sensible-play rules (anti-air, frontline, no clerics stacking). Only public information.
 */
function hardUnitScore(s: MatchState, seat: Seat, u: UnitType, mine: Squad[], threats: Threat[], salt: number): number {
  const def = UNITS[u];
  let w = 1.2;
  if (threats.length) {
    let num = 0, den = 0;
    for (const e of threats) {
      if (e.type === 'lord') continue;
      let cover = 0;
      for (const m of units(mine)) cover += hardCv(m.type as UnitType, e.type) * valueOf(m);
      const weight = e.value / (1 + cover / Math.max(1, e.value));
      num += weight * (hardCv(u, e.type) - 0.7 * hardCv(e.type, u));
      den += weight;
    }
    w = Math.max(0.15, 1.2 + (2.2 * num) / Math.max(1, den));
    let air = 0, all = 0;
    for (const e of threats) { all += e.value; if (e.tags.includes('flier')) air += e.value; }
    const fa = air / Math.max(1, all);
    const antiAir = (def.range > 400 && def.weapon !== 'stone' && !def.traits.includes('healer')) || def.tags.includes('flier');
    let mineAir = 0;
    for (const m of units(mine)) { const d = UNITS[m.type as UnitType]; if ((d.range > 400 && d.weapon !== 'stone') || d.tags.includes('flier')) mineAir += valueOf(m); }
    const airCover = mineAir / Math.max(1, air);
    if (fa > 0.1) w *= antiAir ? 1 + (2.5 * fa) / (1 + airCover) : 1 - 0.4 * fa;
  }
  const front = units(mine).filter((q) => FRONT.has(K(q.type as UnitType))).length;
  const total = units(mine).length;
  if (FRONT.has(K(u)) && front < Math.ceil((total + 1) / 2)) w *= 1.8;
  if (!FRONT.has(K(u)) && front < Math.ceil((total + 1) / 2)) w *= 0.6;
  if (K(u) === 'clerics' && mine.filter((q) => KT(q.type) === 'clerics').length >= 1) w *= 0.25;
  w /= 1 + 0.3 * mine.filter((q) => q.type === u).length;
  const lord = s.players[seat].lord;
  if (lord && LORDS[lord].signature.includes(u)) w *= 1.2;
  // Play to the Lord's passive: the Archmage's magic bonus makes her casters worth far more than anyone else's.
  if (lord === 'archmage' && def.damageType === 'magic' && !def.traits.includes('healer')) w *= 1.5;
  // Spending gold well: prefer the stronger buy when two are close (bigger units are better per deploy slot).
  w *= 0.6 + 0.4 * (def.cost / 200);
  w *= 0.95 + 0.1 * rnd01(s.seed, s.round, seat, u, salt, 'hj');
  return w;
}

type Role = 'front' | 'flank' | 'ranged' | 'support' | 'artillery';
function roleOf(t: SquadType, lord: LordId | null): Role {
  if (t === 'lord') return lord === 'skylady' ? 'flank' : lord && LORDS[lord].range > 400 ? 'ranged' : 'support';
  const k = K(t);
  if (k === 'trebuchet') return 'artillery';
  if (k === 'clerics') return 'support';
  if (k === 'cavaliers' || k === 'pegasus' || k === 'wyvern' || k === 'dragon') return 'flank';
  return UNITS[t].range > 400 ? 'ranged' : 'front';
}

/** Value-weighted mean x of the threats `pred` selects, or `def` if none. */
function meanX(threats: Threat[], pred: (e: Threat) => number, def: number): number {
  let n = 0, d = 0;
  for (const e of threats) { const w = pred(e) * e.value; n += w * e.x; d += w; }
  return d > 0 ? n / d : def;
}

/**
 * Hard's formation for the whole army (seat 0 frame), placed against the enemy's last-round formation:
 * every squad lines up opposite the enemy squads it counters, raiders go to the flank holding the enemy backline
 * (and fewer enemy pikes), archers sit under enemy fliers, artillery behind the enemy's mass.
 */
function hardLayout(p: PlayerState, threats: Threat[]): Map<number, Vec2> {
  const z = deployZone(0);
  const centre = meanX(threats, () => 1, 3999);
  // Flank choice: enemy backline value minus pike danger, per side of the field.
  let left = 0, right = 0;
  for (const e of threats) {
    const ek = KT(e.type);
    const w = (e.backline ? e.value : 0) - (ek === 'pikemen' ? 1.5 * e.value : 0) - (e.ranged && ek === 'archers' ? 0.3 * e.value : 0);
    if (e.x < 3999) left += w; else right += w;
  }
  // A tie goes to the same side in the bot's own frame for both seats, so the two plans are exact mirror images.
  const flankX = left > right ? 1100 : left < right ? 6900 : 1100;
  const rows: Record<Role, { q: Squad; want: number }[]> = { front: [], flank: [], ranged: [], support: [], artillery: [] };
  for (const q of p.squads) {
    const role = roleOf(q.type, p.lord);
    let want = centre;
    if (q.type !== 'lord') {
      const u = q.type as UnitType;
      if (role === 'flank') want = flankX;
      else if (K(u) === 'archers') want = meanX(threats, (e) => (e.tags.includes('flier') ? 3 : 0) + (e.type !== 'lord' && cv(u, e.type) > 0 ? 1 : 0), centre);
      else if (role !== 'support') want = meanX(threats, (e) => (e.type !== 'lord' ? Math.max(0, cv(u, e.type)) : 0), centre);
    } else if (role === 'flank') want = flankX;
    rows[role].push({ q, want });
  }
  // Support (Lord, clerics) stands behind the bulk of the frontline.
  const frontX = rows.front.length ? rows.front.reduce((a, r) => a + r.want, 0) / rows.front.length : centre;
  for (const r of rows.support) r.want = frontX;
  const out = new Map<number, Vec2>();
  const pack = (list: { q: Squad; want: number }[], y: number, spread: boolean): void => {
    if (!list.length) return;
    list.sort((a, b) => a.want - b.want || a.q.id - b.q.id);
    const gap = 60;
    const rad = list.map((r) => squadFootprint(r.q.type));
    const xs = list.map((r) => Math.round(r.want));
    // Spread a row around its wanted spots: sweep right, then pull back inside the zone.
    for (let i = 0; i < xs.length; i++) {
      const lo = i ? xs[i - 1] + rad[i - 1] + rad[i] + gap : z.x0 + rad[i];
      xs[i] = Math.max(xs[i], lo);
    }
    for (let i = xs.length - 1; i >= 0; i--) {
      const hi = i < xs.length - 1 ? xs[i + 1] - rad[i + 1] - rad[i] - gap : z.x1 - rad[i];
      xs[i] = Math.min(xs[i], hi);
    }
    for (let i = 0; i < xs.length; i++) {
      xs[i] = Math.max(z.x0, Math.min(z.x1, xs[i]));
      // Flank rows: stagger vertically so raiders of one flank do not queue in a line.
      const dy = spread ? (i % 2) * 450 : 0;
      out.set(list[i].q.id, [xs[i], y - dy]);
    }
  };
  pack(rows.front, 3650, false);
  pack(rows.flank, 3100, true);
  pack(rows.support, 2500, false);
  pack(rows.ranged, 1850, false);
  pack(rows.artillery, 800, false);
  if (HARD_SPEED_SYNC) speedStagger(p, out, 3650);
  return out;
}

/**
 * Timing by depth (Mechabellum's "timing of engagement"): melee squads are staggered by march speed so they reach
 * the river together. The slowest stands at `frontY`; a squad twice as fast starts twice as far from the river line.
 * Without it the tanks (Golems, Knights) reach the fight 5-9 s after the cheap infantry in front of them has
 * already taken the first blows (docs/reviews/POSITIONING-AND-ECONOMY.md section 1).
 */
function speedStagger(p: PlayerState, out: Map<number, Vec2>, frontY: number): void {
  const z = deployZone(0);
  const melee = units(p.squads).filter((q) => UNITS[q.type as UnitType].range <= 400 && out.has(q.id));
  if (melee.length < 2) return;
  const LINE = 6000; // the middle of the river
  let vmin = Infinity;
  for (const q of melee) vmin = Math.min(vmin, UNITS[q.type as UnitType].speed);
  for (const q of melee) {
    const v = UNITS[q.type as UnitType].speed;
    const y = LINE - Math.round(((LINE - frontY) * v) / vmin);
    const [x] = out.get(q.id)!;
    out.set(q.id, [x, Math.max(z.y0 + squadFootprint(q.type), Math.min(frontY, y))]);
  }
}

/** Hard staggers its melee by speed (switchable for the review scripts). */
const HARD_SPEED_SYNC = true;

/** Move every squad to its layout spot (seat 0 frame), resolving the order so squads never overlap on the way. */
function applyLayout(s: MatchState, seat: Seat, layout: Map<number, Vec2>): void {
  const p = s.players[seat];
  let todo = p.squads.filter((q) => layout.has(q.id));
  for (let pass = 0; pass < 4 && todo.length; pass++) {
    const next: Squad[] = [];
    for (const q of todo) {
      const w = layout.get(q.id)!;
      const pos: Vec2 = seat === 0 ? w : mirrorPos(w);
      if (q.pos[0] === pos[0] && q.pos[1] === pos[1]) continue;
      if (!applyIntent(s, seat, { t: 'move', squad: q.id, pos }).ok) next.push(q);
    }
    if (next.length === todo.length) { todo = next; break; }
    todo = next;
  }
  for (const q of todo) {
    const w = layout.get(q.id)!;
    const spot = freeSpotNear(p.squads, seat, q.type, seat === 0 ? w : mirrorPos(w), q.id);
    if (spot) applyIntent(s, seat, { t: 'move', squad: q.id, pos: spot });
  }
}

/** Normal's anti-air placement: Hard's formation, applied to the archer-type squads only, when the enemy flew last round. */
function antiAirPlacement(s: MatchState, seat: Seat, all: Threat[]): void {
  // Flier squads only: a flying Lord (the Skylady) is one rider, and archers parked under her strip her army's flank.
  const threats = all.filter((e) => e.type !== 'lord');
  if (!threats.some((e) => e.tags.includes('flier'))) return;
  const p = s.players[seat];
  const layout = hardLayout(p, threats);
  for (const q of p.squads) if (q.type === 'lord' || K(q.type) !== 'archers') layout.delete(q.id);
  applyLayout(s, seat, layout);
}

const MELEE_DPS: ReadonlySet<SquadType> = new Set(['berserkers', 'cavaliers', 'militia', 'wyvern', 'knights', 'pikemen', 'pegasus', 'golem']);
const MANY = (t: SquadType): number => (t === 'lord' ? 1 : UNITS[t].squadSize);

/**
 * How much `item` is worth on squad `q` (higher is better): its affixes and legendary power weighed by what the
 * squad does (no range on melee, toughness on the frontline, slaying against what the enemy fields...).
 */
function itemFit(item: Item, q: Squad, threats: Threat[], lord: LordId | null): number {
  const t = q.type;
  if (!canEquip(item, t, lord)) return -1;
  const role = roleOf(t, lord);
  const ranged = t === 'lord' ? LORDS[lord ?? 'marshal'].range > 400 : UNITS[t].range > 400;
  const k = KT(t);
  const healer = k === 'clerics';
  const tough = role === 'front' || k === 'lord' || k === 'golem' || k === 'dragon' || k === 'wyvern';
  let total = 0, magic = 0, ranged_ = 0;
  const tagShare: Partial<Record<Tag, number>> = {};
  for (const e of threats) {
    total += e.value;
    if (e.magic) magic += e.value;
    if (e.ranged) ranged_ += e.value;
    for (const g of e.tags) tagShare[g] = (tagShare[g] ?? 0) + e.value;
  }
  const share = (x: number): number => (total > 0 ? x / total : 0.25);
  let fit = 0;
  for (const a of [item.implicit, ...item.affixes]) {
    const base = a.value * AFFIXES[a.id].power;
    let m = 1;
    switch (a.id) {
      case 'vicious': case 'keen': case 'haste': m = healer ? 0.5 : 1.1; break;
      case 'leech': m = MELEE_DPS.has(k) ? 1.4 : ranged ? 0.6 : 0.8; break;
      case 'farreach': m = ranged ? 1.3 : 0; break;
      case 'stalwart': m = tough ? 1.3 : 0.6; break;
      case 'plated': m = tough ? 1.3 * (1 - share(magic)) + 0.1 : 0.4; break;
      case 'warding': m = 0.4 + 2.5 * share(magic); break;
      case 'thorns': m = role === 'front' ? 1.3 : 0.2; break;
      case 'fleet': m = role === 'flank' || role === 'front' ? 1.2 : 0.4; break;
      case 'slaying': m = 0.3 + 3 * share(a.tag ? tagShare[a.tag] ?? 0 : 0); break;
      case 'embers': case 'frost': m = MANY(t) >= 4 ? 1.2 : 0.7; break;
      case 'phoenix': m = MANY(t) <= 2 ? 2 : MANY(t) <= 4 ? 1.2 : 0.5; break;
      case 'command': m = 1; break;
    }
    fit += base * m;
  }
  if (item.legendary) {
    const L = item.legendary, n = MANY(t);
    let m = 1;
    switch (L) {
      case 'stormcaller': case 'hydra_volley': m = n >= 4 ? 1.6 : 0.6; if (L === 'hydra_volley' && ranged) m *= 1.3; break;
      case 'kingsbane': m = 0.4 + 3 * share((tagShare.large ?? 0) + threats.filter((e) => e.type === 'lord').reduce((a, e) => a + e.value, 0)); break;
      case 'undying_oath': case 'ember_crown': case 'gravebloom': m = n >= 6 ? 1.8 : n >= 3 ? 1 : 0.6; break;
      case 'mirror_aegis': m = (tough ? 1 : 0.5) * (0.3 + 2.5 * share(ranged_)); break;
      case 'warhorn': m = n >= 6 ? 1.8 : n <= 2 ? 1.4 : 0.8; break;
      case 'bloodthirst': case 'earthshaker': case 'windrunner': m = MELEE_DPS.has(k) ? 1.5 : 0.4; break;
      case 'sunfire': m = role === 'front' ? 1.5 : 0.3; break;
      case 'lifebinder': m = tough ? 1.5 : 0.6; break;
      case 'frostheart': m = 1.1; break;
    }
    fit += 14 * m * 1.5;
  }
  if (item.skill) {
    // Active skills: worth more where their trigger will hold often and their effect scales with the squad.
    const n = MANY(t);
    const fast = share((tagShare.mounted ?? 0) + (tagShare.flier ?? 0));
    const foot = share(tagShare.infantry ?? 0);
    let m = 1;
    switch (item.skill) {
      case 'fireball': case 'rain_of_arrows': case 'incendiary_payload': m = 0.7 + 0.9 * foot; break;
      case 'chain_lightning': m = 1.1; break;
      case 'frost_nova': m = 0.5 + 2 * fast; break;
      case 'mending_light': m = k === 'clerics' ? 1.3 : 1; break;
      case 'shield_wall': m = tough ? 1.3 : 0.8; break;
      case 'war_cry': m = role === 'front' || t === 'lord' ? 1.2 : 0.7; break;
      case 'cleave': m = n >= 4 ? 1.4 : 0.9; break;
      case 'fire_arrows': m = 1.2; break;
      case 'pinning_shot': m = 0.7 + 1.5 * fast; break;
      case 'thunderous_charge': case 'dive_strike': m = 1.3; break;
      case 'trample': m = 0.8 + 0.8 * foot; break;
    }
    fit += SKILLS[item.skill].power * m * 1.5;
  }
  // Squads that matter more get the better gear.
  return fit * (valueOf(q) / 200);
}

/** Item-aware gearing: every item (stash and equipped) is re-assigned greedily to the squad it fits best. */
function hardEquip(s: MatchState, seat: Seat, threats: Threat[]): void {
  const p = s.players[seat];
  const items: Item[] = [...p.stash];
  for (const q of p.squads) for (const sl of ['weapon', 'armor', 'relic'] as Slot[]) if (q.items[sl]) items.push(q.items[sl]!);
  const cands: { it: Item; q: Squad; fit: number }[] = [];
  for (const it of items) for (const q of p.squads) if (slotOpen(q, it.slot) && canEquip(it, q.type, p.lord)) cands.push({ it, q, fit: itemFit(it, q, threats, p.lord) });
  cands.sort((a, b) => b.fit - a.fit || a.it.id - b.it.id || a.q.id - b.q.id);
  const used = new Set<number>(), taken = new Set<string>();
  const want = new Map<number, Squad>();
  for (const c of cands) {
    const key = `${c.q.id}:${c.it.slot}`;
    if (used.has(c.it.id) || taken.has(key)) continue;
    used.add(c.it.id); taken.add(key); want.set(c.it.id, c.q);
  }
  // Clear misplaced items first, then equip; whatever is left over waits in the stash.
  for (const q of p.squads) {
    for (const sl of ['weapon', 'armor', 'relic'] as Slot[]) {
      const it = q.items[sl];
      if (it && want.get(it.id) !== q) applyIntent(s, seat, { t: 'unequip', item: it.id });
    }
  }
  const slotOf = new Map(items.map((i) => [i.id, i.slot]));
  for (const [id, q] of want) if (q.items[slotOf.get(id)!]?.id !== id) applyIntent(s, seat, { t: 'equip', item: id, squad: q.id });
}

/**
 * How much Hard prefers levelling a squad over a new squad of equal counter value. Levels cost a flat share of the
 * unit (LEVEL_COST_PCT), so they are cheaper than a new squad but add less: the bias is tuned so that Hard spends
 * roughly a quarter of its gold on levels (docs/BALANCE.md).
 */
const HARD_LEVEL_BIAS = 0.5;
/**
 * Hard levels nothing before this round. (Waiting until round 4 tested about 6 points stronger head-to-head, but it
 * moved the faction and Lord balance by up to 18 points at Hard, so it is left for a full re-tune: see BALANCE.md.)
 */
const HARD_LEVEL_FROM = 1;
/**
 * The squad Hard would level next and how much it wants it, on hardUnitScore's scale: what the squad's type is worth
 * against the enemy's last army, a little less for every level it already has (spread the levels), and more when its
 * next level opens a slot for an item waiting in the stash. Null when no level-up is affordable.
 */
function hardLevelPick(s: MatchState, seat: Seat, threats: Threat[], salt: number): { q: Squad; w: number } | null {
  const p = s.players[seat];
  let best: Squad | null = null, bw = -1;
  for (const q of units(p.squads)) {
    if (q.level >= MAX_SQUAD_LEVEL) continue;
    const u = q.type as UnitType;
    if (levelUpCost(u, q.level) > p.gold) continue;
    const others = p.squads.filter((o) => o !== q);
    let w = hardUnitScore(s, seat, u, others, threats, salt + 3) / (1 + 0.25 * (q.level - 1));
    for (const sl of ['armor', 'relic'] as Slot[]) if (q.level + 1 === SLOT_UNLOCK_LEVEL[sl] && p.stash.some((i) => i.slot === sl && canEquip(i, q.type, p.lord))) w *= 1.4;
    if (w > bw || (w === bw && best && q.id < best.id)) { bw = w; best = q; }
  }
  return best ? { q: best, w: bw } : null;
}

function planHard(s: MatchState, seat: Seat, salt: number): void {
  const v = viewFor(s, seat);
  const p = s.players[seat];
  const threats = threatsOf(seat, v.enemy.lastArmy, v.enemy.lord);
  // 1. Drafts: the unlock that best answers what the enemy fields (and what we do not already answer).
  pickDrafts(s, seat, (opts) => {
    let best = opts[0], bw = -1;
    for (const u of opts) {
      // Late-game power units are worth a pick on their own.
      const w = hardUnitScore(s, seat, u, p.squads, threats, salt + 7) * (K(u) === 'dragon' || K(u) === 'golem' ? 1.25 : 1);
      if (w > bw) { bw = w; best = u; }
    }
    return best;
  });
  // 2. Loot: the item that would fit best somewhere in the army (counting slots a level-up opens).
  if (p.lootOffer) {
    let bi = 0, bf = -1;
    p.lootOffer.forEach((it, i) => {
      let f = 0;
      for (const q of p.squads) {
        const open = slotOpen(q, it.slot) || (q.type !== 'lord' && q.level + 1 >= SLOT_UNLOCK_LEVEL[it.slot]);
        if (!open || !canEquip(it, q.type, p.lord)) continue;
        const cur = q.items[it.slot];
        f = Math.max(f, itemFit(it, q, threats, p.lord) - (cur ? itemFit(cur, q, threats, p.lord) * 0.8 : 0));
      }
      if (f > bf) { bf = f; bi = i; }
    });
    applyIntent(s, seat, { t: 'pickLoot', index: bi });
  }
  // 3. Spend, choosing each time between the best new squad and the best level-up. A level-up is worth taking over a
  //    deployment when the squad it improves counters the enemy (HARD_LEVEL_BIAS times) better than the best
  //    affordable new squad would; a squad whose next level opens a slot for an item waiting in the stash jumps the
  //    queue. When nothing more can be deployed, the gold goes into levels.
  for (let guard = 0; guard < 60; guard++) {
    let best: UnitType | null = null, bw = -1;
    if (canDeploy(p)) {
      for (const u of p.unlocked) {
        if (UNITS[u].cost > p.gold) continue;
        const w = hardUnitScore(s, seat, u, p.squads, threats, salt);
        if (w > bw) { bw = w; best = u; }
      }
    }
    const lv = s.round < HARD_LEVEL_FROM ? null : hardLevelPick(s, seat, threats, salt);
    if (best && !(lv && lv.w * HARD_LEVEL_BIAS > bw)) {
      if (deployNear(s, seat, best, placeFor(best, p.squads, p.lord))) continue;
    }
    if (!lv || !applyIntent(s, seat, { t: 'levelUp', squad: lv.q.id }).ok) break;
  }
  // 5. Gear, then 6. re-form the whole army against the enemy's last formation.
  hardEquip(s, seat, threats);
  applyLayout(s, seat, hardLayout(p, threats));
  applyIntent(s, seat, { t: 'ready' });
}

/** Play one full planning turn for `seat` (lord pick, drafts, loot, equips, deploys, level-ups, ready). */
export function botPlan(s: MatchState, seat: Seat, strategy: BotStrategy, salt = 0): void {
  if (s.phase === 'lordPick') {
    if (!s.players[seat].lord) applyIntent(s, seat, { t: 'pickLord', lord: LORD_IDS[hash(s.seed, seat, salt, 'lord') % LORD_IDS.length] });
    return;
  }
  if (s.phase !== 'planning' || s.players[seat].ready) return;
  const level = levelOf(strategy);
  if (level === 'easy') return planEasy(s, seat, salt);
  if (level === 'hard') {
    // 'hardx' is the strength-test variant: the same planner with the other counter table.
    hardCv = (strategy === 'hardx') !== HARD_USES_REAL ? cvReal : cv;
    return planHard(s, seat, salt);
  }
  return planClassic(s, seat, strategy, salt, level === 'normal' ? 0.12 : 0);
}

export type { Slot };
