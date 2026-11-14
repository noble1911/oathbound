// Title (name; Play vs AI with difficulty; the guided Tutorial; create a PvP room; join or spectate
// with a code; ?room=CODE fills the code in; the rules codex) over the painted key art, and the
// lobby (VS seat cards, invite link, spectators, host swap and Start). Neither draws any 3D: the
// battlefield loads behind the title, which shows its progress and never waits for it.
import type { AiLevel, RoomView, SeatInfo } from '../net/protocol.ts';
import { sound } from '../audio.ts';
import { $, el, esc, store } from './dom.ts';
import { icon } from './icons.ts';
import { art } from './art.ts';
import { toggleRules } from './rules.ts';

export interface TitleActions {
  vsAI(name: string, level: AiLevel): void;
  create(name: string): void;
  join(code: string, name: string, spectate: boolean): void;
  offline(level: AiLevel): void;
  /** The guided first match (offline, untimed, easy AI, with the coach). */
  tutorial(name: string): void;
}

export class TitleScreen {
  readonly root: HTMLElement;
  private err: HTMLElement;
  private busy = false;

  constructor(ui: HTMLElement, a: TitleActions) {
    const code = (new URLSearchParams(location.search).get('room') ?? '').toUpperCase().slice(0, 4);
    const name = store.get('name') ?? '';
    const level = (store.get('ai') as AiLevel) || 'normal';
    const fresh = store.get('tutorial.done') !== '1' && !code;
    const key = art('keyart');
    this.root = el(`
      <div class="screen title" ${key ? `style="--key:url(${key})"` : ''}>
        <div class="title-art"></div>
        <div class="title-vignette"></div>
        <header class="title-head">
          <div class="title-sigil">${icon('sword2')}</div>
          <h1 class="title-word"><span>O</span>athbound</h1>
          <p class="title-tag">Raise your banners. Break their Keep.</p>
        </header>
        <div class="title-menu panel">
          <label class="field"><span>Commander name</span><input class="name" maxlength="16" placeholder="Wanderer" value="${esc(name)}" autocomplete="nickname" spellcheck="false"></label>
          <div class="menu-block">
            <button class="btn ${code ? '' : 'cta'} big vsai">${icon('ai')}<span>Play vs AI</span></button>
            <div class="seg diff" role="radiogroup" aria-label="AI difficulty">
              ${(['easy', 'normal', 'hard'] as AiLevel[]).map((l) => `<button data-lvl="${l}" class="${l === level ? 'on' : ''}" role="radio" aria-checked="${l === level}">${l[0]!.toUpperCase() + l.slice(1)}</button>`).join('')}
            </div>
          </div>
          <button class="btn big tutorial ${fresh ? 'fresh' : ''}" data-tip="A guided first match against an easy AI: no timers, one step at a time">${icon('star')}<span>Tutorial</span><em>${fresh ? 'New here? Start with this' : 'Guided first match'}</em></button>
          <div class="menu-sep"><span>or duel a rival</span></div>
          <button class="btn big create">${icon('sword2')}<span>${code ? 'Create a new PvP room' : 'Create PvP room'}</span></button>
          <div class="join-row">
            <input class="code" maxlength="4" placeholder="CODE" value="${esc(code)}" autocapitalize="characters" spellcheck="false" aria-label="Room code">
            <button class="btn join ${code ? 'cta' : ''}">Join</button>
            <button class="btn spectate" data-tip="Watch the duel without taking a seat">${icon('eye')}<span>Watch</span></button>
          </div>
          <p class="err" role="status"></p>
          <div class="menu-links">
            <button class="linkish how-btn">${icon('tome')}<span>How to play</span><kbd>F1</kbd></button>
            <button class="linkish offline" data-tip="A full match against the AI inside this tab: no server needed">Offline skirmish</button>
          </div>
        </div>
        <div class="title-load" role="status"><span>Raising the battlefield</span><div class="tl-bar"><i></i></div></div>
      </div>`);
    ui.appendChild(this.root);
    this.err = $(this.root, '.err');
    const nameIn = $<HTMLInputElement>(this.root, '.name');
    const codeIn = $<HTMLInputElement>(this.root, '.code');
    let lvl: AiLevel = level;
    const who = () => {
      store.set('name', nameIn.value.trim());
      return nameIn.value.trim() || 'Wanderer';
    };
    const go = (f: () => void) => () => {
      if (this.busy) return;
      sound.unlock();
      sound.click();
      f();
    };
    this.root.querySelectorAll<HTMLButtonElement>('.diff button').forEach((b) =>
      b.addEventListener('click', () => {
        sound.unlock();
        sound.click();
        lvl = b.dataset.lvl as AiLevel;
        store.set('ai', lvl);
        this.root.querySelectorAll('.diff button').forEach((x) => {
          x.classList.toggle('on', x === b);
          x.setAttribute('aria-checked', String(x === b));
        });
      }),
    );
    codeIn.addEventListener('input', () => (codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
    $(this.root, '.vsai').addEventListener('click', go(() => (this.setBusy(true), a.vsAI(who(), lvl))));
    $(this.root, '.create').addEventListener('click', go(() => (this.setBusy(true), a.create(who()))));
    $(this.root, '.offline').addEventListener('click', go(() => a.offline(lvl)));
    $(this.root, '.tutorial').addEventListener('click', go(() => a.tutorial(who())));
    $(this.root, '.how-btn').addEventListener('click', () => (sound.unlock(), toggleRules()));
    const join = (spectate: boolean) =>
      go(() => {
        const c = codeIn.value.trim().toUpperCase();
        if (c.length !== 4) return this.error('Room codes are four characters');
        this.setBusy(true);
        a.join(c, who(), spectate);
      });
    $(this.root, '.join').addEventListener('click', join(false));
    $(this.root, '.spectate').addEventListener('click', join(true));
    codeIn.addEventListener('keydown', (e) => e.key === 'Enter' && join(false)());
  }

  /**
   * The battlefield loads behind the menu (the menu never waits for it). `frac` = 0..1 of the
   * renderer's download, or null when unknown; `ready` hides the line.
   */
  setLoading(frac: number | null, ready: boolean): void {
    const l = $(this.root, '.title-load');
    l.classList.toggle('on', !ready);
    l.classList.toggle('unknown', frac === null);
    ($(l, '.tl-bar i') as HTMLElement).style.width = `${Math.round((frac ?? 0.3) * 100)}%`;
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    this.err.textContent = b ? 'Connecting…' : '';
    this.err.classList.toggle('info', b);
  }

  /** A status line under the buttons (not an error). */
  info(msg: string): void {
    this.err.classList.add('info');
    this.err.textContent = msg;
  }

  error(msg: string): void {
    this.busy = false;
    this.err.classList.remove('info');
    this.err.textContent = msg;
  }

  update(): void {}

  dispose(): void {
    this.root.remove();
  }
}

export interface LobbyActions {
  start(): void;
  swap(): void;
  leave(): void;
}

export class LobbyScreen {
  readonly root: HTMLElement;
  private body: HTMLElement;

  constructor(ui: HTMLElement, a: LobbyActions) {
    const key = art('keyart');
    this.root = el(`<div class="screen lobby" ${key ? `style="--key:url(${key})"` : ''}><div class="lobby-card panel"></div></div>`);
    this.body = $(this.root, '.lobby-card');
    ui.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!t || t.hasAttribute('disabled')) return;
      sound.unlock();
      sound.click();
      if (t.classList.contains('start')) a.start();
      else if (t.classList.contains('leave')) a.leave();
      else if (t.classList.contains('swap')) a.swap();
      else if (t.classList.contains('how-btn')) toggleRules();
      else if (t.classList.contains('copy')) {
        const link = t.dataset.link!;
        void navigator.clipboard?.writeText(link).then(
          () => (t.querySelector('span')!.textContent = 'Invite link copied'),
          () => (t.querySelector('span')!.textContent = link),
        );
      }
    });
  }

  private seatCard(s: SeatInfo | null, i: 0 | 1, mine: boolean, room: RoomView): string {
    // your own seat is always the blue one, whichever end of the field it defends
    const me = room.me.seat;
    const side = (me === null ? i === 0 : i === me) ? 'left' : 'right';
    if (!s)
      return `<div class="vs-seat ${side} empty"><div class="vs-banner"></div><div class="vs-port">${icon('sword2')}</div><b>Awaiting a challenger</b><small>Share the code or invite link</small></div>`;
    const tags = [
      s.isHost ? '<em class="tag">Host</em>' : '',
      mine ? '<em class="tag you">You</em>' : '',
      s.isBot ? `<em class="tag bot">AI · ${esc(room.aiLevel)}</em>` : '',
      s.connected ? '' : '<em class="tag away">Away</em>',
    ].join('');
    return `<div class="vs-seat ${side} ${s.connected ? '' : 'away'}"><div class="vs-banner"></div><div class="vs-port">${icon(s.isBot ? 'ai' : 'crown')}</div><b>${esc(s.name)}</b><div class="tags">${tags}</div><small>${i === 0 ? 'Defends the southern Keep' : 'Defends the northern Keep'}</small></div>`;
  }

  update(room: RoomView): void {
    const link = `${location.origin}${location.pathname}?room=${room.code}`;
    const host = room.me.isHost;
    const full = !!room.seats[0] && !!room.seats[1];
    const specs = room.spectators.filter((s) => s.connected).length;
    this.body.innerHTML = `
      <small class="eyebrow">${room.mode === 'vsAI' ? 'Skirmish vs AI' : 'War council'}</small>
      <div class="code-big" data-tip="Room code">${esc(room.code)}</div>
      <button class="copy linkish" data-link="${esc(link)}">${icon('link')}<span>${esc(link)}</span></button>
      <div class="vs">
        ${this.seatCard(room.seats[0], 0, room.me.seat === 0, room)}
        <div class="vs-mid"><div class="vs-word">VS</div>${host ? `<button class="btn swap" data-tip="Swap sides">${icon('swap')}</button>` : ''}</div>
        ${this.seatCard(room.seats[1], 1, room.me.seat === 1, room)}
      </div>
      <div class="lobby-foot">
        <span class="specs" data-tip="Spectators watching">${icon('eye')} ${specs} watching${room.me.spectator ? ' · you are spectating' : ''}</span>
      </div>
      ${host ? `<button class="btn cta big start" ${full ? '' : 'disabled'}>${full ? 'Begin the war' : 'Waiting for an opponent…'}</button>` : `<p class="muted center">${room.me.spectator ? 'Waiting for the duel to begin…' : 'Waiting for the host to begin…'}</p>`}
      <div class="lobby-acts"><button class="btn leave">${room.me.spectator ? 'Stop watching' : 'Leave room'}</button><button class="linkish how-btn">${icon('tome')}<span>How to play</span></button></div>`;
  }

  dispose(): void {
    this.root.remove();
  }
}
