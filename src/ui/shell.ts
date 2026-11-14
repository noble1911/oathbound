// Widgets that live above every screen: the small toggleable chat (Enter to talk), the settings
// popover (volume, effects, interface sounds, mute, key help) and the reconnect banner.
import type { Seat } from '../sim/types.ts';
import { sound } from '../audio.ts';
import { $, el, esc, store } from './dom.ts';
import { icon } from './icons.ts';

export class Shell {
  readonly root: HTMLElement;
  private log: HTMLElement;
  private chatBox: HTMLElement;
  private input: HTMLInputElement;
  private unread = 0;
  private status: HTMLElement;
  private settings: HTMLElement;
  onSend: ((text: string) => void) | null = null;
  onPower: ((p: { batterySaver?: boolean; fpsCap?: number }) => void) | null = null;

  constructor(ui: HTMLElement) {
    this.root = el(`<div class="shell">
      <div class="corner">
        <button class="icon chat-btn" data-tip="Chat [Enter]">${icon('chat')}<em class="badge"></em></button>
        <button class="icon mute-btn" data-tip="Mute [M]">${icon(sound.muted ? 'mute' : 'sound')}</button>
        <button class="icon set-btn" data-tip="Settings">${icon('gear')}</button>
      </div>
      <div class="chat panel"><div class="chat-log"></div><input class="chat-in" maxlength="140" placeholder="Say something… (Enter)" spellcheck="false"></div>
      <div class="chat-peek"></div>
      <div class="settings panel">
        <h3>Settings</h3>
        <label class="sl"><span>Master volume</span><input type="range" min="0" max="1" step="0.05" data-k="volume" value="${sound.volume}"></label>
        <label class="sl"><span>Battle effects</span><input type="range" min="0" max="1" step="0.05" data-k="sfx" value="${sound.sfx}"></label>
        <label class="sl"><span>Interface sounds</span><input type="range" min="0" max="1" step="0.05" data-k="ui" value="${sound.ui}"></label>
        <h4>Power</h4>
        <label class="ck"><input type="checkbox" class="saver-ck" ${store.get('saver') === '1' ? 'checked' : ''}><span>Battery saver (30 fps, no idle motion)</span></label>
        <label class="sl"><span>Frame rate cap</span><span class="seg fps">${[30, 60].map((f) => `<button data-fps="${f}" class="${(store.get('fps') ?? '60') === String(f) ? 'on' : ''}">${f} fps</button>`).join('')}</span></label>
        <label class="ck"><input type="checkbox" class="mute-ck" ${sound.muted ? 'checked' : ''}><span>Mute all</span></label>
        <h4>Keys</h4>
        <dl class="keys">
          <dt>Space</dt><dd>Ready / un-ready</dd><dt>1–9</dt><dd>Pick a unit from the shop</dd><dt>Q / E</dt><dd>Rotate the squad (or right-drag)</dd>
          <dt>Tab</dt><dd>Show / hide the enemy's last army</dd><dt>U</dt><dd>Level up the selected squad</dd><dt>Del</dt><dd>Sell the selected squad</dd>
          <dt>WASD</dt><dd>Pan the camera (drag, wheel to zoom)</dd><dt>C</dt><dd>Battle camera: director / free</dd><dt>Enter</dt><dd>Chat</dd>
        </dl>
        <button class="btn close-set">Close</button>
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
      this.settings.classList.toggle('on');
    });
    $(this.root, '.close-set').addEventListener('click', () => this.settings.classList.remove('on'));
    $(this.root, '.mute-btn').addEventListener('click', () => this.setMuted(!sound.muted));
    $<HTMLInputElement>(this.root, '.saver-ck').addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked;
      store.set('saver', on ? '1' : '0');
      this.onPower?.({ batterySaver: on });
    });
    this.root.querySelectorAll<HTMLElement>('.fps button').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        store.set('fps', b.dataset.fps!);
        this.root.querySelectorAll('.fps button').forEach((x) => x.classList.toggle('on', x === b));
        this.onPower?.({ fpsCap: Number(b.dataset.fps) });
      }),
    );
    $<HTMLInputElement>(this.root, '.mute-ck').addEventListener('change', (e) => this.setMuted((e.target as HTMLInputElement).checked));
    this.root.querySelectorAll<HTMLInputElement>('.sl input').forEach((r) =>
      r.addEventListener('input', () => {
        const v = Number(r.value);
        if (r.dataset.k === 'volume') sound.setVolume(v);
        else if (r.dataset.k === 'sfx') sound.setSfx(v);
        else sound.setUi(v);
        sound.unlock();
        sound.click();
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
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
      if (e.key === 'Enter' && this.chatEnabled && !document.querySelector('.battle:not(.over)')) {
        this.toggleChat(true);
        this.input.focus();
        e.preventDefault();
      } else if (e.key.toLowerCase() === 'm') this.setMuted(!sound.muted);
    });
    this.setChatEnabled(false);
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
