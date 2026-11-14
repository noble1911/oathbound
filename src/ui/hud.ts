// The top bar shared by planning, battle and results: both Keeps' HP (yours on the left, always),
// the round, the phase label and a countdown ring. Also small shared bits (pretty intent errors).
import type { LordId } from '../sim/types.ts';
import { LORDS } from '../sim/data/lords.ts';
import { sound } from '../audio.ts';
import { $, el, esc, num } from './dom.ts';
import { icon } from './icons.ts';
import { crest } from './units.ts';

export interface SideInfo {
  name: string;
  lord: LordId | null;
  hp: number;
  max: number;
  ready?: boolean;
  status?: string;
}

export class TopBar {
  readonly root: HTMLElement;
  private endsAt = 0;
  private total = 60;
  private lastSec = -1;
  private iv: ReturnType<typeof setTimeout> | null = null;
  private hp: [number, number] = [0, 0];
  ticking = true;

  constructor(host: HTMLElement) {
    this.root = el(`<div class="topbar">
      <div class="tb-side me"></div>
      <div class="tb-mid"><div class="tb-round"><small>Round</small><b>1</b></div>
        <div class="tb-clock"><svg viewBox="0 0 40 40"><circle class="trk" cx="20" cy="20" r="17"/><circle class="arc" cx="20" cy="20" r="17"/></svg><b>60</b></div>
        <div class="tb-phase"><small>Phase</small><b>Planning</b></div></div>
      <div class="tb-side foe"></div>
    </div>`);
    host.appendChild(this.root);
    this.schedule();
  }

  private side(s: SideInfo, cls: 'me' | 'foe', i: 0 | 1): void {
    const box = $(this.root, `.tb-side.${cls}`);
    const f = Math.max(0, Math.min(1, s.hp / Math.max(1, s.max)));
    const lord = s.lord ? LORDS[s.lord] : null;
    const prev = this.hp[i];
    const lost = prev > s.hp && prev > 0;
    this.hp[i] = s.hp;
    if (!box.firstChild) {
      box.innerHTML = `<div class="tb-crest"></div><div class="tb-info"><div class="tb-name"><b></b><span class="tb-lord"></span><em class="tb-ready"></em></div>
        <div class="keepbar" data-tip="Keep life"><i class="lag"></i><i class="fill"></i><span></span></div></div>`;
    }
    $(box, '.tb-crest').innerHTML = s.lord ? crest('lord', s.lord, 'md') : `<div class="crest md blank">${icon('keep')}</div>`;
    $(box, '.tb-name b').textContent = s.name;
    $(box, '.tb-lord').textContent = lord ? `${lord.title} ${lord.name}` : '';
    const rd = $(box, '.tb-ready');
    rd.innerHTML = s.status ? esc(s.status) : s.ready ? `${icon('ready')}Ready` : '';
    rd.className = 'tb-ready' + (s.ready ? ' on' : '');
    const bar = $(box, '.keepbar');
    bar.classList.toggle('low', f < 0.3);
    ($(bar, '.fill') as HTMLElement).style.width = `${f * 100}%`;
    // the lag bar trails behind, so a hit reads as a chunk falling off
    setTimeout(() => (($(bar, '.lag') as HTMLElement).style.width = `${f * 100}%`), lost ? 450 : 0);
    $(bar, 'span').innerHTML = `${icon('keep')}${num(s.hp)} <small>/ ${num(s.max)}</small>`;
    if (lost) {
      bar.classList.remove('hit');
      void bar.offsetWidth;
      bar.classList.add('hit');
    }
  }

  set(me: SideInfo, foe: SideInfo, round: number, phase: string, endsAt: number, total: number): void {
    this.side(me, 'me', 0);
    this.side(foe, 'foe', 1);
    $(this.root, '.tb-round b').textContent = String(round);
    $(this.root, '.tb-phase b').textContent = phase;
    this.endsAt = endsAt;
    this.total = total;
    this.root.classList.toggle('no-clock', !endsAt);
    this.tick();
    this.schedule();
  }

  /** Battle: show elapsed sim time instead of a countdown. */
  setClock(text: string, frac: number): void {
    this.endsAt = 0;
    this.root.classList.remove('no-clock');
    $(this.root, '.tb-clock b').textContent = text;
    ($(this.root, '.tb-clock .arc') as unknown as SVGCircleElement).style.strokeDashoffset = String(106.8 * (1 - frac));
  }

  /** 1 Hz, 4 Hz in the last 10 s; nothing at all without a countdown. */
  private schedule(): void {
    if (this.iv) clearTimeout(this.iv);
    this.iv = null;
    if (!this.endsAt) return;
    const ms = this.endsAt - Date.now();
    if (ms <= 0) return;
    this.iv = setTimeout(() => { this.tick(); this.schedule(); }, ms <= 10_500 ? 250 : ((ms % 1000) || 1000) + 5);
  }

  private tick(): void {
    if (!this.endsAt) return;
    const ms = Math.max(0, this.endsAt - Date.now());
    const s = Math.ceil(ms / 1000);
    $(this.root, '.tb-clock b').textContent = String(s);
    const frac = Math.min(1, ms / (this.total * 1000));
    ($(this.root, '.tb-clock .arc') as unknown as SVGCircleElement).style.strokeDashoffset = String(106.8 * (1 - frac));
    const hurry = s <= 10 && ms > 0;
    this.root.classList.toggle('hurry', hurry);
    if (hurry && s !== this.lastSec && this.ticking) sound.tick(s <= 5);
    this.lastSec = s;
  }

  dispose(): void {
    if (this.iv) clearTimeout(this.iv);
    this.root.remove();
  }
}

const NICE: [RegExp, string][] = [
  [/deployment limit/, 'No deploys left this round'],
  [/army cap/, 'Your army is at the 16-squad cap'],
  [/not enough gold/, 'Not enough gold'],
  [/outside deploy zone/, 'Deploy inside your half of the field'],
  [/already ready/, 'You are Ready: un-ready to make changes'],
  [/not in planning/, 'Planning is over'],
  [/max level/, 'Already at max level'],
  [/the Lord levels/, 'Your Lord levels up from battle XP'],
  [/cannot sell the Lord/, 'The Lord cannot be sold'],
];

export function niceError(e: string): string {
  for (const [re, t] of NICE) if (re.test(e)) return t;
  return e.charAt(0).toUpperCase() + e.slice(1);
}
