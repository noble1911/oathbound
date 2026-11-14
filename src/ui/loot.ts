// "Spoils of War": the pick-1-of-3 (Skylady: 4) loot screen. Each drop falls as a rarity-coloured
// beam, lands, and unfolds its Diablo-style tooltip; one sting per rarity and a full flourish
// (flash, shake, choir) for a legendary. Also the unit-unlock draft modal.
import type { Item, PlayerState, UnitType } from '../sim/types.ts';
import { UNITS } from '../sim/data/units.ts';
import { sound } from '../audio.ts';
import { $, el, esc } from './dom.ts';
import { icon } from './icons.ts';
import { itemIcon, itemTooltip } from './items.ts';
import { SKILLS, canEquip, usableByText, UNIT_CLASS, UNIT_CLASSES, CLASS_NAME } from '../sim/data/skills.ts';
import { bestFit, counters, RARITY_LABEL, rarityRank, SLOT_LABEL, slotOpen, tagsOf, TAG_LABEL, unitName, type Fit } from './gamedata.ts';
import { SLOT_UNLOCK_LEVEL } from '../sim/data/items.ts';
import { crest, unitTooltip } from './units.ts';
import { tip } from './dom.ts';

/**
 * Where an item would do the most good right now (bestFit: the biggest usefulness gain among squads
 * whose slot is open; affixes that do nothing on a squad count for nothing there). The loot card
 * compares against that squad, not always the Lord, and greys the lines that are dead on it.
 */
function fitLine(item: Item, me: PlayerState, fit: Fit | null): string {
  const slot = SLOT_LABEL[item.slot].toLowerCase();
  if (fit) {
    const who = esc(unitName(fit.squad.type, me.lord));
    const dead = fit.dead ? ` <em>${fit.dead} line${fit.dead === 1 ? '' : 's'} wasted</em>` : '';
    return `<span class="fit good">${icon('ready')}Best on: <b>${who}</b>${fit.replaces ? ' (replaces its ' + slot + ')' : ''}${dead}</span>`;
  }
  // a skill item nobody in the army has the class for
  if (item.skill && !me.squads.some((q) => canEquip(item, q.type, me.lord))) return `<span class="fit none">${icon('lock')}Only ${esc(usableByText(item.skill))} can use ${esc(SKILLS[item.skill].name)}: nobody in your army can yet</span>`;
  const open = me.squads.some((s) => slotOpen(s, item.slot));
  if (!open) return `<span class="fit none">${icon('lock')}No open ${slot} slot yet: squads open it at level ${SLOT_UNLOCK_LEVEL[item.slot]}</span>`;
  return `<span class="fit none">${icon('bag')}No upgrade for your army right now</span>`;
}

export class LootModal {
  readonly root: HTMLElement;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private chosen = -1;
  offerKey: string;

  constructor(host: HTMLElement, offer: Item[], me: PlayerState, onPick: (i: number) => void, onClose: () => void) {
    this.offerKey = offer.map((i) => i.id).join(',');
    const best = Math.max(...offer.map((i) => rarityRank(i.rarity)));
    const lordSq = me.squads.find((s) => s.type === 'lord');
    this.root = el(`<div class="modal loot ${best === 3 ? 'has-leg' : ''}">
      <div class="loot-bg"></div>
      <header class="loot-head">
        <small class="eyebrow">After the battle</small>
        <h2>Spoils of War</h2>
        <p>Choose one. It goes to your stash; equip it on a squad or your Lord. <span class="loot-same">Your opponent is offered the same items.</span></p>
      </header>
      <div class="loot-row n${offer.length}">
        ${offer
          .map((it, i) => {
            const fit = bestFit(it, me.squads, me.lord);
            // judged against the squad it suits best (else the Lord, who always has the slot, if the Lord can use it)
            const on = fit?.squad ?? (lordSq && canEquip(it, 'lord', me.lord) ? lordSq : null);
            const cur = on?.items[it.slot] ?? null;
            const onName = on ? unitName(on.type, me.lord) : '';
            const cmp = on ? { compare: cur, compareLabel: cur ? `vs ${onName}'s ${SLOT_LABEL[it.slot].toLowerCase()}` : `On ${onName} (empty ${SLOT_LABEL[it.slot].toLowerCase()} slot)`, on: { type: on.type, lord: me.lord } } : {};
            return `<div class="drop r-${it.rarity}" data-i="${i}" style="--d:${i * 0.45 + 0.3}s">
              <div class="beam"></div><div class="glow"></div>
              <div class="drop-icon">${itemIcon(it, { size: 'lg' })}<span class="drop-rar">${RARITY_LABEL[it.rarity]} ${SLOT_LABEL[it.slot]}</span></div>
              <div class="drop-tip">${itemTooltip(it, cmp)}</div>
              <div class="drop-fit">${fitLine(it, me, fit)}</div>
              <button class="btn primary take">Claim</button>
            </div>`;
          })
          .join('')}
      </div>
      <footer class="loot-foot"><button class="btn later">Decide later</button><small class="muted">If you don't choose, the first item goes to your stash when planning ends.</small></footer>
    </div>`);
    host.appendChild(this.root);
    // staggered reveal, sound on landing
    offer.forEach((it, i) => {
      const delay = (i * 0.45 + 0.3) * 1000 + 520;
      this.timers.push(
        setTimeout(() => {
          sound.lootReveal(it.rarity);
          const d = this.root.querySelector(`.drop[data-i="${i}"]`)!;
          d.classList.add('landed');
          if (it.rarity === 'legendary') {
            this.root.classList.remove('flash');
            void this.root.offsetWidth;
            this.root.classList.add('flash');
          }
        }, it.rarity === 'legendary' ? delay - 700 : delay),
      );
    });
    this.root.querySelectorAll<HTMLElement>('.drop').forEach((d) => {
      const i = Number(d.dataset.i);
      d.addEventListener('pointerenter', () => sound.hover());
      d.querySelector('.take')!.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.chosen >= 0) return;
        this.chosen = i;
        sound.equip();
        this.root.classList.add('picked');
        d.classList.add('chosen');
        onPick(i);
        this.timers.push(setTimeout(onClose, 650));
      });
    });
    $(this.root, '.later').addEventListener('click', () => {
      sound.click();
      onClose();
    });
  }

  dispose(): void {
    this.timers.forEach(clearTimeout);
    this.root.remove();
  }
}

/** The recruit picker's order: by class (line, ranged, casters, riders, fliers, siege, giants), then by cost. */
export function draftOrder(options: UnitType[]): UnitType[] {
  return [...options].sort((x, y) => UNIT_CLASSES.indexOf(UNIT_CLASS[x]) - UNIT_CLASSES.indexOf(UNIT_CLASS[y]) || UNITS[x].cost - UNITS[y].cost || options.indexOf(x) - options.indexOf(y));
}

export interface DraftLine { label: 'Beats' | 'Supports' | 'Role' | 'Fears'; tone: 'good' | 'bad' | 'info'; text: string; tip: string }

/**
 * The two lines under a recruit card, never empty: what the unit is for (the squads it beats; for a
 * healer what it supports; for a unit with a damage bonus but no hard counter, the bonus), and what
 * it fears (or that nothing counters it outright).
 */
export function draftLines(u: UnitType): [DraftLine, DraftLine] {
  const d = UNITS[u];
  const c = counters(u);
  const short = (list: UnitType[]): string => list.slice(0, 3).map((x) => UNITS[x].name.replace(/ (Knights|Riders)$/, '')).join(', ');
  const full = (list: UnitType[]): string => list.map((x) => UNITS[x].name).join(', ');
  let first: DraftLine;
  if (d.traits.includes('healer')) first = { label: 'Supports', tone: 'good', text: 'Heals nearby squads', tip: 'Restores the life of wounded allies in range instead of fighting on the line' };
  else if (c.strongVs.length) first = { label: 'Beats', tone: 'good', text: short(c.strongVs), tip: full(c.strongVs) };
  else {
    // no hard counter of its own: say what its damage bonus is against (Archers: fliers), else its job
    const bonus = (Object.entries(d.effective ?? {}) as [keyof typeof TAG_LABEL, number][]).filter(([, m]) => m > 100).map(([tag, m]) => `${tag === 'flier' ? 'Fliers' : tag === 'infantry' ? 'Infantry' : `${TAG_LABEL[tag]} units`} ×${(m / 100).toFixed(m % 100 ? 1 : 0)}`);
    const ranged = d.range >= 400 ? (bonus.length ? '' : 'Anything in range, fliers included') : '';
    first = bonus.length ? { label: 'Beats', tone: 'good', text: bonus.join(', '), tip: `Deals bonus damage to ${bonus.join(' and ')}${d.range >= 400 ? '; one of the few units that can hit fliers' : ''}` }
      : ranged ? { label: 'Beats', tone: 'good', text: ranged, tip: 'A ranged unit: it can hit fliers, and whatever it outranges' }
      : { label: 'Role', tone: 'info', text: d.role, tip: d.role };
  }
  const second: DraftLine = c.weakTo.length ? { label: 'Fears', tone: 'bad', text: short(c.weakTo), tip: full(c.weakTo) } : { label: 'Fears', tone: 'info', text: 'No hard counter', tip: 'No unit counters it outright' };
  return [first, second];
}

/**
 * "Recruit a new unit type": a free choice of any eligible unit (both commanders get the same
 * options). A grid of unit cards sorted by class, each with its role, cost and what it beats and
 * fears. If planning ends first the sim takes the first option, which is marked on its card.
 */
export class DraftModal {
  readonly root: HTMLElement;
  key: string;

  /** `fresh`: the draft just appeared (not reopened from the notice): sting + "New recruits!" ribbon. */
  constructor(host: HTMLElement, me: PlayerState, round: number, onPick: (u: UnitType) => void, onClose: () => void, fresh = false) {
    this.key = me.draftOptions.join(',') + ':' + me.draftPicks;
    const n = me.draftPicks;
    const fallback = me.draftOptions[0];
    const card = (u: UnitType): string => {
      const d = UNITS[u];
      const row = (l: DraftLine): string => `<span class="dc-ctr ${l.tone}"><small>${l.label}</small><span class="dc-m"><span data-tip="${esc(l.tip)}">${esc(l.text)}</span></span></span>`;
      return `<button class="dcard" data-u="${u}">
        ${u === fallback ? '<em class="dc-def" data-tip="Recruited for you if planning ends before you choose">Default</em>' : ''}
        ${crest(u, null, 'lg')}
        <b>${esc(d.name)}</b>
        <small>${esc(d.role)} · ${esc(CLASS_NAME[UNIT_CLASS[u]])}</small>
        <span class="dc-cost">${icon('gold')}${d.cost} <em>×${d.squadSize}</em><span class="dc-tags">${tagsOf(u).map((g) => `<i data-tip="${esc(TAG_LABEL[g])}">${icon(g)}</i>`).join('')}</span></span>
        ${draftLines(u).map(row).join('')}
      </button>`;
    };
    const opts = draftOrder(me.draftOptions);
    this.root = el(`<div class="modal draft${fresh ? ' fresh' : ''}" data-n="${opts.length}">
      ${fresh ? '<div class="draft-ribbon">New recruits!</div>' : ''}
      <header class="loot-head"><small class="eyebrow">${round <= 1 ? 'Muster' : `Round ${round}`}</small>
        <h2>Recruit a new unit type</h2>
        <p>Choose <b>any ${n > 1 ? n : 'one'}</b> of these ${opts.length}. ${n > 1 ? 'They join' : 'It joins'} your shop for the whole match. <span class="loot-same">Your opponent has the same choice.</span></p>
      </header>
      <div class="draft-row" style="--cols:${Math.min(5, Math.max(3, Math.ceil(opts.length / 2)))}">${opts.map(card).join('')}</div>
      <div class="draft-have"><small>Already yours</small>${me.unlocked.map((u) => `<span class="uchip">${crest(u, null, 'sm')}${esc(UNITS[u].name)}</span>`).join('')}</div>
      <footer class="loot-foot"><button class="btn later">Later</button><small class="muted">${fallback ? `If planning ends first, <b>${esc(UNITS[fallback].name)}</b> is recruited for you.` : ''}</small></footer>
    </div>`);
    host.appendChild(this.root);
    if (fresh) sound.draft();
    else sound.open();
    this.root.querySelectorAll<HTMLElement>('.dcard').forEach((c) => {
      const u = c.dataset.u as UnitType;
      tip(c, () => unitTooltip(u));
      c.addEventListener('pointerenter', () => sound.hover());
      c.addEventListener('click', () => {
        sound.pick();
        c.classList.add('chosen');
        onPick(u);
      });
    });
    $(this.root, '.later').addEventListener('click', () => {
      sound.click();
      onClose();
    });
  }

  dispose(): void {
    this.root.remove();
  }
}
