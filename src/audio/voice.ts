// Lord voice lines (Breeze-TTS-2 renders, tools/voice/; licence in docs/AUDIO.md, Voices).
//
//   import { voice, playLordLine } from './audio/voice.ts';
//   voice.setMatchLords(['marshal', 'warden']);   // once both Lords are known: loads only their lines
//   playLordLine('marshal', 'deploy');            // fire and forget; returns false when gated
//
// - A 'voice' bus on the master (its own level, persisted as oathbound.voicevol, squared curve like the
//   other buses). While a line plays, the music and ambience duck (sound.duck) and the battle effects dip
//   (sound.duckSfx), by the event's VOICE_RULES[ev].duck.
// - One line at a time: per-(Lord, event) cooldowns, a higher-priority line cuts a lower one short (70 ms
//   fade), anything else is dropped while a line plays. Variants rotate (VoiceGate), never repeating early.
// - Lazy: nothing is fetched until a Lord is in the match. The first request for a Lord fetches that line
//   first and the rest of the Lord's ~17 files in the background, two at a time. A requested line that
//   is still loading plays if it arrives within LATE_MS, else it is dropped (a stale bark is worse than none).
// - Mute, master volume and tab-hidden suspension come from the shared AudioContext and master (src/audio.ts).
import { sound } from '../audio.ts';
import { assetUrl, loadAssetVersions } from '../assets.ts';
import { store } from '../ui/dom.ts';
import type { LordId } from '../sim/types.ts';
import { dbToGain } from './bank.ts';
import { VOICE_RULES, VoiceGate, lordVoiceFiles, voiceFile, type VoiceEvent } from './voice-lines.ts';

export type { VoiceEvent } from './voice-lines.ts';

/** A line still decoding is played only if it is ready within this many ms of the request. */
const LATE_MS = 1200;
/** Voice bus trim (dB) on top of the files' normalised level (tools/voice/build.py T_VOICE). */
const BUS_DB = 0;

export interface LineOpts {
  /** Seconds from now (e.g. after a sting). */
  delay?: number;
  /** Stereo pan -1..1 (e.g. the enemy Lord slightly off-centre). Default centre. */
  pan?: number;
  /** Linear gain multiplier. */
  gain?: number;
}

class LordVoice {
  private bus: GainNode | null = null;
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  private lords = new Set<LordId>();
  private gate = new VoiceGate();
  private current: { src: AudioBufferSourceNode; gain: GainNode } | null = null;

  level = Number(store.get('voicevol') ?? '0.9');
  /** Telemetry for tests and tuning. */
  readonly stats = { plays: {} as Record<string, number>, dropped: {} as Record<string, number>, loaded: 0, failed: [] as string[] };

  /** The bus, created on the shared context once it exists (after the first gesture). */
  private out(): { ctx: AudioContext; bus: GainNode } | null {
    const m = sound.mixer();
    if (!m) return null;
    if (this.ctx !== m.ctx || !this.bus) {
      this.ctx = m.ctx;
      this.bus = m.ctx.createGain();
      this.bus.connect(m.master);
      this.applyLevel();
      // anything requested before the gesture can decode now
      for (const l of this.lords) this.loadLord(l);
    }
    return { ctx: this.ctx, bus: this.bus };
  }

  private applyLevel(): void {
    if (this.bus && this.ctx) this.bus.gain.setTargetAtTime(dbToGain(BUS_DB) * this.level * this.level, this.ctx.currentTime, 0.03);
  }

  /** The Settings slider (0..1). Persists as oathbound.voicevol. */
  setVolume(v: number): void {
    this.level = Math.max(0, Math.min(1, v));
    store.set('voicevol', String(this.level));
    this.applyLevel();
  }

  /** The Lords in this match (both seats; duplicates fine). Starts loading their lines; others are never fetched. */
  setMatchLords(lords: readonly (LordId | null | undefined)[]): void {
    for (const l of lords) if (l && !this.lords.has(l)) {
      this.lords.add(l);
      this.loadLord(l);
    }
  }

  private loadLord(lord: LordId): void {
    if (!this.ctx) return; // decoded once the context exists (see out())
    const files = lordVoiceFiles(lord).filter((f) => !this.loading.has(f));
    let i = 0;
    const next = (): void => {
      if (i >= files.length) return;
      void this.load(files[i++]!).then(next);
    };
    next();
    next();
  }

  private load(f: string): Promise<AudioBuffer | null> {
    let p = this.loading.get(f);
    if (p) return p;
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(null);
    p = loadAssetVersions()
      .then(() => fetch(assetUrl(`audio/${f}.webm`)))
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((ab) => (ab ? ctx.decodeAudioData(ab) : null))
      .then((buf) => {
        if (buf) {
          this.buffers.set(f, buf);
          this.stats.loaded++;
        } else this.stats.failed.push(f);
        return buf;
      })
      .catch(() => {
        this.stats.failed.push(f);
        return null;
      });
    this.loading.set(f, p);
    return p;
  }

  private drop(key: string, why: string): false {
    const k = `${key}:${why}`;
    this.stats.dropped[k] = (this.stats.dropped[k] ?? 0) + 1;
    return false;
  }

  /** Say a line. Returns false when gated (muted, cooldown, a more important line playing, not loaded in time). */
  play(lord: LordId, ev: VoiceEvent, o: LineOpts = {}): boolean {
    const key = `${lord}/${ev}`;
    const out = this.out();
    if (!out || sound.muted || out.ctx.state === 'closed') return this.drop(key, 'off');
    if (this.level <= 0) return this.drop(key, 'silent');
    this.setMatchLords([lord]); // a Lord that speaks is in the match
    const now = performance.now();
    const d = this.gate.decide(lord, ev, now);
    if ('drop' in d) return this.drop(key, d.drop);
    const file = voiceFile(lord, ev, d.n);
    const buf = this.buffers.get(file);
    if (buf) this.start(buf, ev, key, d.interrupt, o);
    else {
      void this.load(file).then((b) => {
        if (!b) return this.drop(key, 'failed');
        if (performance.now() - now > LATE_MS) return this.drop(key, 'late');
        this.start(b, ev, key, d.interrupt, o);
      });
    }
    return true;
  }

  private start(buf: AudioBuffer, ev: VoiceEvent, key: string, interrupt: boolean, o: LineOpts): void {
    const out = this.out();
    if (!out) return;
    const { ctx, bus } = out;
    const t = ctx.currentTime + (o.delay ?? 0);
    if (this.current && interrupt) {
      const c = this.current;
      c.gain.gain.cancelScheduledValues(ctx.currentTime);
      c.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.025);
      c.src.stop(ctx.currentTime + 0.1);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    let node: AudioNode = src.connect(g);
    if (o.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      node = node.connect(p);
    }
    node.connect(bus);
    src.start(t);
    const cur = { src, gain: g };
    this.current = cur;
    src.onended = () => {
      if (this.current === cur) {
        this.current = null;
        this.gate.stopped();
      }
      src.disconnect();
    };
    const dur = buf.duration + (o.delay ?? 0);
    this.gate.started(ev, performance.now(), dur * 1000);
    const duck = VOICE_RULES[ev].duck;
    const hold = dur + 0.15;
    if (o.delay) setTimeout(() => this.duckFor(duck, buf.duration + 0.15), o.delay * 1000);
    else this.duckFor(duck, hold);
    this.stats.plays[key] = (this.stats.plays[key] ?? 0) + 1;
  }

  private duckFor(db: number, hold: number): void {
    sound.duck(db, hold);
    sound.duckSfx(db * 0.6, hold);
  }

  /** A snapshot for tests / tuning. */
  debug(): { lords: LordId[]; buffers: number; playing: boolean } {
    return { lords: [...this.lords], buffers: this.buffers.size, playing: !!this.current };
  }
}

export const voice = new LordVoice();

/** Say a Lord's line for a game event (see docs/AUDIO.md, Voices, for where each event fires). */
export function playLordLine(lord: LordId | null | undefined, ev: VoiceEvent, o?: LineOpts): boolean {
  return lord ? voice.play(lord, ev, o) : false;
}
