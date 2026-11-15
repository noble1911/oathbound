// Lord voice lines: the shipped set and the rules that keep them from nagging. Pure data + logic (no
// WebAudio, no DOM) so tests can check it; the player is src/audio/voice.ts. The lines themselves are in
// tools/voice/manifest.json (rendered with Breeze-TTS-2; licence in docs/AUDIO.md, Voices).
import type { LordId } from '../sim/types.ts';

export type VoiceEvent = 'pick' | 'taunt' | 'deploy' | 'ready' | 'charge' | 'ability' | 'roundWon' | 'roundLost' | 'keep' | 'legendary' | 'victory' | 'defeat';

export const VOICE_LORDS: readonly LordId[] = [
  'marshal', 'archmage', 'warden', 'skylady', 'lich', 'sultana', 'deathknight', 'ossuary', 'drakerider', 'vizier', 'rajah', 'rocrider',
];

/** Variants per event (the same for every Lord): files are audio/voice/<lord>/<event>_<n>.webm, n from 1. */
export const VOICE_LINES: Record<VoiceEvent, number> = {
  pick: 1,
  taunt: 1,
  deploy: 3,
  ready: 1,
  charge: 2,
  ability: 2,
  roundWon: 2,
  roundLost: 2,
  keep: 1,
  legendary: 1,
  victory: 1,
  defeat: 1,
};

interface EventRule {
  /** Minimum ms between two lines of this event (per Lord). */
  cooldown: number;
  /** Higher interrupts lower; equal or lower waits its turn (is dropped while another line plays). */
  priority: number;
  /** Music / SFX duck in dB while the line plays. */
  duck: number;
}

export const VOICE_RULES: Record<VoiceEvent, EventRule> = {
  deploy: { cooldown: 4000, priority: 1, duck: 4 },
  ready: { cooldown: 3000, priority: 2, duck: 5 },
  legendary: { cooldown: 6000, priority: 2, duck: 6 },
  roundWon: { cooldown: 5000, priority: 3, duck: 6 },
  roundLost: { cooldown: 5000, priority: 3, duck: 6 },
  charge: { cooldown: 8000, priority: 3, duck: 6 },
  keep: { cooldown: 20000, priority: 3, duck: 6 },
  ability: { cooldown: 6000, priority: 4, duck: 7 },
  pick: { cooldown: 1500, priority: 5, duck: 7 },
  taunt: { cooldown: 3000, priority: 5, duck: 7 },
  victory: { cooldown: 5000, priority: 6, duck: 9 },
  defeat: { cooldown: 5000, priority: 6, duck: 9 },
};

/** A short global gap after any line, so two Lords never talk over each other's tail. */
export const VOICE_GAP_MS = 350;

export const voiceFile = (lord: LordId, ev: VoiceEvent, n: number): string => `voice/${lord}/${ev}_${n}`;

/** Every file of one Lord (paths under public/audio/, no extension), the frequent ones first. */
export function lordVoiceFiles(lord: LordId): string[] {
  const order: VoiceEvent[] = ['pick', 'taunt', 'deploy', 'ready', 'charge', 'ability', 'roundWon', 'roundLost', 'keep', 'legendary', 'victory', 'defeat'];
  return order.flatMap((ev) => Array.from({ length: VOICE_LINES[ev] }, (_, i) => voiceFile(lord, ev, i + 1)));
}

/** Every shipped voice file (tests check each exists). */
export function allVoiceFiles(): string[] {
  return VOICE_LORDS.flatMap(lordVoiceFiles).map((f) => `${f}.webm`);
}

/**
 * Who may speak now: per-(Lord, event) cooldowns, priority over the line already playing, and variant
 * rotation (each event cycles its variants from a random start, so a variant never repeats until the
 * others have played).
 */
export class VoiceGate {
  private last = new Map<string, number>();
  private next = new Map<string, number>();
  private playing: { priority: number; until: number } | null = null;
  private rnd: () => number;

  constructor(rnd: () => number = Math.random) {
    this.rnd = rnd;
  }

  /** The variant (1-based) to play, or a reason it may not. `durMs` is unknown here; call `started` after. */
  decide(lord: LordId, ev: VoiceEvent, now: number): { n: number; interrupt: boolean } | { drop: 'cooldown' | 'busy' } {
    const key = `${lord}:${ev}`;
    const rule = VOICE_RULES[ev];
    if (now - (this.last.get(key) ?? -1e12) < rule.cooldown) return { drop: 'cooldown' };
    let interrupt = false;
    if (this.playing && now < this.playing.until + VOICE_GAP_MS) {
      if (rule.priority <= this.playing.priority) return { drop: 'busy' };
      interrupt = now < this.playing.until;
    }
    const count = VOICE_LINES[ev];
    let i = this.next.get(key);
    if (i === undefined) i = Math.floor(this.rnd() * count);
    this.next.set(key, (i + 1) % count);
    this.last.set(key, now);
    return { n: i + 1, interrupt };
  }

  /** The decided line has started and lasts `durMs`. */
  started(ev: VoiceEvent, now: number, durMs: number): void {
    this.playing = { priority: VOICE_RULES[ev].priority, until: now + durMs };
  }

  /** A line was cut short (or failed to start): free the channel. */
  stopped(): void {
    this.playing = null;
  }
}
