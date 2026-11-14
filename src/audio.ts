// Sound, synthesised with WebAudio (no audio files): noise bursts and tones for battle events
// (clash, bow volleys, spells, impacts, keep hits), HUD feedback (clicks, deploys, errors, timer
// ticks) and the loot reveal (one sting per rarity, a choir-and-bell flourish for legendaries).
// The context is created on the first user gesture (`unlock`) and suspended after a few seconds of
// silence to save battery. A limiter and a voice cap keep big fights clean. Volume and mute persist.
import { store } from './ui/dom.ts';
import type { Rarity } from './sim/types.ts';

type ToneOpts = { type?: OscillatorType; gain?: number; at?: number; slide?: number; attack?: number; pan?: number; detune?: number };
type HissOpts = { freq?: number; q?: number; gain?: number; at?: number; type?: BiquadFilterType; sweep?: number; pan?: number; attack?: number };

class Sound {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private verb: ConvolverNode | null = null;
  private verbIn: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private idleTimer = 0;
  private voices = 0;
  private lastPlay = new Map<string, number>();
  muted = store.get('muted') === '1';
  volume = Number(store.get('volume') ?? '0.7');
  sfx = Number(store.get('sfx') ?? '1');
  ui = Number(store.get('uivol') ?? '1');

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    this.out = ctx.createGain();
    this.applyGain();
    this.out.connect(limiter).connect(ctx.destination);
    // deterministic white noise
    const n = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, n, n);
    const d = this.noise.getChannelData(0);
    let s = 1234567;
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
    }
    // a short dark hall for stings and spells: decaying noise that darkens as it fades
    const len = Math.floor(ctx.sampleRate * 2.2);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = ir.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        const w = ((s >>> 0) / 4294967296) * 2 - 1;
        const t = i / len;
        lp += (w - lp) * (0.5 - 0.42 * t);
        ch[i] = lp * Math.pow(1 - t, 3);
      }
    }
    this.verb = ctx.createConvolver();
    this.verb.buffer = ir;
    this.verbIn = ctx.createGain();
    this.verbIn.gain.value = 0.35;
    this.verbIn.connect(this.verb).connect(this.out);
  }

  private applyGain(): void {
    if (this.out) this.out.gain.value = this.muted ? 0 : 0.75 * this.volume;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    store.set('muted', m ? '1' : '0');
    this.applyGain();
  }
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    store.set('volume', String(this.volume));
    this.applyGain();
  }
  setSfx(v: number): void {
    this.sfx = Math.max(0, Math.min(1, v));
    store.set('sfx', String(this.sfx));
  }
  setUi(v: number): void {
    this.ui = Math.max(0, Math.min(1, v));
    store.set('uivol', String(this.ui));
  }

  /** A context ready to play into, or null (locked, muted, too many voices). */
  private live(): AudioContext | null {
    const ctx = this.ctx;
    if (!ctx || this.muted || this.voices > 30) return null;
    if (ctx.state === 'suspended') void ctx.resume();
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => void ctx.suspend(), 5000);
    return ctx;
  }

  /** Rate-limit a named sound (battle events come in bursts). */
  private gate(name: string, ms: number): boolean {
    const now = performance.now();
    if (now - (this.lastPlay.get(name) ?? -1e9) < ms) return false;
    this.lastPlay.set(name, now);
    return true;
  }

  private dest(ctx: AudioContext, pan: number, wet: number): AudioNode {
    let node: AudioNode = this.out!;
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      p.connect(this.out!);
      if (wet && this.verbIn) p.connect(this.verbIn);
      return p;
    }
    if (wet && this.verbIn) {
      const g = ctx.createGain();
      g.connect(this.out!);
      const w = ctx.createGain();
      w.gain.value = wet;
      g.connect(w).connect(this.verbIn);
      node = g;
    }
    return node;
  }

  private tone(freq: number, dur: number, opts: ToneOpts & { wet?: number; bus?: 'sfx' | 'ui' } = {}): void {
    const ctx = this.live();
    if (!ctx) return;
    const { type = 'sine', gain = 0.3, at = 0, slide = 1, attack = 0.005, pan = 0, detune = 0, wet = 0, bus = 'sfx' } = opts;
    const vol = gain * (bus === 'ui' ? this.ui : this.sfx);
    if (vol <= 0.0002) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.detune.value = detune;
    if (slide !== 1) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.dest(ctx, pan, wet));
    o.start(t);
    o.stop(t + dur + 0.02);
    this.voices++;
    o.onended = () => this.voices--;
  }

  private hiss(dur: number, opts: HissOpts & { wet?: number; bus?: 'sfx' | 'ui' } = {}): void {
    const ctx = this.live();
    if (!ctx || !this.noise) return;
    const { freq = 2000, q = 1, gain = 0.3, at = 0, type = 'bandpass', sweep = 1, pan = 0, attack = 0, wet = 0, bus = 'sfx' } = opts;
    const vol = gain * (bus === 'ui' ? this.ui : this.sfx);
    if (vol <= 0.0002) return;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweep !== 1) f.frequency.exponentialRampToValueAtTime(freq * sweep, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    if (attack) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + attack);
    } else g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.dest(ctx, pan, wet));
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
    this.voices++;
    src.onended = () => this.voices--;
  }

  // ---------------------------------------------------------------- HUD
  click(): void {
    this.tone(1400, 0.05, { type: 'triangle', gain: 0.1, bus: 'ui' });
  }
  hover(): void {
    if (this.gate('hover', 60)) this.tone(2400, 0.025, { type: 'sine', gain: 0.03, bus: 'ui' });
  }
  pick(): void {
    this.tone(660, 0.07, { type: 'triangle', gain: 0.12, bus: 'ui' });
    this.tone(990, 0.08, { type: 'triangle', gain: 0.09, at: 0.04, bus: 'ui' });
  }
  error(): void {
    this.tone(180, 0.16, { type: 'square', gain: 0.07, bus: 'ui' });
    this.tone(150, 0.2, { type: 'square', gain: 0.07, at: 0.08, bus: 'ui' });
  }
  deploy(): void {
    this.tone(110, 0.3, { type: 'sine', gain: 0.35, slide: 0.6, bus: 'ui' });
    this.hiss(0.25, { freq: 500, q: 0.6, gain: 0.18, type: 'lowpass', bus: 'ui' });
    this.tone(880, 0.12, { type: 'triangle', gain: 0.05, at: 0.05, bus: 'ui' });
  }
  drop(): void {
    this.tone(220, 0.09, { type: 'sine', gain: 0.22, slide: 0.7, bus: 'ui' });
    this.hiss(0.06, { freq: 900, gain: 0.08, bus: 'ui' });
  }
  coin(): void {
    this.tone(1976, 0.08, { type: 'square', gain: 0.04, bus: 'ui' });
    this.tone(2637, 0.22, { type: 'square', gain: 0.04, at: 0.06, bus: 'ui' });
  }
  levelUp(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i === 3 ? 0.5 : 0.14, { type: 'triangle', gain: 0.1, at: i * 0.07, wet: 0.4, bus: 'ui' }));
  }
  equip(): void {
    this.hiss(0.08, { freq: 4000, q: 2, gain: 0.12, bus: 'ui' });
    this.tone(320, 0.12, { type: 'square', gain: 0.05, slide: 0.8, bus: 'ui' });
  }
  tick(urgent: boolean): void {
    this.tone(urgent ? 1200 : 800, 0.04, { type: 'square', gain: urgent ? 0.06 : 0.03, bus: 'ui' });
  }
  ready(): void {
    this.tone(392, 0.18, { type: 'triangle', gain: 0.12, bus: 'ui' });
    this.tone(587, 0.35, { type: 'triangle', gain: 0.12, at: 0.1, wet: 0.3, bus: 'ui' });
  }
  horn(): void {
    // battle start: a low brass call
    for (const [f, at] of [[147, 0], [196, 0.35], [147, 0.7]] as const) {
      this.tone(f, 0.6, { type: 'sawtooth', gain: 0.07, at, attack: 0.06, wet: 0.6 });
      this.tone(f * 2, 0.6, { type: 'sawtooth', gain: 0.03, at, attack: 0.08, wet: 0.6, detune: 8 });
    }
    this.hiss(1.4, { freq: 200, gain: 0.08, type: 'lowpass', attack: 0.2 });
  }
  whoosh(): void {
    this.hiss(0.4, { freq: 600, q: 1.5, gain: 0.12, sweep: 4, attack: 0.08, bus: 'ui' });
  }

  // ---------------------------------------------------------------- loot
  /** The drop landing, then a sting by rarity. */
  lootReveal(r: Rarity): void {
    this.hiss(0.18, { freq: 300, gain: 0.25, type: 'lowpass', bus: 'ui' });
    this.tone(90, 0.25, { type: 'sine', gain: 0.3, slide: 0.6, bus: 'ui' });
    if (r === 'common') return void this.tone(660, 0.18, { type: 'triangle', gain: 0.06, at: 0.05, bus: 'ui' });
    if (r === 'magic') {
      [880, 1320].forEach((f, i) => this.tone(f, 0.4, { type: 'sine', gain: 0.08, at: 0.05 + i * 0.06, wet: 0.5, bus: 'ui' }));
      return;
    }
    if (r === 'rare') {
      [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.55, { type: 'triangle', gain: 0.08, at: 0.05 + i * 0.05, wet: 0.6, bus: 'ui' }));
      this.hiss(0.6, { freq: 7000, q: 4, gain: 0.04, at: 0.05, bus: 'ui' });
      return;
    }
    this.legendary();
  }
  /** Big flourish: a rising swell, a low boom, a choir chord and a bell. */
  legendary(): void {
    this.hiss(0.9, { freq: 400, q: 0.8, gain: 0.18, sweep: 8, attack: 0.7, bus: 'ui' });
    this.tone(55, 1.4, { type: 'sine', gain: 0.45, at: 0.75, slide: 0.7, bus: 'ui' });
    this.hiss(0.6, { freq: 180, gain: 0.3, type: 'lowpass', at: 0.75, bus: 'ui' });
    const chord = [220, 277.2, 329.6, 440, 554.4];
    chord.forEach((f, i) => {
      this.tone(f, 2.4, { type: 'sawtooth', gain: 0.025, at: 0.78, attack: 0.25, wet: 0.9, detune: -6, bus: 'ui' });
      this.tone(f, 2.4, { type: 'sawtooth', gain: 0.025, at: 0.78 + i * 0.01, attack: 0.25, wet: 0.9, detune: 6, bus: 'ui' });
    });
    [1760, 2637, 3520].forEach((f, i) => this.tone(f, 1.6, { type: 'sine', gain: 0.06 - i * 0.015, at: 0.8, wet: 0.8, bus: 'ui' }));
  }

  // ---------------------------------------------------------------- battle
  clash(pan = 0, heavy = false): void {
    if (!this.gate('clash', heavy ? 40 : 55)) return;
    const f = 2500 + Math.random() * 1800;
    this.hiss(0.07, { freq: f, q: 6, gain: heavy ? 0.16 : 0.1, pan });
    this.tone(f * 0.71, 0.18, { type: 'square', gain: 0.025, pan, slide: 0.98 });
    this.tone(f * 1.13, 0.14, { type: 'triangle', gain: 0.02, pan });
    if (heavy) this.tone(90, 0.2, { type: 'sine', gain: 0.22, slide: 0.6, pan });
  }
  thud(pan = 0): void {
    if (!this.gate('thud', 70)) return;
    this.hiss(0.1, { freq: 500, q: 0.8, gain: 0.14, type: 'lowpass', pan });
  }
  volley(n: number, pan = 0): void {
    if (!this.gate('volley', 160)) return;
    const k = Math.min(5, 1 + Math.floor(n / 3));
    for (let i = 0; i < k; i++) {
      const at = i * 0.03 + Math.random() * 0.03;
      this.tone(220 + Math.random() * 60, 0.09, { type: 'triangle', gain: 0.08, slide: 1.7, at, pan });
      this.hiss(0.35, { freq: 2600, q: 2.5, gain: 0.05, sweep: 0.45, at: at + 0.02, pan });
    }
  }
  ballista(pan = 0): void {
    if (!this.gate('ballista', 120)) return;
    this.tone(70, 0.25, { type: 'square', gain: 0.12, slide: 0.5, pan });
    this.hiss(0.3, { freq: 1500, q: 1.5, gain: 0.12, sweep: 0.4, pan });
  }
  trebuchet(pan = 0): void {
    if (!this.gate('treb', 200)) return;
    this.hiss(0.6, { freq: 300, q: 0.7, gain: 0.14, sweep: 3, attack: 0.15, pan });
    this.tone(60, 0.4, { type: 'sine', gain: 0.18, pan });
  }
  spell(pan = 0): void {
    if (!this.gate('spell', 110)) return;
    this.tone(320, 0.35, { type: 'sawtooth', gain: 0.04, slide: 2.4, pan, wet: 0.4 });
    this.hiss(0.4, { freq: 1200, q: 1.2, gain: 0.1, sweep: 3, attack: 0.08, pan, wet: 0.3 });
  }
  boom(size: number, pan = 0): void {
    if (!this.gate('boom', 90)) return;
    const g = Math.min(0.45, 0.15 + size * 0.04);
    this.tone(70, 0.5, { type: 'sine', gain: g, slide: 0.45, pan });
    this.hiss(0.5 + size * 0.05, { freq: 700, q: 0.6, gain: g * 0.8, type: 'lowpass', sweep: 0.3, pan, wet: 0.3 });
  }
  breath(pan = 0): void {
    if (!this.gate('breath', 300)) return;
    this.hiss(1.0, { freq: 900, q: 0.5, gain: 0.2, sweep: 0.5, attack: 0.1, pan, wet: 0.3 });
    this.tone(80, 0.8, { type: 'sawtooth', gain: 0.05, pan });
  }
  lightning(pan = 0): void {
    if (!this.gate('zap', 120)) return;
    this.hiss(0.25, { freq: 5000, q: 0.5, gain: 0.18, type: 'highpass', pan });
    this.tone(2200, 0.1, { type: 'square', gain: 0.03, slide: 0.3, pan });
  }
  heal(pan = 0): void {
    if (!this.gate('heal', 400)) return;
    [784, 988, 1175].forEach((f, i) => this.tone(f, 0.3, { type: 'sine', gain: 0.04, at: i * 0.05, pan, wet: 0.5 }));
  }
  death(pan = 0): void {
    if (!this.gate('death', 90)) return;
    this.hiss(0.16, { freq: 350, q: 1, gain: 0.08, type: 'lowpass', pan });
  }
  keepHit(big: boolean): void {
    if (!this.gate('keep', big ? 0 : 140)) return;
    this.tone(48, big ? 1.4 : 0.6, { type: 'sine', gain: big ? 0.6 : 0.35, slide: 0.6 });
    this.hiss(big ? 1.2 : 0.4, { freq: 400, q: 0.6, gain: big ? 0.35 : 0.18, type: 'lowpass', sweep: 0.4, wet: 0.5 });
    if (big) this.hiss(1.8, { freq: 1800, q: 0.5, gain: 0.08, at: 0.1, sweep: 0.3, wet: 0.6 });
  }
  ability(kind: string): void {
    if (kind === 'meteor') {
      this.hiss(1.0, { freq: 300, q: 0.7, gain: 0.2, sweep: 6, attack: 0.8 });
      this.boom(10);
    } else if (kind === 'rally') {
      this.horn();
    } else if (kind === 'bulwark') {
      [196, 294, 392].forEach((f, i) => this.tone(f, 1.2, { type: 'triangle', gain: 0.08, at: i * 0.04, wet: 0.7, attack: 0.05 }));
    } else if (kind === 'skyfall') {
      this.hiss(0.7, { freq: 3000, q: 1, gain: 0.15, sweep: 0.2, attack: 0.3 });
      this.boom(6);
    } else {
      this.tone(660, 0.5, { type: 'triangle', gain: 0.06, wet: 0.6 });
      this.tone(990, 0.6, { type: 'triangle', gain: 0.05, at: 0.06, wet: 0.6 });
    }
  }
  fanfare(win: boolean): void {
    const notes = win ? [392, 523, 659, 784, 1047] : [392, 349, 311, 262, 196];
    notes.forEach((f, i) => {
      this.tone(f, i === 4 ? 1.6 : 0.42, { type: 'sawtooth', gain: 0.05, at: i * 0.2, attack: 0.03, wet: 0.6 });
      this.tone(f / 2, i === 4 ? 1.6 : 0.42, { type: 'triangle', gain: 0.08, at: i * 0.2, wet: 0.6 });
    });
    this.tone(win ? 65 : 49, 2.4, { type: 'sine', gain: 0.3, at: 0.8 });
  }
  roundEnd(won: boolean | null): void {
    const base = won === false ? 220 : 330;
    [1, 1.26, 1.5].forEach((m, i) => this.tone(base * m, 0.6, { type: 'triangle', gain: 0.08, at: i * 0.09, wet: 0.5 }));
  }
}

export const sound = new Sound();
