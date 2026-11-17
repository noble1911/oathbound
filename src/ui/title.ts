// Title (name; Play vs AI with difficulty; the guided Tutorial; create a PvP room; join or spectate
// with a code; ?room=CODE fills the code in; the rules codex) and the lobby (VS seat cards, invite
// link, spectators, host swap and Start).
//
// Behind the title menu a real battle plays (title-battle.ts): the screen itself is transparent, with
// a woodcut backdrop (`.title-art`) that fades away once the battle is on the canvas and stays when it
// cannot be. The menu never waits for any of it.
//
// The menu comes in three styles, all built from the game's own woodcut art rather than from painted
// fantasy UI (docs/UI-STYLE.md, "Title menu"); `?menustyle=1|2|3` picks one:
//   1  Broadside       a printed sheet: woodcut headpiece, a rubricated initial, ink rules, block buttons
//   2  Campaign table  the wordmark over the field and the orders laid out on a campaign map along the bottom
//   3  Ink band        a dark band with the wordmark and a plain list of entries; the battle has the screen
import type { AiLevel, RoomView, SeatInfo } from '../net/protocol.ts';
import { sound } from '../audio.ts';
import { $, el, esc, store } from './dom.ts';
import { icon } from './icons.ts';
import { art } from './art.ts';
import { toggleRules } from './rules.ts';
import type { SceneAdapter } from './scene-adapter.ts';
import { TitleBattle, type MenuInsets } from './title-battle.ts';

/** The style shown without `?menustyle=`. */
export const DEFAULT_MENU_STYLE = 1;
export function menuStyle(): 1 | 2 | 3 {
  const q = Number(new URLSearchParams(location.search).get('menustyle'));
  return (q === 1 || q === 2 || q === 3 ? q : DEFAULT_MENU_STYLE) as 1 | 2 | 3;
}

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
  private battle: TitleBattle;
  readonly style = menuStyle();

  /** `scene`: the renderer whenever it is up (the battle behind the menu); the menu does not wait for it. */
  constructor(ui: HTMLElement, a: TitleActions, scene: Promise<SceneAdapter>) {
    const code = (new URLSearchParams(location.search).get('room') ?? '').toUpperCase().slice(0, 4);
    const name = store.get('name') ?? '';
    const level = (store.get('ai') as AiLevel) || 'normal';
    const fresh = store.get('tutorial.done') !== '1' && !code;
    const st = this.style;
    const img = (id: string, cls: string): string => {
      const u = art(id);
      return u ? `<img class="${cls}" src="${u}" alt="" draggable="false">` : '';
    };
    const initial = st === 1 ? img('scene_initial', 'tw-initial') : '';
    const map = st === 2 ? art('scene_map') : null;
    this.root = el(`
      <div class="screen title ms${st}" ${map ? `style="--map:url(${map})"` : ''}>
        <div class="title-art"></div>
        <div class="title-vignette"></div>
        <div class="title-sheet ${st === 1 ? 'parch' : ''}">
          <header class="title-head">
            ${st === 1 ? img('scene_headpiece', 'tw-headpiece') : ''}
            <h1 class="title-word ${initial ? 'cut' : ''}" aria-label="Oathbound">${initial}<span class="tw-o">O</span>athbound</h1>
            <p class="title-tag">Raise your banners. Break their Keep.</p>
          </header>
          <div class="title-menu ${st === 2 ? 'parch' : ''}">
            <section class="mg mg-you">
              <label class="field"><span>Commander name</span><input class="name" maxlength="16" placeholder="Wanderer" value="${esc(name)}" autocomplete="nickname" spellcheck="false"></label>
            </section>
            <section class="mg mg-play">
              <h3 class="mg-h">Skirmish</h3>
              <div class="menu-block">
                <button class="tbtn ${code ? '' : 'cta'} big vsai">${icon('ai')}<span>Play vs AI</span></button>
                <div class="diff" role="radiogroup" aria-label="AI difficulty">
                  ${(['easy', 'normal', 'hard'] as AiLevel[]).map((l) => `<button data-lvl="${l}" class="${l === level ? 'on' : ''}" role="radio" aria-checked="${l === level}">${l[0]!.toUpperCase() + l.slice(1)}</button>`).join('')}
                </div>
              </div>
              <button class="tbtn big tutorial ${fresh ? 'fresh' : ''}" data-tip="A guided first match against an easy AI: no timers, one step at a time">${icon('star')}<span>Tutorial</span><em>${fresh ? 'New here? Start with this' : 'Guided first match'}</em></button>
            </section>
            <div class="menu-sep"><span>or duel a rival</span></div>
            <section class="mg mg-duel">
              <h3 class="mg-h">Duel a rival<i class="sh me"></i><i class="sh foe"></i></h3>
              <button class="tbtn big create">${icon('sword2')}<span>${code ? 'Create a new PvP room' : 'Create PvP room'}</span></button>
              <div class="join-row">
                <input class="code" maxlength="4" placeholder="CODE" value="${esc(code)}" autocapitalize="characters" spellcheck="false" aria-label="Room code">
                <button class="tbtn join ${code ? 'cta' : ''}">Join</button>
                <button class="tbtn spectate" data-tip="Watch the duel without taking a seat">${icon('eye')}<span>Watch</span></button>
              </div>
            </section>
            <p class="err" role="status"></p>
            <div class="menu-links">
              <button class="linkish how-btn">${icon('tome')}<span>How to play</span><kbd>F1</kbd></button>
              <button class="linkish offline" data-tip="A full match against the AI inside this tab: no server needed">Offline skirmish</button>
            </div>
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
    this.battle = new TitleBattle(this.root, scene, () => this.insets());
    this.battle.begin();
  }

  /** The screen space the menu takes, so the battle is framed in the rest (nothing on a narrow screen). */
  private insets(): MenuInsets {
    const W = innerWidth;
    const H = innerHeight;
    if (W < 720) return {};
    const r = $(this.root, this.style === 2 ? '.title-menu' : '.title-sheet').getBoundingClientRect();
    if (!r.width) return {};
    if (r.width > W * 0.6) return r.top > H * 0.4 ? { bottom: Math.round(H - r.top) } : {};
    if (r.left < W * 0.2) return { left: Math.round(r.right) };
    return {};
  }

  /** The battery saver was switched: the battle behind the menu rests or moves again. */
  powerChanged(): void {
    this.battle.sync();
  }

  /**
   * A match is starting: keep the battle's last frame as the backdrop of the lobby and the Lord pick, stop it
   * and give the renderer back. (dispose() does the same.)
   */
  leave(): void {
    this.battle.dispose();
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
    this.battle.dispose();
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
    this.root = el(`<div class="screen lobby"><div class="lobby-card panel"></div></div>`);
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
    // vs AI the match starts by itself a moment later: no button to press (it sat where the Lord cards appear next,
    // so a press meant for it picked a Lord), only a quiet line in its place
    const vsAI = room.mode === 'vsAI';
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
      ${vsAI ? '<p class="muted center muster" role="status"><i class="dots"></i>Mustering the armies…</p>' : host ? `<button class="btn cta big start" ${full ? '' : 'disabled'}>${full ? 'Begin the war' : 'Waiting for an opponent…'}</button>` : `<p class="muted center">${room.me.spectator ? 'Waiting for the duel to begin…' : 'Waiting for the host to begin…'}</p>`}
      <div class="lobby-acts"><button class="btn leave">${room.me.spectator ? 'Stop watching' : 'Leave room'}</button><button class="linkish how-btn">${icon('tome')}<span>How to play</span></button></div>`;
  }

  dispose(): void {
    this.root.remove();
  }
}
