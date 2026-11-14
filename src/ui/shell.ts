// Widgets that live above every screen: the corner buttons, the small toggleable chat (Enter to
// talk, on every screen), the settings popover (sound: master / music / effects / ambience /
// interface, mute; graphics: quality tier, frame cap, full screen, battery saver; the match:
// leave / concede / stop watching; the rules codex) and the reconnect banner.
// Esc or a click outside closes the popover. Keys: Enter chat, M mute, F full screen, F1 codex.
import type { Seat } from '../sim/types.ts';
import { sound } from '../audio.ts';
import { $, confirmDialog, el, esc, store } from './dom.ts';
import { icon } from './icons.ts';
import { toggleRules } from './rules.ts';
import type { QualityChoice } from './scene-adapter.ts';

/** What "leaving" means right now (null = nothing to leave: the title). */
export type MatchKind = null | 'lobby' | 'vsAI' | 'pvp' | 'spectator' | 'over';

export interface Graphics { choice: QualityChoice; tier: string; batterySaver: boolean; fpsCap: number }

const QUALITIES: QualityChoice[] = ['auto', 'low', 'medium', 'high', 'ultra'];
const LEAVE: Record<Exclude<MatchKind, null>, { label: string; title: string; body: string; yes: string }> = {
  lobby: { label: 'Leave room', title: 'Leave this room?', body: 'Your seat is freed for someone else.', yes: 'Leave room' },
  vsAI: { label: 'Leave match', title: 'Leave this match?', body: 'The match against the AI ends here. There is no way back in.', yes: 'Leave match' },
  // leaving a running PvP match is a concession (protocol: 'leave' and 'concede' both end it at once)
  pvp: { label: 'Concede', title: 'Concede the match?', body: 'Leaving a match in progress concedes it: the match ends at once and your opponent wins.', yes: 'Concede' },
  spectator: { label: 'Stop watching', title: 'Stop watching?', body: 'You return to the title screen. The duel goes on without you.', yes: 'Stop watching' },
  over: { label: 'Leave', title: 'Leave the room?', body: 'You return to the title screen.', yes: 'Leave' },
};

export class Shell {
  readonly root: HTMLElement;
  private log: HTMLElement;
  private chatBox: HTMLElement;
  private input: HTMLInputElement;
  private unread = 0;
  private status: HTMLElement;
  private settings: HTMLElement;
  private match: MatchKind = null;
  onSend: ((text: string) => void) | null = null;
  onPower: ((p: { batterySaver?: boolean; fpsCap?: number }) => void) | null = null;
  onQuality: ((q: QualityChoice) => void) | null = null;
  /** Reads the renderer's current graphics settings (null until the renderer is up). */
  graphics: (() => Graphics | null) | null = null;
  /** Leave / concede / stop watching, already confirmed. `kind` = what was left ('pvp' = a concession). */
  onLeave: ((kind: Exclude<MatchKind, null>) => void) | null = null;

  constructor(ui: HTMLElement) {
    this.root = el(`<div class="shell">
      <div class="corner">
        <button class="icon chat-btn" data-tip="Chat [Enter]">${icon('chat')}<em class="badge"></em></button>
        <button class="icon mute-btn" data-tip="Mute [M]">${icon(sound.muted ? 'mute' : 'sound')}</button>
        <button class="icon set-btn" data-tip="Settings" aria-haspopup="dialog">${icon('gear')}</button>
        <button class="icon help-btn" data-tip="How to play [F1]">${icon('help')}</button>
        <button class="icon leave-btn" data-tip="Leave match">${icon('flag')}</button>
      </div>
      <div class="chat panel"><div class="chat-log"></div><input class="chat-in" maxlength="140" placeholder="Say something… (Enter)" spellcheck="false"></div>
      <div class="chat-peek"></div>
      <div class="settings panel" role="dialog" aria-label="Settings">
        <header><h3>Settings</h3><button class="icon close-set" data-tip="Close [Esc]">${icon('close')}</button></header>
        <h4>Sound</h4>
        <label class="sl"><span>Master volume</span><input type="range" min="0" max="1" step="0.05" data-k="volume" value="${sound.volume}"></label>
        <div class="sl-grid">
          <label class="sl"><span>Music</span><input type="range" min="0" max="1" step="0.05" data-k="music" value="${sound.musicVol}"></label>
          <label class="sl"><span>Battle effects</span><input type="range" min="0" max="1" step="0.05" data-k="sfx" value="${sound.sfx}"></label>
          <label class="sl"><span>Ambience</span><input type="range" min="0" max="1" step="0.05" data-k="amb" value="${sound.amb}"></label>
          <label class="sl"><span>Interface</span><input type="range" min="0" max="1" step="0.05" data-k="ui" value="${sound.ui}"></label>
        </div>
        <label class="ck"><input type="checkbox" class="mute-ck" ${sound.muted ? 'checked' : ''}><span>Mute all <kbd>M</kbd></span></label>
        <h4>Graphics</h4>
        <div class="set-row"><span>Quality</span><span class="seg quality">${QUALITIES.map((q) => `<button data-q="${q}">${q[0]!.toUpperCase() + q.slice(1)}</button>`).join('')}</span></div>
        <p class="set-note q-note"></p>
        <div class="set-row"><span>Frame rate cap</span><span class="seg fps">${[30, 60, 0].map((f) => `<button data-fps="${f}">${f ? `${f} fps` : 'Display'}</button>`).join('')}</span></div>
        <label class="ck"><input type="checkbox" class="saver-ck"><span>Battery saver (30 fps, lowest quality, no idle motion)</span></label>
        <label class="ck"><input type="checkbox" class="fs-ck"><span>Full screen <kbd>F</kbd></span></label>
        <h4>Game</h4>
        <div class="set-acts">
          <button class="btn rules-set">${icon('tome')}<span>How to play</span><kbd>F1</kbd></button>
          <button class="btn danger leave-set">${icon('flag')}<span>Leave match</span></button>
        </div>
      </div>
      <div class="net-status"><i class="dots"></i><span>Reconnecting…</span></div>
    </div>`);
    ui.appendChild(this.root);
    this.log = $(this.root, '.chat-log');
    this.chatBox = $(this.root, '.chat');
    this.input = $(this.root, '.chat-in');
    this.status = $(this.root, '.net-status');
    this.settings = $(this.root, '.settings');
    $(this.root, '.chat-btn').addEventListener('click', () => this.toggleChat());
    $(this.root, '.set-btn').addEventListener('click', () => {
      sound.click();
      this.toggleSettings();
    });
    $(this.root, '.close-set').addEventListener('click', () => this.toggleSettings(false));
    $(this.root, '.mute-btn').addEventListener('click', () => this.setMuted(!sound.muted));
    $(this.root, '.help-btn').addEventListener('click', () => toggleRules());
    $(this.root, '.rules-set').addEventListener('click', () => {
      this.toggleSettings(false);
      toggleRules();
    });
    $(this.root, '.leave-btn').addEventListener('click', () => void this.askLeave());
    $(this.root, '.leave-set').addEventListener('click', () => void this.askLeave());
    $<HTMLInputElement>(this.root, '.saver-ck').addEventListener('change', (e) => {
      this.onPower?.({ batterySaver: (e.target as HTMLInputElement).checked });
      this.syncGraphics();
    });
    this.root.querySelectorAll<HTMLElement>('.fps button').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        sound.click();
        this.onPower?.({ fpsCap: Number(b.dataset.fps) });
        this.syncGraphics();
      }),
    );
    this.root.querySelectorAll<HTMLElement>('.quality button').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        sound.click();
        this.onQuality?.(b.dataset.q as QualityChoice);
        this.syncGraphics();
      }),
    );
    $<HTMLInputElement>(this.root, '.fs-ck').addEventListener('change', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => ($<HTMLInputElement>(this.root, '.fs-ck').checked = !!document.fullscreenElement));
    $<HTMLInputElement>(this.root, '.mute-ck').addEventListener('change', (e) => this.setMuted((e.target as HTMLInputElement).checked));
    this.root.querySelectorAll<HTMLInputElement>('.sl input').forEach((r) =>
      r.addEventListener('input', () => {
        const v = Number(r.value);
        const k = r.dataset.k;
        if (k === 'volume') sound.setVolume(v);
        else if (k === 'music') sound.setMusic(v);
        else if (k === 'sfx') sound.setSfx(v);
        else if (k === 'amb') sound.setAmb(v);
        else sound.setUi(v);
        sound.unlock();
        sound.hover();
      }),
    );
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const t = this.input.value.trim();
        if (t) this.onSend?.(t);
        this.input.value = '';
        this.input.blur();
        if (!t) this.toggleChat(false);
      } else if (e.key === 'Escape') {
        this.input.blur();
        this.toggleChat(false);
      }
    });
    // capture phase, registered before any screen: an open popover takes Esc first
    window.addEventListener(
      'keydown',
      (e) => {
        if (document.querySelector('.dialog-veil')) return; // a confirm dialog owns the keyboard
        if (e.key === 'Escape' && this.settings.classList.contains('on')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.toggleSettings(false);
          return;
        }
        if (e.key === 'F1') {
          e.preventDefault();
          toggleRules();
          return;
        }
        if ((e.target as HTMLElement)?.closest?.('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
        // Enter is chat on every screen (the battle's Skip has its own key)
        if (e.key === 'Enter' && this.chatEnabled) {
          this.toggleChat(true);
          this.input.focus();
          e.preventDefault();
          e.stopImmediatePropagation();
        } else if (e.key.toLowerCase() === 'm') this.setMuted(!sound.muted);
        else if (e.key.toLowerCase() === 'f') this.toggleFullscreen();
      },
      true,
    );
    // a click anywhere else closes the popover
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.settings.classList.contains('on')) return;
        const t = e.target as HTMLElement | null;
        if (t?.closest?.('.settings, .set-btn, .dialog-veil')) return;
        this.toggleSettings(false);
      },
      true,
    );
    this.setChatEnabled(false);
    this.setMatch(null);
  }

  toggleSettings(on?: boolean): void {
    const open = on ?? !this.settings.classList.contains('on');
    this.settings.classList.toggle('on', open);
    if (open) this.syncGraphics();
  }

  /** Show the renderer's stored graphics settings (one source of truth: the renderer's own keys). */
  private syncGraphics(): void {
    const g = this.graphics?.() ?? null;
    this.settings.classList.toggle('no-gfx', !g);
    this.root.querySelectorAll<HTMLElement>('.quality button').forEach((b) => b.classList.toggle('on', !!g && b.dataset.q === g.choice));
    this.root.querySelectorAll<HTMLElement>('.fps button').forEach((b) => b.classList.toggle('on', !!g && Number(b.dataset.fps) === g.fpsCap));
    $<HTMLInputElement>(this.root, '.saver-ck').checked = !!g?.batterySaver;
    $<HTMLInputElement>(this.root, '.fs-ck').checked = !!document.fullscreenElement;
    const note = $(this.root, '.q-note');
    note.textContent = !g ? 'The battlefield is still loading.' : g.batterySaver ? 'Battery saver is on: it overrides the quality tier.' : g.choice === 'auto' ? `Auto picked ${g.tier} for this device.` : '';
  }

  private toggleFullscreen(): void {
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen?.().catch(() => undefined);
    } catch {
      /* not allowed here (an embedded frame): the checkbox follows fullscreenchange */
    }
  }

  /** What the leave buttons say and do. Null hides them (the title). */
  setMatch(kind: MatchKind): void {
    this.match = kind;
    const label = kind ? LEAVE[kind].label : '';
    const corner = $(this.root, '.leave-btn');
    corner.classList.toggle('hidden', !kind);
    corner.dataset.tip = label;
    const b = $(this.root, '.leave-set');
    b.classList.toggle('hidden', !kind);
    $(b, 'span').textContent = label;
  }

  /** Ask, then leave (the lobby and a finished match need no confirmation). */
  async askLeave(): Promise<void> {
    const kind = this.match;
    if (!kind) return;
    sound.click();
    this.toggleSettings(false);
    if (kind !== 'over') {
      const t = LEAVE[kind];
      if (!(await confirmDialog({ title: t.title, body: t.body, yes: t.yes, no: 'Keep playing', danger: true }))) return;
    }
    this.onLeave?.(kind);
  }

  chatEnabled = false;
  setChatEnabled(on: boolean): void {
    this.chatEnabled = on;
    this.root.classList.toggle('no-chat', !on);
    if (!on) this.toggleChat(false);
  }

  private setMuted(m: boolean): void {
    sound.unlock();
    sound.setMuted(m);
    $(this.root, '.mute-btn').innerHTML = icon(m ? 'mute' : 'sound');
    $<HTMLInputElement>(this.root, '.mute-ck').checked = m;
  }

  toggleChat(on?: boolean): void {
    const open = on ?? !this.chatBox.classList.contains('on');
    this.chatBox.classList.toggle('on', open);
    if (open) {
      this.unread = 0;
      this.badge();
      this.log.scrollTop = this.log.scrollHeight;
    }
  }

  private badge(): void {
    const b = $(this.root, '.badge');
    b.textContent = this.unread ? String(Math.min(9, this.unread)) : '';
    b.classList.toggle('on', this.unread > 0);
  }

  message(seat: Seat | null, name: string, text: string, system: boolean, mine: boolean): void {
    const line = el(`<div class="cl ${system ? 'sys' : seat === null ? 'spec' : mine ? 'me' : 'foe'}">${system ? '' : `<b>${esc(name)}</b>`}<span>${esc(text)}</span></div>`);
    this.log.appendChild(line);
    while (this.log.children.length > 60) this.log.firstElementChild!.remove();
    this.log.scrollTop = this.log.scrollHeight;
    if (!this.chatBox.classList.contains('on')) {
      if (!mine) this.unread++;
      this.badge();
      const peek = $(this.root, '.chat-peek');
      const p = line.cloneNode(true) as HTMLElement;
      peek.appendChild(p);
      while (peek.children.length > 3) peek.firstElementChild!.remove();
      setTimeout(() => p.classList.add('out'), 5000);
      setTimeout(() => p.remove(), 5600);
    }
    if (!mine && !system) sound.pick();
  }

  setStatus(s: 'connecting' | 'open' | 'closed', inRoom: boolean): void {
    this.status.classList.toggle('on', inRoom && s !== 'open');
    $(this.status, 'span').textContent = s === 'closed' ? 'Connection lost. Retrying…' : 'Reconnecting…';
  }
}

/** Old UI-side copies of the power settings: the renderer's own keys are the one source now. */
export function migratePowerKeys(): void {
  try {
    const legacyFps = store.get('fps');
    if (legacyFps !== null && localStorage.getItem('oathbound.render.fpsCap') === null) localStorage.setItem('oathbound.render.fpsCap', legacyFps);
    const legacySaver = store.get('saver');
    if (legacySaver !== null && localStorage.getItem('oathbound.render.batterySaver') === null) localStorage.setItem('oathbound.render.batterySaver', legacySaver);
    store.set('fps', null);
    store.set('saver', null);
  } catch {
    /* storage blocked: defaults */
  }
}
