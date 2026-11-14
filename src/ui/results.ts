// Round results (outcome, Keep damage with an animated count, MVP squad, gold income breakdown,
// the spoils waiting next round, countdown) and the match-over cinematic (victory / defeat text,
// stats summary with a per-round damage chart, rematch votes).
import type { BattleResult, LordId, PlayerView, Seat, Squad } from '../sim/types.ts';
import type { RoomView } from '../net/protocol.ts';
import { income, CATCHUP_GOLD } from '../sim/match.ts';
import { sound } from '../audio.ts';
import { $, el, esc, num, secsLeft } from './dom.ts';
import { icon } from './icons.ts';
import { crest } from './units.ts';
import { RARITY_CSS, unitName } from './gamedata.ts';

export interface MvpInfo { squad: Squad | null; type: Squad['type'] | null; lord: LordId | null; dmg: number; kills: number }

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

export class ResultsScreen {
  readonly root: HTMLElement;
  private iv: ReturnType<typeof setInterval>;
  private endsAt = 0;

  constructor(ui: HTMLElement, room: RoomView, result: BattleResult | null, mvp: MvpInfo | null) {
    const v = room.view!;
    const me = (v.seat ?? 0) as Seat;
    const foe = (1 - me) as Seat;
    const last = v.history.at(-1);
    const res = result ?? (last ? ({ winner: last.winner, keepDamage: last.keepDamage, timeout: false, survivors: [[], []] } as unknown as BattleResult) : null);
    const won = res?.winner === null || !res ? null : res.winner === me;
    const spect = v.seat === null;
    const title = spect ? (res?.winner == null ? 'Stalemate' : `${room.seats[res.winner]?.name ?? 'Seat ' + res.winner} takes the round`) : won === null ? 'Stalemate' : won ? 'Victory' : 'Defeat';
    const dealt = res ? res.keepDamage[foe] : 0;
    const taken = res ? res.keepDamage[me] : 0;
    const you = v.you;
    const nextInc = income(v.round + 1);
    const catchup = you?.lostLast ? CATCHUP_GOLD : 0;
    const offer = you?.lootOffer;
    this.root = el(`<div class="screen results">
      <div class="res-card panel ${won === null ? 'neutral' : won ? 'won' : 'lost'}">
        <small class="eyebrow">Round ${v.round} · ${res?.timeout ? 'time ran out' : 'the field is decided'}</small>
        <h2 class="res-title">${esc(title)}</h2>
        <div class="res-keeps">
          <div class="rk dealt"><small>${spect ? `Damage to ${esc(room.seats[foe]?.name ?? '')}` : 'Damage to the enemy Keep'}</small><b class="cnt" data-to="${dealt}">0</b><span>${icon('keep')}${num(v.enemy.keepHp)} left</span></div>
          <div class="rk taken"><small>${spect ? `Damage to ${esc(room.seats[me]?.name ?? '')}` : 'Damage to your Keep'}</small><b class="cnt" data-to="${taken}">0</b><span>${icon('keep')}${num(you?.keepHp ?? v.enemies?.[me]?.keepHp ?? 0)} left</span></div>
        </div>
        ${mvp && mvp.type ? `<div class="res-mvp"><small>${icon('crown')}Most valuable squad</small><div class="mvp">${crest(mvp.type, mvp.lord, 'lg')}<div><b>${esc(unitName(mvp.type, mvp.lord))}</b><span>${num(mvp.dmg)} damage · ${mvp.kills} kills${mvp.squad ? ` · Lv ${mvp.squad.level}` : ''}</span></div></div></div>` : ''}
        ${you ? `<div class="res-gold"><small>${icon('gold')}Next round's war chest</small>
          <div class="rg-row"><span>Carried over</span><b>${num(you.gold)}</b></div>
          <div class="rg-row"><span>Round ${v.round + 1} income</span><b>+${num(nextInc)}</b></div>
          ${catchup ? `<div class="rg-row catch"><span>Catch-up (lost the round)</span><b>+${catchup}</b></div>` : ''}
          <div class="rg-row total"><span>Total</span><b>${num(you.gold + nextInc + catchup)}</b></div></div>` : ''}
        ${offer ? `<div class="res-loot">${icon('bag')}<span>Spoils await: choose 1 of ${offer.length}${you?.lostLast ? ' (one tier higher)' : ''}</span><i>${offer.map((it) => `<em style="background:${RARITY_CSS[it.rarity]}"></em>`).join('')}</i></div>` : ''}
        <p class="res-next muted">Next round in <b>5</b>…</p>
      </div>
    </div>`);
    ui.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('.cnt').forEach((n, i) => setTimeout(() => countUp(n, Number(n.dataset.to)), 350 + i * 250));
    if (offer?.some((i) => i.rarity === 'legendary')) setTimeout(() => sound.lootReveal('rare'), 900);
    this.iv = setInterval(() => ($(this.root, '.res-next b').textContent = String(secsLeft(this.endsAt))), 1000);
    this.update(room);
  }

  update(room: RoomView): void {
    this.endsAt = room.phaseEndsAt - room.serverNow + Date.now();
  }

  dispose(): void {
    clearInterval(this.iv);
    this.root.remove();
  }
}

export class MatchOverScreen {
  readonly root: HTMLElement;
  private body: HTMLElement;

  private act: { rematch(): void; leave(): void };

  constructor(ui: HTMLElement, room: RoomView, act: { rematch(): void; leave(): void }) {
    this.act = act;
    const v = room.view!;
    const me = (v.seat ?? 0) as Seat;
    const foe = (1 - me) as Seat;
    const spect = v.seat === null;
    const win = v.winner;
    const outcome = win === 'draw' ? 'draw' : win === me ? 'victory' : 'defeat';
    const word = spect ? (win === 'draw' ? 'Draw' : `${room.seats[win as Seat]?.name ?? ''} is victorious`) : outcome === 'victory' ? 'Victory' : outcome === 'defeat' ? 'Defeat' : 'Draw';
    const sub = outcome === 'victory' ? 'The enemy Keep lies in ruins.' : outcome === 'defeat' ? 'Your Keep has fallen.' : 'Both Keeps fell as one.';
    const h = v.history;
    const dealt = h.reduce((a, r) => a + r.keepDamage[foe], 0);
    const taken = h.reduce((a, r) => a + r.keepDamage[me], 0);
    const wins = h.filter((r) => r.winner === me).length;
    const maxD = Math.max(1, ...h.map((r) => Math.max(r.keepDamage[0], r.keepDamage[1])));
    this.root = el(`<div class="screen over ${spect ? 'neutral' : outcome}">
      <div class="over-word"><b>${esc(word)}</b><small>${esc(spect ? `After ${h.length} rounds` : sub)}</small></div>
      <div class="over-card panel">
        <div class="ov-stats">
          <div><small>Rounds</small><b>${h.length}</b></div>
          <div><small>Rounds won</small><b>${wins}</b></div>
          <div><small>Keep damage dealt</small><b>${num(dealt)}</b></div>
          <div><small>Keep damage taken</small><b>${num(taken)}</b></div>
        </div>
        <div class="ov-chart" aria-label="Keep damage per round">
          ${h.map((r) => `<div class="ovc" data-tip="Round ${r.round}: dealt ${r.keepDamage[foe]}, took ${r.keepDamage[me]}"><i class="d" style="height:${(r.keepDamage[foe] / maxD) * 100}%"></i><i class="t" style="height:${(r.keepDamage[me] / maxD) * 100}%"></i><small>${r.round}</small></div>`).join('')}
        </div>
        <div class="ov-legend"><span class="d">Dealt</span><span class="t">Taken</span></div>
        <div class="ov-acts"></div>
      </div>
    </div>`);
    this.body = $(this.root, '.ov-acts');
    ui.appendChild(this.root);
    if (!spect) setTimeout(() => sound.fanfare(outcome === 'victory'), 300);
    this.update(room);
  }

  update(room: RoomView): void {
    const me = room.me.seat;
    const votes = room.seats.filter((s) => s?.rematch).length;
    const mine = me !== null && !!room.seats[me]?.rematch;
    this.body.innerHTML = `${me !== null ? `<button class="btn primary big rematch" ${mine ? 'disabled' : ''}>${mine ? `Waiting for rival… (${votes}/2)` : `Rematch${votes ? ` (${votes}/2)` : ''}`}</button>` : ''}<button class="btn big leave">Leave</button>`;
    this.body.querySelector('.rematch')?.addEventListener('click', () => (sound.click(), this.act.rematch()));
    $(this.body, '.leave').addEventListener('click', () => (sound.click(), this.act.leave()));
  }

  dispose(): void {
    this.root.remove();
  }
}

export function mvpOf(view: PlayerView | null, dmg: Map<number, { dmg: number; kills: number }> | null, seat: Seat, soldiers: { squad: number; side: Seat; type: string; lord?: LordId }[]): MvpInfo | null {
  if (!dmg) return null;
  let best: { id: number; dmg: number; kills: number } | null = null;
  for (const [id, r] of dmg) {
    const s = soldiers.find((x) => x.squad === id);
    if (!s || s.side !== seat || s.type === 'skeleton') continue;
    if (!best || r.dmg > best.dmg) best = { id, ...r };
  }
  if (!best) return null;
  const sol = soldiers.find((x) => x.squad === best!.id)!;
  const sq = view?.you?.squads.find((s) => s.id === best!.id) ?? null;
  return { squad: sq, type: sol.type as Squad['type'], lord: sol.lord ?? null, dmg: best.dmg, kills: best.kills };
}
