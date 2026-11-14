// "Spoils of War": the pick-1-of-3 (Skylady: 4) loot screen. Each drop falls as a rarity-coloured
// beam, lands, and unfolds its Diablo-style tooltip; one sting per rarity and a full flourish
// (flash, shake, choir) for a legendary. Also the unit-unlock draft modal.
import type { Item, PlayerState, Squad, UnitType } from '../sim/types.ts';
import { UNITS } from '../sim/data/units.ts';
import { sound } from '../audio.ts';
import { $, el, esc } from './dom.ts';
import { icon } from './icons.ts';
import { itemIcon, itemTooltip } from './items.ts';
import { RARITY_LABEL, rarityRank, SLOT_LABEL, slotOpen, unitName } from './gamedata.ts';
import { crest, unitTooltip } from './units.ts';
import { tip } from './dom.ts';

/** Best squad to suggest for an item: the Lord if its slot is empty, else the first open empty slot. */
function suggest(item: Item, squads: Squad[]): Squad | null {
  return squads.find((s) => slotOpen(s, item.slot) && !s.items[item.slot]) ?? null;
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
        <small class="eyebrow">${me.lostLast ? 'Fortune favours the fallen' : 'After the battle'}</small>
        <h2>Spoils of War</h2>
        <p>${me.lostLast ? 'You lost the last battle: this offer rolled <b>one rarity tier higher</b>.' : 'Choose one. It goes to your stash; equip it on a squad or your Lord.'}</p>
      </header>
      <div class="loot-row n${offer.length}">
        ${offer
          .map((it, i) => {
            const fit = suggest(it, me.squads);
            const cur = lordSq?.items[it.slot] ?? null;
            return `<div class="drop r-${it.rarity}" data-i="${i}" style="--d:${i * 0.45 + 0.3}s">
              <div class="beam"></div><div class="glow"></div>
              <div class="drop-icon">${itemIcon(it, { size: 'lg' })}<span class="drop-rar">${RARITY_LABEL[it.rarity]} ${SLOT_LABEL[it.slot]}</span></div>
              <div class="drop-tip">${itemTooltip(it, lordSq ? { compare: cur, compareLabel: cur ? `vs your Lord's ${SLOT_LABEL[it.slot].toLowerCase()}` : `Your Lord's ${SLOT_LABEL[it.slot].toLowerCase()} slot is empty` } : {})}</div>
              <div class="drop-fit">${fit ? `${icon('ready')}Fits: ${esc(unitName(fit.type, me.lord))}` : `${icon('lock')}No open ${SLOT_LABEL[it.slot].toLowerCase()} slot yet`}</div>
              <button class="btn primary take">Claim</button>
            </div>`;
          })
          .join('')}
      </div>
      <footer class="loot-foot"><button class="btn later">Decide later</button><small class="muted">Unclaimed spoils go to your stash (the first item) when planning ends.</small></footer>
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

export class DraftModal {
  readonly root: HTMLElement;
  key: string;

  constructor(host: HTMLElement, me: PlayerState, round: number, onPick: (u: UnitType) => void, onClose: () => void) {
    this.key = me.draftOptions.join(',') + ':' + me.draftPicks;
    const first = round <= 1;
    this.root = el(`<div class="modal draft">
      <header class="loot-head"><small class="eyebrow">${first ? 'Muster' : `Round ${round}`}</small>
        <h2>${first ? 'Raise your companies' : 'New recruits'}</h2>
        <p>${first ? `Unlock <b>${me.draftPicks}</b> more unit type${me.draftPicks > 1 ? 's' : ''} for the whole match, alongside your Lord's signature units.` : 'Unlock one more unit type. Choose what counters your rival.'}</p>
      </header>
      <div class="draft-row">
        ${me.draftOptions
          .map(
            (u) => `<button class="dcard" data-u="${u}">${crest(u, null, 'lg')}<b>${esc(UNITS[u].name)}</b><small>${esc(UNITS[u].role)}</small>
              <span class="dc-cost">${icon('gold')}${UNITS[u].cost} <em>×${UNITS[u].squadSize}</em></span></button>`,
          )
          .join('')}
      </div>
      <div class="draft-have"><small>Unlocked</small>${me.unlocked.map((u) => `<span class="uchip">${crest(u, null, 'sm')}${esc(UNITS[u].name)}</span>`).join('')}</div>
      <footer class="loot-foot"><button class="btn later">Later</button><small class="muted">If planning ends first, the first option is unlocked.</small></footer>
    </div>`);
    host.appendChild(this.root);
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
