// Faction and Lord pick, one screen: three faction banners (name, blurb, colours, lineup), the
// chosen faction's identity and mechanics, then its four Lords (one per role: infantry, magic,
// armour, fliers; FACTIONS[f].lords is in that order) with the phase countdown. Choosing a banner sends {t:'pickFaction'}
// and can be changed until a Lord is picked; picking a Lord sends {t:'pickLord'}. Picks stay hidden
// until both players have chosen; the reveal (yours vs theirs) plays as the match moves into round 1.
//
// The Lords are the picture: each card is the portrait over a name plate (title, role, name, counter
// line). What a Lord does (passive, ability, signature units, stats) is ONE sheet under the row, for
// the Lord in view: the card under the mouse or with keyboard focus, or the one tapped. A mouse click
// or Enter on a card picks it; a tap only brings it into view, and the sheet's button picks.
import type { FactionId, LordId, UnitType } from '../sim/types.ts';
import type { RoomView } from '../net/protocol.ts';
import { LORDS, LORD_ROLE, LORD_ROLE_NAME } from '../sim/data/lords.ts';
import { UNITS } from '../sim/data/units.ts';
import { FACTIONS, FACTION_IDS, factionOfLord } from '../sim/data/factions.ts';
import { unitSkills } from '../sim/data/skills.ts';
import { sound } from '../audio.ts';
import { playLordLine } from '../audio/voice.ts';
import { $, el, esc, secsLeft, store } from './dom.ts';
import { icon } from './icons.ts';
import { classLine, crest, LORD_HUE } from './units.ts';
import { art } from './art.ts';
import { soldierStats, WEAPON_LABEL } from './gamedata.ts';

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

/**
 * What sets a faction apart on the field, read from its units' own abilities: raise dead, ethereal,
 * plague, life drain, sun blessing, whirlwind, regeneration, howdah archers, healing. A faction
 * with no healer says so.
 */
const MECHANIC_IDS = ['raise', 'ethereal', 'plague', 'lifesteal', 'bless', 'slowing', 'regen', 'howdah', 'sunbeam', 'heal'];
export interface FactionMechanic { id: string; name: string; text: string; units: UnitType[]; tone: 'good' | 'bad' }
export function factionMechanics(f: FactionId): FactionMechanic[] {
  const out = new Map<string, FactionMechanic>();
  for (const u of FACTIONS[f].units) {
    for (const k of unitSkills(u)) {
      if (!MECHANIC_IDS.includes(k.id)) continue;
      const m = out.get(k.id);
      if (m) m.units.push(u);
      else out.set(k.id, { id: k.id, name: k.name, text: k.text, units: [u], tone: 'good' });
    }
  }
  const list = MECHANIC_IDS.map((id) => out.get(id)).filter((m): m is FactionMechanic => !!m);
  if (!out.has('heal')) list.push({ id: 'no_heal', name: 'No healers', text: 'This faction has no unit that heals. Its losses are answered another way.', units: [], tone: 'bad' });
  return list;
}

/** The two colours a faction is known by in the HUD (a small band; team blue and red stay the sides' colours). */
export function factionAccent(f: FactionId): [string, string] {
  const c = FACTIONS[f].colors;
  return f === 'kingdom' ? [c[1], c[0]] : f === 'ashen' ? [c[0], c[2]] : [c[2], c[1]];
}

const FOOT = 'Both players may pick the same faction and Lord. Picks are revealed together.';
const FOOT_TIMED = ' If the timer runs out, a Lord is chosen for you.';

export class LordPickScreen {
  readonly root: HTMLElement;
  private timer: HTMLElement;
  private iv: ReturnType<typeof setInterval>;
  private picked: LordId | null = null;
  /** the Lord whose sheet is shown */
  private shown: LordId | null = null;
  private pick: (l: LordId) => void;
  private faction: FactionId;
  private endsAt = 0;
  private spectator = false;
  private pickFaction: ((f: FactionId) => void) | null;

  /** `initial`: the faction shown first (the tutorial opens on the Kingdom); else the one played last. */
  constructor(ui: HTMLElement, pick: (l: LordId) => void, spectator: boolean, pickFaction: ((f: FactionId) => void) | null = null, initial: FactionId | null = null) {
    const key = art('keyart');
    const stored = store.get('faction') as FactionId | null;
    this.faction = initial ?? (stored && FACTION_IDS.includes(stored) ? stored : 'kingdom');
    this.pickFaction = pickFaction;
    this.pick = pick;
    this.root = el(`<div class="screen lordpick" ${key ? `style="--key:url(${key})"` : ''}>
      <header class="lp-head"><small class="eyebrow">Choose your banner and your Lord</small><h2>Who leads your host?</h2>
        <div class="lp-timer hidden">${icon('timer')}<b>30</b></div></header>
      <div class="lp-factions" role="radiogroup" aria-label="Faction">${FACTION_IDS.map((f) => this.banner(f)).join('')}</div>
      <div class="lp-ident"></div>
      <div class="lp-cards"><div class="lp-row"></div></div>
      <section class="lp-detail parch" aria-label="The Lord in view"><div class="ld-stack"></div>
        <button class="btn primary lp-go" type="button"></button></section>
      <p class="lp-foot muted">${spectator ? 'The commanders are choosing their factions and Lords…' : FOOT}</p>
    </div>`);
    this.spectator = spectator;
    this.timer = $(this.root, '.lp-timer b');
    ui.appendChild(this.root);
    if (spectator) this.root.classList.add('spect');
    this.root.querySelectorAll<HTMLElement>('.fcard').forEach((b) => {
      b.addEventListener('pointerenter', () => sound.hover());
      b.addEventListener('click', () => {
        if (this.picked || this.spectator) return;
        sound.click();
        this.setFaction(b.dataset.faction as FactionId, true);
      });
    });
    const cards = $(this.root, '.lp-row');
    const cardOf = (e: Event): HTMLElement | null => (e.target as HTMLElement).closest<HTMLElement>('.lcard');
    // a finger has no hover: its tap brings the Lord into view, and the sheet's button picks
    let touch = false;
    cards.addEventListener('pointerdown', (e) => { touch = e.pointerType !== 'mouse'; });
    cards.addEventListener('keydown', (e) => {
      touch = false;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const all = [...cards.querySelectorAll<HTMLElement>('.lcard')];
      const i = all.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      e.preventDefault();
      all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]!.focus();
    });
    cards.addEventListener('click', (e) => {
      const c = cardOf(e);
      if (!c) return;
      const id = c.dataset.lord as LordId;
      if (this.picked || this.spectator || touch) {
        if (this.shown !== id && !this.picked) sound.click();
        this.show(id);
        return;
      }
      this.choose(id);
    });
    cards.addEventListener('pointerover', (e) => {
      const c = cardOf(e);
      if (!c || c.contains(e.relatedTarget as Node | null)) return;
      sound.hover();
      if (e.pointerType === 'mouse') this.show(c.dataset.lord as LordId);
    });
    cards.addEventListener('focusin', (e) => {
      const c = cardOf(e);
      // focus that a pointer gave is the click's business (a tap shows, a mouse click picks)
      if (c?.matches(':focus-visible')) this.show(c.dataset.lord as LordId);
    });
    $(this.root, '.lp-go').addEventListener('click', () => { if (this.shown) this.choose(this.shown); });
    this.setFaction(this.faction, false);
    this.iv = setInterval(() => this.tick(), 1000);
  }

  private choose(id: LordId): void {
    if (this.picked || this.spectator) return;
    sound.unlock();
    sound.deploy();
    this.picked = id;
    this.root.classList.add('has-pick');
    this.root.querySelector(`.lcard[data-lord="${id}"]`)?.classList.add('chosen');
    this.show(id);
    store.set('faction', factionOfLord(id));
    this.pick(id);
    playLordLine(id, 'pick', { delay: 0.25 });
  }

  /** Bring a Lord's sheet into view (once a Lord is picked, the sheet stays on that Lord). */
  private show(id: LordId): void {
    if (this.picked) id = this.picked;
    this.shown = id;
    this.root.querySelectorAll<HTMLElement>('.lcard, .ld').forEach((n) => n.classList.toggle('on', n.dataset.lord === id));
    const go = $(this.root, '.lp-go') as HTMLButtonElement;
    go.disabled = !!this.picked;
    go.innerHTML = this.picked ? `${icon('ready')}<span>${esc(LORDS[id].name)} leads</span>` : `<small>Lead with</small><span>${esc(LORDS[id].name)}</span>`;
  }

  private banner(f: FactionId): string {
    const F = FACTIONS[f];
    const show = F.units.slice(0, 7);
    return `<button class="fcard" data-faction="${f}" role="radio" aria-checked="false" style="--f1:${F.colors[0]};--f2:${F.colors[1]};--f3:${F.colors[2]}">
      <i class="fc-band"></i>
      <b>${esc(F.name)}</b>
      <small>${esc(F.blurb)}</small>
      <span class="fc-line">${show.map((u) => `<i data-tip="${esc(UNITS[u].name)}">${crest(u, null, 'sm')}</i>`).join('')}${F.units.length > show.length ? `<em>+${F.units.length - show.length}</em>` : ''}</span>
      <span class="fc-n">${F.lords.length} Lord${F.lords.length === 1 ? '' : 's'} · ${F.units.length} unit types</span>
    </button>`;
  }

  /** Show a faction's identity and Lords; `send` tells the server (a player's own click). */
  private setFaction(f: FactionId, send: boolean): void {
    this.faction = f;
    const F = FACTIONS[f];
    this.root.dataset.faction = f;
    this.root.querySelectorAll<HTMLElement>('.fcard').forEach((b) => {
      const on = b.dataset.faction === f;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    const mech = factionMechanics(f);
    $(this.root, '.lp-ident').innerHTML = `<p><b>${esc(F.short)}.</b> ${esc(F.identity)}</p>
      <div class="lp-mech">${mech.map((m) => `<span class="tg ${m.tone}" data-tip="${esc(m.units.length ? `${m.units.map((u) => UNITS[u].name).join(', ')}: ${m.text}` : m.text)}">${esc(m.name)}</span>`).join('')}</div>`;
    const cards = $(this.root, '.lp-row');
    cards.style.setProperty('--n', String(F.lords.length));
    cards.innerHTML = F.lords.map((id) => this.card(id)).join('');
    $(this.root, '.ld-stack').innerHTML = F.lords.map((id) => this.sheet(id)).join('');
    if (this.picked) cards.querySelector(`.lcard[data-lord="${this.picked}"]`)?.classList.add('chosen');
    this.show(this.picked ?? F.lords[0]!);
    if (send) {
      store.set('faction', f);
      this.pickFaction?.(f);
    }
  }

  /** A Lord's card: the portrait, and a plate with who this is and where they stand on the counter wheel. */
  private card(id: LordId): string {
    const L = LORDS[id];
    return `<button class="lcard" type="button" data-lord="${id}" aria-describedby="ld-${id}" style="--hue:${LORD_HUE[id]}">
      ${lordPortrait(id)}
      <div class="lc-name"><small>${esc(L.title)}</small><b>${esc(L.name)}</b>
      ${classLine('lord', id)}</div>
      <div class="lc-seal">${icon('ready')}<span>Chosen</span></div>
    </button>`;
  }

  /** A Lord's sheet: what they do. A faction's sheets share one cell, so the sheet keeps its height as the Lord in view changes. */
  private sheet(id: LordId): string {
    const L = LORDS[id];
    const s = soldierStats('lord', 1, id);
    return `<article class="ld" id="ld-${id}" data-lord="${id}" style="--hue:${LORD_HUE[id]}">
      <div class="ld-id"><small>${esc(L.title)} <i class="lc-role">${esc(LORD_ROLE_NAME[LORD_ROLE[id]])}</i></small><b>${esc(L.name)}</b>
        <span class="lc-wpn">${icon(L.weapon)}${WEAPON_LABEL[L.weapon]}</span>
        <div class="lc-stats"><span data-tip="Life">${icon('heart')}${s.hp}</span><span data-tip="Damage per second">${icon('sword')}${s.dps.toFixed(0)}</span><span data-tip="Armor">${icon('shield')}${s.armor}%</span><span data-tip="Range">${icon('bow')}${s.range >= 400 ? (s.range / 100).toFixed(0) + 'm' : 'melee'}</span></div></div>
      <div class="ld-text">
        <div class="lc-block"><small>Passive</small><p>${esc(L.passive)}</p></div>
        <div class="lc-block abil"><small>${icon('lightning')}${esc(L.abilityName)}</small><p>${esc(L.abilityText)}</p></div></div>
      <div class="lc-sig"><small>Signature units</small><div>${L.signature.map((u) => `<span class="uchip">${crest(u, null, 'sm')}${esc(UNITS[u].name)}</span>`).join('')}</div></div>
    </article>`;
  }

  private tick(): void {
    // untimed (the tutorial): no countdown
    this.timer.parentElement!.classList.toggle('hidden', !this.endsAt);
    if (!this.endsAt) return;
    const s = secsLeft(this.endsAt);
    this.timer.textContent = String(s);
    this.timer.parentElement!.classList.toggle('hurry', s <= 5 && !this.picked);
  }

  update(room: RoomView): void {
    this.endsAt = room.phaseEndsAt ? room.phaseEndsAt - room.serverNow + Date.now() : 0;
    const me = room.view?.you;
    if (me?.lord && !this.picked) {
      // picked elsewhere (a rejoin, or the timer chose): show that Lord's faction with its card sealed
      this.picked = me.lord;
      this.root.classList.add('has-pick');
      this.setFaction(factionOfLord(me.lord), false);
    }
    const foot = $(this.root, '.lp-foot');
    // the timer is only mentioned when there is one (the tutorial has none)
    if (!this.picked && !this.spectator) foot.textContent = FOOT + (this.endsAt ? FOOT_TIMED : '');
    if (this.picked) foot.textContent = room.view?.enemy.ready || room.view?.enemy.lord ? 'Your rival has chosen. Revealing…' : 'Waiting for your rival to choose…';
    this.tick();
  }

  dispose(): void {
    clearInterval(this.iv);
    this.root.remove();
  }
}
