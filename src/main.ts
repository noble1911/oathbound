// Oathbound v2 client: one 3D scene (behind SceneAdapter) under HTML screens. The server is
// authoritative: we send intents and render the hidden-info filtered RoomView snapshots it sends
// back, and play back (never simulate) each battle replay. `?dev=planning|loot|battle|results|match`
// runs the same screens on a local match against a bot (src/ui/local.ts), no server needed.
import './style.css';
import type { LordId, Replay, Seat, UnitType } from './sim/types.ts';
import { Net, type NetStatus } from './net/client.ts';
import type { AiLevel, RoomView } from './net/protocol.ts';
import { genTerrain } from './sim/terrain.ts';
import { LORDS } from './sim/data/lords.ts';
import { sound } from './audio.ts';
import type { Backend } from './ui/backend.ts';
import { el, esc, store, toast } from './ui/dom.ts';
import { createScene, type SceneAdapter, type SquadVisual } from './ui/scene-adapter.ts';
import { TitleScreen, LobbyScreen } from './ui/title.ts';
import { LordPickScreen, lordPortrait } from './ui/lordpick.ts';
import { PlanningScreen } from './ui/planning.ts';
import { BattleScreen } from './ui/battle.ts';
import { MatchOverScreen, ResultsScreen, mvpOf, type MvpInfo } from './ui/results.ts';
import { Shell } from './ui/shell.ts';
import { niceError } from './ui/hud.ts';
import { LocalMatch, type DevRoute } from './ui/local.ts';
import { loadArt } from './ui/art.ts';

const ui = document.getElementById('ui')!;
const stageHost = document.getElementById('stage')!;
document.addEventListener('pointerdown', () => sound.unlock(), { once: true });
document.addEventListener('keydown', () => sound.unlock(), { once: true });

type Screen = TitleScreen | LobbyScreen | LordPickScreen | PlanningScreen | BattleScreen | ResultsScreen | MatchOverScreen;

/** A quiet diorama behind the title: both armies drawn up on a seeded field. */
function backdrop(scene: SceneAdapter): void {
  const t = genTerrain(7177);
  scene.setTerrain(t);
  const mk = (owner: Seat, list: [UnitType | 'lord', number, number][]): SquadVisual[] =>
    list.map(([type, x, y], i) => ({ id: 9000 + owner * 100 + i, type, lord: type === 'lord' ? (owner ? 'warden' : 'marshal') : null, owner, pos: owner === 0 ? [x, y] : [7999 - x, 11999 - y], facing: owner === 0 ? 64 : 192, level: 1 + (i % 4), rarity: i % 5 === 0 ? 'legendary' : i % 3 === 0 ? 'rare' : null }));
  const army: [UnitType | 'lord', number, number][] = [
    ['lord', 4000, 1500], ['militia', 2600, 3300], ['militia', 5400, 3300], ['knights', 4000, 3500], ['pikemen', 3200, 3000], ['archers', 2000, 2200],
    ['archers', 6000, 2200], ['mages', 4000, 2300], ['cavaliers', 1100, 3200], ['ballista', 3000, 1400], ['golem', 5000, 2900], ['pegasus', 6900, 3000],
  ];
  scene.setArmy([...mk(0, army), ...mk(1, army.map(([t2, x, y]) => [t2 === 'golem' ? 'trebuchet' : t2 === 'pegasus' ? 'wyvern' : t2, x, y + (t2 === 'lord' ? 0 : 1200)] as [UnitType | 'lord', number, number]))]);
  scene.setGhosts(null);
  scene.setKeeps([4000, 4000], [4000, 4000]);
  scene.setPerspective(0);
  scene.setMode('title');
}

class App {
  screen: Screen | null = null;
  backend: Backend | null = null;
  room: RoomView | null = null;
  seat: Seat | null = null;
  scene!: SceneAdapter;
  shell = new Shell(ui);
  net: Net | null = null;
  local: LocalMatch | null = null;
  /** The last battle (results screen: MVP, Keep damage). */
  lastBattle: { replay: Replay; mvp: MvpInfo | null } | null = null;
  private waitEl: HTMLElement | null = null;
  private prevPhase = '';
  /** ?dev=results: don't wait for playback. */
  skipPlayback = false;
  private autoStarted = false;

  async init(): Promise<void> {
    await loadArt();
    this.scene = await createScene(stageHost);
    this.shell.onSend = (t) => this.backend?.chat(t);
    this.shell.onPower = (p) => this.scene.setPower(p);
    this.scene.setPower({ batterySaver: store.get('saver') === '1', fpsCap: Number(store.get('fps') ?? '60') });
    // a hidden tab: pause CSS animation (the scene and battle loops stop by themselves)
    document.addEventListener('visibilitychange', () => document.body.classList.toggle('tab-hidden', document.hidden));
  }

  show(s: Screen | null): void {
    if (this.screen !== s) this.screen?.dispose();
    this.screen = s;
    this.setWait(null);
  }

  private setWait(text: string | null): void {
    this.waitEl?.remove();
    this.waitEl = null;
    if (text) this.waitEl = ui.appendChild(el(`<div class="wait-note"><i class="dots"></i>${esc(text)}</div>`));
  }

  title(err?: string): void {
    this.room = null;
    this.seat = null;
    this.lastBattle = null;
    this.prevPhase = '';
    this.autoStarted = false;
    this.shell.setChatEnabled(false);
    this.shell.setStatus('open', false);
    this.scene.clearReplay();
    backdrop(this.scene);
    const t = new TitleScreen(ui, {
      vsAI: (name, level) => this.connect().create(name, 'vsAI', level),
      create: (name) => this.connect().create(name, 'pvp'),
      join: (code, name, spectate) => this.connect().join(code, name, spectate),
      offline: (level) => this.offline(level),
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
      intent: (i) => net.intent(i),
      battleDone: () => net.battleDone(),
      rematch: () => net.rematch(),
      chat: (t) => net.chat(t),
      leave: () => {
        net.leave();
        this.net = null;
        history.replaceState(null, '', location.pathname);
        this.title();
      },
    };
    return net;
  }

  offline(_level: AiLevel, route: DevRoute = 'match', extra: Partial<ConstructorParameters<typeof LocalMatch>[1]> = {}): void {
    this.net?.leave();
    this.net = null;
    const strategy = _level === 'easy' ? 'random' : _level === 'normal' ? 'counter' : 'best';
    const h = {
      onRoom: (room: RoomView, seat: Seat | null) => this.onRoom(room, seat),
      onBattle: (r: Replay, off: number) => this.onBattle(r, off),
      onRejected: (e: string) => this.rejected(e),
      onChat: (seat: Seat | null, name: string, text: string, system: boolean) => this.shell.message(seat, name, text, system, seat === 0),
      onRestart: (m: LocalMatch) => this.useLocal(m),
    };
    this.useLocal(new LocalMatch(h, { route, strategy, ...extra }));
    this.local!.begin();
  }

  private useLocal(m: LocalMatch): void {
    this.local = m;
    this.lastBattle = null;
    this.prevPhase = '';
    this.backend = {
      online: false,
      start: () => m.start(),
      swapSeats: () => m.swapSeats(),
      intent: (i) => m.intent(i),
      battleDone: () => m.battleDone(),
      rematch: () => m.rematch(),
      chat: (t) => m.chat(t),
      leave: () => {
        m.leave();
        this.local = null;
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
    this.room = room;
    this.seat = seat;
    if (this.net && first) history.replaceState(null, '', `?room=${room.code}`);
    this.shell.setChatEnabled(true);
    this.route();
  }

  onBattle(replay: Replay, offsetMs: number): void {
    const room = this.room;
    const v = room?.view;
    const me = this.seat;
    const lords: [LordId | null, LordId | null] = v?.enemies
      ? [v.enemies[0].lord, v.enemies[1].lord]
      : me === 1
        ? [v?.enemy.lord ?? null, v?.you?.lord ?? null]
        : [v?.you?.lord ?? null, v?.enemy.lord ?? null];
    const names: [string, string] = [room?.seats[0]?.name ?? 'South', room?.seats[1]?.name ?? 'North'];
    this.show(null);
    const b = new BattleScreen(ui, this.scene, replay, offsetMs, { seat: me, names, lords }, () => {
      this.lastBattle = { replay, mvp: mvpOf(this.room?.view ?? null, b.damageBySquad(), (me ?? 0) as Seat, replay.soldiers) };
      this.backend?.battleDone();
      this.route();
    });
    this.show(b);
    this.lastBattle = { replay, mvp: null };
    if (this.skipPlayback) {
      this.skipPlayback = false;
      b.skip();
    }
  }

  /** Pick the screen for the current snapshot. A battle still playing finishes first. */
  route(): void {
    const room = this.room;
    if (!room || !this.backend) return;
    const phase = room.phase;
    const was = this.prevPhase;
    this.prevPhase = phase;
    if (this.screen instanceof BattleScreen && !this.screen.isDone && phase !== 'lobby') return;
    switch (phase) {
      case 'lobby': {
        const l = this.screen instanceof LobbyScreen ? this.screen : new LobbyScreen(ui, { start: () => this.backend!.start(), swap: () => this.backend!.swapSeats(), leave: () => this.backend!.leave() });
        this.show(l);
        l.update(room);
        // vsAI: the bot already sits in seat 1, so start straight away (the server still needs the host's start)
        if (room.mode === 'vsAI' && room.me.isHost && room.seats[0] && room.seats[1] && !this.autoStarted) {
          this.autoStarted = true;
          setTimeout(() => this.backend?.start(), 900);
        }
        if (was !== 'lobby') backdrop(this.scene), this.scene.setMode('lobby');
        return;
      }
      case 'lordPick': {
        const s = this.screen instanceof LordPickScreen ? this.screen : new LordPickScreen(ui, (lord) => this.backend!.intent({ t: 'pickLord', lord }), this.seat === null);
        if (!(this.screen instanceof LordPickScreen)) {
          this.scene.clearReplay();
          this.scene.setArmy([]);
          this.scene.setGhosts(null);
          if (room.view) this.scene.setTerrain(room.view.terrain);
          this.scene.setPerspective(this.seat);
          this.scene.setMode('lordPick');
        }
        this.show(s);
        s.update(room);
        return;
      }
      case 'planning': {
        let p = this.screen instanceof PlanningScreen ? this.screen : null;
        if (!p) {
          this.scene.clearReplay();
          p = new PlanningScreen(ui, this.scene, this.backend);
          this.show(p);
        }
        p.update(room);
        if (was === 'lordPick') this.reveal(room);
        return;
      }
      case 'battle':
        if (this.screen instanceof BattleScreen) return;
        this.show(null);
        this.setWait('The armies clash…');
        return;
      case 'results': {
        if (this.screen instanceof ResultsScreen) return this.screen.update(room);
        this.show(new ResultsScreen(ui, room, this.lastBattle?.replay.result ?? null, this.lastBattle?.mvp ?? null));
        this.scene.setMode('results');
        return;
      }
      case 'over': {
        if (this.screen instanceof MatchOverScreen) return this.screen.update(room);
        this.show(new MatchOverScreen(ui, room, { rematch: () => this.backend!.rematch(), leave: () => this.backend!.leave() }));
        this.scene.setMode('results');
        return;
      }
    }
  }

  /** Round 1: both Lords revealed together, VS style. */
  private reveal(room: RoomView): void {
    const v = room.view!;
    const mine = v.you?.lord ?? v.enemies?.[0].lord ?? null;
    const theirs = v.enemy.lord;
    if (!mine || !theirs) return;
    const me = (this.seat ?? 0) as Seat;
    const r = el(`<div class="reveal">
      <div class="rv-side me">${lordPortrait(mine, 'big')}<b>${esc(LORDS[mine].title)} ${esc(LORDS[mine].name)}</b><small>${esc(room.seats[me]?.name ?? '')}</small></div>
      <div class="rv-vs">VS</div>
      <div class="rv-side foe">${lordPortrait(theirs, 'big')}<b>${esc(LORDS[theirs].title)} ${esc(LORDS[theirs].name)}</b><small>${esc(room.seats[1 - me]?.name ?? '')}</small></div>
    </div>`);
    ui.appendChild(r);
    sound.horn();
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
      timers,
    });
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
});

// for browser tests
(window as unknown as { __ob: unknown }).__ob = { app, sound, ui };
