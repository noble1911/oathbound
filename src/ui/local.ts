// Local match against a bot, straight on the sim (no server): the `?dev=` harness and offline play.
// It plays the server's part — timers, hidden-info views (viewFor), battle simulation, results — and
// reports through the same AppHandlers/RoomView the online client uses.
//
//   ?dev=match      full match from the Lord pick
//   ?dev=planning   round 3 planning (both armies built by bots over rounds 1-2, ghosts visible)
//   ?dev=loot       same, with the loot pick open (a showcase offer: one of each rarity)
//   ?dev=battle     round 3 battle playback
//   ?dev=results    round 3 results screen
//   &round=N        pre-roll to round N instead of 3;  &seed=N;  &lord=marshal|archmage|warden|skylady
//   &timer=0        no phase timers (iterate without the clock)
import type { BattleResult, BotStrategy, Intent, LordId, MatchState, Seat, UnitType } from '../sim/types.ts';
import { levelUpCost, MAX_SQUAD_LEVEL } from '../sim/match.ts';
import * as sim from '../sim/index.ts';
import { Rng } from '../sim/rng.ts';
import { rollItem } from '../sim/loot.ts';
import type { AiLevel, RoomView, RoomPhase } from '../net/protocol.ts';
import { LORD_PICK_MS, PLANNING_MS, LOOT_BONUS_MS, RESULTS_MS } from '../net/protocol.ts';
import type { AppHandlers, Backend } from './backend.ts';

export type DevRoute = 'match' | 'planning' | 'loot' | 'battle' | 'results';

export interface LocalOptions {
  route: DevRoute;
  seed?: number;
  round?: number;
  lord?: LordId;
  enemyLord?: LordId;
  strategy?: BotStrategy;
  timers?: boolean;
  /** No countdown at all (the tutorial): phases only end when the player acts. */
  untimed?: boolean;
  /** The guided first match: round 2 adds the gold for the coach's level-up lesson (never in a real match). */
  tutorial?: boolean;
  /** The difficulty shown for the bot seat. */
  level?: AiLevel;
  name?: string;
}

export class LocalMatch implements Backend {
  readonly online = false;
  readonly s: MatchState;
  private phase: RoomPhase = 'planning';
  private phaseEndsAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private result: BattleResult | null = null;
  private h: AppHandlers;
  private o: Required<LocalOptions>;
  private rematchVote = false;
  /** Gold the tutorial added in round 2 so that levelling a squad costs the learner no deploy (0 = none). */
  tutorialGrant = 0;

  constructor(h: AppHandlers, opts: LocalOptions) {
    this.h = h;
    this.o = {
      seed: 20261114, round: 3, lord: 'marshal', enemyLord: 'warden', strategy: 'best', timers: true, untimed: false, tutorial: false, level: 'hard', name: 'You',
      ...opts,
    } as Required<LocalOptions>;
    const o = this.o;
    if (o.route === 'match') {
      this.s = sim.newMatch(o.seed, null);
      this.phase = 'lordPick';
    } else {
      this.s = sim.newMatch(o.seed, [o.lord, o.enemyLord]);
      this.preroll(Math.max(1, o.round));
      this.phase = 'planning';
    }
  }

  /** Both seats play bot turns up to round `round`'s planning. */
  private preroll(round: number): void {
    const s = this.s;
    while (s.round < round && s.phase === 'planning') {
      sim.botPlan(s, 0, 'best', 7);
      sim.botPlan(s, 1, this.o.strategy, 3);
      const { result } = sim.simulateBattle(s, { record: false });
      sim.applyBattle(s, result);
      if ((s.phase as string) !== 'results') break;
      sim.nextRound(s);
    }
  }

  /** Kick off after the app has its handlers wired (the route decides what happens first). */
  begin(): void {
    const r = this.o.route;
    if (this.phase === 'lordPick') {
      sim.botPlan(this.s, 1, this.o.strategy, 1);
      this.setPhase('lordPick', LORD_PICK_MS);
      this.emit();
      return;
    }
    this.enterPlanning();
    if (r === 'loot') this.showcaseLoot();
    if (r === 'battle' || r === 'results') {
      sim.botPlan(this.s, 0, 'best', 11);
      this.emit();
      this.startBattle();
      if (r === 'results') {
        this.battleDone();
      }
      return;
    }
    this.emit();
  }

  /** One drop of each rarity, so the loot screen can be judged in one look. */
  private showcaseLoot(): void {
    const p = this.s.players[0];
    const rng = new Rng(this.o.seed ^ 0x5eed);
    const rar = ['magic', 'rare', 'legendary', 'common'] as const;
    const n = p.lord === 'skylady' ? 4 : 3;
    const order = n === 4 ? rar : (['magic', 'legendary', 'rare'] as const);
    p.lootOffer = order.map((r) => rollItem(rng, this.s.nextId++, Math.max(3, this.s.round), r));
    // and a few things in the stash to equip / compare
    if (p.stash.length < 3) for (const r of ['rare', 'magic', 'common'] as const) p.stash.push(rollItem(rng, this.s.nextId++, this.s.round, r));
  }

  private setPhase(ph: RoomPhase, ms: number): void {
    this.phase = ph;
    this.phaseEndsAt = ms > 0 ? Date.now() + ms : 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (ms > 0 && (this.o.timers || ph === 'results')) this.timer = setTimeout(() => this.timeout(ph), ms);
    if (!this.o.timers && ph !== 'results') this.phaseEndsAt = this.o.untimed ? 0 : Date.now() + ms;
  }

  private timeout(ph: RoomPhase): void {
    if (ph !== this.phase) return;
    const s = this.s;
    if (ph === 'lordPick') {
      // like the server: a Lord of the faction already chosen, else the Kingdom's first
      if (!s.players[0].lord) sim.applyIntent(s, 0, { t: 'pickLord', lord: sim.FACTIONS[s.players[0].faction ?? 'kingdom'].lords[0] ?? 'marshal' });
      this.afterIntent();
    } else if (ph === 'planning') {
      sim.forceReady(s);
      this.startBattle();
    } else if (ph === 'battle') {
      this.battleDone();
    } else if (ph === 'results') {
      sim.nextRound(s);
      this.enterPlanning();
      this.emit();
    }
  }

  private enterPlanning(): void {
    const s = this.s;
    sim.botPlan(s, 1, this.o.strategy, s.round);
    if (this.o.tutorial && s.round === 2 && !this.tutorialGrant) {
      // the price of the cheapest level-up among the learner's squads, on top of the round's income
      const p = s.players[0];
      const costs = p.squads.filter((q) => q.type !== 'lord' && q.level < MAX_SQUAD_LEVEL).map((q) => levelUpCost(q.type as UnitType, q.level));
      if (costs.length) {
        this.tutorialGrant = Math.min(...costs);
        p.gold += this.tutorialGrant;
        this.h.onChat(null, '', `Tutorial: +${this.tutorialGrant} gold to level up a squad.`, true);
      }
    }
    const loot = !!s.players[0].lootOffer;
    this.setPhase('planning', PLANNING_MS + (loot ? LOOT_BONUS_MS : 0));
  }

  private startBattle(): void {
    const { replay, result } = sim.simulateBattle(this.s);
    this.result = result;
    this.setPhase('battle', replay.ticks * 50 + 10_000);
    this.h.onBattle(replay, 0);
    this.emit();
  }

  room(): RoomView {
    const s = this.s;
    const seat = (n: string, bot: boolean, i: Seat) => ({
      name: n, connected: true, isBot: bot, isHost: !bot, botControlled: false, graceEndsAt: 0,
      rematch: bot || (i === 0 && this.rematchVote),
    });
    return {
      code: 'LOCAL', mode: 'vsAI', aiLevel: this.o.level, phase: this.phase, phaseEndsAt: this.phaseEndsAt, serverNow: Date.now(),
      seats: [seat(this.o.name, false, 0), seat('The Iron Duke', true, 1)],
      spectators: [],
      me: { seat: 0, spectator: false, isHost: true },
      view: sim.viewFor(s, 0),
    };
  }

  private emit(): void {
    this.h.onRoom(this.room(), 0);
  }

  private afterIntent(): void {
    const s = this.s;
    if (this.phase === 'lordPick' && s.phase === 'planning') {
      this.enterPlanning();
    } else if (this.phase === 'planning' && sim.allReady(s)) {
      this.emit();
      setTimeout(() => this.startBattle(), 350);
      return;
    }
    this.emit();
  }

  // ---------------------------------------------------------------- Backend

  start(): void {}
  swapSeats(): void {}

  intent(i: Intent): void {
    if (this.phase !== 'planning' && this.phase !== 'lordPick') return this.h.onRejected('Not now');
    let r: { ok: boolean; error?: string };
    try {
      r = sim.applyIntent(this.s, 0, i);
    } catch (e) {
      r = { ok: false, error: String(e) };
    }
    if (!r.ok) {
      this.h.onRejected(r.error ?? 'Refused');
      this.emit();
      return;
    }
    this.afterIntent();
  }

  battleDone(): void {
    if (this.phase !== 'battle' || !this.result) return;
    sim.applyBattle(this.s, this.result);
    this.result = null;
    if (this.s.phase === 'over') this.setPhase('over', 0);
    else this.setPhase('results', RESULTS_MS);
    this.emit();
  }

  rematch(): void {
    if (this.phase !== 'over') return;
    this.rematchVote = true;
    this.emit();
    setTimeout(() => {
      const fresh = new LocalMatch(this.h, { ...this.o, route: 'match', seed: (this.o.seed * 31 + 7) >>> 0 });
      this.dispose();
      (this.h as { onRestart?: (b: LocalMatch) => void }).onRestart?.(fresh);
      fresh.begin();
    }, 600);
  }

  chat(text: string): void {
    this.h.onChat(0, this.o.name, text, false);
    if (/^(gg|glhf|gl hf)/i.test(text)) setTimeout(() => this.h.onChat(1, 'The Iron Duke', 'Steel speaks louder than words.', false), 900);
  }

  leave(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'over';
  }
}
