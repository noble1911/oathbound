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
/** A short message at the top of the screen. `ms` = how long it stays (auto-picks stay longer). */
export function toast(text: string, kind: 'info' | 'bad' | 'good' | 'loot' | 'auto' = 'info', ms = 2600): void {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = el('<div class="toasts"></div>');
    uiRoot().appendChild(toastHost);
  }
  const t = el(`<div class="toast ${kind}">${esc(text)}</div>`);
  toastHost.appendChild(t);
  while (toastHost.children.length > 4) toastHost.firstElementChild!.remove();
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 500);
}

/** A small in-style yes/no dialog (leave / concede). Esc and the backdrop cancel; Enter confirms. */
export function confirmDialog(o: { title: string; body: string; yes: string; no?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const d = el(`<div class="dialog-veil" role="dialog" aria-modal="true"><div class="dialog panel">
      <h3>${esc(o.title)}</h3><p>${esc(o.body)}</p>
      <div class="dialog-acts"><button class="btn no">${esc(o.no ?? 'Cancel')}</button><button class="btn ${o.danger ? 'danger' : 'primary'} yes">${esc(o.yes)}</button></div>
    </div></div>`);
    uiRoot().appendChild(d);
    const done = (v: boolean) => {
      window.removeEventListener('keydown', key, true);
      d.remove();
      resolve(v);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      done(e.key === 'Enter');
    };
    window.addEventListener('keydown', key, true);
    d.addEventListener('pointerdown', (e) => e.target === d && done(false));
    $(d, '.no').addEventListener('click', () => done(false));
    $(d, '.yes').addEventListener('click', () => done(true));
    $<HTMLButtonElement>(d, '.yes').focus();
  });
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

/**
 * A tooltip never covers what it describes. One owned by an element sits beside that element
 * (above it if there is room: shop cards, slots; else below, right, left). One for something on the
 * battlefield sits off to the side of the pointer, above it, clear of the squad underneath.
 */
function place(): void {
  if (!tipLayer) return;
  const r = tipLayer.getBoundingClientRect();
  const pad = 10;
  const gap = 10;
  const W = innerWidth;
  const H = innerHeight;
  const clampX = (x: number) => Math.max(pad, Math.min(W - pad - r.width, x));
  const clampY = (y: number) => Math.max(pad, Math.min(H - pad - r.height, y));
  let x: number;
  let y: number;
  if (tipOwner) {
    const o = tipOwner.getBoundingClientRect();
    const cx = o.left + o.width / 2;
    const cy = o.top + o.height / 2;
    if (o.top - gap - r.height >= pad) (x = clampX(cx - r.width / 2)), (y = o.top - gap - r.height);
    else if (o.bottom + gap + r.height <= H - pad) (x = clampX(cx - r.width / 2)), (y = o.bottom + gap);
    else if (o.right + gap + r.width <= W - pad) (x = o.right + gap), (y = clampY(cy - r.height / 2));
    else if (o.left - gap - r.width >= pad) (x = o.left - gap - r.width), (y = clampY(cy - r.height / 2));
    else (x = clampX(lastXY.x + 18)), (y = clampY(lastXY.y + 16));
  } else {
    // beside the pointer and raised, so the squad under the cursor stays in view
    x = lastXY.x + 34;
    if (x + r.width > W - pad) x = lastXY.x - r.width - 34;
    x = Math.max(pad, x);
    y = clampY(lastXY.y - r.height - 12);
  }
  tipLayer.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
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
