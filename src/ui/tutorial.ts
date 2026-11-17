// The guided first match. "Tutorial" on the title starts an offline, untimed match against the
// easy AI with this coach on screen: one short prompt at a time, chosen from what the player is
// looking at right now (Lord pick → the unlock draft → deploying → deploys left → Ready → the
// battle → the results → loot → equipping → levelling up → the next draft), with the control it
// talks about ringed in gold. It never blocks input; "Skip tutorial" dismisses it for good.
// Steps are numbered in the order they are first shown (a step that comes back is a reminder and
// carries no number). Round 2 always teaches levelling up (the tutorial match grants the gold for
// it, see LocalMatch.tutorialGrant). The coach ends with a choice once round 3's planning is on
// screen with no modal open: "Finish tutorial" (back to the title) or "Keep playing" (the match
// goes on without the coach).
import type { RoomView } from '../net/protocol.ts';
import type { UnitType } from '../sim/types.ts';
import { UNITS } from '../sim/data/units.ts';
import { SLOT_UNLOCK_LEVEL } from '../sim/data/items.ts';
import { deployPointsText, deployWeight, levelUpCost, MAX_SQUAD_LEVEL } from '../sim/match.ts';
import { sound } from '../audio.ts';
import { $, el, store } from './dom.ts';
import { icon } from './icons.ts';
import { COUNTER_TEXT } from './gamedata.ts';

interface Step {
  id: string;
  title: string;
  /** May contain <b> and <kbd>. */
  text: string;
  /** What to ring. */
  target?: string;
  /**
   * Where the card sits: beside the field (left), on the right of the field (while the shop's
   * tooltips open on the left), along the bottom edge (Lord pick: clear of the heading and the
   * cards), low-left (results) or beside a modal's heading.
   */
  slot?: 'side' | 'right' | 'foot' | 'low' | 'modal';
}

/** The numbered steps of the guided match ("n / 13"); anything else is an unnumbered reminder. */
const MAIN = ['lord', 'draft1', 'deploy', 'deploys', 'ready', 'battle', 'results', 'draft2', 'loot', 'equip', 'level', 'timing', 'ghosts', 'finish'];
/** Taught once: these do not come back in later rounds. */
const ONCE = new Set(['battle', 'results']);
const MODALS = '.modal, .reveal, .dialog-veil, .rules-veil, .report-veil';

export class Coach {
  readonly root: HTMLElement;
  private iv: ReturnType<typeof setInterval>;
  private cur = '';
  private seen = new Set<string>();
  private ringed: Element[] = [];
  private done = false;
  /** Numbered steps in the order they were first shown. */
  private order: string[] = [];
  /** The round a taught-once step was shown in. */
  private taughtIn = new Map<string, number>();
  /** The closing choice is up (Finish tutorial / Keep playing). */
  private final = false;

  private ui: HTMLElement;
  private room: () => RoomView | null;
  private onEnd: (toTitle: boolean) => void;
  private grant: () => number;

  /**
   * `onEnd(toTitle)`: the coach is gone; `toTitle` = the player chose "Finish tutorial".
   * `grant` = the gold the tutorial match added for the level-up lesson (0 = none).
   */
  constructor(ui: HTMLElement, room: () => RoomView | null, onEnd: (toTitle: boolean) => void, grant: () => number = () => 0) {
    this.ui = ui;
    this.room = room;
    this.onEnd = onEnd;
    this.grant = grant;
    this.root = el(`<aside class="coach panel" aria-live="polite">
      <header><i>${icon('star')}</i><small>Tutorial</small><em class="coach-n"></em></header>
      <b class="coach-t"></b>
      <p class="coach-x"></p>
      <footer><button class="linkish coach-skip">Skip tutorial</button></footer>
      <div class="coach-acts"><button class="btn coach-keep">Keep playing</button><button class="btn primary coach-finish">Finish tutorial</button></div>
    </aside>`);
    ui.appendChild(this.root);
    $(this.root, '.coach-skip').addEventListener('click', () => this.finish(false));
    $(this.root, '.coach-keep').addEventListener('click', () => (sound.click(), this.finish(false)));
    $(this.root, '.coach-finish').addEventListener('click', () => (sound.click(), this.finish(true)));
    this.setFinal(false);
    this.iv = setInterval(() => this.tick(), 350);
    this.tick();
  }

  /** The prompt for what is on screen now, or null to stay quiet. */
  private pick(): Step | null {
    const ui = this.ui;
    const has = (sel: string) => !!ui.querySelector(sel);
    const room = this.room();
    const v = room?.view ?? null;
    const me = v?.you ?? null;
    const armor = SLOT_UNLOCK_LEVEL.armor;
    if (has('.lordpick')) {
      if (has('.lordpick.has-pick')) return null;
      return { id: 'lord', slot: 'foot', target: '.lcard[data-lord="marshal"]', title: 'Choose your Lord', text: 'The three banners are the <b>factions</b>, each with its own units and four Lords; gold, loot and rules are the same for all. We start with the Kingdom. Your Lord fights on the field and brings <b>two signature units</b>, a passive and an ability that fires by itself. <b>Marshal Aldric</b> is a forgiving first pick: he deploys an extra squad every round.' };
    }
    if (has('.reveal')) return null;
    if (has('.modal.draft')) {
      const first = (v?.round ?? 1) <= 1;
      return first
        ? { id: 'draft1', slot: 'modal', target: '.dcard', title: 'Raise your companies', text: `Unlock <b>${me?.draftPicks ?? 2} more unit types</b> for the whole match. Hover a card to see what it beats and what beats it. A front line plus something ranged is a sound start.` }
        : { id: 'draft2', slot: 'modal', target: '.dcard', title: 'New recruits', text: `Every round you unlock <b>one more unit type</b>. Each card shows its class on the <b>counter wheel</b>, what it beats (${COUNTER_TEXT} damage) and what it fears: pick the class that beats what the enemy fielded last round. The whole wheel is in the codex, <kbd>F1</kbd>.` };
    }
    if (has('.modal.loot')) return { id: 'loot', slot: 'modal', title: 'Spoils of War', text: 'After every round you claim <b>one item</b>. It works on every soldier of the squad that carries it. The three are equal in power: a weapon for offence, an armor for defence, a relic for utility. <b>Suits</b> names the squad it helps most; a greyed line does nothing there.' };
    if (has('.planning') && me) {
      const army = me.squads.filter((s) => s.type !== 'lord');
      const left = me.deployLimit - me.deploysUsed;
      const cheapest = Math.min(...me.unlocked.map((u) => UNITS[u].cost));
      const canDeploy = left > 0 && me.unlocked.some((u) => UNITS[u].cost <= me.gold && deployWeight(u) <= left) && me.gold >= cheapest;
      const round = v?.round ?? 1;
      // beside the field on the right while the shop is in use (its tooltips open over the left);
      // back on the left when a squad is selected (its panel takes the right)
      const shopSlot = has('.planning.has-sel') ? 'side' : 'right';
      const grant = this.grant();
      if (me.ready) return null;
      if (me.draftPicks > 0 && me.draftOptions.length) return { id: 'draft-n', target: '.draft-n', title: 'Recruits are waiting', text: 'Click <b>New recruits!</b> to unlock a unit type before you plan.' };
      if (me.lootOffer) return { id: 'loot-n', target: '.loot-n', title: 'Spoils are waiting', text: 'Click <b>Spoils of War</b> to claim an item.' };
      if (me.stash.length && !this.seen.has('equip-done')) {
        if (has('.planning.item-dragging')) return { id: 'equip', target: '.stash', title: 'Drop it on a squad', text: 'Release the item over a squad on the field, or over a slot in its panel.' };
        return { id: 'equip', target: '.stash', title: 'Equip your loot', text: `<b>Drag the item</b> from your stash onto a squad or your Lord. Squads carry a Weapon and Armor from level ${armor}, a Relic from level ${SLOT_UNLOCK_LEVEL.relic}; your Lord has all three slots.` };
      }
      if (!army.length && canDeploy) return { id: 'deploy', slot: shopSlot, target: '.ucard:not(.off)', title: 'Deploy a squad', text: 'These are your unit types. <b>Drag a card onto your half of the field</b> (inside the glowing border), or press <kbd>1</kbd> and click the ground. <kbd>Q</kbd> <kbd>E</kbd> turn it while you place.' };
      const up = army.find((s) => s.level < MAX_SQUAD_LEVEL && me.gold >= levelUpCost(s.type as never, s.level));
      if (army.some((s) => s.level > 1)) this.seen.add('level-done');
      // round 2 teaches levelling up before anything else is bought (the tutorial match pays for it)
      const teach = round >= 2 && !this.seen.has('level-done');
      const levelStep = (): Step => {
        if (has('.sqpanel .lvl')) return { id: 'level', target: '.sqpanel .lvl', title: 'Level up', text: `Press <b>Level up</b> <kbd>U</kbd>: +25% life and +20% damage for the whole squad, and level ${SLOT_UNLOCK_LEVEL.relic} opens its Relic slot. Levelling is unlimited, unlike deploying.` };
        const lead = !teach ? 'No deploys left, but gold remains.' : grant ? `Gold also makes the squads you have stronger, and the tutorial has added <b>${grant} gold</b> to try it.` : 'Gold also makes the squads you have stronger.';
        return { id: 'level', title: teach ? 'Level up a squad' : 'Spend what is left', text: `${lead} <b>Click one of your squads</b> on the field (or press <kbd>Tab</kbd>), then <b>Level up</b> <kbd>U</kbd>.` };
      };
      if (up && teach) return levelStep();
      if (canDeploy) return { id: 'deploys', slot: shopSlot, target: '.deploy-badge', title: `${deployPointsText(left)} deploy point${left === 1 ? '' : 's'} left`, text: `You have <b>${deployPointsText(me.deployLimit)} deploy points</b> this round: a 100-gold squad costs 1, a 150 to 300-gold squad 2, a 400-gold one 3. Put tough units in front and archers or mages behind them. <b>Your army is permanent</b>: it comes back every round.` };
      if (up) return levelStep();
      // two melee squads of different speeds: time to teach the stagger
      const melee = army.map((s) => UNITS[s.type as UnitType]).filter((d) => d && d.range <= 400 && !d.tags.includes('flier'));
      if (round >= 2 && new Set(melee.map((d) => d.speed)).size >= 2 && !this.seen.has('timing-done'))
        return { id: 'timing', target: '.pt-sync', title: 'Time the charge', text: 'The seconds under each plate are when that squad reaches the river. <b>Slow tanks in front, fast units held back</b>, so they all hit together instead of one by one. Press <b>Sync</b> to stagger your melee squads by speed, or <kbd>T</kbd> to see every route.' };
      if (round >= 2 && v?.enemy.lastArmy && !this.seen.has('ghosts-done')) return { id: 'ghosts', target: '.r-ghost', title: 'Know your enemy', text: 'The <b>red ghosts</b> on the far half show where the enemy stood last round. They are always shown from round 2; you never see what the enemy does now. Hover one to read it, plan against it, then press Ready.' };
      return { id: 'ready', target: '.ready-btn', title: 'Ready', text: 'Happy with your army? Press <b>Ready</b> <kbd>Space</kbd>. The battle starts when both commanders are ready.' };
    }
    if (has('.battle')) {
      if (has('.battle.over') || this.repeat('battle', v?.round ?? 1)) return null;
      return { id: 'battle', target: '.b-ctrl', title: 'The battle', text: 'The armies fight on their own. Whoever is left standing <b>marches on the enemy Keep</b>. <kbd>C</kbd> frees the camera, <kbd>1</kbd> <kbd>2</kbd> <kbd>4</kbd> set the speed, <kbd>End</kbd> skips.' };
    }
    if (has('.results') && this.repeat('results', v?.round ?? 1)) return null;
    if (has('.results')) return { id: 'results', slot: 'low', target: '.res-hints', title: 'Read the round', text: 'The report says <b>why</b> the round went as it did, squad by squad. Both commanders get the <b>same gold, loot and recruits</b> every round: only your choices differ.' };
    return null;
  }

  /** A taught-once step in a later round than the one it was taught in. */
  private repeat(id: string, round: number): boolean {
    if (!ONCE.has(id)) return false;
    const r = this.taughtIn.get(id);
    if (r === undefined) this.taughtIn.set(id, round);
    return r !== undefined && r !== round;
  }

  /** The closing card swaps "Skip tutorial" for the two choices. */
  private setFinal(on: boolean): void {
    this.root.classList.toggle('final', on);
    $(this.root, '.coach-acts').style.display = on ? '' : 'none';
    $(this.root, 'footer').style.display = on ? 'none' : '';
  }

  private tick(): void {
    if (this.done) return;
    const room = this.room();
    const me = room?.view?.you;
    const has = (sel: string) => !!this.ui.querySelector(sel);
    const modal = has(MODALS);
    // Enough guidance once round 3's planning is on screen (its recruits and spoils dealt with), or
    // the match is over: close with a choice, and never over a modal.
    if (!this.final && !modal) {
      const waiting = !!me && ((me.draftPicks > 0 && me.draftOptions.length > 0) || !!me.lootOffer);
      if (has('.screen.over .over-word') || ((room?.view?.round ?? 1) >= 3 && room?.phase === 'planning' && has('.planning') && !waiting)) this.final = true;
    }
    if (this.final) {
      if (modal) {
        this.root.classList.remove('on');
        this.ring([]);
        this.cur = '';
        return;
      }
      const over = has('.screen.over .over-word');
      this.setFinal(true);
      this.show({
        id: 'finish', slot: over ? 'low' : 'side', title: over ? 'That is the war' : 'You have the basics',
        text: `Deploy, level up, equip, and counter what you saw last round. The codex <kbd>F1</kbd> has every rule. ${over ? '<b>Finish tutorial</b> returns to the title.' : '<b>Keep playing</b> to break their Keep without the coach, or <b>finish</b> here and return to the title.'}`,
      });
      return;
    }
    if (me && this.seen.has('equip') && !me.stash.length) this.seen.add('equip-done');
    const s = this.pick();
    if (!s) {
      this.root.classList.remove('on');
      this.ring([]);
      this.cur = '';
      return;
    }
    this.show(s);
  }

  private show(s: Step): void {
    const fresh = s.id !== this.cur;
    this.cur = s.id;
    this.seen.add(s.id);
    const html = s.text;
    if (fresh) {
      // numbered by first appearance, so the count only ever goes up; a step that returns is a reminder
      let label = '';
      if (MAIN.includes(s.id) && !this.order.includes(s.id)) {
        this.order.push(s.id);
        const n = this.order.length;
        label = `${n} / ${s.id === 'finish' ? n : Math.max(n, MAIN.length)}`;
      }
      $(this.root, '.coach-n').textContent = label;
      $(this.root, '.coach-t').textContent = s.title;
      $(this.root, '.coach-x').innerHTML = html;
      this.root.classList.remove('pop');
      void this.root.offsetWidth;
      this.root.classList.add('pop');
      sound.hover();
      if (s.id === 'ghosts') setTimeout(() => this.seen.add('ghosts-done'), 12000);
      if (s.id === 'timing') setTimeout(() => this.seen.add('timing-done'), 14000);
    } else {
      // the same step, live numbers
      if ($(this.root, '.coach-t').textContent !== s.title) $(this.root, '.coach-t').textContent = s.title;
      if ($(this.root, '.coach-x').innerHTML !== html) $(this.root, '.coach-x').innerHTML = html;
    }
    this.root.dataset.slot = s.slot ?? 'side';
    this.root.classList.add('on');
    // a coach under the screen (the Lord pick) reserves its own height plus its margin, so nothing sits under it
    if (s.slot === 'foot') this.ui.style.setProperty('--coach-foot', `${this.root.offsetHeight + parseFloat(getComputedStyle(this.root).bottom) * 2}px`);
    this.ring(s.target ? [...this.ui.querySelectorAll(s.target)] : []);
  }

  /** Ring every element the step talks about (they are re-rendered often, so this runs each tick). */
  private ring(list: Element[]): void {
    if (list.length === this.ringed.length && list.every((n, i) => n === this.ringed[i])) return;
    for (const n of this.ringed) n.classList.remove('coach-target');
    this.ringed = list;
    for (const n of list) n.classList.add('coach-target');
  }

  private finish(toTitle: boolean): void {
    if (this.done) return;
    store.set('tutorial.done', '1');
    this.dispose();
    this.onEnd(toTitle);
  }

  dispose(): void {
    this.done = true;
    clearInterval(this.iv);
    this.ring([]);
    this.root.remove();
  }
}
