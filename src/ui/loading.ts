// Real loading progress. The renderer streams its models lazily (GLBs, VAT bins, textures) and has
// no progress API, so downloads are counted where they all pass: `fetch`. Only art requests are
// tracked (models/, .glb, .bin, .ktx2); each tracked response is teed so the bytes can be counted as
// they arrive without touching what the loader reads. Two things read the tracker: the boot bar and
// the small "Preparing your army…" chip that shows while unit models are still coming down.
import { el } from './dom.ts';

export interface LoadState {
  /** Requests in flight. */
  active: number;
  /** Bytes received / expected across this burst (expected is 0 when a server sends no length). */
  loaded: number;
  total: number;
  /** Files finished since the page opened. */
  done: number;
}

const state: LoadState = { active: 0, loaded: 0, total: 0, done: 0 };
const subs = new Set<(s: LoadState) => void>();
let installed = false;
let raf = 0;

function emit(): void {
  if (raf) return;
  // at most one update per frame, however many chunks arrive
  raf = requestAnimationFrame(() => {
    raf = 0;
    for (const f of subs) f(state);
  });
}

const TRACK = /(^|\/)models\/|\.(glb|gltf|bin|ktx2)(\?|$)/i;

export function installLoadTracker(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!TRACK.test(url)) return real(input, init);
    if (state.active === 0) state.loaded = state.total = 0; // a new burst starts from zero
    state.active++;
    emit();
    let counted = false;
    const finish = () => {
      if (counted) return;
      counted = true;
      state.active = Math.max(0, state.active - 1);
      state.done++;
      emit();
    };
    try {
      const res = await real(input, init);
      const len = Number(res.headers.get('content-length')) || 0;
      state.total += len;
      if (!res.body || !res.ok) {
        finish();
        return res;
      }
      // count on a clone: the loader's own read of `res` is untouched
      const reader = res.clone().body!.getReader();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            state.loaded += value.byteLength;
            emit();
          }
        } catch {
          /* aborted: the loader reports it */
        }
        finish();
      })();
      return res;
    } catch (e) {
      finish();
      throw e;
    }
  };
}

export function loadState(): LoadState {
  return state;
}

export function onLoad(f: (s: LoadState) => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

/** 0..1 for the current burst, or null when the total is unknown. */
export function loadFraction(s: LoadState = state): number | null {
  return s.total > 0 ? Math.max(0, Math.min(1, s.loaded / s.total)) : null;
}

/** "Preparing your army… 62%": appears while art is streaming (after a short grace), fades when done. */
export class LoadChip {
  readonly root: HTMLElement;
  private bar: HTMLElement;
  private label: HTMLElement;
  private pctEl: HTMLElement;
  private off: () => void;
  private showT: ReturnType<typeof setTimeout> | null = null;
  private text = 'Preparing your army';

  constructor(host: HTMLElement) {
    this.root = el(`<div class="load-chip" role="status" aria-live="polite"><i class="dots"></i><span class="lc-t"></span><b class="lc-p"></b><div class="lc-bar"><i></i></div></div>`);
    host.appendChild(this.root);
    this.bar = this.root.querySelector('.lc-bar i')!;
    this.label = this.root.querySelector('.lc-t')!;
    this.pctEl = this.root.querySelector('.lc-p')!;
    this.off = onLoad((s) => this.render(s));
    this.render(state);
  }

  setLabel(t: string): void {
    this.text = t;
    this.label.textContent = t + '…';
  }

  private render(s: LoadState): void {
    this.label.textContent = this.text + '…';
    if (s.active > 0) {
      // brief fetches (a cached model) never flash the chip
      if (!this.showT && !this.root.classList.contains('on')) this.showT = setTimeout(() => ((this.showT = null), loadState().active > 0 && this.root.classList.add('on')), 350);
      const f = loadFraction(s);
      this.pctEl.textContent = f === null ? '' : `${Math.round(f * 100)}%`;
      this.bar.style.width = f === null ? '35%' : `${f * 100}%`;
      this.root.classList.toggle('unknown', f === null);
    } else {
      if (this.showT) clearTimeout(this.showT);
      this.showT = null;
      this.bar.style.width = '100%';
      this.root.classList.remove('on');
    }
  }

  dispose(): void {
    this.off();
    if (this.showT) clearTimeout(this.showT);
    this.root.remove();
  }
}
