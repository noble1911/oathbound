// The guided first match. "Tutorial" on the title starts an offline, untimed match against the
// easy AI with this coach on screen: one short prompt at a time, chosen from what the player is
// looking at right now (Lord pick → the unlock draft → deploying → deploys left → Ready → the
// battle → the results → loot → equipping → levelling up → the next draft), with the control it
// talks about ringed in gold. It never blocks input; "Skip tutorial" dismisses it for good.
import type { RoomView } from '../net/protocol.ts';
import { UNITS } from '../sim/data/units.ts';
import { SLOT_UNLOCK_LEVEL } from '../sim/data/items.ts';
import { levelUpCost, MAX_SQUAD_LEVEL } from '../sim/match.ts';
import { sound } from '../audio.ts';
import { $, el, store } from './dom.ts';
import { icon } from './icons.ts';

interface Step {
  id: string;
  title: string;
  /** May contain <b> and <kbd>. */
  text: string;
  /** What to ring. */
  target?: string;
  /** Where the card sits: beside the field, top-left (Lord pick), low-left (results) or beside a modal's heading. */
  slot?: 'side' | 'top' | 'low' | 'modal';
}

const ORDER = ['lord', 'draft1', 'deploy', 'deploys', 'level', 'ready', 'battle', 'results', 'loot', 'equip', 'draft2', 'ghosts', 'done'];

export class Coach {
  readonly root: HTMLElement;
  private iv: ReturnType<typeof setInterval>;
  private cur = '';
  private seen = new Set<string>();
  private ringed: Element[] = [];
  private done = false;

  private ui: HTMLElement;
  private room: () => RoomView | null;
  private onEnd: () => void;

  constructor(ui: HTMLElement, room: () => RoomView | null, onEnd: () => void) {
    this.ui = ui;
    this.room = room;
    this.onEnd = onEnd;
    this.root = el(`<aside class="coach panel" aria-live="polite">
      <header><i>${icon('star')}</i><small>Tutorial</small><em class="coach-n"></em></header>
      <b class="coach-t"></b>
      <p class="coach-x"></p>
      <footer><button class="linkish coach-skip">Skip tutorial</button></footer>
    </aside>`);
    ui.appendChild(this.root);
    $(this.root, '.coach-skip').addEventListener('click', () => this.finish());
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
      return { id: 'lord', slot: 'top', title: 'Choose your Lord', text: 'Your Lord is a hero who fights on the field. Each one brings <b>two signature units</b>, a passive and an ability that fires by itself. <b>Marshal Aldric</b> is a forgiving first pick: he lets you deploy an extra squad every round.' };
    }
    if (has('.reveal')) return null;
    if (has('.modal.draft')) {
      const first = (v?.round ?? 1) <= 1;
      return first
        ? { id: 'draft1', slot: 'modal', target: '.dcard', title: 'Raise your companies', text: `Unlock <b>${me?.draftPicks ?? 2} more unit types</b> for the whole match. Hover a card to see what it beats and what beats it. A front line plus something ranged is a sound start.` }
        : { id: 'draft2', slot: 'modal', target: '.dcard', title: 'New recruits', text: 'Every round you unlock <b>one more unit type</b>. Pick what counters the army the enemy fielded last round.' };
    }
    if (has('.modal.loot')) return { id: 'loot', slot: 'modal', title: 'Spoils of War', text: 'After every round you claim <b>one item</b>. It works on every soldier of the squad that carries it. <b>Best on</b> names the squad it helps most; a greyed line does nothing there.' };
    if (has('.planning') && me) {
      const army = me.squads.filter((s) => s.type !== 'lord');
      const left = me.deployLimit - me.deploysUsed;
      const cheapest = Math.min(...me.unlocked.map((u) => UNITS[u].cost));
      const canDeploy = left > 0 && me.gold >= cheapest;
      if (me.ready) return null;
      if (me.draftPicks > 0 && me.draftOptions.length) return { id: 'draft-n', target: '.draft-n', title: 'Recruits are waiting', text: 'Click <b>New recruits!</b> to unlock a unit type before you plan.' };
      if (me.lootOffer) return { id: 'loot-n', target: '.loot-n', title: 'Spoils are waiting', text: 'Click <b>Spoils of War</b> to claim an item.' };
      if (me.stash.length && !this.seen.has('equip-done')) {
        if (has('.planning.item-dragging')) return { id: 'equip', target: '.stash', title: 'Drop it on a squad', text: 'Release the item over a squad on the field, or over a slot in its panel.' };
        return { id: 'equip', target: '.stash', title: 'Equip your loot', text: `<b>Drag the item</b> from your stash onto a squad or your Lord. Squads carry a Weapon from level 1, Armor from level ${armor}; your Lord has all three slots.` };
      }
      if (!army.length && canDeploy) return { id: 'deploy', target: '.ucard:not(.off)', title: 'Deploy a squad', text: 'These are your unit types. <b>Drag a card onto your half of the field</b> (inside the glowing border), or press <kbd>1</kbd> and click the ground. <kbd>Q</kbd> <kbd>E</kbd> turn it while you place.' };
      if (canDeploy) return { id: 'deploys', target: '.deploy-badge', title: `${left} deploy${left === 1 ? '' : 's'} left`, text: 'You may add only a few new squads each round, so every one counts. Put tough units in front and archers or mages behind them. <b>Your army is permanent</b>: it comes back every round.' };
      const up = army.find((s) => s.level < MAX_SQUAD_LEVEL && me.gold >= levelUpCost(s.type as never, s.level));
      if (up && !has('.planning.has-sel')) return { id: 'level', title: 'Spend what is left', text: `No deploys left, but gold remains. <b>Click one of your squads</b>, then <b>Level up</b> <kbd>U</kbd>: +25% life, +20% damage, and level ${armor} opens its Armor slot.` };
      if (up) return { id: 'level', target: '.sqpanel .lvl', title: 'Level up', text: 'Press <b>Level up</b> <kbd>U</kbd>. Levelling is unlimited, unlike deploying.' };
      if ((v?.round ?? 1) >= 2 && v?.enemy.lastArmy && !this.seen.has('ghosts-done')) return { id: 'ghosts', target: '.r-ghost', title: 'Know your enemy', text: 'The <b>red ghosts</b> show where the enemy stood last round. You never see what they do now. Hover one to read it; <kbd>Tab</kbd> hides them. Then press Ready.' };
      return { id: 'ready', target: '.ready-btn', title: 'Ready', text: 'Happy with your army? Press <b>Ready</b> <kbd>Space</kbd>. The battle starts when both commanders are ready.' };
    }
    if (has('.battle')) {
      if (has('.battle.over')) return null;
      return { id: 'battle', target: '.b-ctrl', title: 'The battle', text: 'The armies fight on their own. Whoever is left standing <b>marches on the enemy Keep</b>. <kbd>C</kbd> frees the camera, <kbd>1</kbd> <kbd>2</kbd> <kbd>4</kbd> set the speed, <kbd>End</kbd> skips.' };
    }
    if (has('.results')) return { id: 'results', slot: 'low', target: '.res-hints', title: 'Read the round', text: 'The report says <b>why</b> the round went as it did, squad by squad. Losing is not the end: the loser gets <b>catch-up gold and better loot</b>.' };
    if (has('.screen.over')) return { id: 'done', title: 'That is the war', text: 'You know the ropes now. The codex <kbd>F1</kbd> has every rule if you want the numbers.' };
    return null;
  }

  private tick(): void {
    if (this.done) return;
    const room = this.room();
    // enough guidance once round 3 planning is under way
    if ((room?.view?.round ?? 1) >= 3 && room?.phase === 'planning' && !this.seen.has('wrap')) {
      this.seen.add('wrap');
      this.show({ id: 'wrap', title: 'You have the basics', text: 'Deploy, level up, equip, counter what you saw. Break their Keep! The codex <kbd>F1</kbd> has every rule.' });
      setTimeout(() => this.finish(), 9000);
      return;
    }
    if (this.seen.has('wrap')) return;
    const me = room?.view?.you;
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
      const n = ORDER.indexOf(s.id);
      $(this.root, '.coach-n').textContent = n >= 0 ? `${n + 1} / ${ORDER.length}` : '';
      $(this.root, '.coach-t').textContent = s.title;
      $(this.root, '.coach-x').innerHTML = html;
      this.root.classList.remove('pop');
      void this.root.offsetWidth;
      this.root.classList.add('pop');
      sound.hover();
      if (s.id === 'ghosts') setTimeout(() => this.seen.add('ghosts-done'), 12000);
    } else {
      // the same step, live numbers
      if ($(this.root, '.coach-t').textContent !== s.title) $(this.root, '.coach-t').textContent = s.title;
      if ($(this.root, '.coach-x').innerHTML !== html) $(this.root, '.coach-x').innerHTML = html;
    }
    this.root.dataset.slot = s.slot ?? 'side';
    this.root.classList.add('on');
    this.ring(s.target ? [...this.ui.querySelectorAll(s.target)] : []);
  }

  /** Ring every element the step talks about (they are re-rendered often, so this runs each tick). */
  private ring(list: Element[]): void {
    if (list.length === this.ringed.length && list.every((n, i) => n === this.ringed[i])) return;
    for (const n of this.ringed) n.classList.remove('coach-target');
    this.ringed = list;
    for (const n of list) n.classList.add('coach-target');
  }

  private finish(): void {
    if (this.done) return;
    store.set('tutorial.done', '1');
    this.dispose();
    this.onEnd();
  }

  dispose(): void {
    this.done = true;
    clearInterval(this.iv);
    this.ring([]);
    this.root.remove();
  }
}
