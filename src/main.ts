// Oathbound v2 client: one 3D scene (behind SceneAdapter) under HTML screens. The server is
// authoritative: we send intents and render the hidden-info filtered RoomView snapshots it sends
// back, and play back (never simulate) each battle replay. `?dev=planning|loot|battle|results|match`
// runs the same screens on a local match against a bot (src/ui/local.ts), no server needed.
//
// Boot: the title is painted art and plain DOM, so it shows as soon as the bundle and the art
// manifest are in (the boot bar tracks exactly that). The renderer (three.js, then its models) loads
// behind the menu afterwards; a screen that needs it waits with a "Raising the battlefield" note.
import './style.css';
import type { Intent, LordId, Replay, Seat, UnitType } from './sim/types.ts';
import { Net, type NetStatus } from './net/client.ts';
import type { AiLevel, ClientMsg, RoomView } from './net/protocol.ts';
import { LORDS } from './sim/data/lords.ts';
import { UNITS } from './sim/data/units.ts';
import { itemName } from './sim/loot.ts';
import { sound } from './audio.ts';
import { playLordLine, voice } from './audio/voice.ts';
import type { Backend } from './ui/backend.ts';
import { el, esc, toast } from './ui/dom.ts';
import { createScene, type SceneAdapter } from './ui/scene-adapter.ts';
import { TitleScreen, LobbyScreen } from './ui/title.ts';
import { LordPickScreen, lordPortrait } from './ui/lordpick.ts';
import { PlanningScreen } from './ui/planning.ts';
import { BattleScreen } from './ui/battle.ts';
import { MatchOverScreen, ReportOverlay, ResultsScreen, matchTotals, outcomeText, type BattleReport } from './ui/results.ts';
import { Shell, migratePowerKeys, type MatchKind } from './ui/shell.ts';
import { niceError } from './ui/hud.ts';
import { LocalMatch, type DevRoute } from './ui/local.ts';
import { art, loadArt } from './ui/art.ts';
import { battleHints } from './ui/insights.ts';
import { installLoadTracker, LoadChip, loadFraction, loadState, onLoad } from './ui/loading.ts';
import { Coach } from './ui/tutorial.ts';
import { setRulesContext } from './ui/rules.ts';
import { setFactionContext } from './ui/gamedata.ts';
import { FACTIONS, factionOfLord } from './sim/data/factions.ts';
import type { FactionId } from './sim/types.ts';

installLoadTracker();
migratePowerKeys();

const ui = document.getElementById('ui')!;
const stageHost = document.getElementById('stage')!;
document.addEventListener('pointerdown', () => sound.unlock(), { once: true });
document.addEventListener('keydown', () => sound.unlock(), { once: true });

/** The boot bar in index.html: real milestones (bundle, art manifest, key art decoded). */
function boot(frac: number, text?: string): void {
  const bar = document.querySelector<HTMLElement>('#boot .boot-bar i');
  if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
  const t = document.querySelector<HTMLElement>('#boot .boot-text');
  if (t && text) t.textContent = text;
}

type Screen = TitleScreen | LobbyScreen | LordPickScreen | PlanningScreen | BattleScreen | ResultsScreen | MatchOverScreen;

class App {
  screen: Screen | null = null;
  backend: Backend | null = null;
  room: RoomView | null = null;
  seat: Seat | null = null;
  /** The renderer, once it has loaded (the title and the lobby never need it). */
  scene: SceneAdapter | null = null;
  private sceneReady!: Promise<SceneAdapter>;
  shell = new Shell(ui);
  net: Net | null = null;
  local: LocalMatch | null = null;
  /** The last battle (results screen). */
  lastBattle: { replay: Replay } | null = null;
  /** Every battle watched this match (the round report, match totals). */
  reports: BattleReport[] = [];
  private waitEl: HTMLElement | null = null;
  private prevPhase = '';
  /** ?dev=results: don't wait for playback. */
  skipPlayback = false;
  private autoStarted = false;
  private chip: LoadChip | null = null;
  private coach: Coach | null = null;
  private overlay: ReportOverlay | null = null;
  /** The snapshot before this one (to notice what the server chose for an idle player). */
  private prevRoom: RoomView | null = null;
  private pickedLord = false;

  async init(): Promise<void> {
    boot(0.45, 'Unfurling the banners');
    await loadArt();
    boot(0.75);
    // the title is the key art: have it decoded before the boot veil lifts (never wait long for it)
    const key = art('keyart');
    if (key) {
      const img = new Image();
      img.src = key;
      await Promise.race([img.decode().catch(() => undefined), new Promise((r) => setTimeout(r, 2500))]);
    }
    boot(1);
    this.shell.onSend = (t) => this.backend?.chat(t);
    this.shell.onPower = (p) => this.scene?.setPower(p);
    this.shell.onQuality = (q) => this.scene?.setQuality?.(q);
    this.shell.graphics = () => {
      const s = this.scene;
      if (!s?.quality || !s.power) return null;
      return { ...s.quality(), ...s.power() };
    };
    // PvP: conceding keeps the player in the room to see the result; everything else leaves it
    this.shell.onLeave = (kind) => (kind === 'pvp' && this.backend?.concede ? this.backend.concede() : this.backend?.leave());
    // the codex quotes the viewer's own deploy limit while they are in a match
    setRulesContext(() => (this.room && this.room.phase !== 'lobby' && this.room.phase !== 'over' ? this.room.view?.you?.deployLimit ?? null : null));
    // counters and the codex name the enemy faction's units once the reveal has shown it
    setFactionContext(() => {
      const v = this.room && this.room.phase !== 'lobby' ? this.room.view : null;
      const lordFaction = (l: LordId | null | undefined): FactionId | null => (l ? factionOfLord(l) : null);
      return { mine: v?.you?.faction ?? lordFaction(v?.you?.lord), enemy: v?.enemy?.faction ?? lordFaction(v?.enemy?.lord) };
    });
    // a hidden tab: pause CSS animation (the scene and battle loops stop by themselves)
    document.addEventListener('visibilitychange', () => document.body.classList.toggle('tab-hidden', document.hidden));
    onLoad(() => this.loadProgress());
    this.sceneReady = new Promise<SceneAdapter>((resolve) => {
      // after the menu has painted and is interactive: the renderer never delays the title
      const start = () =>
        void createScene(stageHost).then((scene) => {
          this.scene = scene;
          // battle and ambience sounds are placed against the camera focus
          sound.setListener({
            focus: () => scene.cameraFocus?.() ?? null,
            pan: (p) => {
              const s = scene.toScreen(p);
              return s ? Math.max(-0.85, Math.min(0.85, (s.x / innerWidth) * 2 - 1)) : null;
            },
          });
          scene.setMode('title');
          this.chip = new LoadChip(ui);
          this.loadProgress();
          resolve(scene);
        });
      requestAnimationFrame(() => setTimeout(start, 120));
    });
  }

  /** The renderer's downloads: a line on the title, a chip everywhere else. */
  private loadProgress(): void {
    const s = loadState();
    const busy = !this.scene || s.active > 0;
    if (this.screen instanceof TitleScreen) this.screen.setLoading(this.scene ? loadFraction(s) : null, !busy);
    this.chip?.setLabel(this.screen instanceof PlanningScreen || this.screen instanceof BattleScreen ? 'Preparing your army' : 'Raising the battlefield');
    this.chip?.root.classList.toggle('muted', this.screen instanceof TitleScreen);
  }

  show(s: Screen | null): void {
    if (this.screen !== s) this.screen?.dispose();
    this.screen = s;
    this.setWait(null);
    this.loadProgress();
  }

  private setWait(text: string | null): void {
    this.waitEl?.remove();
    this.waitEl = null;
    if (text) this.waitEl = ui.appendChild(el(`<div class="wait-note"><i class="dots"></i>${esc(text)}</div>`));
  }

  /** A screen that draws the battlefield: true when the renderer is up, else wait and come back. */
  private needScene(): boolean {
    if (this.scene) return true;
    this.show(null);
    this.setWait('Raising the battlefield…');
    void this.sceneReady.then(() => this.route());
    return false;
  }

  title(err?: string): void {
    this.room = null;
    this.prevRoom = null;
    this.seat = null;
    this.lastBattle = null;
    this.reports = [];
    this.prevPhase = '';
    this.autoStarted = false;
    this.pickedLord = false;
    this.chose.clear();
    this.coach?.dispose();
    this.coach = null;
    this.overlay?.dispose();
    this.overlay = null;
    this.shell.setChatEnabled(false);
    this.shell.setStatus('open', false);
    this.shell.setMatch(null);
    this.scene?.clearReplay();
    this.scene?.setArmy([]);
    this.scene?.setGhosts(null);
    this.scene?.setMode('title');
    sound.setPhase('menu');
    sound.setTerrain(null);
    const t = new TitleScreen(ui, {
      vsAI: (name, level) => this.connect().create(name, 'vsAI', level),
      create: (name) => this.connect().create(name, 'pvp'),
      join: (code, name, spectate) => this.connect().join(code, name, spectate),
      offline: (level) => this.offline(level),
      tutorial: (name) => this.tutorial(name),
    });
    this.show(t);
    if (err) t.error(err);
  }

  connect(): Net {
    this.net?.leave();
    this.local?.dispose();
    this.local = null;
    const net = new Net({
      onRoom: (room, seat) => this.onRoom(room, seat),
      onBattle: (r, off) => this.onBattle(r, off),
      onRejected: (e) => this.rejected(e),
      onChat: (seat, name, text, system) => this.shell.message(seat, name, text, system, !system && seat === this.seat && seat !== null),
      onError: (e) => {
        if (this.screen instanceof TitleScreen) this.screen.error(e);
        else {
          toast(e, 'bad');
          if (/another tab/.test(e)) this.title();
        }
      },
      onStatus: (s: NetStatus) => this.shell.setStatus(s, !!this.room),
    });
    this.net = net;
    this.backend = {
      online: true,
      start: () => net.start(),
      swapSeats: () => net.swapSeats(),
      intent: (i) => (this.note(i), net.intent(i)),
      battleDone: () => net.battleDone(),
      rematch: () => net.rematch(),
      chat: (t) => net.chat(t),
      // the `leave` message gives the seat up, and the client forgets it (no rejoin on reload)
      leave: () => {
        net.leave();
        this.net = null;
        this.backend = null;
        history.replaceState(null, '', location.pathname);
        this.title();
      },
      // `concede` ends the match with the opponent as the winner and keeps this player in the room.
      // (Net has no method for it yet, so the message goes through its private `send`.) If the room
      // answers with nothing at all (the socket was down), leave instead: that concedes as well.
      concede: () => {
        const before = this.room;
        (net as unknown as { send(m: ClientMsg): void }).send({ t: 'concede' });
        setTimeout(() => {
          if (this.net === net && this.room === before && before?.phase !== 'over') this.backend?.leave();
        }, 2500);
      },
    };
    return net;
  }

  offline(level: AiLevel, route: DevRoute = 'match', extra: Partial<ConstructorParameters<typeof LocalMatch>[1]> = {}): void {
    this.net?.leave();
    this.net = null;
    const h = {
      onRoom: (room: RoomView, seat: Seat | null) => this.onRoom(room, seat),
      onBattle: (r: Replay, off: number) => this.onBattle(r, off),
      onRejected: (e: string) => this.rejected(e),
      onChat: (seat: Seat | null, name: string, text: string, system: boolean) => this.shell.message(seat, name, text, system, seat === 0),
      onRestart: (m: LocalMatch) => this.useLocal(m),
    };
    this.useLocal(new LocalMatch(h, { route, strategy: level, level, ...extra }));
    this.local!.begin();
  }

  /** The guided first match: offline, no timers, the easy AI, and the coach. */
  tutorial(name: string): void {
    this.offline('easy', 'match', { timers: false, untimed: true, tutorial: true, name });
    this.startCoach();
  }

  /** The coach for a local match. "Finish tutorial" leaves the match for the title; "Keep playing" only drops the coach. */
  private startCoach(): void {
    this.coach?.dispose();
    this.coach = new Coach(
      ui,
      () => this.room,
      (toTitle) => {
        this.coach = null;
        if (toTitle) this.backend?.leave();
      },
      () => this.local?.tutorialGrant ?? 0,
    );
  }

  private useLocal(m: LocalMatch): void {
    this.local = m;
    this.lastBattle = null;
    this.reports = [];
    this.prevPhase = '';
    this.prevRoom = null;
    this.room = null;
    this.pickedLord = false;
    this.backend = {
      online: false,
      start: () => m.start(),
      swapSeats: () => m.swapSeats(),
      intent: (i) => (this.note(i), m.intent(i)),
      battleDone: () => m.battleDone(),
      rematch: () => m.rematch(),
      chat: (t) => m.chat(t),
      leave: () => {
        m.leave();
        this.local = null;
        this.backend = null;
        history.replaceState(null, '', location.pathname);
        this.title();
      },
    };
  }

  private rejected(e: string): void {
    if (this.screen instanceof PlanningScreen) this.screen.rejected(e);
    else {
      sound.error();
      toast(niceError(e), 'bad');
    }
  }

  onRoom(room: RoomView, seat: Seat | null): void {
    const first = !this.room;
    this.prevRoom = this.room;
    this.room = room;
    this.seat = seat;
    if (this.net && first) history.replaceState(null, '', `?room=${room.code}`);
    this.shell.setChatEnabled(true);
    const kind: MatchKind = room.phase === 'lobby' ? 'lobby' : room.phase === 'over' ? 'over' : room.me.spectator || seat === null ? 'spectator' : room.mode === 'vsAI' || !this.backend?.online ? 'vsAI' : 'pvp';
    this.shell.setMatch(kind);
    this.autoPicked(this.prevRoom, room);
    this.route();
  }

  /**
   * An idle player gets told what was chosen for them: the Lord when the pick timer ran out, the
   * unit type unlocked from an unanswered draft, the item taken from unclaimed spoils.
   */
  private autoPicked(prev: RoomView | null, cur: RoomView): void {
    const a = prev?.view?.you;
    const b = cur.view?.you;
    if (!a || !b || !prev) return;
    if (prev.phase === 'lordPick' && !a.lord && b.lord && !this.pickedLord) {
      const L = LORDS[b.lord];
      toast(`Time ran out: ${L.title} ${L.name} was chosen to lead your host.`, 'auto', 6000);
    }
    // whatever appeared without the player asking for it was chosen by the server
    if (a.draftPicks > 0 && a.draftOptions.length) {
      const got = b.unlocked.filter((u: UnitType) => !a.unlocked.includes(u) && !this.chose.has(`draft:${u}`));
      if (got.length) toast(`You did not choose recruits in time: ${got.map((u) => UNITS[u].name).join(' and ')} unlocked for you.`, 'auto', 6000);
    }
    if (a.lootOffer?.length) {
      const taken = a.lootOffer.find((it) => !a.stash.some((s) => s.id === it.id) && b.stash.some((s) => s.id === it.id));
      if (taken && !this.chose.has(`loot:${a.lootOffer.map((it) => it.id).join(',')}`)) toast(`Unclaimed spoils: ${itemName(taken)} was put in your stash.`, 'auto', 6000);
    }
  }

  /** What the player chose themselves (so only the server's choices are announced). */
  private chose = new Set<string>();
  private note(i: Intent): void {
    if (i.t === 'draft') this.chose.add(`draft:${i.unit}`);
    else if (i.t === 'pickLoot') {
      const offer = this.room?.view?.you?.lootOffer;
      if (offer) this.chose.add(`loot:${offer.map((it) => it.id).join(',')}`);
    }
  }

  onBattle(replay: Replay, offsetMs: number): void {
    if (!this.scene) {
      // a rejoin mid-battle before the renderer is up: play from where the battle will be by then
      const t0 = performance.now();
      this.setWait('Raising the battlefield…');
      void this.sceneReady.then(() => this.onBattle(replay, offsetMs + (performance.now() - t0)));
      return;
    }
    const room = this.room;
    const v = room?.view;
    const me = this.seat;
    const lords: [LordId | null, LordId | null] = v?.enemies
      ? [v.enemies[0].lord, v.enemies[1].lord]
      : me === 1
        ? [v?.enemy.lord ?? null, v?.you?.lord ?? null]
        : [v?.you?.lord ?? null, v?.enemy.lord ?? null];
    const names: [string, string] = [room?.seats[0]?.name ?? 'South', room?.seats[1]?.name ?? 'North'];
    const goldHeld = v?.you?.gold;
    this.overlay?.dispose();
    this.overlay = null;
    this.show(null);
    const b = new BattleScreen(ui, this.scene, replay, offsetMs, { seat: me, names, lords }, () => {
      const stats = b.stats();
      const pov = (me ?? 0) as Seat;
      const report: BattleReport = { round: replay.round, stats, decoded: b.decoded, hints: battleHints(stats, pov, { gold: goldHeld }), me: pov, spectator: me === null, names };
      this.reports = this.reports.filter((r) => r.round !== replay.round).concat(report);
      this.backend?.battleDone();
      this.route();
    });
    this.show(b);
    this.lastBattle = { replay };
    if (this.skipPlayback) {
      this.skipPlayback = false;
      b.skip();
    }
  }

  private report(round: number): BattleReport | null {
    return this.reports.find((r) => r.round === round) ?? null;
  }

  /** Pick the screen for the current snapshot. A battle still playing finishes first. */
  route(): void {
    const room = this.room;
    if (!room || !this.backend) return;
    const phase = room.phase;
    const was = this.prevPhase;
    if (this.screen instanceof BattleScreen && !this.screen.isDone && phase !== 'lobby') {
      this.prevPhase = phase;
      // A spectator's playback does not hold the room up: when the players have moved on (they
      // skipped, or finished at a higher speed), jump to the end banner and follow them, so the
      // results are seen and no battle keeps rendering behind the players' menus.
      const round = this.lastBattle?.replay.round ?? 0;
      const movedOn = phase === 'results' || phase === 'over' || phase === 'lordPick' || (phase === 'planning' && (room.view?.round ?? 0) > round);
      if (this.seat === null && movedOn) this.screen.skip();
      return;
    }
    const scene = this.scene;
    switch (phase) {
      case 'lobby': {
        this.prevPhase = phase;
        const l = this.screen instanceof LobbyScreen ? this.screen : new LobbyScreen(ui, { start: () => this.backend!.start(), swap: () => this.backend!.swapSeats(), leave: () => this.backend!.leave() });
        this.show(l);
        l.update(room);
        // vsAI: the bot already sits in seat 1, so start straight away (the server still needs the host's start)
        if (room.mode === 'vsAI' && room.me.isHost && room.seats[0] && room.seats[1] && !this.autoStarted) {
          this.autoStarted = true;
          setTimeout(() => this.backend?.start(), 900);
        }
        if (was !== 'lobby') {
          scene?.clearReplay();
          scene?.setMode('lobby');
          this.reports = [];
        }
        sound.setPhase('menu');
        return;
      }
      case 'lordPick': {
        this.prevPhase = phase;
        // painted backdrop: the Lord pick never waits for the renderer
        const fresh = !(this.screen instanceof LordPickScreen);
        const s = this.screen instanceof LordPickScreen ? this.screen : new LordPickScreen(ui, (lord) => ((this.pickedLord = true), this.backend!.intent({ t: 'pickLord', lord })), this.seat === null, (faction) => this.backend!.intent({ t: 'pickFaction', faction }), this.coach ? 'kingdom' : null);
        if (fresh) {
          this.reports = [];
          this.pickedLord = false;
          scene?.clearReplay();
          scene?.setArmy([]);
          scene?.setGhosts(null);
          if (room.view) scene?.setTerrain(room.view.terrain);
          scene?.setPerspective(this.seat);
          scene?.setMode('lordPick');
        }
        sound.setPhase('menu');
        this.show(s);
        s.update(room);
        return;
      }
      case 'planning': {
        if (!this.needScene()) return;
        this.prevPhase = phase;
        let p = this.screen instanceof PlanningScreen ? this.screen : null;
        if (!p) {
          scene!.clearReplay();
          scene!.setPerspective(this.seat);
          p = new PlanningScreen(ui, scene!, this.backend);
          p.onLeave = () => void this.shell.askLeave();
          this.show(p);
        }
        const rep = this.report((room.view?.round ?? 1) - 1);
        if (rep) {
          const last = room.view?.history.at(-1);
          p.reportHint = rep.hints[0]?.text ?? null;
          p.onReport = () => {
            this.overlay?.dispose();
            this.overlay = new ReportOverlay(ui, rep, last ? outcomeText(last, room.view?.seat ?? null).title : 'Battle report');
          };
        }
        if (room.view) sound.setTerrain(room.view.terrain);
        sound.setPhase('planning');
        // round 1: the VS reveal covers the screen first; the unlock draft opens after it
        if (was === 'lordPick') p.holdModals(3300);
        p.update(room);
        if (was === 'lordPick') this.reveal(room);
        return;
      }
      case 'battle':
        this.prevPhase = phase;
        if (this.screen instanceof BattleScreen) return;
        this.show(null);
        this.setWait('The armies clash…');
        return;
      case 'results': {
        this.prevPhase = phase;
        if (this.screen instanceof ResultsScreen) return this.screen.update(room);
        this.show(new ResultsScreen(ui, room, this.lastBattle?.replay.result ?? null, this.report(room.view?.round ?? 0)));
        scene?.setMode('results');
        sound.setPhase('results');
        return;
      }
      case 'over': {
        this.prevPhase = phase;
        if (this.screen instanceof MatchOverScreen) return this.screen.update(room);
        this.overlay?.dispose();
        this.overlay = null;
        this.show(new MatchOverScreen(ui, room, { rematch: () => this.backend!.rematch(), leave: () => this.backend!.leave() }, this.seat === null ? null : matchTotals(this.reports)));
        scene?.setMode('results');
        return;
      }
    }
  }

  /** Round 1: both Lords revealed together, VS style. */
  private reveal(room: RoomView): void {
    const v = room.view!;
    const me = (this.seat ?? 0) as Seat;
    const mine = v.you?.lord ?? v.enemies?.[me].lord ?? null;
    const theirs = v.enemies?.[1 - me]?.lord ?? v.enemy.lord;
    if (!mine || !theirs) return;
    const r = el(`<div class="reveal">
      <div class="rv-side me">${lordPortrait(mine, 'big')}<b>${esc(LORDS[mine].title)} ${esc(LORDS[mine].name)}</b><em class="rv-fac">${esc(FACTIONS[factionOfLord(mine)].name)}</em><small>${esc(room.seats[me]?.name ?? '')}</small></div>
      <div class="rv-vs">VS</div>
      <div class="rv-side foe">${lordPortrait(theirs, 'big')}<b>${esc(LORDS[theirs].title)} ${esc(LORDS[theirs].name)}</b><em class="rv-fac">${esc(FACTIONS[factionOfLord(theirs)].name)}</em><small>${esc(room.seats[1 - me]?.name ?? '')}</small></div>
    </div>`);
    ui.appendChild(r);
    sound.horn();
    // both Lords' lines load now; the rival opens with a taunt once the horn has sounded
    voice.setMatchLords([mine, theirs]);
    playLordLine(theirs, 'taunt', { delay: 1.0, pan: 0.2 });
    setTimeout(() => r.classList.add('out'), 2600);
    setTimeout(() => r.remove(), 3200);
  }

  dev(route: DevRoute, p: URLSearchParams): void {
    if (route === 'results') this.skipPlayback = true;
    const lord = p.get('lord') as LordId | null;
    const timers = p.get('timer') !== '0';
    this.offline('hard', route, {
      ...(p.get('seed') ? { seed: Number(p.get('seed')) } : {}),
      ...(p.get('round') ? { round: Number(p.get('round')) } : {}),
      ...(lord ? { lord } : {}),
      ...(p.get('enemy') ? { enemyLord: p.get('enemy') as LordId } : {}),
      timers,
    });
    if (p.get('coach') === '1') this.startCoach();
  }
}

const app = new App();
const params = new URLSearchParams(location.search);
const dev = params.get('dev') as DevRoute | null;
void app.init().then(() => {
  if (dev && ['planning', 'loot', 'battle', 'results', 'match'].includes(dev)) app.dev(dev, params);
  else {
    app.title();
    // back in a room after a reload (same tab): rejoin our seat
    const seat = Net.savedSeat();
    if (seat && (!params.get('room') || params.get('room')!.toUpperCase() === seat.code)) app.connect().resume();
  }
  document.body.classList.add('booted');
  const veil = document.getElementById('boot');
  if (veil) setTimeout(() => veil.remove(), 600);
});

// for browser tests
(window as unknown as { __ob: unknown }).__ob = { app, sound, ui };
