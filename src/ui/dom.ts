// Small DOM helpers, per-browser storage and the shared hover-tooltip layer. Every storage key is
// prefixed `oathbound.`: the games site shares one origin between all its games.

export function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

export function esc(s: string | number): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function $<T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T {
  return root.querySelector(sel) as T;
}

/** 12345 -> "12,345". */
export function num(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Seconds left until `t` (ms epoch), never negative. */
export function secsLeft(t: number | null | undefined): number {
  if (!t) return 0;
  return Math.max(0, Math.ceil((t - Date.now()) / 1000));
}

const PREFIX = 'oathbound.';

function storage(kind: 'local' | 'session') {
  return {
    get(key: string): string | null {
      try {
        return (kind === 'local' ? localStorage : sessionStorage).getItem(PREFIX + key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string | null): void {
      try {
        const s = kind === 'local' ? localStorage : sessionStorage;
        if (value === null) s.removeItem(PREFIX + key);
        else s.setItem(PREFIX + key, value);
      } catch {
        /* private mode, blocked storage: fine */
      }
    },
  };
}

export const store = storage('local');
export const session = storage('session');

function uiRoot(): HTMLElement {
  return document.getElementById('ui')!;
}

let toastHost: HTMLElement | null = null;
/** A short message at the top of the screen. */
export function toast(text: string, kind: 'info' | 'bad' | 'good' | 'loot' = 'info'): void {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = el('<div class="toasts"></div>');
    uiRoot().appendChild(toastHost);
  }
  const t = el(`<div class="toast ${kind}">${esc(text)}</div>`);
  toastHost.appendChild(t);
  while (toastHost.children.length > 4) toastHost.firstElementChild!.remove();
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3100);
}

// ---------------------------------------------------------------- tooltips
// Any element can carry a tooltip: `tip(el, html | () => html)`, or a plain `data-tip="text"`
// attribute. One floating layer follows the pointer and stays inside the viewport.

type TipSource = string | (() => string);
const tips = new WeakMap<Element, TipSource>();
let tipLayer: HTMLElement | null = null;
let tipOwner: Element | null = null;
let lastXY = { x: 0, y: 0 };

export function tip(target: Element, src: TipSource): void {
  tips.set(target, src);
  installTips();
}

function layer(): HTMLElement {
  if (!tipLayer || !tipLayer.isConnected) {
    tipLayer = el('<div class="tip-layer"></div>');
    uiRoot().appendChild(tipLayer);
  }
  return tipLayer;
}

function findTip(t: EventTarget | null): [Element, TipSource] | null {
  let e = t instanceof Element ? t : null;
  while (e && e !== document.body) {
    const s = tips.get(e);
    if (s) return [e, s];
    const d = e.getAttribute('data-tip');
    if (d) return [e, `<div class="tip-plain">${esc(d)}</div>`];
    e = e.parentElement;
  }
  return null;
}

function place(): void {
  if (!tipLayer) return;
  const r = tipLayer.getBoundingClientRect();
  const pad = 12;
  let x = lastXY.x + 18;
  let y = lastXY.y + 16;
  if (x + r.width > innerWidth - pad) x = lastXY.x - r.width - 14;
  if (y + r.height > innerHeight - pad) y = innerHeight - pad - r.height;
  tipLayer.style.transform = `translate(${Math.max(pad, x)}px, ${Math.max(pad, y)}px)`;
}

/** Re-render the current tooltip (e.g. the hovered thing changed under the pointer). */
export function refreshTip(): void {
  if (!tipOwner || !tipLayer) return;
  if (!tipOwner.isConnected) return hideTip();
  const s = tips.get(tipOwner);
  if (typeof s === 'function') tipLayer.innerHTML = s();
  place();
}

export function hideTip(): void {
  tipOwner = null;
  tipLayer?.classList.remove('on');
}

/** Show a tooltip for something that isn't a DOM element (a squad on the battlefield). */
export function showTipAt(x: number, y: number, html: string | null): void {
  lastXY = { x, y };
  const l = layer();
  if (!html) {
    if (!tipOwner) l.classList.remove('on');
    return;
  }
  tipOwner = null;
  l.innerHTML = html;
  l.classList.add('on');
  place();
}

let installed = false;
function installTips(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('pointermove', (e) => {
    lastXY = { x: e.clientX, y: e.clientY };
    if (e.pointerType === 'touch') return;
    const f = findTip(e.target);
    if (!f) {
      if (tipOwner) hideTip();
      return;
    }
    const [owner, src] = f;
    const l = layer();
    if (owner !== tipOwner) {
      tipOwner = owner;
      l.innerHTML = typeof src === 'function' ? src() : src;
      l.classList.add('on');
    }
    place();
  });
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('dragstart', hideTip, true);
}
if (typeof document !== "undefined") installTips();
