// The live battle behind the title menu. A real sim battle between two bot armies (title-matchup.ts,
// simulated in a worker) is played back by the real renderer through `SceneAdapter.playBackdrop`;
// when it ends another one, with a new seed and matchup, takes its place.
//
// Power is the hard requirement here (CLAUDE.md), so the battle is a guest on the title:
//   - it draws on the low tier at 3/4 resolution and 30 fps at most, whatever the graphics settings say;
//   - it does not move at all (one still frame, then 0 fps) under the battery saver, with
//     prefers-reduced-motion, and after IDLE_MS without input on the title; the engine itself stops while
//     the tab is hidden or the window is not focused;
//   - nothing of it is loaded before the menu is interactive: the sim runs in a worker, the renderer and
//     only this battle's unit models stream in behind the menu, and the battle fades in over the static
//     woodcut backdrop once they are all there;
//   - without the engine (WebGL failed, `?scene=standin`, `?titlebg=0`) the woodcut backdrop simply stays.
// Leaving the title captures the last frame as the backdrop of the lobby and the Lord pick (`--still`),
// then stops the battle and hands the renderer back with the player's own settings.
import { decodeReplay } from '../sim/index.ts';
import type { BackdropHandle, SceneAdapter } from './scene-adapter.ts';
import type { TitleMatchup } from './title-matchup.ts';
import { loadState } from './loading.ts';

const Q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (Q.get(k) !== null && Number.isFinite(Number(Q.get(k))) ? Number(Q.get(k)) : d);
/** No input on the title for this long: the battle stops on a still frame. */
const IDLE_MS = num('titleidle', 180) * 1000;
const TIER = Q.get('titletier') === 'medium' ? 'medium' : 'low';
const SCALE = Math.min(1, Math.max(0.4, num('titlescale', 0.75)));
const FPS = Math.min(30, Math.max(5, num('titlefps', 30)));
/** Models still missing after this long: show the battle anyway (stand-ins fill the gaps). */
const LOAD_PATIENCE_MS = 20_000;

export type TitleBattleState = 'static' | 'loading' | 'live' | 'still';
export interface MenuInsets { left?: number; right?: number; top?: number; bottom?: number }

let stillUrl: string | null = null;
/** The last title frame becomes the backdrop of the screens that follow (lobby, Lord pick). */
function setStill(blob: Blob | null): void {
  if (!blob) return;
  if (stillUrl) URL.revokeObjectURL(stillUrl);
  stillUrl = URL.createObjectURL(blob);
  document.documentElement.style.setProperty('--still', `url(${stillUrl})`);
}

export class TitleBattle {
  /** For tests and the dev console (`__ob.titleBattle()`). */
  static current: TitleBattle | null = null;
  state: TitleBattleState = 'static';
  matchup: TitleMatchup | null = null;
  /** Battles shown so far. */
  played = 0;
  private dead = false;
  private handle: BackdropHandle | null = null;
  private scene: SceneAdapter | null = null;
  private worker: Worker | null = null;
  private waiting: ((m: TitleMatchup | null) => void) | null = null;
  private next: Promise<TitleMatchup | null> | null = null;
  private seed: number;
  private idle = false;
  private lastInput = performance.now();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private abort = new AbortController();
  private motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  private readonly root: HTMLElement;
  private readonly insets: () => MenuInsets;

  /**
   * `root`: the title screen (gets `tb-live` while the canvas shows the battle, `tb-idle` when it rests).
   * `scene`: the renderer, whenever it is up. `insets`: the screen space the menu takes.
   */
  constructor(root: HTMLElement, scene: Promise<SceneAdapter>, insets: () => MenuInsets) {
    this.root = root;
    this.insets = insets;
    this.seed = Q.get('titleseed') !== null ? num('titleseed', 1) >>> 0 : (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
    TitleBattle.current = this;
    if (Q.get('titlebg') === '0') return;
    const sig = { signal: this.abort.signal, passive: true, capture: true } as const;
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const) window.addEventListener(ev, this.onInput, sig);
    window.addEventListener('resize', () => this.handle?.setInsets(this.insets()), sig);
    this.motion?.addEventListener('change', () => this.sync(), { signal: this.abort.signal });
    this.state = 'loading';
    this.next = this.request();
    void Promise.all([scene, this.next]).then(([sc, first]) => {
      if (this.dead) return;
      if (!sc.playBackdrop || !first) {
        this.state = 'static';
        return;
      }
      this.scene = sc;
      this.play(first);
    });
  }

  /** Where the battle on screen is (ms), 0 when there is none. */
  get timeMs(): number {
    return this.handle?.timeMs ?? 0;
  }

  // ------------------------------------------------------------------ battles

  /** Simulate the next matchup (worker; the main thread, once the page is idle, if there is none). */
  private request(): Promise<TitleMatchup | null> {
    const seed = this.seed;
    this.seed = (this.seed + 0x9e3779b1) >>> 0;
    return new Promise((resolve) => {
      const local = () =>
        this.later(() => void import('./title-matchup.ts').then((m) => resolve(this.dead ? null : m.titleMatchup(seed)), () => resolve(null)), 400);
      try {
        this.worker ??= new Worker(new URL('./title-battle.worker.ts', import.meta.url), { type: 'module' });
        this.waiting = resolve;
        this.worker.onmessage = (e: MessageEvent<{ matchup: TitleMatchup | null }>) => {
          this.waiting = null;
          resolve(e.data.matchup);
        };
        this.worker.onerror = () => {
          this.worker?.terminate();
          this.worker = null;
          this.waiting = null;
          local();
        };
        this.worker.postMessage({ seed });
      } catch {
        local();
      }
    });
  }

  private play(m: TitleMatchup): void {
    const sc = this.scene!;
    this.matchup = m;
    this.state = 'loading';
    let h: BackdropHandle;
    try {
      h = sc.playBackdrop!(decodeReplay(m.replay), { factions: m.factions, side: m.seed & 1 ? 1 : -1, tier: TIER, scale: SCALE, fps: FPS, onEnd: () => this.ended(h) });
    } catch (e) {
      console.warn('title battle unavailable', e);
      this.state = 'static';
      return;
    }
    this.handle = h;
    h.setInsets(this.insets());
    // the next one is simulated while this one plays
    this.next = this.request();
    const t0 = performance.now();
    const poll = () => {
      if (this.dead || this.handle !== h) return;
      const ready = h.loaded() && loadState().active === 0;
      if (!ready && performance.now() - t0 < LOAD_PATIENCE_MS) return void this.later(poll, 200);
      this.reveal(h, m);
    };
    this.later(poll, 150);
  }

  /** The models are in: start (or, when the battle may not move, show one frame of the fight) and fade in. */
  private reveal(h: BackdropHandle, m: TitleMatchup): void {
    this.played++;
    if (this.wantStill()) h.frameAt(m.stillMs);
    else h.playing = true;
    this.state = h.playing ? 'live' : 'still';
    // a few frames first, so the canvas holds this battle when the art in front of it fades
    this.later(() => this.handle === h && this.root.classList.add('tb-live'), 320);
  }

  private ended(h: BackdropHandle): void {
    if (this.dead || this.handle !== h) return;
    // hold on the aftermath, fade back to the woodcut, and bring the next battle up behind it
    this.later(() => {
      if (this.handle !== h) return;
      this.root.classList.remove('tb-live');
      this.later(() => {
        if (this.handle !== h) return;
        void (this.next ?? this.request()).then((m) => {
          if (this.dead || this.handle !== h) return;
          if (m) this.play(m);
          else {
            h.stop();
            this.handle = null;
            this.state = 'static';
          }
        });
      }, 1300);
    }, 3000);
  }

  // ------------------------------------------------------------------ rest

  private wantStill(): boolean {
    return this.idle || !!this.motion?.matches || !!this.scene?.power?.().batterySaver;
  }

  /** Move or rest, as idleness, the motion preference and the battery saver say. Call after any of them changed. */
  sync(): void {
    const h = this.handle;
    this.root.classList.toggle('tb-idle', this.idle);
    if (!h || this.state === 'loading' || this.state === 'static') return;
    const still = this.wantStill();
    if (still === !h.playing) return;
    h.playing = !still;
    this.state = h.playing ? 'live' : 'still';
  }

  private onInput = (): void => {
    this.lastInput = performance.now();
    if (!this.idle) return;
    this.idle = false;
    this.sync();
    this.watchIdle();
  };

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** One timer, re-armed for the remaining time (no polling while the player is active, none at all once idle). */
  private watchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const left = IDLE_MS - (performance.now() - this.lastInput);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.dead) return;
      if (performance.now() - this.lastInput < IDLE_MS - 50) return this.watchIdle();
      this.idle = true;
      this.sync();
    }, Math.max(250, left));
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.dead) fn();
    }, ms);
    this.timers.add(t);
  }

  /** Start watching for idleness (the title calls this once it is on screen). */
  begin(): void {
    if (this.state !== 'static' || this.next) this.watchIdle();
  }

  /**
   * Leave the title: keep the frame on screen as `--still` (when the battle was showing), stop the battle and
   * free everything this object holds. Safe to call twice.
   */
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    if (TitleBattle.current === this) TitleBattle.current = null;
    this.abort.abort();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.worker?.terminate();
    this.worker = null;
    this.waiting?.(null);
    const h = this.handle;
    this.handle = null;
    if (h) {
      if (this.root.classList.contains('tb-live')) void h.still().then(setStill);
      h.stop();
    }
    this.state = 'static';
  }
}
