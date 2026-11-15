// Battle playback HUD: Keep bars (driven by keepHit events), a squad tally per side, the sim clock,
// 1×/2×/4× speed, director/free camera (the UI owns C and Home and sets the rig's mode explicitly,
// both ways), Skip (End; Enter is chat on every screen), a battle log of notable events (Lord abilities,
// item skills, legendary procs, squads wiped, Keep breaches) and big banners for Lord abilities.
// Click any squad (or a log entry) to inspect it; Shift+click a second to compare; Tab cycles; Esc
// closes (src/ui/inspector.ts). Battle audio is driven from the same events (src/audio.ts). The
// clients never simulate: playback only. Power: the HUD and the inspector tick at 4 Hz, never per frame.
import type { DecodedReplay, LordId, Replay, ReplayEvent, Seat } from '../sim/types.ts';
import { decodeReplay } from '../sim/index.ts';
import { LORDS } from '../sim/data/lords.ts';
import { LEGENDARIES } from '../sim/data/items.ts';
import { sound } from '../audio.ts';
import { playLordLine, voice } from '../audio/voice.ts';
import type { CameraMode, PlaybackHandle, SceneAdapter } from './scene-adapter.ts';
import { $, el, esc, store } from './dom.ts';
import { icon } from './icons.ts';
import { crest } from './units.ts';
import { unitName } from './gamedata.ts';
import { TopBar } from './hud.ts';
import { battleStats, type BattleStats } from './insights.ts';
import { outcomeText } from './results.ts';
import { Inspector } from './inspector.ts';
import { castEvents, inspectRow, rowOfSoldier, rowOfSquad, type CastEvent } from './inspect-data.ts';
import { SKILLS } from '../sim/data/skills.ts';
import { replaySquads } from '../sim/stats.ts';
import { skillGlyph } from './items.ts';
import type { SkillId } from '../sim/types.ts';

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
const LORD_ABIL = new Set(['rally', 'meteor', 'bulwark', 'skyfall', 'necromancy', 'radiance']);
/** How the log words a Lord's ability when "casts X" would undersell it. */
const ABIL_VERB: Record<string, string> = { necromancy: 'raises the dead', radiance: 'calls down Radiance' };

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
  private insp: Inspector;
  private casts: CastEvent[];
  private castAt = 0;
  private hoverRow = -1;

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
        <button class="btn skip" data-tip="Jump to the result [End]">${icon('skip')}Skip<kbd>End</kbd></button>
      </div>
      <div class="b-banner"></div>
    </div>`);
    ui.appendChild(this.root);
    this.insp = new Inspector(this.root, {
      decoded: this.decoded, viewer: info.seat, names: info.names,
      tick: () => Math.min(this.decoded.replay.ticks, Math.floor((this.finished ? this.end : this.t) / 50)),
      onChange: () => this.syncSelection(),
    });
    this.casts = castEvents(this.decoded);
    while (this.castAt < this.casts.length && this.casts[this.castAt]!.tick * 50 <= this.t) this.castAt++;
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
      // an item skill fires: the log line and the inspector's chip flash, on the frame its effect starts
      onSkill: (e) => {
        const row = inspectRow(this.decoded, e.squad);
        if (row >= 0) this.cast({ tick: e.tick, row, id: e.skill, name: SKILLS[e.skill]?.name ?? e.skill, lord: false });
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
      if ((e.target as HTMLElement)?.closest?.('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('.rules-veil, .dialog-veil')) return;
      const k = e.key.toLowerCase();
      if (e.key === '1' || e.key === '2' || e.key === '4') this.setSpeed(Number(e.key));
      else if (k === 'c' || k === 'home') {
        // one owner for the camera keys: the rig never sees them (it used to flip the mode back)
        e.preventDefault();
        e.stopPropagation();
        const now = this.scene.cameraMode?.() ?? this.cam;
        this.setCam(k === 'home' || now !== 'director' ? 'director' : 'free');
      } else if (e.key === 'End' && !this.finished) {
        e.preventDefault();
        this.skip();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.insp.cycle(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape' && this.insp.isOpen && !document.querySelector('.settings.on, .chat.on')) {
        e.preventDefault();
        e.stopPropagation();
        this.insp.back();
      }
    };
    // capture phase: ahead of the camera rig's own window listener
    window.addEventListener('keydown', key, true);
    this.off.push(() => removeEventListener('keydown', key, true));
    this.bindField();
    this.feed.addEventListener('click', (e) => {
      const n = (e.target as HTMLElement).closest<HTMLElement>('.kf[data-row]');
      if (n) this.insp.open(Number(n.dataset.row));
    });
    const onResize = () => this.syncInsets();
    window.addEventListener('resize', onResize);
    this.off.push(() => removeEventListener('resize', onResize));
    this.renderTop();
    this.renderTally();
    this.syncInsets();
    sound.setTerrain(replay.terrain);
    voice.setMatchLords(info.lords);
    if (offsetMs < 500) {
      sound.battleStart(replay.round);
      if (info.seat !== null) playLordLine(info.lords[info.seat], 'charge', { delay: 1.6 });
      this.banner('To battle!', `Round ${replay.round}`, 'start');
    } else sound.setPhase('battle');
    // the HUD clock ticks at 4 Hz (no per-frame DOM work)
    this.clock = setInterval(() => this.tickClock(), 250);
    this.tickClock();
  }

  private mySeat(): Seat {
    return (this.info.seat ?? 0) as Seat;
  }

  /**
   * Clicks on the field pick squads: a press that did not travel is a click (a drag is the camera's).
   * Shift adds a second squad to compare; empty ground closes the inspector. Hover marks the plate.
   */
  private bindField(): void {
    const cv = this.scene.canvas;
    if (!this.scene.pickSoldier) return;
    let down: { x: number; y: number; t: number } | null = null;
    let hoverAt = 0;
    const rowAt = (x: number, y: number): number => {
      const i = this.scene.pickSoldier!(x, y);
      return i === null ? -1 : rowOfSoldier(this.decoded, i);
    };
    const onDown = (e: PointerEvent) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 600) return;
      const row = rowAt(e.clientX, e.clientY);
      if (row < 0) this.insp.close();
      else if (e.shiftKey) this.insp.compare(row);
      else this.insp.open(row);
      if (row >= 0) sound.click();
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons || performance.now() - hoverAt < 90) return;
      hoverAt = performance.now();
      const row = rowAt(e.clientX, e.clientY);
      if (row === this.hoverRow) return;
      this.hoverRow = row;
      cv.style.cursor = row >= 0 ? 'pointer' : '';
      this.syncSelection(false);
    };
    const onLeave = () => { if (this.hoverRow >= 0) { this.hoverRow = -1; cv.style.cursor = ''; this.syncSelection(false); } };
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerleave', onLeave);
    this.off.push(() => {
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerleave', onLeave);
      cv.style.cursor = '';
    });
  }

  /** The inspector's selection (and the hover) on the in-world plates, and the view inset beside the panel. */
  private syncSelection(insets = true): void {
    const rows = replaySquads(this.decoded);
    const id = (row: number): number | null => rows[row]?.id ?? null;
    this.scene.markSquads?.(this.insp.rows.map(id).filter((x): x is number => x !== null), this.hoverRow >= 0 ? id(this.hoverRow) : null);
    this.root.classList.toggle('has-insp', this.insp.isOpen);
    if (insets) this.syncInsets();
  }

  /** Keep the fight out from under the HUD: the top bar and tally, the controls, and the inspector when open. */
  private syncInsets(): void {
    // the slim top HUD: the plaques' bottom edge (the tally tucks under the medallion on narrow screens)
    const top = Math.max(this.root.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0, this.tally.getBoundingClientRect().bottom);
    const ctrl = $(this.root, '.b-ctrl').getBoundingClientRect();
    const dock = this.insp.root.classList.contains('min') ? 0 : this.insp.dockWidth();
    const next = `${Math.round(top)}/${Math.round(innerHeight - ctrl.top)}/${dock}`;
    if (next === this.insetSig) return;
    this.insetSig = next;
    this.scene.setInsets({ top: Math.round(top), bottom: Math.max(0, Math.round(innerHeight - ctrl.top)), right: dock });
  }
  private insetSig = '';

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
    const spect = this.info.seat === null;
    this.tally.innerHTML = `<div class="tl me" data-tip="${spect ? esc(this.info.names[me]) + "'s" : 'Your'} squads still standing"><i class="tl-cap"></i><b>${n[me]}</b></div><i>squads standing</i><div class="tl foe" data-tip="${spect ? esc(this.info.names[1 - me]) + "'s" : 'Enemy'} squads still standing"><b>${n[1 - me]}</b><i class="tl-cap"></i></div>`;
  }

  /** "Your" / "Enemy" for a player; the commander's name for a spectator. */
  private sideName(s: Seat): string {
    if (this.info.seat === null) return `${esc(this.info.names[s])}'s`;
    return s === this.mySeat() ? 'Your' : 'Enemy';
  }

  /** The same, unescaped (for text that is escaped later). */
  private plainSide(s: Seat): string {
    if (this.info.seat === null) return `${this.info.names[s]}'s`;
    return s === this.mySeat() ? 'Your' : 'Enemy';
  }

  private squadLabel(squadId: number): { name: string; side: Seat; crest: string; row: number } {
    const sol = this.decoded.replay.soldiers[this.squadSoldier.get(squadId) ?? 0]!;
    return { name: unitName(sol.type, sol.lord), side: sol.side, crest: crest(sol.type, sol.lord, 'sm'), row: rowOfSquad(this.decoded, squadId, sol.side) };
  }

  /**
   * Casts up to now, from the replay's own lists at the HUD's 4 Hz: Lord abilities flash their chip
   * (their banner and log line come from the 'ability' event), and item skills are logged here when
   * the scene has not already reported them through onSkill (the stand-in scene never does).
   */
  private runCasts(quiet: boolean): void {
    const tick = Math.floor(this.t / 50);
    while (this.castAt < this.casts.length && this.casts[this.castAt]!.tick <= tick) {
      const c = this.casts[this.castAt++]!;
      if (!quiet) this.cast(c);
    }
  }

  /** One cast, once: the inspector's chip flash, and for an item skill a log line ("Mages cast Fireball"). */
  private cast(c: CastEvent): void {
    const once = `${c.tick}:${c.row}:${c.id}`;
    if (this.castSeen.has(once)) return;
    this.castSeen.add(once);
    this.insp.flash(c.row, c.id);
    if (c.lord) return;
    const q = replaySquads(this.decoded)[c.row];
    if (!q) return;
    // a squad that casts again within a few seconds does not flood the log
    const key = `${c.row}:${c.id}`;
    if (performance.now() - (this.procSeen.get(key) ?? -1e9) < 3000) return;
    this.procSeen.set(key, performance.now());
    const t = q.type;
    const mine = q.side === this.mySeat();
    this.push(`${skillGlyph(c.id as SkillId)}${crest(t, q.lord ?? q.ownerLord ?? null, 'sm')}<span>${this.sideName(q.side)} ${esc(unitName(t, q.lord ?? q.ownerLord ?? null))} cast <b>${esc(c.name)}</b></span>`, `skill ${mine ? 'mine' : 'foe'}`, c.row);
  }
  private castSeen = new Set<string>();

  private soldierSide(i: number): Seat | null {
    return this.decoded.replay.soldiers[i]?.side ?? null;
  }

  private push(html: string, cls: string, row = -1): void {
    const n = el(`<div class="kf ${cls}"${row >= 0 ? ` data-row="${row}" data-tip="Click to inspect"` : ''}>${html}</div>`);
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
        if (!quiet) sound.death(this.posOf(e.tgt, e.tick));
        if (left === 0 && !s.summoned) {
          const L = this.squadLabel(s.squad);
          if (!quiet) {
            sound.wipe(this.posOf(e.tgt, e.tick), s.type === 'lord');
            const mine = L.side === this.mySeat();
            if (s.type === 'lord') {
              this.push(`${icon('skull')}${L.crest}<span><b>${esc(L.name)}</b> has fallen</span>`, mine ? 'bad big' : 'good big', L.row);
              this.banner(`${L.name} has fallen`, `${this.plainSide(L.side)} Lord`, mine ? 'bad' : 'good');
            } else this.push(`${icon('skull')}${L.crest}<span>${this.sideName(L.side)} <b>${esc(L.name)}</b> wiped out</span>`, mine ? 'bad' : 'good', L.row);
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
          this.push(`${icon(e.cause === 'undying_oath' ? 'star' : 'flame')}${L.crest}<span>${this.sideName(L.side)} ${esc(L.name)}: <em class="leg">${esc(n)}</em></span>`, 'proc', L.row);
        }
        break;
      }
      case 'summon': {
        const s = sol[e.tgt];
        if (!s) break;
        this.alive.set(s.squad, (this.alive.get(s.squad) ?? 0) + 1);
        if (!this.squadSide.has(s.squad)) this.squadSide.set(s.squad, s.side);
        if (quiet) break;
        sound.summon(e.pos);
        const key = `${e.src}:summon`;
        if (performance.now() - (this.procSeen.get(key) ?? -1e9) > 6000) {
          this.procSeen.set(key, performance.now());
          const srcSol = sol[e.src];
          if (srcSol && srcSol.type !== 'lord') {
            const L = this.squadLabel(srcSol.squad);
            const bloom = srcSol.items.some((it) => it.legendary === 'gravebloom');
            this.push(bloom
              ? `${icon('skull')}${L.crest}<span>${this.sideName(L.side)} ${esc(L.name)}: <em class="leg">Gravebloom</em> raises the dead</span>`
              : `${icon('skull')}${L.crest}<span>${this.sideName(L.side)} <b>${esc(L.name)}</b> raise the dead</span>`, bloom ? 'proc' : srcSol.side === this.mySeat() ? 'skill mine' : 'skill foe', L.row);
          }
        }
        break;
      }
      case 'keepHit': {
        this.keepHp[e.seat] = e.hpAfter;
        if (quiet) break;
        this.renderTop();
        sound.keepHit(e.final || e.dmg >= 200, this.decoded.replay.keeps[e.seat].pos);
        if (!this.breached[e.seat]) {
          this.breached[e.seat] = true;
          const mine = e.seat === this.mySeat();
          if (mine && this.info.seat !== null) playLordLine(this.info.lords[e.seat], 'keep');
          this.push(`${icon('keep')}<span>${this.info.seat === null ? `${this.sideName(e.seat)} Keep is under attack!` : mine ? 'Your Keep is under attack!' : 'Assault on the enemy Keep!'}</span>`, mine ? 'bad big' : 'good big');
        }
        if (e.final && e.dmg > 0) {
          const mine = e.seat === this.mySeat();
          this.push(`${icon('keep')}<span>${this.sideName(e.seat)} Keep takes <b>${e.dmg}</b></span>`, mine ? 'bad' : 'good');
        }
        break;
      }
      case 'ability': {
        if (quiet) break;
        const src = sol[e.src];
        // a Grave Acolyte's raise is also a 'necromancy' event: its log line comes from the 'summon' event
        if (LORD_ABIL.has(e.ability) && src && src.type !== 'lord') break;
        if (LORD_ABIL.has(e.ability) && src) {
          const lord = src.lord ?? 'marshal';
          const L = LORDS[lord];
          const mine = src.side === this.mySeat();
          sound.ability(e.ability, e.pos);
          playLordLine(lord, 'ability', { delay: 0.1, pan: this.info.seat === null || mine ? 0 : 0.25 });
          this.banner(`${L.abilityName}!`, `${this.plainSide(src.side)} ${L.title} ${L.name}`, `abil ${e.ability} ${mine ? 'mine' : 'foe'}`);
          this.push(`${icon('lightning')}${crest('lord', lord, 'sm')}<span>${esc(L.title)} ${esc(L.name)} ${ABIL_VERB[e.ability] ? `<b>${esc(ABIL_VERB[e.ability]!)}</b>` : `casts <b>${esc(L.abilityName)}</b>`}</span>`, mine ? 'abil mine' : 'abil foe');
          break;
        }
        const proc = PROC[e.ability];
        if (proc && src) {
          const key = `${src.squad}:${e.ability}`;
          if (performance.now() - (this.procSeen.get(key) ?? -1e9) > 7000) {
            this.procSeen.set(key, performance.now());
            const L = this.squadLabel(src.squad);
            this.push(`${icon(proc.ic)}${L.crest}<span>${this.sideName(L.side)} ${esc(L.name)}: <em class="leg">${esc(proc.name)}</em></span>`, 'proc', L.row);
          }
          if (e.ability === 'chain') sound.lightning(e.pos);
          else if (e.ability === 'ember_burst') sound.boom(3, e.pos);
          else if (e.ability === 'earthshaker') sound.stomp(e.pos);
          else if (e.ability === 'lifebinder') sound.heal(e.pos);
        } else if (e.ability === 'stomp') sound.stomp(e.pos);
        else if (e.ability === 'levelup' && src) {
          const L = this.squadLabel(src.squad);
          if (src.type === 'lord') this.push(`${icon('up')}${L.crest}<span>${esc(L.name)} levels up</span>`, src.side === this.mySeat() ? 'good' : 'bad');
        }
        break;
      }
      case 'attack': {
        if (quiet) break;
        if (e.projectile === 'none' && e.weapon !== 'tower') {
          const pos = this.posOf(e.src, e.tick);
          if (e.weapon === 'fists') sound.fist(pos);
          else sound.melee(pos, e.weapon === 'axe' || e.weapon === 'lance');
        }
        break;
      }
      case 'projectile': {
        if (quiet) break;
        const p = e.from;
        if (e.kind === 'arrow' || e.kind === 'tower_arrow') {
          this.volleyCount++;
          this.volleyX += p[0];
          this.volleyY += p[1];
        } else if (e.kind === 'bolt') sound.ballista(p);
        else if (e.kind === 'stone') sound.trebuchet(p);
        else if (e.kind === 'fireball') sound.spell(p);
        else if (e.kind === 'firebreath') sound.breath(p, sol[e.src]?.type !== 'wyvern');
        else if (e.kind === 'lightning') sound.lightning(p);
        break;
      }
      case 'impact': {
        if (quiet) break;
        if (e.kind === 'stone') sound.stoneImpact(e.pos, e.splash / 100);
        else if (e.kind === 'fireball') sound.boom(e.splash / 100, e.pos);
        else if (e.kind === 'arrow' || e.kind === 'tower_arrow') sound.arrowImpact(e.pos);
        break;
      }
      case 'heal':
        if (!quiet) sound.heal(this.posOf(e.tgt, e.tick));
        break;
      case 'keepStage':
        if (!quiet) sound.keepStage(e.stage, this.decoded.replay.keeps[e.seat].pos);
        break;
    }
    void this.soldierSide;
  }
  private volleyCount = 0;
  private volleyX = 0;
  private volleyY = 0;

  /** Arrows released in the same event burst are one volley: one whoosh at their centroid. */
  private flushVolley(): void {
    const n = this.volleyCount;
    if (n) sound.volley(n, [this.volleyX / n, this.volleyY / n]);
    this.volleyCount = this.volleyX = this.volleyY = 0;
  }

  /** A soldier's field position (cm) at a tick, from the replay keyframes. */
  private posOf(i: number, tick: number): [number, number] | undefined {
    const d = this.decoded;
    if (i < 0 || i >= d.soldierCount) return undefined;
    const f = Math.min(d.frameCount - 1, Math.max(0, Math.floor(tick / (d.replay.frameTicks || 1))));
    const k = f * d.soldierCount + i;
    return [d.x[k]!, d.y[k]!];
  }

  private tickClock(): void {
    this.t = this.pb.timeMs;
    this.runCasts(false);
    this.insp.update();
    const fight = Math.min(this.t, 90_000);
    const sec = Math.floor(fight / 1000);
    // elapsed against the 1:30 limit: at the limit the battle is called and Keep damage is halved
    this.top.setClock(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`, 1 - fight / 90_000, '/ 1:30', fight >= 75_000 && fight < 90_000);
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
      this.runCasts(true);
      this.tickClock();
      this.renderTop();
      this.renderTally();
    }
    const won = r.winner === null ? null : r.winner === me;
    // the sim's own words for the result, so the banner, the results card and the history agree
    const txt = outcomeText(r as unknown as Parameters<typeof outcomeText>[0], this.info.seat, r.timeout);
    const end = (r as unknown as { end?: string }).end;
    const title = this.info.seat === null ? (r.winner === null ? txt.title : `${this.info.names[r.winner]} wins the round`) : txt.title === 'Victory' ? 'Round won' : txt.title === 'Defeat' ? 'Round lost' : txt.title;
    sound.battleEnd(won);
    if (won !== null && this.info.seat !== null) playLordLine(this.info.lords[this.info.seat], won ? 'roundWon' : 'roundLost', { delay: 0.8 });
    this.banner(title, end === 'stalemate' ? 'Neither army could harm the other' : r.timeout ? 'Time is up: 1:30' : 'The field falls silent', won === null ? 'neutral' : won ? 'good' : 'bad');
    this.root.classList.add('over');
    $(this.root, '.skip').setAttribute('disabled', '');
    // the last numbers of the fight (the 4 Hz clock has stopped)
    this.insp.update();
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

  /** Per-squad damage dealt / taken / kills for both sides (the results report). */
  stats(): BattleStats {
    return battleStats(this.decoded);
  }

  /** Damage dealt per squad id (MVP on the results screen). */
  damageBySquad(): Map<number, { dmg: number; kills: number }> {
    const m = new Map<number, { dmg: number; kills: number }>();
    for (const q of battleStats(this.decoded).squads) m.set(q.id, { dmg: q.dealt, kills: q.kills });
    return m;
  }

  update(): void {}

  dispose(): void {
    if (!this.finished) sound.battleEnd(null);
    if (this.clock) clearInterval(this.clock);
    this.pb.stop();
    this.insp.dispose();
    this.scene.markSquads?.([], null);
    this.scene.setInsets({});
    this.scene.onCameraMode = null;
    this.off.forEach((f) => f());
    this.top.dispose();
    this.root.remove();
  }
}
