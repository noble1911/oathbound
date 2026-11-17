// The battle inspector: click a squad during a battle (or a row of the battle report) and a stone
// panel docks to the right with who it is, how it is doing, where its damage comes from, what it
// can do and has done, its items and its stats. Shift-click a second squad for the pair view.
// The data is src/ui/inspect-data.ts; this file only draws it. Power: the panel is built once per
// selection and `update()` (the HUD's 4 Hz clock, only while it is open) rewrites the few numbers
// that changed. Nothing here asks for a frame.
import type { DecodedReplay, Item, Seat } from '../sim/types.ts';
import { squadStatsAt } from '../sim/stats.ts';
import { MAX_SQUAD_LEVEL } from '../sim/match.ts';
import { TICK_HZ } from '../sim/constants.ts';
import type { StatLine } from '../sim/sheet.ts';
import { $, el, esc, num, store, tip } from './dom.ts';
import { icon } from './icons.ts';
import { classLine, crest, sheetStats, skillChips, skillTooltip } from './units.ts';
import { cooldownText, itemIcon, itemTooltip, skillGlyph } from './items.ts';
import { SLOT_LABEL } from './gamedata.ts';
import { FACTIONS } from '../sim/data/factions.ts';
import { cycleRows, inspectModel, pairModel, sparkPath, tickClock, SPARK_MIN_S, type InspectModel, type SkillRow } from './inspect-data.ts';

export interface InspectorCtx {
  decoded: DecodedReplay;
  /** The viewer's seat (null = spectator). */
  viewer: Seat | null;
  names: [string, string];
  /** The sim tick to show (playback position; the report passes the last tick). */
  tick(): number;
  /** The selection changed: 0, 1 or 2 replay rows (the battle marks their plates and insets the view). */
  onChange?(rows: number[]): void;
  /** Over the results card / report overlay rather than docked in the battle HUD. */
  floating?: boolean;
}

const SPARK_W = 100, SPARK_H = 26;

export class Inspector {
  readonly root: HTMLElement;
  /** Selected replay rows: [] closed, [a] one squad, [a, b] compare. */
  rows: number[] = [];
  private ctx: InspectorCtx;
  private base = 'insp panel';
  private min = store.get('insp.min') === '1';
  private last = new Map<string, string>();
  private flashT = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(host: HTMLElement, ctx: InspectorCtx) {
    this.ctx = ctx;
    this.base = `insp panel${ctx.floating ? ' floating' : ''}`;
    this.root = el(`<aside class="${this.base}" aria-live="off"></aside>`);
    host.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.in-x')) this.close();
      else if (t.closest('.in-min')) this.setMin(!this.min);
      else if (t.closest('.in-solo')) this.open(Number((t.closest('.in-solo') as HTMLElement).dataset.row));
    });
  }

  get isOpen(): boolean {
    return this.rows.length > 0;
  }

  /** Inspect one squad (again = stay). */
  open(row: number): void {
    if (row < 0) return;
    this.rows = [row];
    this.build();
  }

  /** Shift-click: add a second squad to compare with, or drop it again. */
  compare(row: number): void {
    if (row < 0) return;
    if (!this.rows.length || this.rows[0] === row) return this.open(row);
    this.rows = [this.rows[0]!, row];
    this.build();
  }

  /** Esc: compare falls back to the first squad, then the panel closes. Returns whether anything changed. */
  back(): boolean {
    if (!this.rows.length) return false;
    if (this.rows.length === 2) this.open(this.rows[0]!);
    else this.close();
    return true;
  }

  close(): void {
    if (!this.rows.length) return;
    this.rows = [];
    this.build();
  }

  /** Tab / Shift+Tab: the next squad, the viewer's own side first. */
  cycle(dir: 1 | -1): void {
    const order = cycleRows(this.ctx.decoded, this.ctx.viewer);
    if (!order.length) return;
    const at = this.rows.length ? order.indexOf(this.rows[0]!) : -1;
    this.open(order[at < 0 ? (dir > 0 ? 0 : order.length - 1) : (at + dir + order.length) % order.length]!);
  }

  private setMin(on: boolean): void {
    this.min = on;
    store.set('insp.min', on ? '1' : '0');
    this.root.classList.toggle('min', on);
    $(this.root, '.in-min').dataset.tip = on ? 'Expand' : 'Collapse';
    this.ctx.onChange?.(this.rows);
  }

  private stats() {
    return squadStatsAt(this.ctx.decoded, this.ctx.tick());
  }

  private model(row: number): InspectModel | null {
    return inspectModel(this.ctx.decoded, this.stats(), row, this.ctx.viewer, this.ctx.names);
  }

  private sideLabel(side: Seat, short = false): string {
    const v = this.ctx.viewer;
    return v === null ? this.ctx.names[side] : side === v ? (short ? 'Yours' : 'Your squad') : short ? 'Enemy' : 'Enemy squad';
  }

  private teamClass(side: Seat): 'me' | 'foe' {
    return side === (this.ctx.viewer ?? 0) ? 'me' : 'foe';
  }

  private head(m: InspectModel, solo = false): string {
    const pips = m.type === 'lord'
      ? `<div class="sp-pips"><small>Lord · level ${m.level}</small></div>`
      : `<div class="sp-pips">${Array.from({ length: MAX_SQUAD_LEVEL }, (_, i) => `<i class="${i < m.level ? 'on' : ''}"></i>`).join('')}<small>Lv ${m.level}</small></div>`;
    return `${crest(m.type, m.lord, solo ? 'md' : 'lg')}<div class="in-t"><small data-tip="${esc(FACTIONS[m.faction].name)}">${esc(this.sideLabel(m.side, solo))}${solo ? '' : ` · ${esc(FACTIONS[m.faction].short)}`}${m.role && m.type !== 'lord' && !solo ? ` · ${esc(m.role)}` : ''}</small><b>${esc(m.name)}</b>${solo ? '' : pips}</div>`;
  }

  private bar(key: string): string {
    return `<div class="in-bar" data-k="${key}" data-tip="Soldiers standing and the squad's total life"><i></i><span></span><em></em></div>`;
  }

  /** Build the panel for the current selection, then fill in the live numbers. */
  private build(): void {
    this.last.clear();
    const r = this.root;
    const models = this.rows.map((row) => this.model(row));
    if (!models.length || models.some((m) => !m)) {
      this.rows = [];
      r.className = this.base;
      r.innerHTML = '';
      this.ctx.onChange?.(this.rows);
      return;
    }
    const [a, b] = models as InspectModel[];
    const tools = `<button class="icon in-min" data-tip="${this.min ? 'Expand' : 'Collapse'}"><i class="in-chev"></i></button><button class="icon in-x" data-tip="Close [Esc]">${icon('close')}</button>`;
    if (b) {
      r.className = `${this.base} on cmp${this.min ? ' min' : ''}`;
      r.innerHTML = `
        <header class="in-h"><b class="in-title">Compare</b>${tools}</header>
        <div class="in-vs">
          <button class="in-solo ${this.teamClass(a!.side)}" data-row="${a!.row}" data-tip="Inspect this squad alone">${this.head(a!, true)}</button>
          <i>vs</i>
          <button class="in-solo ${this.teamClass(b.side)}" data-row="${b.row}" data-tip="Inspect this squad alone">${this.head(b, true)}</button>
        </div>
        <div class="in-body">
          <div class="in-bars"><div class="${this.teamClass(a!.side)}">${this.bar('a')}</div><div class="${this.teamClass(b.side)}">${this.bar('b')}</div></div>
          <section class="in-pair"><small>Damage between them</small>
            <div class="in-pr ${this.teamClass(a!.side)}" data-k="ab"><span>${esc(a!.name)} → ${esc(b.name)}</span><b></b><i><u></u></i><em></em></div>
            <div class="in-pr ${this.teamClass(b.side)}" data-k="ba"><span>${esc(b.name)} → ${esc(a!.name)}</span><b></b><i><u></u></i><em></em></div>
          </section>
          <section><small>Performance</small><div class="in-cmp" data-k="perf"></div><p class="in-none in-idle" data-k="idle"></p></section>
          <section class="in-spark"><small>Life over time</small><svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true"><path class="l ${this.teamClass(a!.side)}" data-k="a"/><path class="l ${this.teamClass(b.side)} two" data-k="b"/></svg></section>
          <section><small>Stats now</small><div class="in-cmp">${this.statCompare(a!, b)}</div></section>
          <p class="in-hint">Click ${this.ctx.floating ? 'a row' : 'a squad'} to inspect it alone · <kbd>Esc</kbd> back</p>
        </div>`;
    } else {
      const m = a!;
      const items = m.sheet?.items ?? [];
      const actives = m.skills.filter((k) => k.casts !== null);
      const passives = m.skills.filter((k) => k.casts === null).map((k) => k.info);
      const healer = !!m.sheet?.stats.some((l) => l.key === 'heal');
      const cell = (k: string, label: string, tipText: string, cls = ''): string => `<div class="in-c ${cls}" data-k="${k}" data-tip="${esc(tipText)}"><small>${label}</small><b>0</b></div>`;
      r.className = `${this.base} on ${this.teamClass(m.side)}${this.min ? ' min' : ''}`;
      r.innerHTML = `
        <header class="in-h">${this.head(m)}${tools}</header>
        ${this.bar('a')}
        <div class="in-body">
          ${classLine(m.type, m.lord, true)}
          <section class="in-perf">
            ${cell('dealt', 'Damage dealt', 'Life removed from the enemy: attacks, burns and abilities, with no overkill')}
            ${cell('taken', 'Damage taken', 'Life this squad has lost')}
            ${cell('mitigated', 'Mitigated', 'Damage its armor, resistance and shields absorbed')}
            ${cell('kills', 'Kills', 'Enemy soldiers killed')}
            ${cell('losses', 'Losses', 'Soldiers lost')}
            ${cell('keep', 'Keep damage', 'Damage dealt to the enemy Keep on the march')}
            ${cell('healD', 'Healing done', 'Life restored on allies and itself: heals, lifesteal, revives', healer ? '' : 'opt')}
            ${cell('healR', 'Healing received', 'Life restored on this squad', healer ? '' : 'opt')}
          </section>
          <p class="in-rank" data-k="rank"></p>
          <section class="in-spark"><small>Life over time</small><svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true"><path class="a" data-k="area"/><path class="l" data-k="a"/></svg></section>
          <section class="in-causes"><small>Damage by source</small><div class="in-cl" data-k="causes"></div></section>
          ${m.skills.length ? `<section class="in-skills"><small>Abilities</small>
            ${actives.map((k, i) => `<div class="in-sk" data-sk="${i}" data-id="${esc(k.info.id)}">${k.info.skill ? skillGlyph(k.info.skill) : `<i class="sk-i">${icon(k.info.source === 'lord' ? 'crown' : 'star')}</i>`}<div><b>${esc(k.info.name)}</b><small data-k="sk${i}"></small></div>${k.info.cooldown !== undefined ? `<span class="sk-cd">${icon('timer')}${cooldownText(k.info.cooldown)}</span>` : ''}</div>`).join('')}
            ${passives.length ? `<div class="sp-skills">${skillChips(passives, items.map((x) => x.item))}</div>` : ''}
          </section>` : ''}
          <section class="in-items"><small>Equipment</small><div class="sp-slots">${items.map((s) => `<div class="sp-slot ${s.open ? '' : 'locked'}" data-slot="${s.slot}">${itemIcon(s.item, { slot: s.slot, locked: s.open ? undefined : s.opensAt, size: 'md' })}<small>${SLOT_LABEL[s.slot]}</small></div>`).join('')}</div></section>
          ${m.sheet ? `<details class="sp-sec st-d" ${store.get('insp.stats') === '1' ? 'open' : ''}><summary><span>Stats</span></summary>${sheetStats(m.sheet)}</details>` : ''}
          <p class="in-hint">${this.ctx.floating ? '<kbd>Shift</kbd>+click another row to compare' : '<kbd>Shift</kbd>+click a squad to compare · <kbd>Tab</kbd> next'}</p>
        </div>`;
      // tooltips: abilities by name, items in full
      r.querySelectorAll<HTMLElement>('.in-sk').forEach((n) => {
        const k = actives[Number(n.dataset.sk)]!.info;
        const it = k.item !== undefined ? items.find((x) => x.item?.id === k.item)?.item ?? null : null;
        tip(n, () => skillTooltip(k, it));
      });
      r.querySelectorAll<HTMLElement>('.sk-chip').forEach((n) => {
        const k = passives[Number(n.dataset.sk)];
        if (!k) return;
        const it = k.item !== undefined ? items.find((x) => x.item?.id === k.item)?.item ?? null : null;
        tip(n, () => skillTooltip(k, it));
      });
      r.querySelectorAll<HTMLElement>('.in-items [data-item]').forEach((n) => {
        const it: Item | null = items.find((x) => x.item?.id === Number(n.dataset.item))?.item ?? null;
        if (it) tip(n, () => itemTooltip(it, { on: { type: m.type, lord: m.sheet?.lord ?? m.lord } }));
      });
      r.querySelector('.st-d')?.addEventListener('toggle', (e) => store.set('insp.stats', (e.target as HTMLDetailsElement).open ? '1' : '0'));
    }
    this.update();
    this.ctx.onChange?.(this.rows);
  }

  private statCompare(a: InspectModel, b: InspectModel): string {
    const keys: StatLine['key'][] = ['soldiers', 'hp', 'damage', 'attackInterval', 'dps', 'range', 'armor', 'magicResist', 'speed'];
    const label: Partial<Record<StatLine['key'], string>> = { soldiers: 'Soldiers', hp: 'Life each', damage: 'Damage', attackInterval: 'Attack every', dps: 'Squad DPS', range: 'Range', armor: 'Armor', magicResist: 'Magic res.', speed: 'Speed' };
    const fmt = (l: StatLine | undefined): string => (!l ? '–' : l.unit === '%' ? `${l.value}%` : l.unit ? `${l.value} ${l.unit}` : num(l.value));
    return keys.map((k) => {
      const x = a.sheet?.stats.find((l) => l.key === k), y = b.sheet?.stats.find((l) => l.key === k);
      const hi = x && y && x.value !== y.value ? (x.value > y.value === x.higherIsBetter ? 'a' : 'b') : '';
      return `<span>${label[k]}</span><b class="${hi === 'a' ? 'hi' : ''}">${fmt(x)}</b><b class="${hi === 'b' ? 'hi' : ''}">${fmt(y)}</b>`;
    }).join('');
  }

  /** Write `text` into the node keyed `k` only when it changed since the last update. */
  private put(k: string, text: string, html = false): void {
    if (this.last.get(k) === text) return;
    this.last.set(k, text);
    const n = this.root.querySelector<HTMLElement>(`[data-k="${k}"]`);
    if (!n) return;
    const target = n.classList.contains('in-c') ? n.querySelector('b')! : n;
    if (html) target.innerHTML = text;
    else target.textContent = text;
  }

  private putBar(k: string, m: InspectModel): void {
    const sig = `${m.alive}/${m.soldiers}/${m.hp}/${m.wipedAt}`;
    if (this.last.get(`bar${k}`) === sig) return;
    this.last.set(`bar${k}`, sig);
    const n = this.root.querySelector<HTMLElement>(`.in-bar[data-k="${k}"]`);
    if (!n) return;
    (n.querySelector('i') as HTMLElement).style.width = `${Math.max(0, Math.min(100, (m.hp / Math.max(1, m.hpMax)) * 100))}%`;
    n.classList.toggle('dead', m.alive <= 0);
    n.querySelector('span')!.textContent = m.alive <= 0 ? (m.wipedAt >= 0 ? `Wiped out at ${tickClock(m.wipedAt, TICK_HZ)}` : 'Wiped out') : m.type === 'lord' ? 'Standing' : `${m.alive} / ${m.soldiers} soldiers`;
    n.querySelector('em')!.textContent = `${num(m.hp)} / ${num(m.hpMax)}`;
  }

  private skillLine(k: SkillRow): string {
    if (k.casts === null) return '';
    if (!k.casts) return 'Not cast yet';
    const parts = [`${k.casts} cast${k.casts === 1 ? '' : 's'}`];
    if (k.damage) parts.push(`${num(k.damage)} damage`);
    if (k.healing) parts.push(`${num(k.healing)} healed`);
    if (k.hits) parts.push(`${k.hits} hit${k.hits === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }

  /** Refresh the live numbers (call at about 4 Hz while open; a no-op when closed). */
  update(): void {
    if (!this.rows.length) return;
    const st = this.stats();
    const d = this.ctx.decoded;
    const a = inspectModel(d, st, this.rows[0]!, this.ctx.viewer, this.ctx.names);
    if (!a) return;
    this.putBar('a', a);
    // the chart is the battle so far (never less than SPARK_MIN_S wide), inset so a full-life line is not lost in the frame
    const line = (m: InspectModel, n = m.series.length) => sparkPath(m.series, m.hpMax, SPARK_W, SPARK_H, Math.max(SPARK_MIN_S, n - 1), 2.5);
    if (this.rows.length === 2) {
      const b = inspectModel(d, st, this.rows[1]!, this.ctx.viewer, this.ctx.names);
      if (!b) return;
      this.putBar('b', b);
      const p = pairModel(d, st, a.row, b.row);
      const top = Math.max(1, p.aToB, p.bToA);
      const pr = (k: string, v: number, share: number, victim: string): void => {
        const sig = `${v}`;
        if (this.last.get(`pr${k}`) === sig) return;
        this.last.set(`pr${k}`, sig);
        const n = this.root.querySelector<HTMLElement>(`.in-pr[data-k="${k}"]`);
        if (!n) return;
        n.querySelector('b')!.textContent = num(v);
        (n.querySelector('u') as HTMLElement).style.width = `${(v / top) * 100}%`;
        n.querySelector('em')!.textContent = v ? `${Math.round(share * 100)}% of ${victim}'s life` : 'none yet';
      };
      // both bars share one scale, so they are rewritten together
      if (this.last.get('prtop') !== String(top)) { this.last.set('prtop', String(top)); this.last.delete('prab'); this.last.delete('prba'); }
      pr('ab', p.aToB, p.aToBShare, b.name);
      pr('ba', p.bToA, p.bToAShare, a.name);
      const rows: [string, number, number, boolean][] = [
        ['Damage dealt', a.dealt, b.dealt, true], ['Damage taken', a.taken, b.taken, false], ['Mitigated', a.mitigated, b.mitigated, true],
        ['Healing done', a.healingDone, b.healingDone, true], ['Kills', a.kills, b.kills, true], ['Losses', a.losses, b.losses, false], ['Keep damage', a.keepDamage, b.keepDamage, true],
      ];
      this.put('perf', rows.filter(([l, x, y]) => x || y || l === 'Damage dealt' || l === 'Damage taken' || l === 'Kills' || l === 'Losses')
        .map(([l, x, y, up]) => `<span>${l}</span><b class="${x !== y && x > y === up ? 'hi' : ''}">${num(x)}</b><b class="${x !== y && y > x === up ? 'hi' : ''}">${num(y)}</b>`).join(''), true);
      const both = Math.max(a.series.length, b.series.length);
      this.putAttr('a', 'd', line(a, both).line);
      this.putAttr('b', 'd', line(b, both).line);
      this.put('idle', a.idle && b.idle ? 'Neither has reached the fight yet.' : a.idle ? `${a.name} has not reached the fight yet.` : b.idle ? `${b.name} has not reached the fight yet.` : '');
      return;
    }
    this.put('dealt', num(a.dealt));
    this.put('taken', num(a.taken));
    this.put('mitigated', num(a.mitigated));
    this.put('kills', String(a.kills));
    this.put('losses', String(a.losses));
    this.put('keep', num(a.keepDamage));
    this.put('healD', num(a.healingDone));
    this.put('healR', num(a.healingReceived));
    // the healing cells of a squad that is no healer appear once there is something in them
    const heal = a.healingDone + a.healingReceived > 0;
    if (this.last.get('healOn') !== String(heal)) {
      this.last.set('healOn', String(heal));
      this.root.querySelectorAll('.in-c.opt').forEach((n) => n.classList.toggle('show', heal));
    }
    this.put('rank', a.rank || (a.idle ? 'Has not reached the fight yet' : a.alive > 0 ? 'No damage dealt yet' : 'Fell without dealing damage'));
    const s = line(a);
    this.putAttr('a', 'd', s.line);
    this.putAttr('area', 'd', s.area);
    this.put('causes', a.causes.length
      ? a.causes.map((c) => `<div class="in-cr"><span>${esc(c.label)}</span><i><u style="width:${Math.max(2, Math.round(c.share * 100))}%"></u></i><b>${num(c.value)}</b><em>${Math.round(c.share * 100)}%</em></div>`).join('')
      : '<p class="in-none">Nothing yet</p>', true);
    a.skills.filter((k) => k.casts !== null).forEach((k, i) => this.put(`sk${i}`, this.skillLine(k)));
  }

  private putAttr(k: string, attr: string, v: string): void {
    const key = `@${k}`;
    if (this.last.get(key) === v) return;
    this.last.set(key, v);
    this.root.querySelector(`svg [data-k="${k}"]`)?.setAttribute(attr, v);
  }

  /** A cast just fired: flash that ability's row if its squad is the one on show. */
  flash(row: number, id: string): void {
    if (this.rows.length !== 1 || this.rows[0] !== row) return;
    const n = this.root.querySelector<HTMLElement>(`.in-sk[data-id="${CSS.escape(id)}"]`);
    if (!n) return;
    n.classList.remove('cast');
    void n.offsetWidth;
    n.classList.add('cast');
    clearTimeout(this.flashT.get(id));
    this.flashT.set(id, setTimeout(() => n.classList.remove('cast'), 900));
  }

  /** Width the panel takes on the right of the screen (CSS px), 0 when closed: the battle insets the view by it. */
  dockWidth(): number {
    if (!this.rows.length) return 0;
    const r = this.root.getBoundingClientRect();
    return Math.round(window.innerWidth - r.left);
  }

  dispose(): void {
    this.flashT.forEach((t) => clearTimeout(t));
    this.root.remove();
  }
}
