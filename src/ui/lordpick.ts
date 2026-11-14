// Lord pick: four Lord cards (portrait, signature units, passive, ability, stats) with the phase
// countdown. Picks stay hidden until both players have chosen; the reveal (yours vs theirs) plays
// as the match moves into round 1.
import type { LordId } from '../sim/types.ts';
import type { RoomView } from '../net/protocol.ts';
import { LORDS, LORD_IDS } from '../sim/data/lords.ts';
import { UNITS } from '../sim/data/units.ts';
import { sound } from '../audio.ts';
import { $, el, esc, secsLeft } from './dom.ts';
import { icon } from './icons.ts';
import { crest, LORD_HUE } from './units.ts';
import { art } from './art.ts';
import { dps, soldierStats, WEAPON_LABEL } from './gamedata.ts';

export function lordPortrait(id: LordId, cls = ''): string {
  const L = LORDS[id];
  const img = art(`lord_${id}`);
  if (img) return `<div class="lport art ${cls}" style="--hue:${LORD_HUE[id]};--img:url(${img})"><div class="lport-img"></div></div>`;
  // placeholder portrait: heraldic field, the Lord's weapon and initial, until rendered portraits land
  return `<div class="lport ${cls}" style="--hue:${LORD_HUE[id]}">
    <div class="lport-rays"></div>
    <div class="lport-sigil">${icon(L.weapon)}</div>
    <div class="lport-init">${esc(L.name[0]!)}</div>
  </div>`;
}

export class LordPickScreen {
  readonly root: HTMLElement;
  private timer: HTMLElement;
  private iv: ReturnType<typeof setInterval>;
  private picked: LordId | null = null;
  private endsAt = 0;

  constructor(ui: HTMLElement, pick: (l: LordId) => void, spectator: boolean) {
    this.root = el(`<div class="screen lordpick">
      <header class="lp-head"><small class="eyebrow">Choose your Lord</small><h2>Who leads your host?</h2>
        <div class="lp-timer">${icon('timer')}<b>30</b></div></header>
      <div class="lp-cards">${LORD_IDS.map((id) => this.card(id)).join('')}</div>
      <p class="lp-foot muted">${spectator ? 'The commanders are choosing their Lords…' : 'Both players may pick the same Lord. Picks are revealed together.'}</p>
    </div>`);
    this.timer = $(this.root, '.lp-timer b');
    ui.appendChild(this.root);
    if (!spectator)
      this.root.querySelectorAll<HTMLElement>('.lcard').forEach((c) =>
        c.addEventListener('click', () => {
          if (this.picked) return;
          sound.unlock();
          sound.deploy();
          this.picked = c.dataset.lord as LordId;
          this.root.classList.add('has-pick');
          c.classList.add('chosen');
          pick(this.picked);
        }),
      );
    else this.root.classList.add('spect');
    this.root.querySelectorAll('.lcard').forEach((c) => c.addEventListener('pointerenter', () => sound.hover()));
    this.iv = setInterval(() => this.tick(), 1000);
  }

  private card(id: LordId): string {
    const L = LORDS[id];
    const s = soldierStats('lord', 1, id);
    return `<button class="lcard" data-lord="${id}" style="--hue:${LORD_HUE[id]}">
      ${lordPortrait(id)}
      <div class="lc-name"><small>${esc(L.title)}</small><b>${esc(L.name)}</b><span class="lc-wpn">${icon(L.weapon)}${WEAPON_LABEL[L.weapon]}</span></div>
      <div class="lc-sig"><small>Signature units</small><div>${L.signature.map((u) => `<span class="uchip">${crest(u, null, 'sm')}${esc(UNITS[u].name)}</span>`).join('')}</div></div>
      <div class="lc-block"><small>Passive</small><p>${esc(L.passive)}</p></div>
      <div class="lc-block abil"><small>${icon('lightning')}${esc(L.abilityName)}</small><p>${esc(L.abilityText)}</p></div>
      <div class="lc-stats"><span data-tip="Life">${icon('heart')}${s.hp}</span><span data-tip="Damage per second">${icon('sword')}${dps(s.dmg, s.attackTicks).toFixed(0)}</span><span data-tip="Armor">${icon('shield')}${s.armor}%</span><span data-tip="Range">${icon('bow')}${s.range >= 400 ? (s.range / 100).toFixed(0) + 'm' : 'melee'}</span></div>
      <div class="lc-seal">${icon('ready')}<span>Chosen</span></div>
    </button>`;
  }

  private tick(): void {
    const s = secsLeft(this.endsAt);
    this.timer.textContent = String(s);
    this.timer.parentElement!.classList.toggle('hurry', s <= 5 && !this.picked);
  }

  update(room: RoomView): void {
    this.endsAt = room.phaseEndsAt - room.serverNow + Date.now();
    const me = room.view?.you;
    if (me?.lord && !this.picked) {
      this.picked = me.lord;
      this.root.classList.add('has-pick');
      this.root.querySelector(`.lcard[data-lord="${me.lord}"]`)?.classList.add('chosen');
    }
    const foot = $(this.root, '.lp-foot');
    if (this.picked) foot.textContent = room.view?.enemy.ready || room.view?.enemy.lord ? 'Your rival has chosen. Revealing…' : 'Waiting for your rival to choose…';
    this.tick();
  }

  dispose(): void {
    clearInterval(this.iv);
    this.root.remove();
  }
}

