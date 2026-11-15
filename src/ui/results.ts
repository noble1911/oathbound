// Round results: the outcome in the sim's own words, up to three lines that explain the round
// (src/ui/insights.ts), a per-squad table of damage dealt / taken / healed / kills / survivors for both
// armies, Keep damage with an animated count, the gold coming next round, the spoils waiting and
// the countdown. The same report opens again during planning (ReportOverlay), because six seconds
// is not long to read a table. Then the match-over cinematic: victory / defeat, match totals, the
// per-round damage chart, and Play again (vs AI) or Rematch votes (PvP).
import type { BattleResult, LordId, PlayerView, RoundSummary, Seat, Squad } from '../sim/types.ts';
import type { RoomView } from '../net/protocol.ts';
import { battleClock, TIME_LIMIT_TICKS } from './insights.ts';
import { income } from '../sim/match.ts';
import * as match from '../sim/match.ts';
import { sound } from '../audio.ts';
import { playLordLine } from '../audio/voice.ts';
import { $, el, esc, num, secsLeft } from './dom.ts';
import { icon } from './icons.ts';
import { crest } from './units.ts';
import { RARITY_CSS, unitName } from './gamedata.ts';
import { LORDS } from '../sim/data/lords.ts';
import type { BattleStats, Hint, SquadStat } from './insights.ts';
import type { DecodedReplay } from '../sim/types.ts';
import { Inspector } from './inspector.ts';
import { rowOfSquad } from './inspect-data.ts';

export interface MvpInfo { squad: Squad | null; type: Squad['type'] | null; lord: LordId | null; dmg: number; kills: number }

/** One battle, ready to show: the stats, the explanation and who was who. */
export interface BattleReport {
  round: number;
  stats: BattleStats;
  /** The battle itself, when this client watched it: rows of the report open the inspector on it. */
  decoded?: DecodedReplay;
  hints: Hint[];
  /** Whose point of view (spectators: seat 0) and whether the viewer is a spectator. */
  me: Seat;
  spectator: boolean;
  names: [string, string];
}

function countUp(node: HTMLElement, to: number, ms = 1200): void {
  const t0 = performance.now();
  const step = (now: number) => {
    const f = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - f, 3);
    node.textContent = num(to * e);
    if (f < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

type OutcomeText = { outcome: 'won' | 'lost' | 'draw'; title: string; detail: string };

/** The sim's wording for a round when it provides it (roundOutcomeText), else a plain fallback. */
export function outcomeText(r: Pick<RoundSummary, 'winner'> & Partial<Omit<RoundSummary, 'survivors'>> & { survivors?: unknown }, seat: Seat | null, timeout = false): OutcomeText {
  const f = (match as unknown as { roundOutcomeText?: (r: unknown, seat: Seat | null) => OutcomeText }).roundOutcomeText;
  if (typeof f === 'function' && r.end) {
    const t = f(r, seat);
    // both armies still stood: the sentence states the real end (the clock at 1:30, or a stalemate
    // called at its actual time) and never shows a standing army as 0%
    if (r.end === 'timeout' || r.end === 'stalemate') {
      const me = (seat ?? 0) as Seat;
      const foe = (1 - me) as Seat;
      const alive = (i: Seat): boolean => {
        const sv = (r.survivors as unknown[] | undefined)?.[i];
        return sv === undefined ? true : Array.isArray(sv) ? sv.length > 0 : Number(sv) > 0;
      };
      const share = (i: Seat) => Math.max(alive(i) ? 1 : 0, Math.round(r.score?.[i] ?? 0));
      const pts = `${share(me)}% of ${seat === null ? "Blue's army" : 'your army'} still stands, ${share(foe)}% of ${seat === null ? "Red's army" : 'the enemy'}`;
      const at = r.ticks ? ` at ${battleClock(r.end === 'timeout' ? TIME_LIMIT_TICKS : Math.min(r.ticks, TIME_LIMIT_TICKS))}` : '';
      const even = t.outcome === 'draw';
      t.detail = r.end === 'timeout'
        ? `Time ran out${at}${even ? ' with the armies even' : ''}: ${pts}.`
        : `Neither army could still harm the other, so the battle was called${at}${even ? ' with the armies even' : ''}: ${pts}.`;
    }
    return t;
  }
  const me = seat ?? 0;
  const outcome = r.winner === null ? 'draw' : r.winner === me ? 'won' : 'lost';
  return { outcome, title: outcome === 'draw' ? 'Stalemate' : outcome === 'won' ? 'Victory' : 'Defeat', detail: timeout ? 'Time ran out.' : 'The field is decided.' };
}

const HINT_ICON: Record<Hint['tone'], string> = { good: 'ready', bad: 'skull', info: 'help' };

export function hintsHtml(hints: Hint[]): string {
  if (!hints.length) return '';
  return `<ul class="res-hints">${hints.map((h) => `<li class="${h.tone}">${icon(HINT_ICON[h.tone])}<span>${esc(h.text)}</span></li>`).join('')}</ul>`;
}

function armyTable(list: SquadStat[], cls: 'me' | 'foe', title: string, maxDealt: number, heal: boolean): string {
  const rows = [...list].sort((a, b) => b.dealt - a.dealt);
  const total = rows.reduce((a, q) => a + q.dealt, 0);
  return `<div class="rt-army ${cls}">
    <header><b>${esc(title)}</b><span>${num(total)} damage</span></header>
    <div class="rt-head"><span></span><span>Squad</span><span data-tip="Life removed from the enemy, burns and abilities included">Dealt</span><span data-tip="Life lost (overkill is not counted)">Taken</span>${heal ? '<span data-tip="Life restored on allies and itself: heals, lifesteal, revives">Healed</span>' : ''}<span data-tip="Enemy soldiers killed">Kills</span><span data-tip="Soldiers still standing at the end">Left</span></div>
    ${rows
      .map((q, i) => {
        const left = Math.max(0, q.size - q.lost);
        return `<div class="rt-row ${left === 0 ? 'dead' : ''}" data-squad="${q.id}" data-side="${q.side}">
          ${crest(q.type, q.lord, 'sm')}
          <span class="rt-name" data-tip="${esc(unitName(q.type, q.lord))} · level ${q.level}${i === 0 && q.dealt > 0 ? ' · most damage' : ''}">${i === 0 && q.dealt > 0 ? icon('crown') : ''}<b>${esc(q.type === 'lord' && q.lord ? LORDS[q.lord].name : unitName(q.type, q.lord))}</b><small>Lv ${q.level}</small></span>
          <span class="rt-bar"><i style="width:${Math.round((q.dealt / maxDealt) * 100)}%"></i><em>${num(q.dealt)}</em></span>
          <span class="rt-n">${num(q.taken)}</span>
          ${heal ? `<span class="rt-n">${q.healed ? num(q.healed) : '–'}</span>` : ''}
          <span class="rt-n">${q.kills}</span>
          <span class="rt-n left">${left === 0 ? icon('skull') : `${left}/${q.size}`}</span>
        </div>`;
      })
      .join('')}
  </div>`;
}

/**
 * Rows of a report table open the battle inspector on that squad, at the last tick of the battle
 * (Shift+click a second row to compare). Returns the inspector, or null when the battle is not held.
 */
export function attachReportInspector(root: HTMLElement, rep: BattleReport): Inspector | null {
  const d = rep.decoded;
  const table = root.querySelector<HTMLElement>('.res-table');
  if (!d || !table) return null;
  table.classList.add('pick');
  const insp = new Inspector(root, {
    decoded: d, viewer: rep.spectator ? null : rep.me, names: rep.names, tick: () => d.replay.ticks, floating: true,
    onChange: (rows) => {
      table.querySelectorAll<HTMLElement>('.rt-row').forEach((n) => n.classList.toggle('sel', rows.includes(rowOfSquad(d, Number(n.dataset.squad), Number(n.dataset.side) as Seat))));
      // the panel sits over the other army's table, so the row it describes stays in view
      const first = rows.length ? d.replay.squads[rows[0]!] : null;
      if (first) insp.root.classList.toggle('left', first.side !== rep.me);
    },
  });
  table.addEventListener('click', (e) => {
    const n = (e.target as HTMLElement).closest<HTMLElement>('.rt-row[data-squad]');
    if (!n) return;
    const row = rowOfSquad(d, Number(n.dataset.squad), Number(n.dataset.side) as Seat);
    if (row < 0) return;
    sound.click();
    if (e.shiftKey) insp.compare(row);
    else if (insp.rows.length === 1 && insp.rows[0] === row) insp.close();
    else insp.open(row);
  });
  return insp;
}

/** Both armies side by side: damage dealt / taken, kills and survivors per squad. */
export function reportTable(rep: BattleReport): string {
  const mine = rep.stats.squads.filter((q) => q.side === rep.me);
  const theirs = rep.stats.squads.filter((q) => q.side !== rep.me);
  const max = Math.max(1, ...rep.stats.squads.map((q) => q.dealt));
  const a = rep.spectator ? `${rep.names[rep.me]}'s army` : 'Your army';
  const b = rep.spectator ? `${rep.names[1 - rep.me]}'s army` : 'Enemy army';
  // healing gets a column only in a battle where somebody healed
  const heal = rep.stats.squads.some((q) => q.healed > 0);
  return `<div class="res-table${heal ? ' heal' : ''}">${armyTable(mine, 'me', a, max, heal)}${armyTable(theirs, 'foe', b, max, heal)}</div>`;
}

export class ResultsScreen {
  readonly root: HTMLElement;
  private iv: ReturnType<typeof setInterval>;
  private endsAt = 0;
  private insp: Inspector | null = null;
  private key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.insp?.isOpen || document.querySelector('.rules-veil, .dialog-veil, .settings.on')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.insp.back();
  };

  constructor(ui: HTMLElement, room: RoomView, result: BattleResult | null, report: BattleReport | null) {
    const v = room.view!;
    const me = (v.seat ?? 0) as Seat;
    const foe = (1 - me) as Seat;
    const last = v.history.at(-1);
    const res = result ?? (last ? ({ winner: last.winner, keepDamage: last.keepDamage, timeout: false, survivors: [[], []] } as unknown as BattleResult) : null);
    const spect = v.seat === null;
    const txt = outcomeText(last ?? { winner: res?.winner ?? null }, v.seat, !!res?.timeout);
    const title = spect ? (txt.outcome === 'draw' ? txt.title : `${room.seats[txt.outcome === 'won' ? me : foe]?.name ?? 'Seat ' + (txt.outcome === 'won' ? me : foe)} takes the round`) : txt.title;
    const dealt = res ? res.keepDamage[foe] : 0;
    const taken = res ? res.keepDamage[me] : 0;
    const you = v.you;
    const nextInc = income(v.round + 1);
    const offer = you?.lootOffer;
    const myKeep = you?.keepHp ?? v.enemies?.[me]?.keepHp ?? 0;
    const foeKeep = v.enemies?.[foe]?.keepHp ?? v.enemy.keepHp;
    this.root = el(`<div class="screen results">
      <div class="res-card panel ${txt.outcome === 'draw' ? 'neutral' : txt.outcome}">
        <small class="eyebrow">Round ${v.round}</small>
        <h2 class="res-title">${esc(title)}</h2>
        <p class="res-detail">${esc(txt.detail)}</p>
        ${report ? hintsHtml(report.hints) : ''}
        ${report ? reportTable(report) : ''}
        <div class="res-foot">
          <div class="rk dealt"><small>${spect ? `Damage to ${esc(room.seats[foe]?.name ?? '')}'s Keep` : 'Damage to the enemy Keep'}</small><b class="cnt" data-to="${dealt}">0</b><span>${icon('keep')}${num(foeKeep)} left</span></div>
          <div class="rk taken"><small>${spect ? `Damage to ${esc(room.seats[me]?.name ?? '')}'s Keep` : 'Damage to your Keep'}</small><b class="cnt" data-to="${taken}">0</b><span>${icon('keep')}${num(myKeep)} left</span></div>
          ${you ? `<div class="res-gold"><small>${icon('gold')}Next round's war chest</small>
            <div class="rg-row"><span>Carried over</span><b>${num(you.gold)}</b></div>
            <div class="rg-row"><span>Round ${v.round + 1} income</span><b>+${num(nextInc)}</b></div>
            <div class="rg-row total"><span>Total</span><b>${num(you.gold + nextInc)}</b></div></div>` : ''}
        </div>
        ${offer ? `<div class="res-loot">${icon('bag')}<span>Spoils await: choose 1 of ${offer.length}</span><i>${offer.map((it) => `<em style="background:${RARITY_CSS[it.rarity]}"></em>`).join('')}</i></div>` : ''}
        <p class="res-next muted">Next round in <b>5</b>…${report && you ? ' The battle report stays open to you while planning.' : ''}</p>
      </div>
    </div>`);
    ui.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('.cnt').forEach((n, i) => setTimeout(() => countUp(n, Number(n.dataset.to)), 350 + i * 250));
    if (offer?.some((i) => i.rarity === 'legendary')) setTimeout(() => sound.lootReveal('rare'), 900);
    this.iv = setInterval(() => ($(this.root, '.res-next b').textContent = String(secsLeft(this.endsAt))), 1000);
    if (report) this.insp = attachReportInspector(this.root, report);
    window.addEventListener('keydown', this.key, true);
    this.update(room);
  }

  update(room: RoomView): void {
    this.endsAt = room.phaseEndsAt - room.serverNow + Date.now();
    $(this.root, '.res-next b').textContent = String(secsLeft(this.endsAt));
  }

  dispose(): void {
    clearInterval(this.iv);
    window.removeEventListener('keydown', this.key, true);
    this.insp?.dispose();
    this.root.remove();
  }
}

/** Last round's report again, during planning (the "Battle report" notice). Esc or a click outside closes it. */
export class ReportOverlay {
  readonly root: HTMLElement;
  private insp: Inspector | null = null;
  private key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Esc closes the inspector first, then the report
    if (!this.insp?.back()) this.dispose();
  };

  constructor(ui: HTMLElement, rep: BattleReport, title: string) {
    this.root = el(`<div class="report-veil" role="dialog" aria-modal="true"><div class="res-card panel report">
      <header class="rp-head"><div><small class="eyebrow">Round ${rep.round} · battle report</small><h2 class="res-title">${esc(title)}</h2></div><button class="icon close" data-tip="Close [Esc]">${icon('close')}</button></header>
      ${hintsHtml(rep.hints)}
      ${reportTable(rep)}
    </div></div>`);
    ui.appendChild(this.root);
    this.root.addEventListener('pointerdown', (e) => e.target === this.root && this.dispose());
    $(this.root, '.rp-head .close').addEventListener('click', () => this.dispose());
    this.insp = attachReportInspector(this.root, rep);
    window.addEventListener('keydown', this.key, true);
    sound.open();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.key, true);
    this.insp?.dispose();
    this.root.remove();
  }
}

/** Totals over the whole match, from the battles this client watched. */
export interface MatchTotals {
  dealt: number;
  taken: number;
  kills: number;
  lost: number;
  /** The viewer's hardest-hitting squad over the match. */
  mvp: { type: Squad['type']; lord: LordId | null; dmg: number; kills: number } | null;
  /** How many battles the totals cover (a rejoin may have missed some). */
  battles: number;
}

export function matchTotals(reports: BattleReport[]): MatchTotals {
  const t: MatchTotals = { dealt: 0, taken: 0, kills: 0, lost: 0, mvp: null, battles: reports.length };
  const by = new Map<number, { type: Squad['type']; lord: LordId | null; dmg: number; kills: number }>();
  for (const r of reports) {
    for (const q of r.stats.squads) {
      if (q.side !== r.me) continue;
      t.dealt += q.dealt;
      t.taken += q.taken;
      t.kills += q.kills;
      t.lost += q.lost;
      const m = by.get(q.id) ?? { type: q.type, lord: q.lord, dmg: 0, kills: 0 };
      m.dmg += q.dealt;
      m.kills += q.kills;
      by.set(q.id, m);
    }
  }
  for (const m of by.values()) if (!t.mvp || m.dmg > t.mvp.dmg) t.mvp = m;
  return t;
}

/**
 * How a finished match ended. `RoomView.over` names the reason and, for a concession, the seat that
 * gave up; a snapshot without it (the offline match) falls back on the view's `overReason`, where
 * the one who conceded is the one who lost.
 */
export function matchEnd(room: Pick<RoomView, 'over' | 'view'>): { reason: NonNullable<PlayerView['overReason']>; by: Seat | null } {
  const v = room.view;
  const reason = room.over?.reason ?? v?.overReason ?? 'keep';
  if (reason !== 'concede') return { reason, by: null };
  const by = room.over?.by ?? (v && (v.winner === 0 || v.winner === 1) ? ((1 - v.winner) as Seat) : null);
  return { reason, by };
}

/** The match ended because a player gave up (or left a running match). */
export function matchConceded(room: Pick<RoomView, 'over' | 'view'>): boolean {
  return matchEnd(room).reason === 'concede';
}

export class MatchOverScreen {
  readonly root: HTMLElement;
  private body: HTMLElement;

  private act: { rematch(): void; leave(): void };

  constructor(ui: HTMLElement, room: RoomView, act: { rematch(): void; leave(): void }, totals: MatchTotals | null = null) {
    this.act = act;
    const v = room.view!;
    const me = (v.seat ?? 0) as Seat;
    const foe = (1 - me) as Seat;
    const spect = v.seat === null;
    const win = v.winner;
    const outcome = win === 'draw' ? 'draw' : win === me ? 'victory' : 'defeat';
    const word = spect ? (win === 'draw' ? 'Draw' : `${room.seats[win as Seat]?.name ?? ''} is victorious`) : outcome === 'victory' ? 'Victory' : outcome === 'defeat' ? 'Defeat' : 'Draw';
    const myKeep = v.you?.keepHp ?? v.enemies?.[me]?.keepHp ?? 0;
    const foeKeep = v.enemies?.[foe]?.keepHp ?? v.enemy.keepHp;
    // a Keep can stand at the end: a conceded match, or the round limit decided on Keep life
    const end = matchEnd(room);
    const conceded = end.reason === 'concede' && (win === 0 || win === 1);
    const quitter = conceded ? (end.by ?? ((1 - (win as Seat)) as Seat)) : null;
    const loser = quitter !== null ? room.seats[quitter]?.name || 'A commander' : '';
    const sub = conceded ? (quitter === me ? 'You conceded the war.' : 'Your opponent conceded.') : outcome === 'victory' ? (foeKeep <= 0 ? 'The enemy Keep lies in ruins.' : 'The war is decided: your Keep stands taller.') : outcome === 'defeat' ? (myKeep <= 0 ? 'Your Keep has fallen.' : 'The war is decided against you.') : 'Neither Keep outlasted the other.';
    const h = v.history;
    const dealt = h.reduce((a, r) => a + r.keepDamage[foe], 0);
    const taken = h.reduce((a, r) => a + r.keepDamage[me], 0);
    const wins = h.filter((r) => r.winner === me).length;
    const losses = h.filter((r) => r.winner === foe).length;
    const maxD = Math.max(1, ...h.map((r) => Math.max(r.keepDamage[0], r.keepDamage[1])));
    const best = h.reduce<RoundSummary | null>((b, r) => (!b || r.keepDamage[foe] > b.keepDamage[foe] ? r : b), null);
    const stat = (label: string, value: string, tip = '') => `<div ${tip ? `data-tip="${esc(tip)}"` : ''}><small>${label}</small><b>${value}</b></div>`;
    this.root = el(`<div class="screen over ${spect ? 'neutral' : outcome}${conceded ? ' conceded' : ''}">
      <div class="over-word"><b>${esc(word)}</b><small>${esc(spect ? (conceded ? `${loser} conceded ${h.length ? `after ${h.length} round${h.length === 1 ? '' : 's'}` : 'before the first battle'}` : `After ${h.length} rounds`) : sub)}</small></div>
      <div class="over-card panel">
        <div class="ov-stats">
          ${stat('Rounds', String(h.length))}
          ${stat(spect ? 'Rounds: South – North' : 'Won – lost', `${wins} – ${losses}`, 'Rounds won and lost (the rest were draws)')}
          ${stat('Keep damage dealt', num(dealt))}
          ${stat('Keep damage taken', num(taken))}
          ${best && best.keepDamage[foe] > 0 ? stat('Hardest blow', `${num(best.keepDamage[foe])}`, `Round ${best.round}: the most Keep damage dealt in one round`) : ''}
          ${totals && totals.battles ? stat('Damage dealt', num(totals.dealt), 'All damage your squads dealt in battle') : ''}
          ${totals && totals.battles ? stat('Kills – losses', `${num(totals.kills)} – ${num(totals.lost)}`, 'Enemy soldiers killed and your soldiers lost') : ''}
        </div>
        ${totals?.mvp && totals.mvp.dmg > 0 ? `<div class="ov-mvp">${crest(totals.mvp.type, totals.mvp.lord, 'md')}<div><small>${icon('crown')}Squad of the match</small><b>${esc(unitName(totals.mvp.type, totals.mvp.lord))}</b><span>${num(totals.mvp.dmg)} damage · ${totals.mvp.kills} kills</span></div></div>` : ''}
        <div class="ov-chart" aria-label="Keep damage per round">
          ${h.map((r) => `<div class="ovc" data-tip="Round ${r.round}: dealt ${r.keepDamage[foe]}, took ${r.keepDamage[me]}"><i class="d" style="height:${(r.keepDamage[foe] / maxD) * 100}%"></i><i class="t" style="height:${(r.keepDamage[me] / maxD) * 100}%"></i><small>${r.round}</small></div>`).join('')}
        </div>
        <div class="ov-legend"><span class="d">Keep damage dealt</span><span class="t">Keep damage taken</span></div>
        <div class="ov-acts"></div>
      </div>
    </div>`);
    this.body = $(this.root, '.ov-acts');
    ui.appendChild(this.root);
    if (!spect) setTimeout(() => sound.fanfare(outcome === 'victory'), 300);
    if (!spect && outcome !== 'draw') playLordLine(v.you?.lord, outcome, { delay: 2.2 });
    this.update(room);
  }

  update(room: RoomView): void {
    const me = room.me.seat;
    const foe = me === null ? null : room.seats[1 - me];
    // against the AI there is nobody to wait for: one click starts the next match
    const vsBot = room.mode === 'vsAI' || !!foe?.isBot;
    const humans = room.seats.filter((s) => s && !s.isBot).length;
    const votes = room.seats.filter((s) => s && !s.isBot && s.rematch).length;
    const mine = me !== null && !!room.seats[me]?.rematch;
    const html = `${me !== null ? `<button class="btn cta big rematch" ${mine ? 'disabled' : ''}>${vsBot ? (mine ? 'Starting…' : 'Play again') : mine ? `Waiting for your rival… (${votes}/${humans})` : votes ? `Rematch (${votes}/${humans}: your rival is ready)` : 'Rematch'}</button>` : ''}<button class="btn big leave">${me === null ? 'Stop watching' : 'Leave'}</button>`;
    if (this.body.dataset.h === html) return;
    this.body.dataset.h = html;
    this.body.innerHTML = html;
    this.body.querySelector('.rematch')?.addEventListener('click', () => (sound.click(), this.act.rematch()));
    $(this.body, '.leave').addEventListener('click', () => (sound.click(), this.act.leave()));
  }

  dispose(): void {
    this.root.remove();
  }
}

export function mvpOf(view: PlayerView | null, dmg: Map<number, { dmg: number; kills: number }> | null, seat: Seat, soldiers: { squad: number; side: Seat; type: string; lord?: LordId; summoned?: boolean }[]): MvpInfo | null {
  if (!dmg) return null;
  let best: { id: number; dmg: number; kills: number } | null = null;
  for (const [id, r] of dmg) {
    const s = soldiers.find((x) => x.squad === id);
    if (!s || s.side !== seat || s.summoned) continue;
    if (!best || r.dmg > best.dmg) best = { id, ...r };
  }
  if (!best) return null;
  const sol = soldiers.find((x) => x.squad === best!.id)!;
  const sq = view?.you?.squads.find((s) => s.id === best!.id) ?? null;
  return { squad: sq, type: sol.type as Squad['type'], lord: sol.lord ?? null, dmg: best.dmg, kills: best.kills };
}
