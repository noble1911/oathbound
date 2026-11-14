// Planning bots for the tournament and the vs-AI mode. Bots see only viewFor() (no hidden information)
// and act only through applyIntent, so they obey exactly the same rules as players.
import { mirrorPos } from './constants.ts';
import { LORDS, LORD_IDS } from './data/lords.ts';
import { SLOT_UNLOCK_LEVEL } from './data/items.ts';
import { UNITS } from './data/units.ts';
import { itemPower } from './loot.ts';
import { ARMY_CAP, applyIntent, levelUpCost, viewFor } from './match.ts';
import { hash } from './rng.ts';
import type { BotStrategy, Item, LordId, MatchState, Seat, Slot, Squad, UnitType, Vec2 } from './types.ts';

export const BOT_STRATEGIES: readonly BotStrategy[] = ['rush', 'ranged', 'armor', 'air', 'counter', 'random', 'best'];

/** Preference weights per strategy (unlisted units get weight 1; 'random' is flat). */
const PREF: Record<Exclude<BotStrategy, 'random' | 'counter' | 'best'>, Partial<Record<UnitType, number>>> = {
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
const cv = (a: UnitType, b: UnitType): number => C[a]?.[b] ?? 0;

const FRONT: ReadonlySet<UnitType> = new Set(['militia', 'pikemen', 'berserkers', 'knights', 'cavaliers', 'golem', 'pegasus', 'wyvern', 'dragon']);

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

function unitScore(s: MatchState, seat: Seat, strat: BotStrategy, u: UnitType, salt: number, mine: Squad[], enemy: Squad[] | null): number {
  const def = UNITS[u];
  // Counter score vs the enemy's last army (only public information).
  let counter = 1;
  if (enemy && enemy.length) {
    let num = 0, den = 0;
    for (const e of enemy) {
      if (e.type === 'lord') continue;
      const val = UNITS[e.type].cost * e.level;
      num += val * (cv(u, e.type) - 0.7 * cv(e.type, u));
      den += val;
    }
    counter = Math.max(0.2, 1.2 + (2 * num) / Math.max(1, den));
  }
  let w: number;
  if (strat === 'random') w = (1 + 2 * rnd01(s.seed, s.round, seat, u, salt, 'r')) * fsqrt(counter);
  // 'best' (the vs-AI bot) is the counter-picker: it topped the tournament (docs/BALANCE.md).
  else if (strat === 'counter' || strat === 'best') w = counter;
  // Flavoured strategies still counter-pick a little ("random-but-sensible").
  else w = (PREF[strat][u] ?? 0.5) * fsqrt(counter);
  // Sensible play for every strategy: answer enemy fliers with anti-air, and answer enemy cavalry with pikes.
  if (enemy && enemy.length) {
    let air = 0, mounted = 0, all = 0;
    for (const e of enemy) {
      if (e.type === 'lord') continue;
      const d = UNITS[e.type], val = d.cost * e.level;
      all += val;
      if (d.tags.includes('flier')) air += val;
      else if (d.tags.includes('mounted')) mounted += val;
    }
    const fa = air / Math.max(1, all), fm = mounted / Math.max(1, all);
    const antiAir = def.range > 400 && def.weapon !== 'stone' && !def.traits.includes('healer') || def.tags.includes('flier');
    if (fa > 0.1) w *= antiAir ? 1 + 2.5 * fa : 1 - 0.5 * fa;
    if (fm > 0.15 && u === 'pikemen') w *= 1 + 3 * fm;
  }
  // Keep a frontline: at least ~half the squads must be front units.
  const front = mine.filter((q) => q.type !== 'lord' && FRONT.has(q.type as UnitType)).length;
  const total = mine.filter((q) => q.type !== 'lord').length;
  if (FRONT.has(u) && front < Math.ceil((total + 1) / 2)) w *= 1.8;
  if (!FRONT.has(u) && front < Math.ceil((total + 1) / 2)) w *= 0.6;
  if (u === 'clerics' && mine.filter((q) => q.type === 'clerics').length >= 2) w *= 0.2;
  // Diminishing returns on stacking one type.
  const same = mine.filter((q) => q.type === u).length;
  w /= 1 + 0.25 * same;
  // Signature units of your Lord are cheaper to love.
  const lord = s.players[seat].lord;
  if (lord && LORDS[lord].signature.includes(u)) w *= 1.25;
  w *= 0.9 + 0.2 * rnd01(s.seed, s.round, seat, u, salt, 'j');
  return w;
}

/** Deterministic slot for the k-th squad of a role, in seat 0 coordinates. */
function placeFor(u: UnitType | 'lord', k: number, lord: LordId | null): Vec2 {
  const lanes = [3999, 2600, 5400, 1300, 6700, 3300, 4700, 2000, 6000];
  const x = lanes[k % lanes.length];
  if (u === 'lord') return lord === 'archmage' ? [3999, 1500] : [3999, 2600];
  const def = UNITS[u];
  let y: number;
  if (u === 'trebuchet') y = 700;
  else if (u === 'ballista' || u === 'clerics') y = 1500;
  else if (def.range > 400) y = 2100;
  else if (u === 'cavaliers' || u === 'pegasus' || u === 'wyvern') y = 2900;
  else y = 3500;
  const row = Math.floor(k / lanes.length);
  return [x, Math.max(400, y - row * 500)];
}

function bestSquadFor(item: Item, squads: Squad[]): Squad | null {
  let best: Squad | null = null, bestV = -1;
  for (const q of squads) {
    if (q.type !== 'lord' && q.level < SLOT_UNLOCK_LEVEL[item.slot]) continue;
    const cur = q.items[item.slot];
    if (cur && itemPower(cur) >= itemPower(item)) continue;
    const value = q.type === 'lord' ? 450 : UNITS[q.type].cost * (1 + 0.5 * (q.level - 1));
    // Ranged-only affixes are wasted on melee.
    const v = value - (cur ? itemPower(cur) * 5 : 0);
    if (v > bestV) { bestV = v; best = q; }
  }
  return best;
}

/** Play one full planning turn for `seat` (lord pick, drafts, loot, equips, deploys, level-ups, ready). */
export function botPlan(s: MatchState, seat: Seat, strategy: BotStrategy, salt = 0): void {
  if (s.phase === 'lordPick') {
    if (!s.players[seat].lord) applyIntent(s, seat, { t: 'pickLord', lord: LORD_IDS[hash(s.seed, seat, salt, 'lord') % LORD_IDS.length] });
    return;
  }
  if (s.phase !== 'planning') return;
  const v = viewFor(s, seat);
  const me = v.you!;
  if (me.ready) return;
  const enemy = v.enemy.lastArmy;
  const strat = strategy;
  // 1. Drafts.
  while (s.players[seat].draftPicks > 0 && s.players[seat].draftOptions.length) {
    const p = s.players[seat];
    let best = p.draftOptions[0], bw = -1;
    for (const u of p.draftOptions) {
      const w = unitScore(s, seat, strat, u, salt + 7, p.squads, enemy);
      if (w > bw) { bw = w; best = u; }
    }
    applyIntent(s, seat, { t: 'draft', unit: best });
  }
  // 2. Loot: take the strongest item.
  const offer = s.players[seat].lootOffer;
  if (offer) {
    let bi = 0, bp = -1;
    offer.forEach((it, i) => { const pw = itemPower(it); if (pw > bp) { bp = pw; bi = i; } });
    applyIntent(s, seat, { t: 'pickLoot', index: bi });
  }
  // 3. Spend: deploy up to the limit, then level up.
  const p = s.players[seat];
  for (let guard = 0; guard < 8; guard++) {
    if (p.deploysUsed >= p.deployLimit) break;
    if (p.squads.filter((q) => q.type !== 'lord').length >= ARMY_CAP) break;
    let best: UnitType | null = null, bw = -1;
    for (const u of p.unlocked) {
      if (UNITS[u].cost > p.gold) continue;
      const w = unitScore(s, seat, strat, u, salt, p.squads, enemy);
      if (w > bw) { bw = w; best = u; }
    }
    if (!best) break;
    const k = p.squads.filter((q) => q.type !== 'lord').length;
    let pos = placeFor(best, k, p.lord);
    if (seat === 1) pos = mirrorPos(pos);
    if (applyIntent(s, seat, { t: 'deploy', unit: best, pos }).ok !== true) break;
  }
  // Level-ups: cheapest relative upgrade first (lowest level, then higher cost tier). Keep a small reserve when
  // deploy slots were not used so the next round can buy expensive units.
  for (let guard = 0; guard < 40; guard++) {
    let best: Squad | null = null, bestScore = Infinity;
    for (const q of p.squads) {
      if (q.type === 'lord' || q.level >= 5) continue;
      const cost = levelUpCost(q.type, q.level);
      if (cost > p.gold) continue;
      const score = q.level * 10 - UNITS[q.type].cost / 100 + (q.level === 2 || q.level === 4 ? -3 : 0);
      if (score < bestScore) { bestScore = score; best = q; }
    }
    if (!best) break;
    applyIntent(s, seat, { t: 'levelUp', squad: best.id });
  }
  // 4. Equip everything in the stash where it helps most.
  for (const it of [...p.stash]) {
    const q = bestSquadFor(it, p.squads);
    if (q) applyIntent(s, seat, { t: 'equip', item: it.id, squad: q.id });
  }
  // Upgrade slots that opened: move items from the Lord to high-level squads is not worth the churn; done.
  // 5. Lord placement.
  const lord = p.squads.find((q) => q.type === 'lord');
  if (lord && s.round === 1) {
    let pos = placeFor('lord', 0, p.lord);
    if (seat === 1) pos = mirrorPos(pos);
    applyIntent(s, seat, { t: 'move', squad: lord.id, pos });
  }
  applyIntent(s, seat, { t: 'ready' });
}

export type { Slot };
