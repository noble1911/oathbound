// The rules codex ("How to play"): a tabbed panel that opens from the title, the lobby and the
// settings popover. Everything a new commander needs, with the numbers read from the sim's own
// tables (so a balance change never leaves the codex lying): how a match is won, the weapon
// triangle and counters, fliers and anti-air, terrain, loot / slots / levels, the economy and
// catch-up, and the controls.
import type { UnitType } from '../sim/types.ts';
import { UNITS, UNIT_TYPES } from '../sim/data/units.ts';
import { SLOT_UNLOCK_LEVEL, LEGENDARY_MIN_ROUND } from '../sim/data/items.ts';
import { ARMY_CAP, BASE_DEPLOY_LIMIT, CATCHUP_GOLD, KEEP_HP, MAX_SQUAD_LEVEL, START_GOLD, income } from '../sim/match.ts';
import * as match from '../sim/match.ts';
import { sound } from '../audio.ts';
import { $, el, esc, store } from './dom.ts';
import { icon } from './icons.ts';
import { crest } from './units.ts';
import { TAG_LABEL } from './gamedata.ts';

type TabId = 'match' | 'combat' | 'air' | 'terrain' | 'loot' | 'gold' | 'keys';
const TABS: { id: TabId; label: string; ic: string }[] = [
  { id: 'match', label: 'The match', ic: 'keep' },
  { id: 'combat', label: 'Counters', ic: 'sword2' },
  { id: 'air', label: 'Fliers', ic: 'flier' },
  { id: 'terrain', label: 'Terrain', ic: 'move' },
  { id: 'loot', label: 'Loot & levels', ic: 'bag' },
  { id: 'gold', label: 'Gold', ic: 'gold' },
  { id: 'keys', label: 'Controls', ic: 'gear' },
];

const chip = (u: UnitType) => `<span class="uchip">${crest(u, null, 'sm')}${esc(UNITS[u].name)}</span>`;
const chips = (l: UnitType[]) => l.map(chip).join('');
const fliers = () => UNIT_TYPES.filter((u) => UNITS[u].tags.includes('flier'));
const antiAir = () => UNIT_TYPES.filter((u) => !UNITS[u].traits?.includes('healer') && !UNITS[u].tags.includes('flier') && (UNITS[u].weapon === 'bow' || UNITS[u].damageType === 'magic' || UNITS[u].weapon === 'bolt'));

function triangle(): string {
  const node = (cls: string, w: string, label: string, units: string) => `<div class="tri-node ${cls}"><i>${icon(w)}</i><span class="tri-l"><b>${label}</b><small>${units}</small></span></div>`;
  const of = (w: string) => UNIT_TYPES.filter((u) => UNITS[u].weapon === w).map((u) => UNITS[u].name).join(', ');
  return `<div class="tri">
    <svg viewBox="0 0 200 180" aria-hidden="true">
      <defs><marker id="tri-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
      <g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <path d="M113 36 L152 106" marker-end="url(#tri-a)"/>
        <path d="M140 128 L62 128" marker-end="url(#tri-a)"/>
        <path d="M48 106 L87 36" marker-end="url(#tri-a)"/>
      </g>
    </svg>
    ${node('n-sword', 'sword', 'Sword', esc(of('sword')))}
    ${node('n-axe', 'axe', 'Axe', esc(of('axe')))}
    ${node('n-lance', 'lance', 'Lance', esc(of('lance')))}
    <span class="tri-mid">beats</span>
  </div>`;
}

function effectiveRows(): string {
  const rows: string[] = [];
  for (const u of UNIT_TYPES) {
    const d = UNITS[u];
    for (const [tag, m] of Object.entries(d.effective ?? {})) {
      if (!m || m <= 100) continue;
      const prey = UNIT_TYPES.filter((v) => UNITS[v].tags.includes(tag as never)).slice(0, 4);
      rows.push(`<div class="rl-row">${chip(u)}<b class="x">×${(m / 100).toFixed(m % 100 ? 1 : 0)}</b><span>vs ${TAG_LABEL[tag as keyof typeof TAG_LABEL]}</span><div class="rl-prey">${chips(prey)}</div></div>`);
    }
  }
  return rows.join('');
}

function catchUp(): string {
  const m = match as unknown as Record<string, number | undefined>;
  const perRound = m.CATCHUP_PER_ROUND;
  const perDef = m.CATCHUP_PER_DEFICIT;
  const under = m.UNDERDOG_DEFICIT;
  let t = `<li><b>Losing a round pays +${CATCHUP_GOLD} gold</b>${perRound ? `, plus ${perRound} per round played${perDef ? ` and ${perDef} for every point your Keep trails by` : ''}` : ''}.</li>`;
  if (under) t += `<li>Trail by <b>${under} points of Keep life</b> or more and you may deploy <b>one extra squad</b> next round.</li>`;
  t += '<li>The loser\'s <b>spoils roll one rarity tier higher</b>.</li>';
  return t;
}

function page(id: TabId): string {
  const armor = SLOT_UNLOCK_LEVEL.armor;
  const relic = SLOT_UNLOCK_LEVEL.relic;
  switch (id) {
    case 'match':
      return `<h3>Break their Keep</h3>
        <p class="lead">Each commander holds a <b>Keep with ${KEEP_HP.toLocaleString('en-US')} life</b>. Bring the enemy Keep to zero and the war is yours.</p>
        <div class="rl-flow">
          <div class="rl-step"><i>1</i><b>Plan</b><p>Both commanders plan in secret, at the same time. Deploy up to <b>${BASE_DEPLOY_LIMIT} new squads</b> on your half, level squads up, equip loot. Press <kbd>Space</kbd> when ready.</p></div>
          <div class="rl-step"><i>2</i><b>Battle</b><p>The armies fight on their own: no orders. A battle ends when one army is wiped out, or after <b>1:30</b>.</p></div>
          <div class="rl-step"><i>3</i><b>Siege</b><p>The winner's <b>surviving squads march on the enemy Keep</b>. Costlier and higher-level survivors hit harder, and later rounds add more.</p></div>
          <div class="rl-step"><i>4</i><b>Spoils</b><p>Pick <b>1 item of 3</b> and unlock <b>a new unit type</b>. Then plan again.</p></div>
        </div>
        <ul class="rl-list">
          <li><b>Your army is permanent.</b> Every squad returns at full strength next round, where you placed it.</li>
          <li><b>You see where the enemy stood <i>last</i> round</b> (the red ghosts, <kbd>Tab</kbd>), never what they are doing now. Counter it.</li>
          <li>If time runs out, both sides deal only <b>half</b> Keep damage from what still stands.</li>
          <li>Your <b>Lord</b> is a hero on the field with a passive, an ability that fires by itself, and three item slots. If the Lord falls, they are back next round.</li>
        </ul>`;
    case 'combat':
      return `<h3>The weapon triangle</h3>
        <div class="rl-two">${triangle()}
          <div><p class="lead">Sword beats Axe, Axe beats Lance, Lance beats Sword.</p>
          <p>The winner deals <b class="good">+25% damage</b> and the loser <b class="bad">−25%</b>. Bows, magic and siege weapons stand outside the triangle.</p>
          <p>Hover any unit card to see what it is <span class="good">strong against</span> and what <span class="bad">counters it</span>.</p></div>
        </div>
        <h3>Hard counters</h3>
        <div class="rl-table">${effectiveRows()}</div>
        <ul class="rl-list">
          <li><b>Armor</b> (Knights, Golem) cuts physical damage. <b>Magic ignores armor</b>, and crushing blows break it.</li>
          <li><b>Splash</b> (Mages, Trebuchet) shreds big squads of small soldiers; cheap Militia soak it up.</li>
          <li><b>Fast squads</b> (Cavaliers, Pegasus) ride past the line to hunt archers, mages and healers.</li>
        </ul>`;
    case 'air':
      return `<h3>Fliers and anti-air</h3>
        <p class="lead">Fliers cross rivers and forests freely, and <b>most of an army cannot touch them</b>.</p>
        <div class="rl-two cards">
          <div class="rl-card air"><small>${icon('flier')}Fliers</small><div>${chips(fliers())}</div><p>Only bows, magic, ballista bolts and other fliers can hit them. Swords, axes and lances on the ground cannot.</p></div>
          <div class="rl-card aa"><small>${icon('bow')}Anti-air</small><div>${chips(antiAir())}</div><p>Archers deal <b>×${((UNITS.archers.effective?.flier ?? 200) / 100).toFixed(0)}</b> to fliers. Keep at least one answer once you see wings among the ghosts.</p></div>
        </div>
        <ul class="rl-list">
          <li>An army with <b>no anti-air</b> loses to a single flier squad left alive: it will reach your Keep.</li>
          <li>Fliers are fragile. They die fast to massed arrows, so strike the archers first or come from the flank.</li>
        </ul>`;
    case 'terrain':
      return `<h3>The battlefield</h3>
        <p class="lead">The field is mirrored, so both sides get the same ground. Where you stand matters.</p>
        <div class="rl-grid">
          <div class="rl-card t-forest"><small>Forest</small><p>Ranged attacks against units inside <b>miss 40%</b> of the time. Movement <b>−30%</b>.</p></div>
          <div class="rl-card t-hill"><small>Hill</small><p>Ranged units standing on a hill deal <b>+15% damage</b>.</p></div>
          <div class="rl-card t-river"><small>River</small><p>Wading costs <b>half your speed</b>. Bridges are free, fords are slightly slow. Fliers ignore it.</p></div>
          <div class="rl-card t-ruins"><small>Ruins</small><p>Light cover: units inside take <b>−25%</b> ranged damage.</p></div>
        </div>
        <ul class="rl-list">
          <li>Deploy anywhere in your zone (the glowing border). Each squad needs its own ground.</li>
          <li>Squads march straight at the enemy: a tank in front of archers keeps the archers alive.</li>
        </ul>`;
    case 'loot':
      return `<h3>Loot</h3>
        <p class="lead">After every round you choose <b>1 item of 3</b>. An item works on <b>every soldier</b> of the squad that carries it.</p>
        <div class="rl-rar"><span class="r-common">Common</span><span class="r-magic">Magic · 1–2 affixes</span><span class="r-rare">Rare · 3–4 affixes</span><span class="r-legendary">Legendary · a unique power (round ${LEGENDARY_MIN_ROUND}+)</span></div>
        <h3>Slots and levels</h3>
        <div class="rl-slots">
          <div class="rl-slot"><i>${icon('weapon')}</i><b>Weapon</b><small>from level 1</small></div>
          <div class="rl-slot"><i>${icon('armor')}</i><b>Armor</b><small>from level ${armor}</small></div>
          <div class="rl-slot"><i>${icon('relic')}</i><b>Relic</b><small>from level ${relic}</small></div>
          <div class="rl-slot lord"><i>${icon('crown')}</i><b>Your Lord</b><small>all three, always</small></div>
        </div>
        <ul class="rl-list">
          <li><b>Level up a squad with gold</b> (unit cost × its level, up to level ${MAX_SQUAD_LEVEL}): <b>+25% life and +20% damage</b> per level, and more item slots.</li>
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
          <li><b>${BASE_DEPLOY_LIMIT} new squads per round</b> (some Lords and relics add one). Levelling up and equipping are unlimited.</li>
          <li>Army cap: <b>${ARMY_CAP} squads</b>, not counting your Lord.</li>
          <li>Selling refunds <b>half</b>, but only in the round the squad was deployed. Its items return to your stash.</li>
        </ul>
        <h3>Falling behind</h3>
        <ul class="rl-list">${catchUp()}</ul>`;
    case 'keys':
      return `<h3>Controls</h3>
        <dl class="keys big">
          <dt><kbd>1</kbd>–<kbd>9</kbd> <kbd>0</kbd> <kbd>-</kbd></dt><dd>Pick a unit from the shop, then click your half of the field</dd>
          <dt><kbd>Q</kbd> <kbd>E</kbd></dt><dd>Turn the camera. While placing or dragging a squad (or with <kbd>Shift</kbd> on a selected squad): turn the squad</dd>
          <dt><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dt><dd>Pan the camera (also drag; wheel zooms; right-drag turns)</dd>
          <dt><kbd>Home</kbd></dt><dd>Reset the camera</dd>
          <dt><kbd>Space</kbd></dt><dd>Ready / un-ready</dd>
          <dt><kbd>Tab</kbd></dt><dd>Show / hide where the enemy stood last round</dd>
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
