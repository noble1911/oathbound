// Battle playback HUD: Keep bars (driven by keepHit events), a squad tally per side, the sim clock,
// 1×/2× speed, director/free camera, Skip, a kill feed of notable events (Lord abilities,
// legendary procs, squads wiped, Keep breaches) and big banners for Lord abilities. Battle audio
// is driven from the same events (src/audio.ts). The clients never simulate: playback only.
import type { DecodedReplay, LordId, Replay, ReplayEvent, Seat } from '../sim/types.ts';
import { decodeReplay } from '../sim/index.ts';
import { LORDS } from '../sim/data/lords.ts';
import { LEGENDARIES } from '../sim/data/items.ts';
import { sound } from '../audio.ts';
import type { CameraMode, PlaybackHandle, SceneAdapter } from './scene-adapter.ts';
import { $, el, esc, store } from './dom.ts';
import { icon } from './icons.ts';
import { crest } from './units.ts';
import { unitName } from './gamedata.ts';
import { TopBar } from './hud.ts';

export interface BattleInfo {
  seat: Seat | null;
  names: [string, string];
  lords: [LordId | null, LordId | null];
}

const PROC: Record<string, { name: string; ic: string }> = {
  ember_burst: { name: 'Ember Crown', ic: 'flame' },
  earthshaker: { name: 'Earthshaker', ic: 'stone' },
  bloodthirst: { name: 'Bloodthirst', ic: 'heart' },
  sunfire: { name: 'Sunfire Mantle', ic: 'flame' },
  lifebinder: { name: 'Lifebinder', ic: 'heart' },
  chain: { name: 'Stormcaller', ic: 'lightning' },
  reflect: { name: 'Mirror Aegis', ic: 'shield' },
};
const LORD_ABIL = new Set(['rally', 'meteor', 'bulwark', 'skyfall']);

export class BattleScreen {
  readonly root: HTMLElement;
  readonly decoded: DecodedReplay;
  private top: TopBar;
  private feed: HTMLElement;
  private tally: HTMLElement;
  private t: number;
  private end: number;
  private speed = Number(store.get('bspeed') ?? '1') || 1;
  private cam: CameraMode = (store.get('bcam') as CameraMode) || 'director';
  private pb!: PlaybackHandle;
  private clock: ReturnType<typeof setInterval> | null = null;
  private ev = 0;
  private keepHp: [number, number];
  private alive = new Map<number, number>();
  private squadSide = new Map<number, Seat>();
  private squadSoldier = new Map<number, number>();
  private procSeen = new Map<string, number>();
  private breached: [boolean, boolean] = [false, false];
  private finished = false;
  private doneSent = false;
  isDone = false;
  private off: (() => void)[] = [];

  private scene: SceneAdapter;
  private info: BattleInfo;
  private onDone: () => void;

  constructor(ui: HTMLElement, scene: SceneAdapter, replay: Replay, offsetMs: number, info: BattleInfo, onDone: () => void) {
    this.scene = scene;
    this.info = info;
    this.onDone = onDone;
    this.decoded = decodeReplay(replay);
    this.t = Math.max(0, offsetMs);
    this.end = replay.ticks * 50;
    this.keepHp = [replay.keeps[0].hpBefore, replay.keeps[1].hpBefore];
    for (const s of replay.soldiers) {
      this.squadSide.set(s.squad, s.side);
      if (!this.squadSoldier.has(s.squad)) this.squadSoldier.set(s.squad, s.id);
      if (!s.summoned) this.alive.set(s.squad, (this.alive.get(s.squad) ?? 0) + 1);
    }
    this.root = el(`<div class="screen battle">
      <div class="b-tally"></div>
      <div class="b-feed"></div>
      <div class="b-ctrl panel">
        <div class="seg speed">${[1, 2, 4].map((s) => `<button data-s="${s}" data-tip="Playback speed [${s === 1 ? '1' : s === 2 ? '2' : '4'}]">${s}×</button>`).join('')}</div>
        <div class="seg cam"><button data-c="director" data-tip="Cinematic director camera [C]">${icon('camera')}Director</button><button data-c="free" data-tip="Free RTS camera: WASD / drag / wheel [C]">${icon('move')}Free</button></div>
        <button class="btn skip" data-tip="Jump to the result [Enter]">${icon('skip')}Skip</button>
      </div>
      <div class="b-banner"></div>
    </div>`);
    ui.appendChild(this.root);
    this.top = new TopBar(this.root);
    this.top.ticking = false;
    this.feed = $(this.root, '.b-feed');
    this.tally = $(this.root, '.b-tally');
    scene.setMode('battle');
    scene.setPerspective(info.seat);
    scene.setTerrain(replay.terrain);
    // skip events already past when joining mid-battle (state only, no sound)
    while (this.ev < this.decoded.events.length && this.decoded.events[this.ev]!.tick * 50 <= this.t) this.apply(this.decoded.events[this.ev++]!, true);
    // the scene owns the clock; events come back as they fire
    this.pb = scene.playReplay(this.decoded, {
      offsetMs: this.t,
      onEvent: (e) => {
        this.ev++;
        this.apply(e, false);
        if (this.volleyCount === 1) setTimeout(() => this.flushVolley(), 0);
      },
      onEnd: () => this.finish(false),
    });
    this.pb.speed = this.speed;
    scene.setCameraMode(this.cam);
    scene.onCameraMode = (m) => {
      this.cam = m;
      this.syncControls();
    };
    this.syncControls();
    this.root.querySelectorAll<HTMLElement>('.speed button').forEach((b) => b.addEventListener('click', () => this.setSpeed(Number(b.dataset.s))));
    this.root.querySelectorAll<HTMLElement>('.cam button').forEach((b) => b.addEventListener('click', () => this.setCam(b.dataset.c as CameraMode)));
    $(this.root, '.skip').addEventListener('click', () => this.skip());
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
      if (e.key === '1' || e.key === '2' || e.key === '4') this.setSpeed(Number(e.key));
      else if (e.key.toLowerCase() === 'c') this.setCam(this.cam === 'director' ? 'free' : 'director');
      else if (e.key === 'Enter' && !this.finished) this.skip();
    };
    window.addEventListener('keydown', key);
    this.off.push(() => removeEventListener('keydown', key));
    this.renderTop();
    this.renderTally();
    if (offsetMs < 500) {
      sound.horn();
      this.banner('To battle!', `Round ${replay.round}`, 'start');
    }
    // the HUD clock ticks at 4 Hz (no per-frame DOM work)
    this.clock = setInterval(() => this.tickClock(), 250);
    this.tickClock();
  }

  private mySeat(): Seat {
    return (this.info.seat ?? 0) as Seat;
  }

  private setSpeed(s: number): void {
    this.speed = s;
    this.pb.speed = s;
    store.set('bspeed', String(s));
    sound.click();
    this.syncControls();
  }

  private setCam(c: CameraMode): void {
    this.cam = c;
    store.set('bcam', c);
    this.scene.setCameraMode(c);
    sound.click();
    this.syncControls();
  }

  private syncControls(): void {
    this.root.querySelectorAll<HTMLElement>('.speed button').forEach((b) => b.classList.toggle('on', Number(b.dataset.s) === this.speed));
    this.root.querySelectorAll<HTMLElement>('.cam button').forEach((b) => b.classList.toggle('on', b.dataset.c === this.cam));
  }

  private renderTop(): void {
    const me = this.mySeat();
    const foe = (1 - me) as Seat;
    const k = this.decoded.replay.keeps;
    this.top.set(
      { name: this.info.names[me], lord: this.info.lords[me], hp: this.keepHp[me], max: k[me].hpMax },
      { name: this.info.names[foe], lord: this.info.lords[foe], hp: this.keepHp[foe], max: k[foe].hpMax },
      this.decoded.replay.round, 'Battle', 0, 1,
    );
  }

  private renderTally(): void {
    const n: [number, number] = [0, 0];
    for (const [sq, a] of this.alive) if (a > 0) n[this.squadSide.get(sq)!]++;
    const me = this.mySeat();
    this.tally.innerHTML = `<div class="tl me" data-tip="Your squads still standing">${icon('squads')}<b>${n[me]}</b></div><i>squads</i><div class="tl foe" data-tip="Enemy squads still standing"><b>${n[1 - me]}</b>${icon('squads')}</div>`;
  }

  private sideName(s: Seat): string {
    return s === this.mySeat() ? 'Your' : 'Enemy';
  }

  private squadLabel(squadId: number): { name: string; side: Seat; crest: string } {
    const sol = this.decoded.replay.soldiers[this.squadSoldier.get(squadId) ?? 0]!;
    return { name: unitName(sol.type === 'skeleton' ? 'militia' : sol.type, sol.lord), side: sol.side, crest: crest(sol.type === 'skeleton' ? 'militia' : sol.type, sol.lord, 'sm') };
  }

  private soldierSide(i: number): Seat | null {
    return this.decoded.replay.soldiers[i]?.side ?? null;
  }

  private pan(p: [number, number] | undefined): number {
    if (!p) return 0;
    const s = this.scene.toScreen(p);
    return s ? Math.max(-0.8, Math.min(0.8, (s.x / innerWidth) * 2 - 1)) : 0;
  }

  private push(html: string, cls: string): void {
    const n = el(`<div class="kf ${cls}">${html}</div>`);
    this.feed.prepend(n);
    while (this.feed.children.length > 6) this.feed.lastElementChild!.remove();
    setTimeout(() => n.classList.add('old'), 6000);
  }

  private banner(title: string, sub: string, cls: string): void {
    const b = $(this.root, '.b-banner');
    b.innerHTML = `<div class="bb ${cls}"><small>${esc(sub)}</small><b>${esc(title)}</b></div>`;
    b.classList.remove('on');
    void b.offsetWidth;
    b.classList.add('on');
  }

  /** One event: state (keeps, tallies), feed and sound. `quiet` = catching up after a seek. */
  private apply(e: ReplayEvent, quiet: boolean): void {
    const sol = this.decoded.replay.soldiers;
    switch (e.k) {
      case 'death': {
        const s = sol[e.tgt];
        if (!s) break;
        const left = (this.alive.get(s.squad) ?? 1) - 1;
        this.alive.set(s.squad, left);
        if (!quiet) sound.death(0);
        if (left === 0 && !s.summoned) {
          const L = this.squadLabel(s.squad);
          if (!quiet) {
            const mine = L.side === this.mySeat();
            if (s.type === 'lord') {
              this.push(`${icon('skull')}${L.crest}<span><b>${esc(L.name)}</b> has fallen</span>`, mine ? 'bad big' : 'good big');
              this.banner(`${L.name} has fallen`, mine ? 'Your Lord' : 'Enemy Lord', mine ? 'bad' : 'good');
            } else this.push(`${icon('skull')}${L.crest}<span>${this.sideName(L.side)} <b>${esc(L.name)}</b> wiped out</span>`, mine ? 'bad' : 'good');
          }
        }
        if (!quiet) this.renderTally();
        break;
      }
      case 'revive': {
        const s = sol[e.tgt];
        if (!s) break;
        this.alive.set(s.squad, (this.alive.get(s.squad) ?? 0) + 1);
        if (quiet) break;
        const key = `${s.squad}:${e.cause}`;
        if (performance.now() - (this.procSeen.get(key) ?? -1e9) > 6000) {
          this.procSeen.set(key, performance.now());
          const L = this.squadLabel(s.squad);
          const n = e.cause === 'undying_oath' ? LEGENDARIES.undying_oath.name : 'of the Phoenix';
          this.push(`${icon(e.cause === 'undying_oath' ? 'star' : 'flame')}${L.crest}<span>${this.sideName(L.side)} ${esc(L.name)}: <em class="leg">${esc(n)}</em></span>`, 'proc');
        }
        break;
      }
      case 'summon': {
        const s = sol[e.tgt];
        if (!s) break;
        this.alive.set(s.squad, (this.alive.get(s.squad) ?? 0) + 1);
        if (!this.squadSide.has(s.squad)) this.squadSide.set(s.squad, s.side);
        if (quiet) break;
        const key = `${e.src}:summon`;
        if (performance.now() - (this.procSeen.get(key) ?? -1e9) > 6000) {
          this.procSeen.set(key, performance.now());
          const srcSol = sol[e.src];
          if (srcSol) {
            const L = this.squadLabel(srcSol.squad);
            this.push(`${icon('skull')}${L.crest}<span>${this.sideName(L.side)} ${esc(L.name)}: <em class="leg">Gravebloom</em> raises the dead</span>`, 'proc');
          }
        }
        break;
      }
      case 'keepHit': {
        this.keepHp[e.seat] = e.hpAfter;
        if (quiet) break;
        this.renderTop();
        sound.keepHit(e.final || e.dmg >= 200);
        if (!this.breached[e.seat]) {
          this.breached[e.seat] = true;
          const mine = e.seat === this.mySeat();
          this.push(`${icon('keep')}<span>${mine ? 'Your Keep is under attack!' : 'Assault on the enemy Keep!'}</span>`, mine ? 'bad big' : 'good big');
        }
        if (e.final && e.dmg > 0) {
          const mine = e.seat === this.mySeat();
          this.push(`${icon('keep')}<span>${mine ? 'Your' : 'Enemy'} Keep takes <b>${e.dmg}</b></span>`, mine ? 'bad' : 'good');
        }
        break;
      }
      case 'ability': {
        if (quiet) break;
        const src = sol[e.src];
        if (LORD_ABIL.has(e.ability) && src) {
          const lord = src.lord ?? 'marshal';
          const L = LORDS[lord];
          const mine = src.side === this.mySeat();
          sound.ability(e.ability);
          this.banner(`${L.abilityName}!`, `${mine ? 'Your' : 'Enemy'} ${L.title} ${L.name}`, `abil ${e.ability} ${mine ? 'mine' : 'foe'}`);
          this.push(`${icon('lightning')}${crest('lord', lord, 'sm')}<span>${esc(L.title)} ${esc(L.name)} casts <b>${esc(L.abilityName)}</b></span>`, mine ? 'abil mine' : 'abil foe');
          break;
        }
        const proc = PROC[e.ability];
        if (proc && src) {
          const key = `${src.squad}:${e.ability}`;
          if (performance.now() - (this.procSeen.get(key) ?? -1e9) > 7000) {
            this.procSeen.set(key, performance.now());
            const L = this.squadLabel(src.squad);
            this.push(`${icon(proc.ic)}${L.crest}<span>${this.sideName(L.side)} ${esc(L.name)}: <em class="leg">${esc(proc.name)}</em></span>`, 'proc');
          }
          if (e.ability === 'chain') sound.lightning(this.pan(e.pos));
          else if (e.ability === 'ember_burst' || e.ability === 'earthshaker') sound.boom(3, this.pan(e.pos));
        } else if (e.ability === 'stomp') sound.boom(2, this.pan(e.pos));
        else if (e.ability === 'levelup' && src) {
          const L = this.squadLabel(src.squad);
          if (src.type === 'lord') this.push(`${icon('up')}${L.crest}<span>${esc(L.name)} levels up</span>`, src.side === this.mySeat() ? 'good' : 'bad');
        }
        break;
      }
      case 'attack': {
        if (quiet) break;
        if (e.projectile === 'none' && e.weapon !== 'tower') {
          const heavy = e.weapon === 'axe' || e.weapon === 'fists';
          if (e.weapon === 'fists') sound.boom(1.5);
          else sound.clash(this.pan(undefined), heavy);
        }
        break;
      }
      case 'projectile': {
        if (quiet) break;
        const p = this.pan(e.from);
        if (e.kind === 'arrow' || e.kind === 'tower_arrow') this.volleyCount++, (this.volleyPan = p);
        else if (e.kind === 'bolt') sound.ballista(p);
        else if (e.kind === 'stone') sound.trebuchet(p);
        else if (e.kind === 'fireball') sound.spell(p);
        else if (e.kind === 'firebreath') sound.breath(p);
        else if (e.kind === 'lightning') sound.lightning(p);
        break;
      }
      case 'impact': {
        if (quiet) break;
        if (e.kind === 'stone' || e.kind === 'fireball') sound.boom(e.splash / 100, this.pan(e.pos));
        else if (e.kind === 'arrow') sound.thud(this.pan(e.pos));
        break;
      }
      case 'heal':
        if (!quiet) sound.heal();
        break;
    }
    void this.soldierSide;
  }
  private volleyCount = 0;
  private volleyPan = 0;

  private flushVolley(): void {
    if (this.volleyCount) sound.volley(this.volleyCount, this.volleyPan);
    this.volleyCount = 0;
  }

  private tickClock(): void {
    this.t = this.pb.timeMs;
    const fight = Math.min(this.t, 90_000);
    const sec = Math.floor(fight / 1000);
    this.top.setClock(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`, 1 - fight / 90_000);
  }

  private finish(skipped: boolean): void {
    if (this.finished) return;
    this.finished = true;
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
    const r = this.decoded.replay.result;
    const me = this.mySeat();
    if (skipped) {
      // settle: play every remaining event quietly
      const evs = this.decoded.events;
      while (this.ev < evs.length) this.apply(evs[this.ev++]!, true);
      this.t = this.end;
      this.pb.seek(this.end);
      this.tickClock();
      this.renderTop();
      this.renderTally();
    }
    const won = r.winner === null ? null : r.winner === me;
    const title = this.info.seat === null ? (r.winner === null ? 'Stalemate' : `${this.info.names[r.winner]} wins the round`) : won === null ? (r.timeout ? 'Stalemate' : 'Mutual destruction') : won ? 'Round won' : 'Round lost';
    sound.roundEnd(won);
    this.banner(title, r.timeout ? 'Time is up' : 'The field falls silent', won === null ? 'neutral' : won ? 'good' : 'bad');
    this.root.classList.add('over');
    $(this.root, '.skip').setAttribute('disabled', '');
    setTimeout(() => this.done(), skipped ? 900 : 2200);
  }

  private done(): void {
    if (this.doneSent) return;
    this.doneSent = true;
    this.isDone = true;
    const w = el('<div class="b-wait"><i class="dots"></i>Waiting for the other commander…</div>');
    this.root.appendChild(w);
    this.onDone();
  }

  skip(): void {
    if (this.finished) return;
    sound.whoosh();
    this.finish(true);
  }

  /** Damage dealt per squad id (MVP on the results screen). */
  damageBySquad(): Map<number, { dmg: number; kills: number }> {
    const m = new Map<number, { dmg: number; kills: number }>();
    const sol = this.decoded.replay.soldiers;
    for (const e of this.decoded.events) {
      if (e.k !== 'hit' && e.k !== 'death') continue;
      const s = sol[e.src];
      if (!s) continue;
      const r = m.get(s.squad) ?? { dmg: 0, kills: 0 };
      if (e.k === 'hit' && !e.miss) r.dmg += e.dmg;
      if (e.k === 'death') r.kills++;
      m.set(s.squad, r);
    }
    return m;
  }

  update(): void {}

  dispose(): void {
    if (this.clock) clearInterval(this.clock);
    this.pb.stop();
    this.scene.onCameraMode = null;
    this.off.forEach((f) => f());
    this.top.dispose();
    this.root.remove();
  }
}
