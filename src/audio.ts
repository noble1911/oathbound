// Game audio: recorded samples (public/audio/, built by tools/audio/build.py, credits in
// docs/AUDIO.md) through a small RTS-style mixer.
//
//   voices ─┬─ ui ───────────────────────────┐
//           ├─ sfx ─┐                        ├─ master ─ glue compressor ─ limiter ─ out
//           │       └─ (send) ─ hall reverb ─┤
//           ├─ amb ─ duck ───────────────────┤
//   <audio> music ─ crossfade ─ music ─ duck ┘
//
// - Buses: master, music, sfx (battle), ambience, interface. Levels persist (oathbound.* keys).
// - Battles never machine-gun: every sound has variants, random pitch/volume, a voice limit and
//   a cooldown; melee contacts drive two layered "clash bed" loops (skirmish → full melee) while
//   only a few individual clashes play on top as accents; a volley is one layered whoosh; arrow
//   impacts are pooled per 150 ms; everything is attenuated / filtered / panned by its distance
//   to the camera focus. Big moments (Lord abilities, keep hits and collapses, dragon roars) duck
//   the music.
// - Power: only interface sounds load at boot; planning loads ambience and the battle set in the
//   background; the context is suspended while the tab is hidden or everything is muted. The
//   mixer's timers run only while their phase is active. Nothing here touches the renderer.
import { store } from './ui/dom.ts';
import { assetUrl, loadAssetVersions } from './assets.ts';
import type { Rarity, Terrain, Vec2 } from './sim/types.ts';
import { BANK, MUSIC, attenuate, dbToGain, distanceCutoff, smooth, type Bus, type LoadGroup, type MusicId, type SoundDef, type SoundId } from './audio/bank.ts';

export type AudioPhase = 'menu' | 'planning' | 'battle' | 'results' | 'over';

/** Where the camera looks (field cm) and how far away it is (m); screen pan of a field point. */
export interface AudioListener {
  focus(): { pos: Vec2; dist: number } | null;
  pan(p: Vec2): number | null;
}

interface PlayOpts {
  /** Field position (cm): attenuated, filtered and panned against the listener. */
  pos?: Vec2;
  pan?: number;
  /** Linear gain multiplier. */
  gain?: number;
  /** Seconds from now. */
  delay?: number;
  /** Playback-rate multiplier (on top of the random pitch). */
  rate?: number;
}

interface Voice {
  id: string;
  group: string;
  src: AudioBufferSourceNode;
}

interface Loop {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const rand = (a: number): number => (Math.random() * 2 - 1) * a;
/** Distance (m) from a point to a terrain feature (cm geometry). */
function featureDist(p: Vec2, f: Terrain['features'][number]): number {
  if (f.shape === 'circle') return Math.max(0, Math.hypot(p[0] - f.x, p[1] - f.y) - f.r) / 100;
  const dx = Math.max(f.x - p[0], 0, p[0] - (f.x + f.w));
  const dy = Math.max(f.y - p[1], 0, p[1] - (f.y + f.h));
  return Math.hypot(dx, dy) / 100;
}

const MAX_VOICES = 40;
const PHASE_LOADS: Record<AudioPhase, LoadGroup[]> = {
  menu: ['boot'],
  planning: ['boot', 'planning', 'battle'],
  battle: ['boot', 'planning', 'battle', 'end'],
  results: ['boot', 'planning', 'battle', 'end'],
  over: ['boot', 'end'],
};

class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bus: Record<Bus | 'music', GainNode> | null = null;
  private musicDuck: GainNode | null = null;
  private ambDuck: GainNode | null = null;
  /** Ducks the battle effects under Lord voice lines (src/audio/voice.ts). */
  private sfxDuck: GainNode | null = null;
  private verbIn: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private raw = new Map<string, Promise<ArrayBuffer | null>>();
  private decoding = new Map<string, Promise<AudioBuffer | null>>();
  private requested = new Set<LoadGroup>();
  private voices: Voice[] = [];
  private lastStart = new Map<string, number>();
  private lastFile = new Map<string, number>();
  private loops = new Map<string, Loop>();
  private tracks = new Map<MusicId, { el: HTMLAudioElement; gain: GainNode }>();
  private track: MusicId | null = null;
  private phase: AudioPhase = 'menu';
  private listener: AudioListener | null = null;
  private terrain: Terrain | null = null;
  private ambTimer = 0;
  private battleTimer = 0;
  private contacts = 0;
  private arrowPool: { n: number; x: number; y: number; t: number } | null = null;
  private volleyPool: { n: number; x: number; y: number; t: number } | null = null;
  private battleRound = 0;

  muted = store.get('muted') === '1';
  volume = Number(store.get('volume') ?? '0.8');
  musicVol = Number(store.get('musicvol') ?? '0.6');
  sfx = Number(store.get('sfx') ?? '0.9');
  amb = Number(store.get('ambvol') ?? '0.7');
  ui = Number(store.get('uivol') ?? '0.8');

  /** Telemetry for tests and tuning: plays per sound, drops by reason, peak voices. */
  readonly stats = { plays: {} as Record<string, number>, dropped: {} as Record<string, number>, pooled: {} as Record<string, number>, peakVoices: 0, loaded: 0, failed: [] as string[], decodeMs: 0 };

  // ---------------------------------------------------------------- setup
  /** Create / resume the context (needs a user gesture). Safe to call often. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !document.hidden && !this.muted) void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    const ctx = this.ctx;
    // master chain: gentle glue compression, then a brick-wall-ish limiter
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -20;
    glue.knee.value = 10;
    glue.ratio.value = 3;
    glue.attack.value = 0.012;
    glue.release.value = 0.25;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.002;
    lim.release.value = 0.12;
    this.master = ctx.createGain();
    this.master.connect(glue).connect(lim).connect(ctx.destination);
    const g = (to: AudioNode): GainNode => {
      const n = ctx.createGain();
      n.connect(to);
      return n;
    };
    this.musicDuck = g(this.master);
    this.ambDuck = g(this.master);
    this.sfxDuck = g(this.master);
    this.bus = { ui: g(this.master), sfx: g(this.sfxDuck), amb: g(this.ambDuck), music: g(this.musicDuck) };
    // a short stereo hall (decaying filtered noise) as a shared send
    const len = Math.floor(ctx.sampleRate * 2.0);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    let s = 1234567;
    for (let c = 0; c < 2; c++) {
      const ch = ir.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        const w = ((s >>> 0) / 4294967296) * 2 - 1;
        const t = i / len;
        lp += (w - lp) * (0.55 - 0.45 * t);
        ch[i] = lp * Math.pow(1 - t, 2.6) * (i < ctx.sampleRate * 0.012 ? i / (ctx.sampleRate * 0.012) : 1);
      }
    }
    const verb = ctx.createConvolver();
    verb.buffer = ir;
    this.verbIn = ctx.createGain();
    this.verbIn.gain.value = 0.55;
    this.verbIn.connect(verb).connect(this.master);
    this.applyLevels();
    document.addEventListener('visibilitychange', () => this.onVisibility());
    // decode whatever was fetched before the gesture, then follow the phase
    for (const gname of this.requested) this.decodeGroup(gname);
    this.setPhase(this.phase, true);
  }

  private onVisibility(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (document.hidden) {
      for (const t of this.tracks.values()) t.el.pause();
      void ctx.suspend();
    } else if (!this.muted) {
      void ctx.resume();
      if (this.track) void this.tracks.get(this.track)?.el.play().catch(() => {});
    }
  }

  private applyLevels(): void {
    const b = this.bus;
    if (!b || !this.master || !this.ctx) return;
    const t = this.ctx.currentTime;
    const set = (n: GainNode, v: number) => n.gain.setTargetAtTime(v, t, 0.03);
    set(this.master, this.muted ? 0 : this.volume);
    set(b.music, 0.42 * this.musicVol * this.musicVol);
    set(b.sfx, this.sfx * this.sfx);
    set(b.amb, 0.85 * this.amb * this.amb);
    set(b.ui, 0.9 * this.ui * this.ui);
    // nothing audible: let the audio thread sleep
    if (this.muted || this.volume <= 0) void this.ctx.suspend();
    else if (!document.hidden && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    store.set('muted', m ? '1' : '0');
    this.applyLevels();
    if (!m && this.track) void this.tracks.get(this.track)?.el.play().catch(() => {});
  }
  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    store.set('volume', String(this.volume));
    this.applyLevels();
  }
  setMusic(v: number): void {
    this.musicVol = clamp(v, 0, 1);
    store.set('musicvol', String(this.musicVol));
    this.applyLevels();
  }
  setSfx(v: number): void {
    this.sfx = clamp(v, 0, 1);
    store.set('sfx', String(this.sfx));
    this.applyLevels();
  }
  setAmb(v: number): void {
    this.amb = clamp(v, 0, 1);
    store.set('ambvol', String(this.amb));
    this.applyLevels();
  }
  setUi(v: number): void {
    this.ui = clamp(v, 0, 1);
    store.set('uivol', String(this.ui));
    this.applyLevels();
  }

  /** A snapshot for tests / tuning (e2e/audio.mjs). */
  debug(): { state: string; phase: AudioPhase; track: MusicId | null; trackTime: number; trackPaused: boolean; loops: Record<string, number>; voices: number; buffers: number } {
    const tr = this.track ? this.tracks.get(this.track) : null;
    const loops: Record<string, number> = {};
    for (const [k, l] of this.loops) loops[k] = Math.round(l.gain.gain.value * 1000) / 1000;
    return { state: this.ctx?.state ?? 'none', phase: this.phase, track: this.track, trackTime: tr?.el.currentTime ?? 0, trackPaused: tr?.el.paused ?? true, loops, voices: this.voices.length, buffers: this.buffers.size };
  }

  setListener(l: AudioListener | null): void {
    this.listener = l;
  }
  setTerrain(t: Terrain | null): void {
    this.terrain = t;
  }

  // ---------------------------------------------------------------- loading
  /** Fetch a load group (and decode it once the context exists). */
  preload(group: LoadGroup): void {
    if (this.requested.has(group)) return;
    this.requested.add(group);
    if (this.ctx) this.decodeGroup(group);
    else for (const f of this.groupFiles(group)) this.fetchRaw(f);
  }

  private groupFiles(group: LoadGroup): string[] {
    const out: string[] = [];
    for (const d of Object.values(BANK) as SoundDef[]) if (d.load === group) out.push(...d.files);
    return out;
  }

  private fetchRaw(f: string): Promise<ArrayBuffer | null> {
    let p = this.raw.get(f);
    if (!p) {
      p = loadAssetVersions()
        .then(() => fetch(assetUrl(`audio/${f}.webm`)))
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null);
      this.raw.set(f, p);
    }
    return p;
  }

  private decode(f: string): Promise<AudioBuffer | null> {
    let p = this.decoding.get(f);
    if (p) return p;
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(null);
    p = this.fetchRaw(f).then(async (ab) => {
      if (!ab) {
        this.stats.failed.push(f);
        return null;
      }
      const t0 = performance.now();
      try {
        const buf = await ctx.decodeAudioData(ab.slice(0));
        this.buffers.set(f, buf);
        this.stats.loaded++;
        this.stats.decodeMs += performance.now() - t0;
        this.raw.delete(f); // the compressed bytes are no longer needed
        return buf;
      } catch {
        this.stats.failed.push(f);
        return null;
      }
    });
    this.decoding.set(f, p);
    return p;
  }

  /** Decode a group a few files at a time (keeps the main thread smooth). */
  private decodeGroup(group: LoadGroup): void {
    const files = this.groupFiles(group).filter((f) => !this.decoding.has(f));
    let i = 0;
    const next = (): void => {
      if (i >= files.length) return;
      const f = files[i++]!;
      void this.decode(f).then(next);
    };
    for (let k = 0; k < 3; k++) next();
  }

  // ---------------------------------------------------------------- voices
  private count(pred: (v: Voice) => boolean): number {
    let n = 0;
    for (const v of this.voices) if (pred(v)) n++;
    return n;
  }

  private reject(id: string, why: string): null {
    const k = `${id}:${why}`;
    this.stats.dropped[k] = (this.stats.dropped[k] ?? 0) + 1;
    return null;
  }

  /** Play one sound from the bank. Returns the source (or null when gated / not loaded). */
  play(id: SoundId, o: PlayOpts = {}): AudioBufferSourceNode | null {
    const ctx = this.ctx;
    const b = this.bus;
    if (!ctx || !b || this.muted || ctx.state === 'closed') return null;
    const d = BANK[id] as SoundDef;
    const now = performance.now();
    if (d.cooldown && now - (this.lastStart.get(id) ?? -1e9) < d.cooldown) return this.reject(id, 'cooldown');
    if (d.limit && this.count((v) => v.id === id) >= d.limit) return this.reject(id, 'limit');
    if (d.group && d.limit && this.count((v) => v.group === d.group) >= d.limit + 1) return this.reject(id, 'group');
    if (d.bus === 'sfx' && this.voices.length >= MAX_VOICES) return this.reject(id, 'voices');
    // pick a variant, never the same one twice running
    let fi = Math.floor(Math.random() * d.files.length);
    if (d.files.length > 1 && fi === this.lastFile.get(id)) fi = (fi + 1) % d.files.length;
    const file = d.files[fi]!;
    const buf = this.buffers.get(file);
    if (!buf) {
      void this.decode(file);
      return this.reject(id, 'loading');
    }
    let gain = dbToGain(d.db + rand(d.vary ?? 0)) * (o.gain ?? 1);
    let pan = o.pan ?? 0;
    let cutoff = 20000;
    let wet = d.wet ?? 0;
    if (o.pos && this.listener) {
      const f = this.listener.focus();
      if (f) {
        const dist = Math.hypot(o.pos[0] - f.pos[0], o.pos[1] - f.pos[1]) / 100;
        const att = attenuate(dist, f.dist);
        gain *= att;
        cutoff = distanceCutoff(att);
        wet = Math.min(0.6, wet + (1 - att) * 0.35);
      }
      const p = this.listener.pan(o.pos);
      if (p !== null) pan = p;
    }
    if (gain < 0.004) return this.reject(id, 'inaudible');
    const t = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, rand(d.pitch ?? 0) / 12) * (o.rate ?? 1);
    let node: AudioNode = src;
    if (cutoff < 19000) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      lp.Q.value = 0.5;
      node = node.connect(lp);
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    node = node.connect(g);
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      node = node.connect(p);
    }
    node.connect(b[d.bus]);
    if (wet > 0 && this.verbIn) {
      const w = ctx.createGain();
      w.gain.value = wet;
      node.connect(w).connect(this.verbIn);
    }
    src.start(t);
    const v: Voice = { id, group: d.group ?? id, src };
    this.voices.push(v);
    src.onended = () => {
      const i = this.voices.indexOf(v);
      if (i >= 0) this.voices.splice(i, 1);
      src.disconnect();
    };
    this.lastStart.set(id, now);
    this.lastFile.set(id, fi);
    this.stats.plays[id] = (this.stats.plays[id] ?? 0) + 1;
    this.stats.peakVoices = Math.max(this.stats.peakVoices, this.voices.length);
    return src;
  }

  /** Start (or retarget) a looping sound. Gain 0 keeps it running silently (cheap; beds stay in sync). */
  private loop(id: SoundId, gain: number, tc = 0.6): void {
    const ctx = this.ctx;
    const b = this.bus;
    if (!ctx || !b) return;
    let l = this.loops.get(id);
    if (!l) {
      if (gain <= 0) return;
      const d = BANK[id] as SoundDef;
      const buf = this.buffers.get(d.files[0]!);
      if (!buf) {
        void this.decode(d.files[0]!);
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(b[d.bus]);
      src.start(ctx.currentTime, Math.random() * buf.duration);
      l = { src, gain: g };
      this.loops.set(id, l);
      this.stats.plays[id] = (this.stats.plays[id] ?? 0) + 1;
    }
    l.gain.gain.setTargetAtTime(gain * dbToGain((BANK[id] as SoundDef).db), ctx.currentTime, tc);
  }

  private stopLoop(id: SoundId, fade = 1.0): void {
    const l = this.loops.get(id);
    if (!l || !this.ctx) return;
    this.loops.delete(id);
    const t = this.ctx.currentTime;
    l.gain.gain.cancelScheduledValues(t);
    l.gain.gain.setTargetAtTime(0, t, fade / 3);
    l.src.stop(t + fade + 0.1);
    l.src.onended = () => l.src.disconnect();
  }

  /** Pull the music (and a little ambience) down under a big moment. */
  duck(db = 9, hold = 1.5): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicDuck || !this.ambDuck) return;
    const t = ctx.currentTime;
    for (const [n, k] of [[this.musicDuck, 1], [this.ambDuck, 0.5]] as const) {
      n.gain.cancelScheduledValues(t);
      n.gain.setTargetAtTime(dbToGain(-db * k), t, 0.05);
      n.gain.setTargetAtTime(1, t + hold, 0.6);
    }
  }

  /** Under a Lord voice line: the battle effects dip by `db` for `hold` s (the music via duck()). */
  duckSfx(db: number, hold: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxDuck) return;
    const t = ctx.currentTime;
    const n = this.sfxDuck.gain;
    n.cancelScheduledValues(t);
    n.setTargetAtTime(dbToGain(-db), t, 0.04);
    n.setTargetAtTime(1, t + hold, 0.35);
  }

  /** The context and master bus once unlocked, for the voice bus (src/audio/voice.ts); null before the first gesture. */
  mixer(): { ctx: AudioContext; master: GainNode } | null {
    return this.ctx && this.master ? { ctx: this.ctx, master: this.master } : null;
  }

  // ---------------------------------------------------------------- music & phases
  private music(id: MusicId | null, fade = 2.5): void {
    const ctx = this.ctx;
    const b = this.bus;
    if (!ctx || !b || id === this.track) return;
    const t = ctx.currentTime;
    if (this.track) {
      const old = this.tracks.get(this.track);
      if (old) {
        old.gain.gain.cancelScheduledValues(t);
        old.gain.gain.setTargetAtTime(0, t, fade / 3);
        const el = old.el;
        const was = this.track;
        setTimeout(() => this.track !== was && el.pause(), fade * 1000 + 200);
      }
    }
    this.track = id;
    if (!id) return;
    let tr = this.tracks.get(id);
    if (!tr) {
      const el = new Audio(assetUrl(MUSIC[id]));
      el.loop = true;
      el.preload = 'auto';
      const src = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(b.music);
      tr = { el, gain };
      this.tracks.set(id, tr);
    }
    tr.gain.gain.cancelScheduledValues(t);
    tr.gain.gain.setTargetAtTime(1, t, fade / 3);
    if (!document.hidden && !this.muted) void tr.el.play().catch(() => {});
    this.stats.plays[`music:${id}`] = (this.stats.plays[`music:${id}`] ?? 0) + 1;
  }

  /** The game phase: picks the music, the ambience beds and what to load next. */
  setPhase(p: AudioPhase, force = false): void {
    if (p === this.phase && !force) return;
    const prev = this.phase;
    this.phase = p;
    for (const gname of PHASE_LOADS[p]) this.preload(gname);
    if (!this.ctx) return;
    clearInterval(this.ambTimer);
    this.ambTimer = 0;
    if (p !== 'battle') this.endBattleBeds();
    if (p === 'menu') {
      this.music('menu');
      this.loop('ambWind', 0.5);
      this.stopLoop('ambForest');
      this.stopLoop('ambRiver');
      this.stopLoop('ambBattle');
    } else if (p === 'planning' || p === 'results') {
      if (p === 'planning' || prev === 'battle') this.music('planning');
      this.stopLoop('ambBattle', 2);
      this.ambTick();
      this.ambTimer = window.setInterval(() => this.ambTick(), 500);
    } else if (p === 'battle') {
      this.music(this.battleRound % 2 ? 'battle_b' : 'battle_a', 1.5);
      this.stopLoop('ambForest', 2);
      if (!this.battleTimer) this.battleTimer = window.setInterval(() => this.battleTick(), 150);
      this.ambTick();
      this.ambTimer = window.setInterval(() => this.ambTick(), 500);
    } else if (p === 'over') {
      this.music(null, 1.2);
      this.stopLoop('ambBattle', 2);
      this.stopLoop('ambRiver', 2);
    }
  }

  /** Ambience follows the camera: birds and wind in planning, the river louder near it. */
  private ambTick(): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const f = this.listener?.focus() ?? null;
    let river = 0;
    if (f && this.terrain) {
      let d = 1e9;
      for (const ft of this.terrain.features) if (ft.kind === 'river' || ft.kind === 'ford' || ft.kind === 'bridge') d = Math.min(d, featureDist(f.pos, ft));
      // full at the bank, gone ~70 m away; zoomed out, it blends into the general bed
      river = (1 - smooth(4, 70, d)) * (1 - 0.6 * smooth(60, 140, f.dist));
    }
    const zoom = f ? smooth(40, 140, f.dist) : 0.5;
    if (this.phase === 'battle') {
      this.loop('ambWind', 0.55 + 0.3 * zoom, 1.5);
      this.loop('ambBattle', 0.7, 2);
      this.loop('ambRiver', river * 0.7, 1);
    } else {
      this.loop('ambForest', 0.75 + 0.25 * (1 - zoom), 1.5);
      this.loop('ambWind', 0.35 + 0.45 * zoom, 1.5);
      this.loop('ambRiver', river, 1);
    }
  }

  // ---------------------------------------------------------------- battle soundscape
  /** Battle begins: battle music, the horn and the charge, beds armed. */
  battleStart(round: number): void {
    this.battleRound = round;
    this.contacts = 0;
    this.endBattleBeds();
    this.setPhase('battle', true);
    this.play('horn');
    this.play('charge', { delay: 1.1 });
    this.duck(5, 2.5);
  }

  /** Battle over (or skipped): beds fade, the round sting plays. */
  battleEnd(won: boolean | null): void {
    this.endBattleBeds();
    if (won === true) this.play('roundWon');
    else if (won === false) this.play('roundLost');
  }

  private endBattleBeds(): void {
    clearInterval(this.battleTimer);
    this.battleTimer = 0;
    this.flushArrows();
    this.volleyPool = null;
    this.stopLoop('bedSkirmish', 1.5);
    this.stopLoop('bedMelee', 1.5);
  }

  /** Melee contacts per second (decayed, distance-weighted) → the two clash beds. */
  private battleTick(): void {
    this.contacts *= Math.exp(-0.15 / 0.9);
    const cps = this.contacts / 0.9;
    this.loop('bedSkirmish', smooth(0.4, 6, cps) * (1 - 0.45 * smooth(14, 40, cps)), 0.35);
    this.loop('bedMelee', smooth(5, 32, cps), 0.45);
    const now = performance.now();
    if (this.arrowPool && now - this.arrowPool.t > 150) this.flushArrows();
    if (this.volleyPool && now - this.volleyPool.t > 250) this.flushVolley();
  }

  private weight(pos: Vec2 | undefined): number {
    const f = pos && this.listener?.focus();
    if (!f || !pos) return 0.6;
    return Math.max(0.25, attenuate(Math.hypot(pos[0] - f.pos[0], pos[1] - f.pos[1]) / 100, f.dist));
  }

  private pool(id: string): null {
    this.stats.pooled[id] = (this.stats.pooled[id] ?? 0) + 1;
    return null;
  }

  /** A melee swing landing. Feeds the beds; only some become individual accents. */
  melee(pos: Vec2 | undefined, heavy: boolean): void {
    this.contacts += this.weight(pos);
    const cps = this.contacts / 0.9;
    // a handful of distinct clashes per second sit on top of the bed, favouring the ones in view
    const p = Math.min(1, 6 / Math.max(1, cps)) * (0.4 + 0.6 * this.weight(pos));
    if (Math.random() > p) return void this.pool('clash');
    this.play(heavy ? 'clashHeavy' : 'clash', { pos });
  }

  fist(pos?: Vec2): void {
    this.contacts += this.weight(pos);
    this.play('fist', { pos });
  }

  /** Arrows loosed within 250 ms are one volley: one layered whoosh at their centroid, sized by count. */
  volley(n: number, pos?: Vec2): void {
    const v = this.volleyPool;
    const p = pos ?? [4000, 6000];
    if (!v) this.volleyPool = { n, x: p[0] * n, y: p[1] * n, t: performance.now() };
    else {
      v.n += n;
      v.x += p[0] * n;
      v.y += p[1] * n;
      this.pool('volley');
    }
    if (!this.battleTimer) this.flushVolley();
  }

  private flushVolley(): void {
    const v = this.volleyPool;
    this.volleyPool = null;
    if (v) this.play(v.n >= 6 ? 'volleyLarge' : 'volleySmall', { pos: [v.x / v.n, v.y / v.n], gain: Math.min(1.25, 0.7 + v.n / 20) });
  }

  /** Arrow impacts pool into one scatter per 150 ms. */
  arrowImpact(pos: Vec2): void {
    const a = this.arrowPool;
    if (!a) this.arrowPool = { n: 1, x: pos[0], y: pos[1], t: performance.now() };
    else {
      a.n++;
      a.x += pos[0];
      a.y += pos[1];
      this.pool('arrowHit');
    }
    if (!this.battleTimer) this.flushArrows();
  }

  private flushArrows(): void {
    const a = this.arrowPool;
    this.arrowPool = null;
    if (a) this.play('arrowHit', { pos: [a.x / a.n, a.y / a.n], gain: Math.min(1.3, 0.6 + a.n / 12) });
  }

  death(pos?: Vec2): void {
    if (Math.random() < 0.3) this.play('grunt', { pos });
    if (Math.random() < 0.7) this.play('death', { pos });
    else this.pool('death');
  }

  /** A whole squad wiped out. */
  wipe(pos?: Vec2, lord = false): void {
    this.play('wipe', { pos, gain: lord ? 1.3 : 1 });
    if (lord) {
      this.play('boomBig', { gain: 0.6 });
      this.duck(8, 2);
    }
  }

  ballista(pos?: Vec2): void {
    this.play('ballista', { pos });
  }
  trebuchet(pos?: Vec2): void {
    this.play('treb', { pos });
  }
  stoneImpact(pos?: Vec2, splash = 1): void {
    this.play('stone', { pos, gain: Math.min(1.3, 0.8 + splash / 6) });
  }
  spell(pos?: Vec2): void {
    this.play('fireball', { pos });
  }
  boom(size: number, pos?: Vec2): void {
    if (size >= 6) this.play('boomBig', { pos });
    else this.play('boom', { pos, gain: Math.min(1.3, 0.7 + size / 8) });
  }
  breath(pos?: Vec2, dragon = true): void {
    this.play('breath', { pos });
    this.play(dragon ? 'roar' : 'screech', { pos, delay: 0.05 });
    if (dragon) this.duck(4, 1.2);
  }
  lightning(pos?: Vec2): void {
    this.play('zap', { pos });
  }
  heal(pos?: Vec2): void {
    this.play('heal', { pos });
  }
  stomp(pos?: Vec2): void {
    this.play('stomp', { pos });
  }
  summon(pos?: Vec2): void {
    this.play('summon', { pos });
  }

  keepHit(big: boolean, pos?: Vec2): void {
    this.play('keepHit', { pos, gain: big ? 1.25 : 0.9 });
    if (big) {
      this.play('boomBig', { pos, gain: 0.7 });
      this.duck(7, 1.5);
    }
  }

  /** The keep visibly crumbles a stage (1..4). */
  keepStage(stage: number, pos?: Vec2): void {
    if (stage <= 0) return;
    this.play('collapse', { pos, gain: stage >= 4 ? 1.3 : 1 });
    if (stage >= 4) this.play('boomBig', { pos });
    this.duck(stage >= 4 ? 12 : 8, stage >= 4 ? 3 : 2);
  }

  /** Lord abilities: always heard (they're the headline), music ducks. */
  ability(kind: string, pos?: Vec2): void {
    const big = { meteor: 'meteor', rally: 'rally', bulwark: 'bulwark', skyfall: 'skyfall' } as const;
    const id = big[kind as keyof typeof big];
    if (id) {
      this.play(id, { pos, gain: 1.2 });
      this.duck(10, kind === 'meteor' ? 2.5 : 2);
    } else this.play('cast', { pos });
  }

  // ---------------------------------------------------------------- interface
  click(): void {
    this.play('click');
  }
  hover(): void {
    this.play('hover');
  }
  pick(): void {
    this.play('pick');
  }
  error(): void {
    this.play('error');
  }
  deploy(): void {
    this.play('deploy');
  }
  drop(): void {
    this.play('drop');
  }
  coin(): void {
    this.play('coin');
  }
  levelUp(): void {
    this.play('levelUp');
  }
  equip(): void {
    this.play('equip');
  }
  tick(urgent: boolean): void {
    this.play(urgent ? 'tickUrgent' : 'tick');
  }
  ready(): void {
    this.play('ready');
  }
  /** A call to arms (the Lord reveal, battle start). */
  horn(): void {
    this.play('reveal');
    this.duck(6, 2.5);
  }
  whoosh(): void {
    this.play('whoosh');
  }
  open(): void {
    this.play('open');
  }
  /** New recruits: the unit-unlock draft appears. */
  draft(): void {
    this.play('draft');
    this.duck(8, 3);
  }

  /** The drop landing, then a sting by rarity. */
  lootReveal(r: Rarity): void {
    if (r === 'common') return void this.play('lootCommon');
    this.play('lootLand');
    if (r === 'magic') this.play('lootMagic', { delay: 0.05 });
    else if (r === 'rare') this.play('lootRare', { delay: 0.05 });
    else this.legendary();
  }
  legendary(): void {
    this.play('lootLegendary', { delay: 0.05 });
    this.duck(12, 4);
  }

  /** Match over: the victory / defeat sting, then the menu theme returns. */
  fanfare(win: boolean): void {
    this.setPhase('over');
    this.play(win ? 'victory' : 'defeat');
    setTimeout(() => this.phase === 'over' && this.music('menu', 4), win ? 7000 : 10000);
  }

  /** Back-compat: the battle screen reports the round result through battleEnd(). */
  roundEnd(won: boolean | null): void {
    this.battleEnd(won);
  }
}

export const sound = new Sound();
