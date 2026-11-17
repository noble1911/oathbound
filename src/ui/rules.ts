// The rules codex ("How to play"): a tabbed panel that opens from the title, the lobby and the
// settings popover. Everything a new commander needs, with the numbers read from the sim's own
// tables (so a balance change never leaves the codex lying): how a match is won, the counter
// wheel, fliers and anti-air, terrain, loot / slots / levels, the economy and
// catch-up, and the controls.
import type { FactionId, UnitType, WheelClass } from '../sim/types.ts';
import { FACTIONS, FACTION_IDS } from '../sim/data/factions.ts';
import { UNITS } from '../sim/data/units.ts';
import { SLOT_UNLOCK_LEVEL, LEGENDARY_EVERY } from '../sim/data/items.ts';
import { lootSchedule } from '../sim/loot.ts';
import type { Rarity } from '../sim/types.ts';
import { ARMY_CAP, BASE_DEPLOY_LIMIT, DEPLOY_BONUS, deployPointsText, KEEP_HP, LEVEL_COST_PCT, MAX_SQUAD_LEVEL, START_GOLD, deployZone, income } from '../sim/match.ts';
import { RIVER_Y0 } from '../sim/terrain.ts';
import { LORDS, LORD_ROLE, LORD_ROLES, LORD_ROLE_NAME } from '../sim/data/lords.ts';
import { TICK_HZ } from '../sim/constants.ts';
import { sound } from '../audio.ts';
import { $, el, esc, store } from './dom.ts';
import { icon } from './icons.ts';
import { classTag, crest } from './units.ts';
import { COUNTER_TEXT, factionContext } from './gamedata.ts';
import { WHEEL, WHEEL_NAME, WHEEL_WHY, beatenBy, beatsClass } from '../sim/data/wheel.ts';
import { factionMechanics } from './lordpick.ts';

export type TabId = 'match' | 'factions' | 'combat' | 'air' | 'terrain' | 'loot' | 'gold' | 'keys';
const TABS: { id: TabId; label: string; ic: string }[] = [
  { id: 'match', label: 'The match', ic: 'keep' },
  { id: 'factions', label: 'Factions', ic: 'flag' },
  { id: 'combat', label: 'Counters', ic: 'sword2' },
  { id: 'air', label: 'Fliers', ic: 'flier' },
  { id: 'terrain', label: 'Terrain', ic: 'move' },
  { id: 'loot', label: 'Loot & levels', ic: 'bag' },
  { id: 'gold', label: 'Gold', ic: 'gold' },
  { id: 'keys', label: 'Controls', ic: 'gear' },
];

const chip = (u: UnitType) => `<span class="uchip">${crest(u, null, 'sm')}${esc(UNITS[u].name)}</span>`;
const chips = (l: UnitType[]) => l.map(chip).join('');
/**
 * The codex speaks about one faction's units at a time: yours while you are in a match, else the
 * one you played last (the Kingdom for a newcomer). The Factions tab describes all three.
 */
export function codexFaction(): FactionId {
  const mine = factionContext().mine;
  if (mine) return mine;
  const last = store.get('faction') as FactionId | null;
  return last && FACTION_IDS.includes(last) ? last : 'kingdom';
}
const roster = (): UnitType[] => FACTIONS[codexFaction()].units;
const names = (l: UnitType[], n = 3): string => l.slice(0, n).map((u) => UNITS[u].name).join(', ');
/** March speed in m/s (the sim's speed is cm per tick). */
const mps = (u: UnitType): number => (UNITS[u].speed * TICK_HZ) / 100;
/** The codex faction's slowest and fastest melee units on the ground, for the timing lesson. */
function timingPair(): { slow: UnitType; fast: UnitType } | null {
  const melee = roster().filter((u) => UNITS[u].range <= 400 && !UNITS[u].tags.includes('flier'));
  if (melee.length < 2) return null;
  const by = [...melee].sort((a, b) => UNITS[a].speed - UNITS[b].speed);
  return { slow: by[0]!, fast: by[by.length - 1]! };
}
function timingSection(): string {
  const p = timingPair();
  // from the front edge of a deploy zone to the river's near bank
  const gap = (RIVER_Y0 - deployZone(0).y1) / 100;
  const ex = p
    ? `${esc(UNITS[p.slow].name)} march at <b>${mps(p.slow).toFixed(1)} m/s</b> and ${esc(UNITS[p.fast].name)} at <b>${mps(p.fast).toFixed(1)} m/s</b>. Side by side on the front edge, ${gap.toFixed(0)} m from the river, the ${esc(UNITS[p.fast].name)} get there ${(gap / mps(p.slow) - gap / mps(p.fast)).toFixed(0)} s sooner and fight alone.`
    : 'Fast squads that start beside slow ones arrive alone and fight alone.';
  return `<h3>Timing the charge</h3>
        <p class="lead"><b>Slow tanks in front, fast units held back</b>, so they all hit together.</p>
        <p>${ex} Put the slowest melee squad at the front edge of your zone and the faster ones deeper, until they reach the river at the same moment. Then your tanks take the first blows, and the hard hitters arrive while the enemy is still busy with them.</p>
        <ul class="rl-list">
          <li>The seconds under each squad's plate are when it reaches the river. Press <kbd>T</kbd> for every route, with the time to where the enemy's front stood last round.</li>
          <li><b>Sync</b> (on the formation bar, or with several squads selected) staggers your melee squads for you, slowest in front.</li>
          <li>Ranged squads stop as soon as their target is in range: keep them behind the line, not in step with it.</li>
        </ul>`;
}
const scope = (): string => {
  const e = factionContext().enemy;
  // the text in one span: as loose flex items, each text run and <b> got the flex gap around it ("Kingdom . The")
  return `<p class="rl-scope">${icon('flag')}<span>Showing <b>${esc(FACTIONS[codexFaction()].name)}</b>${e && e !== codexFaction() ? ` against <b>${esc(FACTIONS[e].name)}</b>` : ''}. The other factions are under <i>Factions</i>.</span></p>`;
};
const fliers = () => roster().filter((u) => UNITS[u].tags.includes('flier'));
const antiAir = () => roster().filter((u) => !UNITS[u].traits?.includes('healer') && !UNITS[u].tags.includes('flier') && (UNITS[u].weapon === 'bow' || UNITS[u].damageType === 'magic' || UNITS[u].weapon === 'bolt' || UNITS[u].weapon === 'beam' || UNITS[u].traits?.includes('howdah' as never)));

/** The three factions side by side: what each is, its Lords, its roster and what sets it apart. */
function factionsPage(): string {
  const mine = factionContext().mine;
  return `<h3>Three factions, one set of rules</h3>
    <p class="lead">A faction is a <b>roster</b>: its own units and four Lords, one for each way to lead (infantry, magic, armour, fliers). Gold, loot offers, the deploy limit, Keep life and every rule of battle are <b>the same for all three</b>.</p>
    <div class="rl-facs">${FACTION_IDS.map((f) => {
      const F = FACTIONS[f];
      const mech = factionMechanics(f);
      return `<div class="rl-fac${f === mine ? ' mine' : ''}" style="--f1:${F.colors[0]};--f2:${F.colors[1]};--f3:${F.colors[2]}">
        <i class="fc-band"></i>
        <b>${esc(F.name)}${f === mine ? ' <em>yours</em>' : ''}</b>
        <p>${esc(F.blurb)} ${esc(F.identity)}</p>
        <small>Lords</small><div>${F.lords.map((l) => `<span class="uchip" data-tip="${esc(`${LORD_ROLE_NAME[LORD_ROLE[l]]}. ${LORDS[l].passive}. ${LORDS[l].abilityName}: ${LORDS[l].abilityText}`)}">${crest('lord', l, 'sm')}${esc(LORDS[l].title)} ${esc(LORDS[l].name)}</span>`).join('')}</div>
        <small>Units</small><div>${chips(F.units)}</div>
        <small>What sets it apart</small>
        <ul class="rl-list">${mech.map((m) => `<li class="${m.tone}"><b>${esc(m.name)}</b>${m.units.length ? ` (${esc(names(m.units, 2))})` : ''}: ${esc(m.text)}</li>`).join('')}</ul>
      </div>`;
    }).join('')}</div>
    <h3>The Lords, role by role</h3>
    <p class="lead">Each faction's Lord in a role plays the same part as the others in that row, with its own passive and ability.</p>
    <div class="rl-lords">
      <span></span>${FACTION_IDS.map((f) => `<b class="rl-lh">${esc(FACTIONS[f].short)}</b>`).join('')}
      ${LORD_ROLES.map((r) => `<b class="rl-lr">${esc(LORD_ROLE_NAME[r])}</b>${FACTION_IDS.map((f) => {
        const id = FACTIONS[f].lords.find((l) => LORD_ROLE[l] === r);
        if (!id) return '<span></span>';
        const L = LORDS[id];
        return `<div class="rl-lord">${crest('lord', id, 'sm')}<span><b>${esc(L.title)} ${esc(L.name)}</b><small>${esc(L.passive)}</small><small><em>${esc(L.abilityName)}:</em> ${esc(L.abilityText)}</small></span></div>`;
      }).join('')}`).join('')}
    </div>`;
}

/**
 * The counter wheel as a ring of eight class stamps, each arrow pointing at the class it beats. The names sit
 * outside the ring (pushed outward along their spoke), so no arrow ever runs through a label. Laid out in rem on a
 * 22 x 19 box: the SVG's viewBox is the same box at 10 units a rem.
 */
function wheel(): string {
  const W = 22, H = 19, R = 6.6, n = WHEEL.length;
  const cx = W / 2, cy = H / 2;
  const ang = (i: number): number => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const arrows = WHEEL.map((_, i) => {
    // a short arc between two neighbouring stamps (a stamp is 2.3rem across: about 10 degrees of the ring each side)
    const a0 = ang(i + 0.3), a1 = ang(i + 0.7);
    const p = (a: number) => `${(10 * (cx + R * Math.cos(a))).toFixed(1)} ${(10 * (cy + R * Math.sin(a))).toFixed(1)}`;
    return `<path d="M${p(a0)} A${10 * R} ${10 * R} 0 0 1 ${p(a1)}" marker-end="url(#whl-a)"/>`;
  }).join('');
  const units = (c: WheelClass) => roster().filter((u) => UNITS[u].class === c).map((u) => UNITS[u].name).join(', ') || '–';
  return `<div class="whl" style="width:${W}rem;height:${H}rem">
    <svg viewBox="0 0 ${10 * W} ${10 * H}" aria-hidden="true">
      <defs><marker id="whl-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
      <g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">${arrows}</g>
    </svg>
    ${WHEEL.map((c, i) => {
      const a = ang(i), cs = Math.cos(a), sn = Math.sin(a);
      // the stamp on the ring; its name just outside it, its near edge on the spoke
      const lx = cx + (R + 1.45) * cs, ly = cy + (R + 1.45) * sn;
      const tx = (-50 + 50 * Math.round(cs * 100) / 100).toFixed(0), ty = (-50 + 50 * Math.round(sn * 100) / 100).toFixed(0);
      return `<div class="whl-node" style="left:${(cx + R * cs).toFixed(2)}rem;top:${(cy + R * sn).toFixed(2)}rem" data-tip="${esc(`${WHEEL_NAME[c]}: ${units(c)}`)}"><i>${icon(`cls_${c}`)}</i></div>
        <b class="whl-name" style="left:${lx.toFixed(2)}rem;top:${ly.toFixed(2)}rem;transform:translate(${tx}%, ${ty}%)">${WHEEL_NAME[c]}</b>`;
    }).join('')}
    <span class="whl-mid">${COUNTER_TEXT}<small>to the next</small></span>
  </div>`;
}

/** One row per class: what it beats and why, with the codex faction's units of that class. */
function wheelRows(): string {
  return WHEEL.map((c) => {
    const mine = roster().filter((u) => UNITS[u].class === c);
    return `<div class="rl-row">${classTag(c, 'me')}<b class="x">›</b>${classTag(beatsClass(c))}<span>${esc(WHEEL_WHY[c])}</span><div class="rl-prey">${mine.length ? chips(mine) : `<em class="bad">${esc(FACTIONS[codexFaction()].short)} has none</em>`}</div></div>`;
  }).join('');
}

/** The viewer's deploy limit this round, when they are in a match (set by the app); null otherwise. */
let deployLimit: () => number | null = () => null;
export function setRulesContext(limit: () => number | null): void {
  deployLimit = limit;
}
const marshalBonus = (): string => {
  const m = Object.values(LORDS).find((l) => l.id === 'marshal');
  return m ? `${deployPointsText(BASE_DEPLOY_LIMIT + DEPLOY_BONUS)} with ${esc(m.title)} ${esc(m.name)}` : 'some Lords add one';
};
/** "2 deploy points" for the viewer's own limit in a match (half-points in the sim), else the base rule with its exceptions. */
function deployText(): { n: string; note: string } {
  const mine = deployLimit();
  if (mine && mine > 0) return { n: `${deployPointsText(mine)} deploy points`, note: mine === BASE_DEPLOY_LIMIT ? ` (the base limit; ${marshalBonus()}, and some relics add more)` : ` this round (the base limit is ${deployPointsText(BASE_DEPLOY_LIMIT)}; your Lord and relics add the rest)` };
  return { n: `${deployPointsText(BASE_DEPLOY_LIMIT)} deploy points`, note: ` (${marshalBonus()}; some relics add more)` };
}

const RARITY_NAME: Record<Rarity, string> = { common: 'Common', magic: 'Magic', rare: 'Rare', legendary: 'Legendary' };

/**
 * The loot schedule as the sim rolls it (lootSchedule): one rarity for all three items, the same for both
 * commanders, in bands ("Rounds 1-2: 3 Magic"); every Nth round is all Legendary (shown apart).
 */
export function lootBands(maxRound = 12): { from: number; to: number | null; counts: [Rarity, number][] }[] {
  const legendary = (r: number): boolean => r >= LEGENDARY_EVERY && r % LEGENDARY_EVERY === 0;
  // a Legendary round belongs to the band of the rounds after it (the band says what the other rounds bring)
  const sig = (r: number): string => [...lootSchedule(legendary(r) ? r + 1 : r)].sort().join(',');
  const bands: { from: number; to: number | null; counts: [Rarity, number][] }[] = [];
  for (let r = 1; r <= maxRound; r++) {
    const last = bands.at(-1);
    if (last && sig(last.from) === sig(r)) { last.to = r; continue; }
    const counts = new Map<Rarity, number>();
    for (const x of lootSchedule(legendary(r) ? r + 1 : r)) counts.set(x, (counts.get(x) ?? 0) + 1);
    bands.push({ from: r, to: r, counts: (['legendary', 'rare', 'magic', 'common'] as Rarity[]).filter((x) => counts.has(x)).map((x) => [x, counts.get(x)!]) });
  }
  if (bands.length) bands.at(-1)!.to = null;
  return bands;
}

function lootTable(): string {
  const bands = lootBands();
  return `<div class="rl-sched">${bands.map((b) => `<div><small>${b.to === null ? `Round ${b.from}+` : b.from === b.to ? `Round ${b.from}` : `Rounds ${b.from}–${b.to}`}</small><p>${b.counts.map(([x, n]) => `<span class="r-${x}">${n} ${RARITY_NAME[x]}</span>`).join('')}</p></div>`).join('')}
    <div class="leg"><small>Every ${LEGENDARY_EVERY === 3 ? '3rd' : `${LEGENDARY_EVERY}th`} round</small><p><span class="r-legendary">3 Legendary</span></p></div></div>`;
}

/** " (Knights, Stone Golem)" for the units of the codex's faction that match, or nothing. */
function listOf(test: (d: (typeof UNITS)[UnitType]) => boolean): string {
  const l = roster().filter((u) => test(UNITS[u]));
  return l.length ? ` (${esc(names(l))})` : '';
}
/** "Ranged deals ×1.5 to Air." for the faction's answer to wings. */
function antiAirLine(): string {
  const r = roster().filter((u) => UNITS[u].class === beatenBy('air'));
  return `${WHEEL_NAME[beatenBy('air')]}${r.length ? ` (${esc(names(r))})` : ''} deals <b>${COUNTER_TEXT}</b> to Air on the counter wheel.`;
}

/** One tab of the codex as HTML (exported for the tests: every faction unit must appear in it). */
export function codexPage(id: TabId): string {
  return page(id);
}

function page(id: TabId): string {
  const armor = SLOT_UNLOCK_LEVEL.armor;
  const relic = SLOT_UNLOCK_LEVEL.relic;
  switch (id) {
    case 'match':
      return `<h3>Break their Keep</h3>
        <p class="lead">Each commander holds a <b>Keep with ${KEEP_HP.toLocaleString('en-US')} life</b>. Bring the enemy Keep to zero and the war is yours.</p>
        <div class="rl-flow">
          <div class="rl-step"><i>1</i><b>Plan</b><p>Both commanders plan in secret, at the same time. Deploy up to <b>${deployText().n}</b> a round on your half${deployLimit() ? '' : ` (${marshalBonus()})`}: a 100-gold squad costs ½, a 150 to 300-gold one 1, a 400-gold one 1½. Level squads up, equip loot. Press <kbd>Space</kbd> when ready.</p></div>
          <div class="rl-step"><i>2</i><b>Battle</b><p>The armies fight on their own: no orders. A battle ends when one army is wiped out, or after <b>1:30</b>.</p></div>
          <div class="rl-step"><i>3</i><b>Siege</b><p>The winner's <b>surviving squads march on the enemy Keep</b>. Costlier and higher-level survivors hit harder, and later rounds add more. A narrow win adds less than a clear one.</p></div>
          <div class="rl-step"><i>4</i><b>Spoils</b><p>Pick <b>1 item of 3</b> and unlock <b>a new unit type</b>. Then plan again.</p></div>
        </div>
        <ul class="rl-list">
          <li><b>Your army is permanent.</b> Every squad returns at full strength next round, where you placed it.</li>
          <li><b>You see where the enemy stood <i>last</i> round</b> (the red ghosts on the far half, always shown from round 2), never what they are doing now. Counter it.</li>
          <li>If time runs out, both sides deal only <b>half</b> Keep damage from what still stands.</li>
          <li>Your <b>Lord</b> is a hero on the field with a passive, an ability that fires by itself, and three item slots. If the Lord falls, they are back next round.</li>
        </ul>`;
    case 'factions':
      return factionsPage();
    case 'combat':
      return `${scope()}<h3>The counter wheel</h3>
        <div class="rl-two">${wheel()}
          <div><p class="lead">Every unit and every Lord has <b>one class</b>. Each class <b>beats the next</b> one around the ring and is beaten by the one before it.</p>
          <p>A counter deals <b class="good">${COUNTER_TEXT} damage</b> to the class it beats. Every other match-up is even: there is no other counter rule. A Lord counts as the class of its body or mount.</p>
          <p>Hover any unit card for its class, what it <span class="good">beats</span> and what it is <span class="bad">weak to</span>. Look at the enemy's ghosts and bring the class that beats what they fielded.</p></div>
        </div>
        <h3>Why each class wins</h3>
        <div class="rl-table">${wheelRows()}</div>
        <ul class="rl-list">
          <li><b>Armor</b>${listOf((d) => d.armor >= 40)} cuts physical damage. <b>Magic ignores armor</b>, and crushing blows break it.</li>
          <li><b>Splash</b>${listOf((d) => !!d.splash)} shreds big squads of small soldiers; cheap chaff soaks it up.</li>
          <li><b>Fast squads</b>${listOf((d) => d.traits.includes('raider'))} ride past the line to hunt archers, casters and healers.</li>
          ${roster().some((u) => UNITS[u].traits.includes('healer')) ? '' : `<li class="bad"><b>${esc(FACTIONS[codexFaction()].short)} has no healers.</b> What falls stays down, unless it is raised again.</li>`}
        </ul>`;
    case 'air':
      return `${scope()}<h3>Fliers and anti-air</h3>
        <p class="lead">Fliers cross rivers and forests freely, and <b>most of an army cannot touch them</b>.</p>
        <div class="rl-two cards">
          <div class="rl-card air"><small>${icon('flier')}Fliers</small><div>${chips(fliers())}</div><p>Only bows, magic, ballista bolts and other fliers can hit them. Swords, axes and lances on the ground cannot.</p></div>
          <div class="rl-card aa"><small>${icon('bow')}Anti-air</small><div>${chips(antiAir())}</div><p>${antiAirLine()} Keep at least one answer once you see wings among the ghosts.</p></div>
        </div>
        <ul class="rl-list">
          <li>An army with <b>no anti-air</b> loses to a single flier squad left alive: it will reach your Keep.</li>
          <li>Fliers are fragile. They die fast to massed arrows, so strike the archers first or come from the flank.</li>
        </ul>`;
    case 'terrain':
      return `<h3>The battlefield</h3>
        <p class="lead">The field is mirrored, so both sides get the same ground. Where you stand matters.</p>
        <div class="rl-grid">
          <div class="rl-card t-forest"><small>Forest</small><p>Units inside take <b>−40%</b> ranged damage. Movement <b>−30%</b>.</p></div>
          <div class="rl-card t-hill"><small>Hill</small><p>Ranged units standing on a hill deal <b>+15% damage</b>.</p></div>
          <div class="rl-card t-river"><small>River</small><p>Wading costs <b>half your speed</b>. Bridges are free, fords are slightly slow. Fliers ignore it.</p></div>
          <div class="rl-card t-ruins"><small>Ruins</small><p>Light cover: units inside take <b>−25%</b> ranged damage.</p></div>
        </div>
        <ul class="rl-list">
          <li>Deploy anywhere in your zone (the glowing border). Each squad needs its own ground.</li>
          <li>Squads march straight at the enemy: a tank in front of archers keeps the archers alive.</li>
        </ul>
        ${timingSection()}`;
    case 'loot':
      return `<h3>Loot</h3>
        <p class="lead">After every round you choose <b>1 item of 3</b>: a <b>weapon</b> (offence: damage, crits, attack speed, burn, slaying), an <b>armor</b> (defence: life, armour, resistance, thorns, revival) and a <b>relic</b> (utility: speed, range, frost, leech, command). An item works on <b>every soldier</b> of the squad that carries it.</p>
        <p>The three share <b>one rarity and one power budget</b>, so the choice is what your army needs against this enemy, not the biggest number. The offer follows a <b>fixed schedule</b>, and <b>your opponent is offered the same items</b>. Nothing is rolled for luck.</p>
        ${lootTable()}
        <div class="rl-rar"><span class="r-magic">Magic · 2 affixes</span><span class="r-rare">Rare · 3 affixes (or 2 and a skill)</span><span class="r-legendary">Legendary · 2 affixes and a power</span></div>
        <p>Every Legendary power is <b>built for some classes</b> of the counter wheel, and its tooltip says which (<b>Best on</b>). On any other squad the power does nothing and only its affixes work, so a Legendary that does not fit your army is a fair pass.</p>
        <h3>Slots and levels</h3>
        <div class="rl-slots">
          <div class="rl-slot"><i>${icon('weapon')}</i><b>Weapon</b><small>from level 1</small></div>
          <div class="rl-slot"><i>${icon('armor')}</i><b>Armor</b><small>from level ${armor}</small></div>
          <div class="rl-slot"><i>${icon('relic')}</i><b>Relic</b><small>from level ${relic}</small></div>
          <div class="rl-slot lord"><i>${icon('crown')}</i><b>Your Lord</b><small>all three, always</small></div>
        </div>
        <ul class="rl-list">
          <li><b>Level up a squad with gold</b> (${LEVEL_COST_PCT}% of the unit's cost for every level, up to level ${MAX_SQUAD_LEVEL}): <b>+25% life and +20% damage</b> per level, and level ${relic} opens the Relic slot. A level needs no deployment and no army slot.</li>
          <li>Your Lord levels from <b>kills</b>, not gold.</li>
          <li>Drag items between squads and the stash freely while planning. Any squad can carry any item, but <b>greyed lines do nothing</b> there: range on a melee squad, damage on healers.</li>
        </ul>`;
    case 'gold':
      return `<h3>Gold and limits</h3>
        <div class="rl-stats">
          <div><small>Round 1</small><b>${START_GOLD}</b></div>
          <div><small>Round 2</small><b>+${income(2)}</b></div>
          <div><small>Round 6</small><b>+${income(6)}</b></div>
          <div><small>Most per round</small><b>+${income(99)}</b></div>
        </div>
        <ul class="rl-list">
          <li>Unspent gold <b>carries over</b>.</li>
          <li><b>${deployText().n} per round</b>${deployText().note}. Levelling up and equipping are unlimited.</li>
          <li>Army cap: <b>${ARMY_CAP} squads</b>, not counting your Lord.</li>
          <li>Selling in the round the squad was deployed is an <b>undo</b>: it refunds everything you spent on it. A squad from an earlier round refunds nothing. Its items return to your stash.</li>
        </ul>
        <h3>Equal terms</h3>
        <ul class="rl-list">
          <li>Both commanders get the <b>same income</b> every round, win or lose. There is no catch-up gold.</li>
          <li>Both are offered the <b>same loot</b> and the <b>same choice of new unit types</b>.</li>
          <li>Battles have <b>no dice</b>: no misses, and critical hits come on a count (a squad with 10% critical rate lands one every 10th attack).</li>
          <li>Only your choices differ.</li>
        </ul>`;
    case 'keys':
      return `<h3>Controls</h3>
        <dl class="keys big">
          <dt><kbd>1</kbd>–<kbd>9</kbd> <kbd>0</kbd> <kbd>-</kbd></dt><dd>Pick a unit from the shop, then click your half of the field</dd>
          <dt><kbd>Q</kbd> <kbd>E</kbd></dt><dd>Turn the camera. While placing or dragging a squad (or with <kbd>Shift</kbd> on a selected squad): turn the squad</dd>
          <dt><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dt><dd>Pan the camera (also drag; wheel zooms; right-drag turns)</dd>
          <dt><kbd>Home</kbd></dt><dd>Reset the camera</dd>
          <dt><kbd>Space</kbd></dt><dd>Ready / un-ready</dd>
          <dt><kbd>Tab</kbd></dt><dd>Select your next squad (<kbd>Shift</kbd>+<kbd>Tab</kbd>: the previous one)</dd>
          <dt>Drag on your ground</dt><dd>Box-select squads (<kbd>Shift</kbd>-click adds or removes one; <kbd>Ctrl</kbd>+<kbd>A</kbd> all). Drag one of them to move the group; right-drag or <kbd>Shift</kbd>+<kbd>Q</kbd>/<kbd>E</kbd> turns it</dd>
          <dt><kbd>Ctrl</kbd>+<kbd>Z</kbd></dt><dd>Undo the last move, turn, deploy or equip of this round</dd>
          <dt><kbd>T</kbd> <kbd>G</kbd></dt><dd>March routes and timings · placement grid snap</dd>
          <dt><kbd>U</kbd></dt><dd>Level up the selected squad</dd>
          <dt><kbd>Del</kbd></dt><dd>Sell the selected squad (press twice)</dd>
          <dt><kbd>C</kbd></dt><dd>Battle camera: director / free</dd>
          <dt><kbd>1</kbd> <kbd>2</kbd> <kbd>4</kbd></dt><dd>Battle speed</dd>
          <dt><kbd>End</kbd></dt><dd>Skip the battle</dd>
          <dt><kbd>Enter</kbd></dt><dd>Chat</dd>
          <dt><kbd>M</kbd> <kbd>F</kbd></dt><dd>Mute · full screen</dd>
          <dt><kbd>F1</kbd></dt><dd>This codex</dd>
        </dl>`;
  }
}

let open: RulesPanel | null = null;

export class RulesPanel {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'F1') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.dispose();
    }
  };

  constructor(tab?: TabId) {
    const start = tab ?? ((store.get('rules.tab') as TabId) || 'match');
    this.root = el(`<div class="rules-veil" role="dialog" aria-modal="true" aria-label="How to play">
      <div class="rules panel">
        <header class="rl-head"><div><small class="eyebrow">The commander's codex</small><h2>How to play</h2></div><button class="icon close" data-tip="Close [Esc]">${icon('close')}</button></header>
        <nav class="rl-tabs" role="tablist">${TABS.map((t) => `<button role="tab" data-tab="${t.id}">${icon(t.ic)}<span>${t.label}</span></button>`).join('')}</nav>
        <div class="rl-body"></div>
      </div>
    </div>`);
    this.body = $(this.root, '.rl-body');
    document.getElementById('ui')!.appendChild(this.root);
    this.root.addEventListener('pointerdown', (e) => e.target === this.root && this.dispose());
    $(this.root, '.close').addEventListener('click', () => this.dispose());
    this.root.querySelectorAll<HTMLElement>('.rl-tabs button').forEach((b) => b.addEventListener('click', () => (sound.click(), this.show(b.dataset.tab as TabId))));
    window.addEventListener('keydown', this.key, true);
    this.show(TABS.some((t) => t.id === start) ? start : 'match');
    sound.open();
  }

  show(id: TabId): void {
    store.set('rules.tab', id);
    this.root.querySelectorAll<HTMLElement>('.rl-tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === id);
      b.setAttribute('aria-selected', String(b.dataset.tab === id));
    });
    this.body.innerHTML = page(id);
    this.body.scrollTop = 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.key, true);
    this.root.remove();
    if (open === this) open = null;
  }
}

/** Open the codex (or close it if it is already open). */
export function toggleRules(tab?: TabId): void {
  if (open) return open.dispose();
  open = new RulesPanel(tab);
}

export function rulesOpen(): boolean {
  return !!open;
}
